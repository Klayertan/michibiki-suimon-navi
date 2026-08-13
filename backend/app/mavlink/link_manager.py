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

Telemetry bootstrap
--------------------
A newly connected MAVLink link -- real or simulated GCS software alike --
only ever gets HEARTBEAT (and, from ArduPilot, TIMESYNC) until something asks
for anything else. Right after the first vehicle HEARTBEAT of every session
(initial connect *and* every reconnect), the worker fires a fire-and-forget
burst of ``MAV_CMD_SET_MESSAGE_INTERVAL`` requests for
:data:`~app.mavlink.constants.ESSENTIAL_TELEMETRY_STREAMS` -- see
:meth:`LinkManager._request_essential_streams`. This is read-only telemetry
configuration, not a flight command: it cannot arm, change mode, or move the
aircraft, and it is never gated behind ``SUISUI_MAVLINK_ALLOW_SAFE_COMMANDS``.
"""

from __future__ import annotations

import contextlib
import logging
import threading
import time
from collections import deque
from concurrent.futures import Future
from dataclasses import dataclass
from queue import Empty, SimpleQueue
from typing import Any, Callable

from ..config import Settings
from . import constants
from .interface import LinkError, MavlinkLink, ReceivedMessage
from .telemetry_state import ConnectionState, TelemetryState

logger = logging.getLogger(__name__)

#: Longest a single receive() call may block. Keeps shutdown responsive.
_RECEIVE_SLICE = 0.2
#: How long connect() waits for the worker to reach a settled state before
#: returning, so the HTTP response reflects reality instead of "connecting".
_CONNECT_SETTLE_POLL = 0.05
#: Re-request only missing manual-control parameters. PARAM_VALUE is not a
#: reliable transport, so a single lost reply must not leave the pilot blocked
#: until the next physical reconnect.
_PARAMETER_RETRY_INTERVAL = 2.0


class LinkBusyError(RuntimeError):
    """A connect was requested while a link was already running."""


@dataclass
class _TransmitJob:
    """A transmit closure to run on the worker thread."""

    run: Callable[[MavlinkLink], Any]
    future: Future
    session_generation: int


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


class ArmStateWaiter:
    """Wait for HEARTBEAT to confirm an expected armed/disarmed state."""

    def __init__(self, expected_armed: bool) -> None:
        self.expected_armed = bool(expected_armed)
        self._event = threading.Event()
        self._observed: bool | None = None

    def offer(self, armed: bool | None) -> None:
        if armed is not None and bool(armed) is self.expected_armed:
            self._observed = bool(armed)
            self._event.set()

    def wait(self, timeout: float) -> bool | None:
        return self._observed if self._event.wait(timeout) else None


class StreamRequestTracker:
    """Best-effort FIFO correlation for ``MAV_CMD_SET_MESSAGE_INTERVAL`` acks.

    ``COMMAND_ACK`` does not echo back the ``COMMAND_LONG`` params it is
    acknowledging -- only the command id (511, the same for all six essential
    requests) and the result. A batch of same-command requests can therefore
    only be matched to their acknowledgements by *send order*, which is a
    reasonable assumption on a single serial link with a single sender, but
    not a guarantee -- hence "best effort", not exact correlation.

    Instance state is touched exclusively from the link worker thread (via
    :meth:`LinkManager._request_essential_streams` and
    :meth:`LinkManager._dispatch_ack`), so this class needs no locking.
    """

    def __init__(self) -> None:
        self._pending: deque[str] = deque()
        self.results: dict[str, str] = {}

    def reset(self) -> None:
        """Start a new correlation batch, discarding any previous results."""
        self._pending.clear()
        self.results = {}

    def record_sent(self, name: str) -> None:
        """Note that ``name`` was transmitted and now awaits an ack."""
        self._pending.append(name)

    def record_transmit_failed(self, name: str) -> None:
        """Note that ``name`` could not be sent at all -- no ack will arrive."""
        self.results[name] = "TRANSMIT_FAILED"

    def offer(self, ack: dict[str, Any]) -> str | None:
        """Correlate one command-511 ack against the oldest pending request.

        Returns the matched stream name, or ``None`` if nothing was pending
        (an unsolicited or already-resolved ack).
        """
        if not self._pending:
            return None
        name = self._pending.popleft()
        self.results[name] = str(ack.get("resultName", "UNKNOWN"))
        return name

    def expire_pending(self) -> None:
        """Give up on every request still awaiting an ack."""
        while self._pending:
            name = self._pending.popleft()
            self.results[name] = "NO_ACK"

    @property
    def all_resolved(self) -> bool:
        """True once every sent-or-failed request has a recorded result."""
        return not self._pending


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
        self._worker_wake = threading.Event()
        self._transmit: SimpleQueue[_TransmitJob] = SimpleQueue()
        self._ack_waiters: list[AckWaiter] = []
        self._mode_waiters: list[ModeWaiter] = []
        self._arm_state_waiters: list[ArmStateWaiter] = []
        self._waiter_lock = threading.Lock()
        self._link: MavlinkLink | None = None
        # A queued transmit is valid only for the session whose target
        # heartbeat admitted it.  Reconnects advance this generation and
        # leave it inactive until the replacement vehicle is identified.
        self._session_generation = 0
        self._active_session_generation: int | None = None
        self._settled = threading.Event()

        # Essential-telemetry-stream bootstrap. Worker-thread-only state (see
        # the class docstring on StreamRequestTracker) -- no lock needed.
        self._essential_stream_tracker = StreamRequestTracker()
        self._essential_stream_deadline: float | None = None
        self._essential_stream_finalized = False
        self._next_parameter_request_at: float | None = None
        self._manual_parameter_discovery_started = False

        # Manual pilot RC control. Attached by the app factory when configured;
        # None means the worker never requests RC configuration or transmits an
        # override.
        self._pilot: Any = None

    def attach_pilot_service(self, pilot: Any) -> None:
        """Give the worker a :class:`~app.mavlink.pilot_service.PilotService`.

        Injected rather than constructed here so the link manager keeps no
        dependency on pilot control, and so the existing tests that build a
        LinkManager directly continue to exercise a link that cannot move an
        aircraft at all.
        """
        self._pilot = pilot
        setter = getattr(pilot, "set_worker_waker", None)
        if callable(setter):
            setter(self.wake_worker)

    def wake_worker(self) -> None:
        """Notify the receive loop that manual-control state changed."""
        self._worker_wake.set()

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
        snapshot["armSupported"] = True
        snapshot["armEnabled"] = bool(
            self._settings.allow_safe_commands
            and getattr(self._settings, "allow_pilot_control", False)
        )
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
            self._worker_wake.clear()
            self._settled.clear()
            self._active_session_generation = None
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

        # Preserve the single-owner transport rule by queuing the release onto
        # the worker before asking that worker to stop. A short burst makes an
        # intentional disconnect itself a first-class manual-control failsafe.
        if self._pilot is not None and thread is not None and thread.is_alive():
            target_component = self._state.target_component(self._settings.target_component)
            future = self.submit(
                lambda link: self._pilot.release_immediately(
                    link,
                    target_system=self._settings.target_system,
                    target_component=target_component,
                    reason="mavlink_disconnected",
                )
            )
            with contextlib.suppress(Exception):
                future.result(timeout=min(1.0, max(0.1, timeout)))
        self._stop.set()
        self._worker_wake.set()
        if thread is not None and thread.is_alive():
            thread.join(timeout)
            if thread.is_alive():
                logger.error(
                    "link worker did not stop within %.1fs; reconnect remains blocked until it exits",
                    timeout,
                )
                self._state.set_error(
                    "The MAVLink worker did not stop before the disconnect deadline.",
                    kind="shutdown_timeout",
                )
                self._state.set_connection_state(ConnectionState.ERROR)
                self._fail_pending_jobs(LinkError("The MAVLink worker is still shutting down."))
                # Keep `_thread` and `_link` owned by that worker.  Clearing
                # either here permits a second worker to race the old one and
                # lets late cleanup close a replacement transport.
                return self.snapshot()
        with self._lock:
            if self._thread is thread and (thread is None or not thread.is_alive()):
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
        with self._lock:
            thread = self._thread
            generation = self._active_session_generation
            connected = self._state.get_connection_state() is ConnectionState.CONNECTED
            if thread is None or not thread.is_alive() or generation is None or not connected:
                future.set_exception(LinkError("The MAVLink link is not connected to an identified vehicle."))
                return future
            self._transmit.put(
                _TransmitJob(run=run, future=future, session_generation=generation)
            )
        self._worker_wake.set()
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

    def register_arm_state_waiter(self, expected_armed: bool) -> ArmStateWaiter:
        waiter = ArmStateWaiter(expected_armed)
        with self._waiter_lock:
            self._arm_state_waiters.append(waiter)
        return waiter

    def release_arm_state_waiter(self, waiter: ArmStateWaiter) -> None:
        with self._waiter_lock:
            if waiter in self._arm_state_waiters:
                self._arm_state_waiters.remove(waiter)

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
                    # Best effort even after a receive failure: the write may
                    # still succeed. Then forget desired movement so a later
                    # reconnect can never resume it.
                    if self._pilot is not None:
                        with contextlib.suppress(Exception):
                            with self._lock:
                                closing_link = self._link
                            if closing_link is not None:
                                self._pilot.release_immediately(
                                    closing_link,
                                    target_system=self._settings.target_system,
                                    target_component=self._state.target_component(
                                        self._settings.target_component
                                    ),
                                    reason="mavlink_disconnected",
                                )
                            self._pilot.on_link_lost()
                    with self._lock:
                        self._active_session_generation = None
                        closing_link = self._link
                    self._close_link(expected_link=closing_link)

                if self._stop.is_set() or not self._settings.auto_reconnect:
                    break
        finally:
            with self._lock:
                self._active_session_generation = None
                closing_link = self._link
            self._close_link(expected_link=closing_link)
            if self._state.get_connection_state() is not ConnectionState.ERROR:
                self._state.set_connection_state(ConnectionState.DISCONNECTED)
            self._settled.set()
            logger.info("MAVLink link worker stopped")

    def _session(self) -> None:
        """One open-until-failure session on the transport."""
        link = self._link_factory()
        with self._lock:
            self._session_generation += 1
            session_generation = self._session_generation
            self._active_session_generation = None
            self._link = link
        link.open()
        # Every opened transport is a new vehicle/session boundary, including
        # automatic reconnect. Never let prior RC calibration/source IDs,
        # observed component, armed state, or freshness timestamps suppress
        # discovery or authorize output on the replacement link.
        self._state.reset_vehicle_data()
        self._state.clear_error()
        # Fresh per session (initial connect *and* every reconnect), so a
        # result recorded before a drop can never leak into the next attempt.
        self._essential_stream_tracker.reset()
        self._essential_stream_deadline = None
        self._essential_stream_finalized = False
        self._next_parameter_request_at = None
        self._manual_parameter_discovery_started = False

        next_heartbeat = time.monotonic()
        session_started = next_heartbeat
        saw_vehicle_heartbeat = False

        while not self._stop.is_set():
            self._drain_transmit_queue(link)

            now = time.monotonic()
            if now >= next_heartbeat:
                link.send_gcs_heartbeat()
                self._state.note_gcs_heartbeat_sent()
                next_heartbeat = now + self._settings.heartbeat_interval

            budget = min(_RECEIVE_SLICE, max(0.01, next_heartbeat - time.monotonic()))
            if self._pilot is not None:
                next_tick_delay = self._pilot.next_tick_delay()
                if next_tick_delay is not None:
                    # Do not let a quiet telemetry link reduce the advertised
                    # 15 Hz RC refresh to the generic 5 Hz receive slice.
                    budget = min(budget, max(0.001, next_tick_delay))
            if self._worker_wake.is_set():
                budget = min(budget, 0.001)
            for received in link.receive(budget):
                applied = self._apply(received)
                if applied == "HEARTBEAT" and not saw_vehicle_heartbeat:
                    saw_vehicle_heartbeat = True
                    with self._lock:
                        # Only now may queued commands for this generation
                        # execute; before this point the vehicle identity and
                        # armed/mode state are unknown.
                        self._active_session_generation = session_generation
                    self._state.set_connection_state(ConnectionState.CONNECTED)
                    self._settled.set()
                    logger.info("vehicle heartbeat received; link is live")
                    # Ask for telemetry now: a real ArduPilot (and most other
                    # autopilots) sends nothing beyond HEARTBEAT/TIMESYNC to a
                    # link that has not requested anything else. This must not
                    # block: it queues a handful of non-blocking serial writes
                    # and returns, so the heartbeat cadence and the receive
                    # loop below are unaffected.
                    self._request_essential_streams(link)
                    self._request_manual_control_parameters(link)

            self._maybe_finalize_essential_streams()
            self._maybe_request_manual_control_parameters(link)
            self._state.evaluate_freshness()

            # Manual RC overrides. Runs on the same thread that owns the
            # transport, after freshness has been re-evaluated so the service
            # gates on the current link state rather than a stale one. It is
            # rate-limited internally and returns immediately when there is
            # nothing to send.
            # Clear before processing the pilot (or beginning the next loop
            # when pilot is absent): a concurrent update during/after this
            # point leaves the event set instead of being lost.
            self._worker_wake.clear()
            if self._pilot is not None:
                try:
                    self._pilot.tick(
                        link,
                        target_system=self._settings.target_system,
                        target_component=self._state.target_component(self._settings.target_component),
                    )
                except Exception:  # noqa: BLE001 - never let control kill the link
                    logger.exception("manual pilot tick failed; continuing with output inactive")
                    # A programming/normalization error is just as capable of
                    # leaving the previous RC frame owned as a serial error.
                    # Latch the pilot failsafe and use this worker-owned link
                    # for an immediate best-effort zero-release burst.
                    with contextlib.suppress(Exception):
                        self._pilot.command_failsafe("transmit_failed")
                    with contextlib.suppress(Exception):
                        self._pilot.release_immediately(
                            link,
                            target_system=self._settings.target_system,
                            target_component=self._state.target_component(
                                self._settings.target_component
                            ),
                            reason="transmit_failed",
                        )
            if (
                not saw_vehicle_heartbeat
                and time.monotonic() - session_started > self._settings.connect_timeout
            ):
                # Port opened but nothing is talking: wrong baud, radio off,
                # wrong TELEM port, or the aircraft is unpowered.
                raise LinkError(
                    f"No MAVLink heartbeat received within {self._settings.connect_timeout:.0f}s. "
                    f"Check the aircraft is powered, the telemetry radios are paired (solid green), "
                    f"and the baud rate matches SERIAL2_BAUD."
                )

    def _apply(self, received: ReceivedMessage) -> str | None:
        try:
            msg_type = received.message.get_type()
        except Exception:  # noqa: BLE001 - TelemetryState handles malformed frames identically
            return None
        if not self._is_target_source(received, msg_type):
            logger.debug(
                "ignoring %s from non-target MAVLink source %s/%s",
                msg_type,
                received.system_id,
                received.component_id,
            )
            return None

        applied = self._state.apply_message(
            received.message,
            system_id=received.system_id,
            component_id=received.component_id,
        )
        if applied == "COMMAND_ACK":
            self._dispatch_ack(received.message)
        elif applied == "HEARTBEAT":
            self._dispatch_heartbeat(received.message)
        return applied

    def _is_target_source(self, received: ReceivedMessage, msg_type: str) -> bool:
        """Whether a frame may affect the configured vehicle or its waiters.

        Source metadata comes from the MAVLink frame header, not payload
        target fields.  The first valid autopilot HEARTBEAT from the configured
        system is the one deliberate component exception: it discovers the
        actual flight-controller component (including component 0).  Once
        discovered, every message must come from that exact system/component.
        """
        if received.system_id != self._settings.target_system:
            return False
        if received.component_id is None:
            return False

        observed_component = self._state.observed_component()
        if msg_type == "HEARTBEAT" and observed_component is None:
            from .normalizers import normalize_heartbeat

            autopilot = normalize_heartbeat(received.message).get("autopilot")
            return autopilot not in (None, constants.MAV_AUTOPILOT_INVALID)

        target_component = (
            observed_component
            if observed_component is not None
            else self._settings.target_component
        )
        return received.component_id == target_component

    def _dispatch_ack(self, message: Any) -> None:
        from .normalizers import normalize_command_ack  # local import keeps the hot path flat

        payload = normalize_command_ack(message)
        command = payload.get("command")

        with self._waiter_lock:
            waiters = [w for w in self._ack_waiters if w.command == command]
        for waiter in waiters:
            waiter.deliver(payload)
        if waiters:
            # An explicit, CommandService-driven request (mode change, version
            # request, or a browser-triggered /api/drone/request-streams call)
            # owns this ack -- including one for command 511, which takes
            # priority over the essential-stream tracker below so the two
            # mechanisms cannot steal each other's acknowledgements.
            return

        if command == constants.MAV_CMD_SET_MESSAGE_INTERVAL:
            # Our own automatic essential-stream requests correlate here,
            # best-effort, by send order -- see StreamRequestTracker. A single
            # unsupported *optional* stream is expected on some firmware and
            # must never be treated as a connection-level error; only "every
            # essential stream request failed" is, via
            # _finalize_essential_stream_results.
            matched = self._essential_stream_tracker.offer(payload)
            if matched is not None:
                self._log_essential_stream_result(matched, payload)
            else:
                logger.debug(
                    "unmatched SET_MESSAGE_INTERVAL ack (result=%s); nothing was pending",
                    payload.get("resultName"),
                )
            return

        if payload.get("accepted") is False:
            # An unsolicited rejection of anything else still deserves to be
            # visible; never silently discard a negative acknowledgement.
            logger.warning(
                "unmatched COMMAND_ACK: command=%s result=%s",
                command,
                payload.get("resultName"),
            )
            self._state.set_error(
                f"Vehicle rejected command {command}: {payload.get('resultName')}",
                kind="command_ack",
            )

    def _dispatch_heartbeat(self, message: Any) -> None:
        from .normalizers import normalize_heartbeat

        heartbeat = normalize_heartbeat(message)
        mode = heartbeat.get("flightMode")
        armed = heartbeat.get("armed")
        if self._pilot is not None:
            observer = getattr(self._pilot, "observe_armed_state", None)
            if callable(observer):
                observer(armed)
        with self._waiter_lock:
            mode_waiters = list(self._mode_waiters)
            arm_waiters = list(self._arm_state_waiters)
        for waiter in mode_waiters:
            waiter.offer(mode)
        for waiter in arm_waiters:
            waiter.offer(armed)

    # ------------------------------------------------------------------
    # Read-only manual-control parameter discovery
    # ------------------------------------------------------------------

    def _request_manual_control_parameters(self, link: MavlinkLink) -> None:
        """Request missing RC mapping/calibration/timeout values, never write."""
        if self._pilot is None:
            self._next_parameter_request_at = None
            return
        # Ask for optional MAV source-id diagnostics once. Retry only the
        # values required to operate: older firmware may not expose every
        # optional diagnostic, and that should not create permanent polling.
        if self._manual_parameter_discovery_started:
            requested_names = list(constants.REQUIRED_MANUAL_CONTROL_PARAMETERS)
            source_values = self._state.get_parameters(constants.RC_OVERRIDE_SOURCE_PARAMETERS)
            if not any(
                name in source_values for name in ("SYSID_MYGCS", "MAV_GCS_SYSID")
            ):
                requested_names.extend(constants.RC_OVERRIDE_SOURCE_PARAMETERS)
            requested_names = tuple(dict.fromkeys(requested_names))
        else:
            requested_names = constants.MANUAL_CONTROL_PARAMETERS
        present = self._state.get_parameters(requested_names)
        missing = [name for name in requested_names if name not in present]
        if not missing:
            self._next_parameter_request_at = None
            self._manual_parameter_discovery_started = True
            return

        target_system = self._settings.target_system
        target_component = self._state.target_component(self._settings.target_component)
        for name in missing:
            try:
                link.send_parameter_request(
                    target_system=target_system,
                    target_component=target_component,
                    name=name,
                )
            except LinkError as error:
                logger.warning("could not request vehicle parameter %s: %s", name, error)
            else:
                logger.debug("requested read-only vehicle parameter %s", name)
        self._manual_parameter_discovery_started = True
        self._next_parameter_request_at = time.monotonic() + _PARAMETER_RETRY_INTERVAL

    def _maybe_request_manual_control_parameters(self, link: MavlinkLink) -> None:
        deadline = self._next_parameter_request_at
        if deadline is not None and time.monotonic() >= deadline:
            self._request_manual_control_parameters(link)

    # ------------------------------------------------------------------
    # Essential telemetry stream bootstrap
    # ------------------------------------------------------------------

    def _request_essential_streams(self, link: MavlinkLink) -> None:
        """Ask the vehicle to start streaming the telemetry the UI needs.

        Read-only telemetry configuration, not a flight command: every entry
        in :data:`~app.mavlink.constants.ESSENTIAL_TELEMETRY_STREAMS` only
        asks the autopilot to *send* a message type at a given rate. It
        cannot arm, change mode, or move the aircraft, and unlike the safe
        commands in :mod:`app.mavlink.command_service`, it is sent
        unconditionally -- never gated by
        ``SUISUI_MAVLINK_ALLOW_SAFE_COMMANDS`` -- because without it a
        freshly booted (or freshly connected-to) vehicle never sends battery,
        GPS, attitude, or VFR_HUD data at all.

        Fire-and-forget: this sends a handful of ``COMMAND_LONG`` frames back
        to back without waiting for any of their acks, so it cannot stall the
        GCS heartbeat or the receive loop even if the vehicle is slow, or
        never responds, to one of them. Acknowledgements are correlated
        best-effort as they arrive later, in :meth:`_dispatch_ack`.
        """
        self._essential_stream_tracker.reset()
        self._essential_stream_deadline = time.monotonic() + self._settings.command_timeout
        self._essential_stream_finalized = False

        target_system = self._settings.target_system
        # Preserves the existing component-0 handling: prefers whatever
        # component the vehicle's own HEARTBEAT reported, falling back to the
        # configured value only if no heartbeat has supplied one yet.
        target_component = self._state.target_component(self._settings.target_component)

        for name, message_id, interval_us in constants.ESSENTIAL_TELEMETRY_STREAMS:
            try:
                link.send_command_long(
                    target_system=target_system,
                    target_component=target_component,
                    command=constants.MAV_CMD_SET_MESSAGE_INTERVAL,
                    params=(float(message_id), float(interval_us), 0.0, 0.0, 0.0, 0.0, 0.0),
                )
            except LinkError as error:
                # One bad write must not abort the rest of the batch, and must
                # not tear down an otherwise-live session -- if the serial
                # port is genuinely dead, the very next link.receive() call in
                # the main loop will raise the same error and drive the
                # existing reconnect path; duplicating that here would only
                # risk masking it.
                logger.warning("could not request %s telemetry stream: %s", name, error)
                self._essential_stream_tracker.record_transmit_failed(name)
            else:
                self._essential_stream_tracker.record_sent(name)
                logger.info(
                    "requested telemetry stream %s (msg id %d, %.0f us, target %d/%d)",
                    name,
                    message_id,
                    interval_us,
                    target_system,
                    target_component,
                )

    def _log_essential_stream_result(self, name: str, ack: dict[str, Any]) -> None:
        if ack.get("accepted"):
            logger.info("telemetry stream %s accepted by the vehicle", name)
        else:
            logger.warning(
                "telemetry stream %s not accepted by the vehicle: %s",
                name,
                ack.get("resultName"),
            )
        if self._essential_stream_tracker.all_resolved:
            self._finalize_essential_stream_results()

    def _maybe_finalize_essential_streams(self) -> None:
        """Give up waiting on any essential-stream ack that never arrives.

        Some ArduPilot builds do not acknowledge ``SET_MESSAGE_INTERVAL`` at
        all; without this, a request that is silently ignored would leave its
        tracker entry pending forever and the "did every essential stream
        fail" check in :meth:`_finalize_essential_stream_results` would never
        run.
        """
        deadline = self._essential_stream_deadline
        if deadline is None or self._essential_stream_finalized:
            return
        if time.monotonic() < deadline:
            return
        self._essential_stream_tracker.expire_pending()
        self._finalize_essential_stream_results()

    def _finalize_essential_stream_results(self) -> None:
        """Surface a backend error only if every essential stream failed.

        Idempotent and safe to call from both the ack-driven path (as soon as
        the last outstanding ack arrives) and the deadline-driven path (once
        :attr:`_essential_stream_deadline` passes) -- whichever happens
        first wins, and the other becomes a no-op.
        """
        if self._essential_stream_finalized:
            return
        self._essential_stream_finalized = True
        self._essential_stream_deadline = None

        results = self._essential_stream_tracker.results
        if not results:
            return
        failed = {name: result for name, result in results.items() if result != "ACCEPTED"}
        if not failed:
            return
        if len(failed) == len(results):
            # Every single essential stream was rejected, unsupported, or
            # never acknowledged: the operator needs to know telemetry will
            # not arrive, since nothing else will tell them why the UI stays
            # empty. One or a few failures among the six is not escalated --
            # that is normal (e.g. BATTERY_STATUS is not implemented on every
            # ArduPilot build) and is fully covered by the warning log above.
            logger.error("all essential telemetry stream requests failed: %s", results)
            self._state.set_error(
                "The vehicle did not accept any telemetry stream request "
                f"({', '.join(sorted(results))}). Battery, GPS, attitude and VFR_HUD "
                "readings may stay unavailable until the link is reconnected.",
                kind="stream_request",
            )
        else:
            logger.warning("some optional telemetry streams were not accepted: %s", failed)

    def _drain_transmit_queue(self, link: MavlinkLink) -> None:
        while True:
            try:
                job = self._transmit.get_nowait()
            except Empty:
                return
            if job.future.set_running_or_notify_cancel() is False:
                continue
            with self._lock:
                current_generation = self._active_session_generation
            if current_generation != job.session_generation:
                job.future.set_exception(LinkError("The MAVLink session changed before transmission."))
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

    def _close_link(self, expected_link: MavlinkLink | None = None) -> None:
        with self._lock:
            if expected_link is not None and self._link is not expected_link:
                return
            link, self._link = self._link, None
        if link is None:
            return
        try:
            link.close()
        except Exception:  # noqa: BLE001 - close must never propagate
            logger.warning("error closing the MAVLink transport (ignored)", exc_info=True)
