"""Link lifecycle: one worker thread owns the MAVLink transport.

Concurrency model
-----------------
Exactly one thread -- the link worker -- ever touches the
:class:`~app.mavlink.interface.MavlinkLink`. It reads messages, sends the 1 Hz
GCS heartbeat, and executes queued transmit jobs. The FastAPI event loop never
calls into the transport directly; it queues a job and waits on a future.

That gives thread safety without sprinkling locks through the transport, and it
guarantees that a heartbeat and a command can never interleave mid-frame on the
serial line.

Shutdown is deterministic: set the stop event, wake the worker, join it with a
timeout, close the transport in the worker's ``finally`` (and again defensively
from the caller if the join timed out).

Serial ownership
----------------
Three independent mechanisms keep a second owner off the port:

1. Uvicorn binds ``127.0.0.1:8787``; a second backend fails to start.
2. :meth:`LinkManager.connect` refuses while a worker thread is already alive.
3. The OS grants a COM port to one process; a second opener gets "access is
   denied", which is reported as
   :class:`~app.mavlink.interface.PortBusyError` with a QGroundControl hint.
"""

from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import Future
from dataclasses import dataclass
from queue import Empty, SimpleQueue
from typing import Any, Callable

from ..config import Settings
from .interface import LinkError, MavlinkLink, ReceivedMessage
from .telemetry_state import ConnectionState, TelemetryState

logger = logging.getLogger(__name__)

#: Longest a single receive() call may block. Keeps shutdown responsive.
_RECEIVE_SLICE = 0.2
#: How long connect() waits for the worker to reach a settled state before
#: returning, so the HTTP response reflects reality instead of "connecting".
_CONNECT_SETTLE_POLL = 0.05


class LinkBusyError(RuntimeError):
    """A connect was requested while a link was already running."""


@dataclass
class _TransmitJob:
    """A transmit closure to run on the worker thread."""

    run: Callable[[MavlinkLink], Any]
    future: Future


class AckWaiter:
    """Waits for a ``COMMAND_ACK`` matching one command id."""

    def __init__(self, command: int) -> None:
        self.command = command
        self._event = threading.Event()
        self._payload: dict[str, Any] | None = None

    def deliver(self, payload: dict[str, Any]) -> None:
        self._payload = payload
        self._event.set()

    def wait(self, timeout: float) -> dict[str, Any] | None:
        """Return the ack payload, or ``None`` if it did not arrive in time."""
        return self._payload if self._event.wait(timeout) else None


class ModeWaiter:
    """Waits for the vehicle's own HEARTBEAT to report an expected mode.

    An accepted ``COMMAND_ACK`` means "the autopilot received and allowed the
    command", not "the aircraft is now in that mode". Only a subsequent
    heartbeat proves the mode actually changed, so every mode change is
    confirmed this way before the API reports success.
    """

    def __init__(self, expected_mode: str) -> None:
        self.expected_mode = expected_mode
        self._event = threading.Event()
        self._observed: str | None = None

    def offer(self, mode: str | None) -> None:
        if mode is not None and mode == self.expected_mode:
            self._observed = mode
            self._event.set()

    def wait(self, timeout: float) -> str | None:
        return self._observed if self._event.wait(timeout) else None


LinkFactory = Callable[[], MavlinkLink]


class LinkManager:
    """Owns the transport, the worker thread, and the telemetry state."""

    def __init__(self, settings: Settings, link_factory: LinkFactory) -> None:
        self._settings = settings
        self._link_factory = link_factory
        self._state = TelemetryState(
            stale_timeout=settings.stale_timeout,
            link_lost_timeout=settings.link_lost_timeout,
            max_statustext=settings.max_statustext,
        )
        self._lock = threading.RLock()
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._transmit: SimpleQueue[_TransmitJob] = SimpleQueue()
        self._ack_waiters: list[AckWaiter] = []
        self._mode_waiters: list[ModeWaiter] = []
        self._waiter_lock = threading.Lock()
        self._link: MavlinkLink | None = None
        self._settled = threading.Event()

    # ------------------------------------------------------------------
    # Public state
    # ------------------------------------------------------------------

    @property
    def state(self) -> TelemetryState:
        return self._state

    @property
    def settings(self) -> Settings:
        return self._settings

    def is_running(self) -> bool:
        with self._lock:
            return self._thread is not None and self._thread.is_alive()

    def snapshot(self) -> dict[str, Any]:
        """Full status payload: telemetry plus transport description."""
        snapshot = self._state.snapshot()
        with self._lock:
            link = self._link
        snapshot["transport"] = link.describe() if link is not None else {
            "transport": self._settings.mode,
            "port": self._settings.port if self._settings.is_real else None,
            "baud": self._settings.baud if self._settings.is_real else None,
        }
        snapshot["mode"] = self._settings.mode
        snapshot["allowSafeCommands"] = self._settings.allow_safe_commands
        snapshot["armSupported"] = False
        snapshot["takeoffSupported"] = False
        return snapshot

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def connect(self, *, settle_timeout: float | None = None) -> dict[str, Any]:
        """Start the worker thread and wait briefly for it to settle.

        Raises:
            LinkBusyError: a link is already running in this process.
        """
        with self._lock:
            if self.is_running():
                raise LinkBusyError(
                    "A MAVLink link is already running in this backend. Disconnect it before "
                    "connecting again."
                )
            self._stop.clear()
            self._settled.clear()
            self._state.clear_error()
            self._state.reset_vehicle_data()
            self._state.set_connection_state(ConnectionState.CONNECTING)
            thread = threading.Thread(target=self._run, name="mavlink-link", daemon=True)
            self._thread = thread
            thread.start()

        timeout = self._settings.connect_timeout if settle_timeout is None else settle_timeout
        self._settled.wait(timeout)
        return self.snapshot()

    def disconnect(self, *, timeout: float = 5.0) -> dict[str, Any]:
        """Stop the worker, close the transport, and clear vehicle telemetry."""
        with self._lock:
            thread = self._thread
        self._stop.set()
        if thread is not None and thread.is_alive():
            thread.join(timeout)
            if thread.is_alive():
                logger.error(
                    "link worker did not stop within %.1fs; closing the transport from the caller",
                    timeout,
                )
                self._close_link()
        with self._lock:
            self._thread = None
        self._state.set_connection_state(ConnectionState.DISCONNECTED)
        self._state.reset_vehicle_data()
        self._fail_pending_jobs(LinkError("The MAVLink link was disconnected."))
        return self.snapshot()

    def shutdown(self) -> None:
        """Deterministic shutdown used by the application lifespan hook."""
        logger.info("shutting down MAVLink link manager")
        try:
            self.disconnect()
        except Exception:  # noqa: BLE001 - shutdown must complete
            logger.exception("error during link manager shutdown")

    # ------------------------------------------------------------------
    # Transmit / waiters
    # ------------------------------------------------------------------

    def submit(self, run: Callable[[MavlinkLink], Any]) -> Future:
        """Queue a transmit job for the worker thread.

        The callable receives the live transport. It must not block: anything
        that waits for a reply belongs in an :class:`AckWaiter`.
        """
        future: Future = Future()
        if not self.is_running():
            future.set_exception(LinkError("The MAVLink link is not connected."))
            return future
        self._transmit.put(_TransmitJob(run=run, future=future))
        return future

    def register_ack_waiter(self, command: int) -> AckWaiter:
        waiter = AckWaiter(command)
        with self._waiter_lock:
            self._ack_waiters.append(waiter)
        return waiter

    def release_ack_waiter(self, waiter: AckWaiter) -> None:
        with self._waiter_lock:
            if waiter in self._ack_waiters:
                self._ack_waiters.remove(waiter)

    def register_mode_waiter(self, expected_mode: str) -> ModeWaiter:
        waiter = ModeWaiter(expected_mode)
        with self._waiter_lock:
            self._mode_waiters.append(waiter)
        return waiter

    def release_mode_waiter(self, waiter: ModeWaiter) -> None:
        with self._waiter_lock:
            if waiter in self._mode_waiters:
                self._mode_waiters.remove(waiter)

    # ------------------------------------------------------------------
    # Worker
    # ------------------------------------------------------------------

    def _run(self) -> None:
        attempt = 0
        try:
            while not self._stop.is_set():
                attempt += 1
                if attempt > 1:
                    self._state.set_connection_state(ConnectionState.RECONNECTING)
                    self._settled.set()
                    logger.info("reconnect attempt %d in %.1fs", attempt, self._settings.reconnect_delay)
                    if self._stop.wait(self._settings.reconnect_delay):
                        break
                    self._state.set_connection_state(ConnectionState.CONNECTING)

                try:
                    self._session()
                except LinkError as error:
                    logger.error("MAVLink link error: %s", error)
                    self._state.set_error(str(error), kind=type(error).__name__)
                    self._state.set_connection_state(ConnectionState.ERROR)
                    self._settled.set()
                    self._fail_pending_jobs(error)
                except Exception as error:  # noqa: BLE001 - never lose the reason
                    logger.exception("unexpected failure in the MAVLink link worker")
                    self._state.set_error(f"Unexpected link failure: {error}", kind="internal")
                    self._state.set_connection_state(ConnectionState.ERROR)
                    self._settled.set()
                    self._fail_pending_jobs(LinkError(str(error)))
                finally:
                    self._close_link()

                if self._stop.is_set() or not self._settings.auto_reconnect:
                    break
        finally:
            self._close_link()
            if self._state.get_connection_state() is not ConnectionState.ERROR:
                self._state.set_connection_state(ConnectionState.DISCONNECTED)
            self._settled.set()
            logger.info("MAVLink link worker stopped")

    def _session(self) -> None:
        """One open-until-failure session on the transport."""
        link = self._link_factory()
        with self._lock:
            self._link = link
        link.open()
        self._state.clear_error()

        next_heartbeat = time.monotonic()
        saw_vehicle_heartbeat = False

        while not self._stop.is_set():
            self._drain_transmit_queue(link)

            now = time.monotonic()
            if now >= next_heartbeat:
                link.send_gcs_heartbeat()
                self._state.note_gcs_heartbeat_sent()
                next_heartbeat = now + self._settings.heartbeat_interval

            budget = min(_RECEIVE_SLICE, max(0.01, next_heartbeat - time.monotonic()))
            for received in link.receive(budget):
                applied = self._apply(received)
                if applied == "HEARTBEAT" and not saw_vehicle_heartbeat:
                    saw_vehicle_heartbeat = True
                    self._state.set_connection_state(ConnectionState.CONNECTED)
                    self._settled.set()
                    logger.info("vehicle heartbeat received; link is live")

            self._state.evaluate_freshness()
            if not saw_vehicle_heartbeat and time.monotonic() - now > self._settings.connect_timeout:
                # Port opened but nothing is talking: wrong baud, radio off,
                # wrong TELEM port, or the aircraft is unpowered.
                raise LinkError(
                    f"No MAVLink heartbeat received within {self._settings.connect_timeout:.0f}s. "
                    f"Check the aircraft is powered, the telemetry radios are paired (solid green), "
                    f"and the baud rate matches SERIAL2_BAUD."
                )

    def _apply(self, received: ReceivedMessage) -> str | None:
        applied = self._state.apply_message(
            received.message,
            system_id=received.system_id,
            component_id=received.component_id,
        )
        if applied == "COMMAND_ACK":
            self._dispatch_ack(received.message)
        elif applied == "HEARTBEAT":
            self._dispatch_mode(received.message)
        return applied

    def _dispatch_ack(self, message: Any) -> None:
        from .normalizers import normalize_command_ack  # local import keeps the hot path flat

        payload = normalize_command_ack(message)
        with self._waiter_lock:
            waiters = [w for w in self._ack_waiters if w.command == payload.get("command")]
        for waiter in waiters:
            waiter.deliver(payload)
        if not waiters and payload.get("accepted") is False:
            # An unsolicited rejection still deserves to be visible; never
            # silently discard a negative acknowledgement.
            logger.warning(
                "unmatched COMMAND_ACK: command=%s result=%s",
                payload.get("command"),
                payload.get("resultName"),
            )
            self._state.set_error(
                f"Vehicle rejected command {payload.get('command')}: {payload.get('resultName')}",
                kind="command_ack",
            )

    def _dispatch_mode(self, message: Any) -> None:
        from .normalizers import normalize_heartbeat

        mode = normalize_heartbeat(message).get("flightMode")
        with self._waiter_lock:
            waiters = list(self._mode_waiters)
        for waiter in waiters:
            waiter.offer(mode)

    def _drain_transmit_queue(self, link: MavlinkLink) -> None:
        while True:
            try:
                job = self._transmit.get_nowait()
            except Empty:
                return
            if job.future.set_running_or_notify_cancel() is False:
                continue
            try:
                job.future.set_result(job.run(link))
            except Exception as error:  # noqa: BLE001 - reported to the caller
                logger.warning("transmit job failed: %s", error)
                job.future.set_exception(error)

    def _fail_pending_jobs(self, error: BaseException) -> None:
        while True:
            try:
                job = self._transmit.get_nowait()
            except Empty:
                return
            if not job.future.done():
                job.future.set_exception(error)

    def _close_link(self) -> None:
        with self._lock:
            link, self._link = self._link, None
        if link is None:
            return
        try:
            link.close()
        except Exception:  # noqa: BLE001 - close must never propagate
            logger.warning("error closing the MAVLink transport (ignored)", exc_info=True)
