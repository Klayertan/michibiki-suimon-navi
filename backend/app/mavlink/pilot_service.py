"""Pilot velocity control: the only place movement commands are produced.

Architecture (deliberately one-directional)::

    keyboard / gamepad provider   (js/gamepad/*, transport-free)
        -> normalized pilot axes  (-1 .. +1)
        -> js/pilot/*             (browser transport, no MAVLink knowledge)
        -> PilotService           (this module: safety gates + unit conversion)
        -> MavlinkLink.send_velocity_setpoint
        -> SET_POSITION_TARGET_LOCAL_NED, body frame, velocity + yaw rate

The browser never names a MAVLink message, a frame, a type mask, or a speed.
It sends four numbers between -1 and +1 and a monotonically increasing
sequence number; everything that decides *whether* and *how fast* the aircraft
moves happens here, server-side, where a hostile or wedged browser cannot
reach it.

Fail-closed
-----------
Every path that is not "all gates pass, and fresh input said move" produces a
zero-velocity setpoint. There is no path that produces motion by default, and
none that stops transmitting while the aircraft might still be moving --
stopping the stream entirely would leave ArduPilot holding its last target
until *its* failsafe noticed, so this service transmits explicit zeros
instead.

Not implemented here, on purpose: arming, disarming, takeoff, landing, RTL,
mode changes, motor tests, servo output. Commanding a velocity to an aircraft
the operator has not armed does nothing at all, which is the intended
behaviour.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from ..config import Settings
from . import pilot_limits
from .interface import LinkError, MavlinkLink
from .pilot_limits import (
    NEUTRAL_HOLD_SECONDS,
    NEUTRAL_SETPOINT,
    PILOT_INPUT_TIMEOUT,
    REQUIRED_PILOT_MODE,
    SETPOINT_INTERVAL,
    PilotLimits,
    VelocitySetpoint,
    normalized_to_velocity,
)
from .telemetry_state import ConnectionState, TelemetryState

logger = logging.getLogger(__name__)


#: Machine-readable reasons the service is not commanding movement. Surfaced
#: to the UI so the operator can see *why* nothing is happening rather than
#: guessing.
class BlockReason:
    DISABLED = "pilot_control_disabled"
    NOT_ENABLED = "not_enabled"
    NOT_CONNECTED = "not_connected"
    TELEMETRY_STALE = "telemetry_stale"
    NO_INPUT = "no_input"
    INPUT_TIMEOUT = "input_timeout"
    WRONG_MODE = "wrong_mode"
    DISARMED = "disarmed"
    ARM_STATE_UNKNOWN = "arm_state_unknown"
    NEUTRAL_COMMANDED = "neutral_commanded"
    TRANSMIT_FAILED = "transmit_failed"


@dataclass
class PilotInput:
    """One normalized command from the browser, with arrival time."""

    forward: float = 0.0
    right: float = 0.0
    up: float = 0.0
    yaw: float = 0.0
    #: ``time.monotonic()`` when this was accepted. Monotonic so an NTP step
    #: or a DST change cannot make a stale command look fresh.
    received_at: float = field(default_factory=time.monotonic)
    #: Set by the Space key / neutral endpoint. Forces zero regardless of the
    #: axis values that came with it.
    neutral: bool = False
    sequence: int = 0

    @property
    def is_zero(self) -> bool:
        return self.forward == 0.0 and self.right == 0.0 and self.up == 0.0 and self.yaw == 0.0


class PilotService:
    """Holds the latest desired pilot state and turns it into setpoints.

    Thread model: :meth:`submit` and :meth:`snapshot` are called from the
    FastAPI event loop; :meth:`tick` is called only from the MAVLink worker
    thread. A single lock guards the shared state, and ``tick`` never blocks
    on anything but that lock.
    """

    def __init__(
        self,
        settings: Settings,
        state: TelemetryState,
        *,
        limits: PilotLimits | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._settings = settings
        self._state = state
        self._limits = limits or pilot_limits.DEFAULT_PILOT_LIMITS
        self._clock = clock

        self._lock = threading.Lock()
        self._enabled = False
        self._input: PilotInput | None = None
        self._sequence = 0

        # Diagnostics / UI
        self._last_setpoint: VelocitySetpoint = NEUTRAL_SETPOINT
        self._last_reason: str | None = BlockReason.NOT_ENABLED
        self._last_sent_at: float | None = None
        self._setpoints_sent = 0
        self._neutral_until: float = 0.0
        self._next_send: float = 0.0
        self._last_error: str | None = None

    # ------------------------------------------------------------------
    # Configuration
    # ------------------------------------------------------------------

    @property
    def limits(self) -> PilotLimits:
        return self._limits

    @property
    def available(self) -> bool:
        """Whether pilot control is permitted by configuration at all.

        Off unless the backend was started with
        ``SUISUI_MAVLINK_ALLOW_PILOT_CONTROL=1``. A default install cannot
        command movement no matter what the browser sends.
        """
        return bool(getattr(self._settings, "allow_pilot_control", False))

    # ------------------------------------------------------------------
    # Input from the browser
    # ------------------------------------------------------------------

    def enable(self) -> dict[str, Any]:
        """Arm the *control channel* (never the aircraft).

        Enabling only permits setpoints to be produced; every other gate still
        applies, and the vehicle will not move unless the operator has armed
        it themselves and put it in GUIDED.
        """
        if not self.available:
            return self.snapshot()
        with self._lock:
            self._enabled = True
            # Never inherit a stale command across an enable: start neutral.
            self._input = None
            self._neutral_until = self._clock() + NEUTRAL_HOLD_SECONDS
        logger.info("pilot control channel enabled (aircraft not armed by this action)")
        return self.snapshot()

    def disable(self) -> dict[str, Any]:
        """Stop producing motion and hold neutral briefly on the way out."""
        with self._lock:
            self._enabled = False
            self._input = None
            self._neutral_until = self._clock() + NEUTRAL_HOLD_SECONDS
        logger.info("pilot control channel disabled; commanding neutral")
        return self.snapshot()

    def submit(self, *, forward: float, right: float, up: float, yaw: float, neutral: bool = False) -> dict[str, Any]:
        """Accept one normalized command. Returns the resulting state."""
        with self._lock:
            self._sequence += 1
            self._input = PilotInput(
                forward=forward,
                right=right,
                up=up,
                yaw=yaw,
                received_at=self._clock(),
                neutral=bool(neutral),
                sequence=self._sequence,
            )
            if neutral:
                self._neutral_until = self._clock() + NEUTRAL_HOLD_SECONDS
        return self.snapshot()

    def command_neutral(self) -> dict[str, Any]:
        """Explicit stop (Space, blur, tab hidden, page unload).

        Deliberately *not* a disable: the operator keeps the control channel
        and can fly again immediately by pressing a key. It is a movement
        command, not a kill switch, and is described that way in the UI.
        """
        with self._lock:
            self._sequence += 1
            self._input = PilotInput(received_at=self._clock(), neutral=True, sequence=self._sequence)
            self._neutral_until = self._clock() + NEUTRAL_HOLD_SECONDS
        return self.snapshot()

    # ------------------------------------------------------------------
    # Gates
    # ------------------------------------------------------------------

    def _evaluate(self, now: float) -> tuple[VelocitySetpoint, str | None]:
        """Decide the setpoint for this instant. Caller holds the lock.

        Returns the setpoint and, when it is neutral, the reason why. Order
        matters only for the quality of the reported reason -- every failing
        gate yields the same zero velocity.
        """
        if not self.available:
            return NEUTRAL_SETPOINT, BlockReason.DISABLED
        if not self._enabled:
            return NEUTRAL_SETPOINT, BlockReason.NOT_ENABLED

        link_state = self._state.get_connection_state()
        if link_state is not ConnectionState.CONNECTED:
            # Covers disconnected, connecting, reconnecting, link_lost and
            # error. If the link is not solidly up we are commanding blind.
            return NEUTRAL_SETPOINT, (
                BlockReason.TELEMETRY_STALE
                if link_state is ConnectionState.TELEMETRY_STALE
                else BlockReason.NOT_CONNECTED
            )

        # ArduPilot only honours velocity setpoints in GUIDED. Sending them in
        # any other mode is silently ignored by the vehicle, which would leave
        # the operator pressing keys with no effect and no explanation.
        mode = self._state.current_mode()
        if mode != REQUIRED_PILOT_MODE:
            return NEUTRAL_SETPOINT, BlockReason.WRONG_MODE

        armed = self._state.is_armed()
        if armed is None:
            return NEUTRAL_SETPOINT, BlockReason.ARM_STATE_UNKNOWN
        if not armed:
            # Not an error: this is the normal state on the bench. Commanding
            # a velocity to a disarmed aircraft does nothing, but reporting it
            # honestly tells the operator why the propellers are not turning.
            return NEUTRAL_SETPOINT, BlockReason.DISARMED

        command = self._input
        if command is None:
            return NEUTRAL_SETPOINT, BlockReason.NO_INPUT
        if now - command.received_at > PILOT_INPUT_TIMEOUT:
            # The browser stopped refreshing: wedged tab, closed lid, dead
            # Wi-Fi. Never keep flying on a stale command.
            return NEUTRAL_SETPOINT, BlockReason.INPUT_TIMEOUT
        if command.neutral:
            return NEUTRAL_SETPOINT, BlockReason.NEUTRAL_COMMANDED

        setpoint = normalized_to_velocity(
            forward=command.forward,
            right=command.right,
            up=command.up,
            yaw=command.yaw,
            limits=self._limits,
        )
        return setpoint, (None if not setpoint.is_neutral else BlockReason.NO_INPUT)

    # ------------------------------------------------------------------
    # Transmission, driven by the MAVLink worker thread
    # ------------------------------------------------------------------

    def tick(self, link: MavlinkLink, *, target_system: int, target_component: int) -> bool:
        """Send at most one setpoint. Called every worker-loop iteration.

        Returns whether anything was transmitted.

        Rate-limited to :data:`SETPOINT_INTERVAL`. While neutral and outside
        the neutral-hold window nothing is transmitted at all, so a backend
        sitting idle on the bench puts no traffic on a 57600-baud link.
        """
        if not self.available:
            return False

        now = self._clock()
        with self._lock:
            if now < self._next_send:
                return False

            setpoint, reason = self._evaluate(now)
            self._last_setpoint = setpoint
            self._last_reason = reason

            if setpoint.is_neutral and now >= self._neutral_until:
                # Nothing to say, and the "make sure it heard the stop"
                # window has expired. Staying quiet is correct: ArduPilot
                # applies its own GUIDED timeout, and an armed aircraft in
                # GUIDED with no target holds position.
                self._next_send = now + SETPOINT_INTERVAL
                return False

            self._next_send = now + SETPOINT_INTERVAL

        try:
            link.send_velocity_setpoint(
                target_system=target_system,
                target_component=target_component,
                vx=setpoint.vx,
                vy=setpoint.vy,
                vz=setpoint.vz,
                yaw_rate=setpoint.yaw_rate,
            )
        except LinkError as error:
            # A dead serial port must not raise into the worker loop, but it
            # must also never be hidden: the receive path will surface the
            # same failure and drive the reconnect.
            with self._lock:
                self._last_error = str(error)
                self._last_reason = BlockReason.TRANSMIT_FAILED
            logger.warning("could not transmit pilot setpoint: %s", error)
            return False

        with self._lock:
            self._last_sent_at = now
            self._setpoints_sent += 1
        return True

    def on_link_lost(self) -> None:
        """Called when a session ends. Drops any pending desired movement.

        Without this, reconnecting could resume a command the operator issued
        before the radio dropped.
        """
        with self._lock:
            self._input = None
            self._last_setpoint = NEUTRAL_SETPOINT
            self._last_reason = BlockReason.NOT_CONNECTED
            self._neutral_until = 0.0
            self._next_send = 0.0

    # ------------------------------------------------------------------
    # Reporting
    # ------------------------------------------------------------------

    def snapshot(self) -> dict[str, Any]:
        """Pilot state for the status payload and the UI."""
        now = self._clock()
        with self._lock:
            command = self._input
            age = None if command is None else max(0.0, now - command.received_at)
            # When the feature is off, `tick` returns before `_evaluate` ever
            # runs, so `_last_reason` would still hold its initial value.
            # Report the real reason rather than a stale one.
            reason = BlockReason.DISABLED if not self.available else self._last_reason
            return {
                "available": self.available,
                "enabled": self._enabled,
                # True only when a non-zero setpoint is actually going out.
                "outputActive": reason is None and not self._last_setpoint.is_neutral,
                "blockedReason": reason,
                "requiredMode": REQUIRED_PILOT_MODE,
                "limits": self._limits.to_dict(),
                "setpoint": self._last_setpoint.to_dict(),
                "axes": {
                    "forward": command.forward if command else 0.0,
                    "right": command.right if command else 0.0,
                    "up": command.up if command else 0.0,
                    "yaw": command.yaw if command else 0.0,
                },
                "inputAgeSeconds": age,
                "inputTimeoutSeconds": PILOT_INPUT_TIMEOUT,
                "setpointRateHz": pilot_limits.SETPOINT_RATE_HZ,
                "setpointsSent": self._setpoints_sent,
                "lastSentAt": self._last_sent_at,
                "sequence": self._sequence,
                "error": self._last_error,
                # Stated explicitly so no UI has to infer it.
                "armSupported": False,
                "takeoffSupported": False,
            }
