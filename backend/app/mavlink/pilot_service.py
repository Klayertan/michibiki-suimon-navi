"""Fail-closed manual pilot control over ``RC_CHANNELS_OVERRIDE``.

Keyboard and gamepad providers send the same semantic axes to this service.
The service owns every safety gate and the vehicle-calibrated RC mapping.  The
older GUIDED velocity sender remains available on :class:`MavlinkLink`, but it
is deliberately not part of this manual-control path.

Channels 1-8 are released with zero immediately when a gate closes, then at
the normal transmit cadence for a short hold window.  Unowned channels in an
active override are ``UINT16_MAX`` (ignore).  This distinction follows the
MAVLink message definition and prevents auxiliary channels being overwritten.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from ..config import Settings
from . import constants, pilot_limits
from .interface import MavlinkLink
from .pilot_limits import (
    MANUAL_OVERRIDE_INTERVAL,
    MANUAL_RELEASE_HOLD_SECONDS,
    PILOT_INPUT_TIMEOUT,
    RELEASE_RC_OVERRIDE,
    RcConfigurationError,
    RcDeflectionLimits,
    RcInputConfiguration,
    RcOverride,
    normalized_to_rc_override,
    rc_configuration_from_parameters,
)
from .telemetry_state import ConnectionState, TelemetryState

logger = logging.getLogger(__name__)


class BlockReason:
    """Stable reasons surfaced to the manual-control UI."""

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
    DEADMAN_RELEASED = "deadman_released"
    TRANSMIT_FAILED = "transmit_failed"
    RC_CONFIGURATION_MISSING = "rc_configuration_missing"
    RC_CONFIGURATION_INVALID = "rc_configuration_invalid"
    STALE_SEQUENCE = "stale_sequence"
    WEBSOCKET_DISCONNECTED = "websocket_disconnected"
    PROVIDER_DISCONNECTED = "provider_disconnected"
    ARMING_INPUT_BARRIER = "arming_input_barrier"
    MOCK_PROVIDER_FORBIDDEN = "mock_provider_forbidden"


class PilotSequenceRejected(ValueError):
    """A delayed/replayed input tried to supersede newer client state."""

    reason = BlockReason.STALE_SEQUENCE

    def __init__(self, sequence: int, last_sequence: int) -> None:
        super().__init__(
            f"Pilot input sequence {sequence} is not newer than the last accepted sequence "
            f"{last_sequence}."
        )
        self.sequence = sequence
        self.last_sequence = last_sequence


class PilotProviderRejected(ValueError):
    """A simulator-only provider attempted active output in real mode."""

    reason = BlockReason.MOCK_PROVIDER_FORBIDDEN

    def __init__(self, provider: str, sequence: int) -> None:
        super().__init__(
            f"Pilot provider {provider!r} cannot command an active real-vehicle override."
        )
        self.provider = provider
        self.sequence = sequence


@dataclass(frozen=True)
class PilotInput:
    """One canonical normalized command and its server arrival time."""

    pitch: float = 0.0
    roll: float = 0.0
    throttle: float = 0.0
    yaw: float = 0.0
    deadman: bool = False
    neutral: bool = False
    source: str = "keyboard"
    provider: str = "keyboard"
    sequence: int = 0
    received_at: float = field(default_factory=time.monotonic)

    @property
    def is_zero(self) -> bool:
        return (
            self.pitch == 0.0
            and self.roll == 0.0
            and self.throttle == 0.0
            and self.yaw == 0.0
        )

    # Read-only compatibility names for older backend callers/tests.  New JSON
    # and snapshots use pitch/roll/throttle/yaw only.
    @property
    def forward(self) -> float:
        return self.pitch

    @property
    def right(self) -> float:
        return self.roll

    @property
    def up(self) -> float:
        return self.throttle


class PilotService:
    """Map fresh, dead-man-held semantic input into calibrated RC overrides.

    REST handlers call configuration/input methods from the event-loop thread;
    the MAVLink worker alone calls :meth:`tick`.  A lock protects their small
    shared state.  No method except ``tick`` and ``release_immediately``
    touches the transport.
    """

    _FAILSAFE_REASONS = frozenset(
        {
            BlockReason.NOT_CONNECTED,
            BlockReason.TELEMETRY_STALE,
            BlockReason.INPUT_TIMEOUT,
            BlockReason.DEADMAN_RELEASED,
            BlockReason.TRANSMIT_FAILED,
            BlockReason.WEBSOCKET_DISCONNECTED,
            BlockReason.PROVIDER_DISCONNECTED,
        }
    )

    def __init__(
        self,
        settings: Settings,
        state: TelemetryState,
        *,
        limits: RcDeflectionLimits | None = None,
        clock: Callable[[], float] = time.monotonic,
        wake_worker: Callable[[], None] | None = None,
    ) -> None:
        self._settings = settings
        self._state = state
        self._limits = limits or pilot_limits.DEFAULT_RC_LIMITS
        self._clock = clock

        self._lock = threading.RLock()
        # Serializes an in-flight transport call with safety requests.  A
        # neutral/dead-man request first invalidates the generation, then
        # waits on this barrier before returning.  Therefore an active frame
        # can never finish transmission *after* that safety request returns.
        self._transport_barrier = threading.Lock()
        self._wake_worker = wake_worker
        self._generation = 0
        self._enabled = False
        self._bench_mode = False
        self._props_ack = False
        self._input: PilotInput | None = None

        # Never lower this high-water mark on enable/disable.  Keeping it
        # across control-channel cycles makes a delayed request from the
        # previous cycle unable to reactivate an override after a panic stop.
        self._last_client_sequence = -1
        self._last_rejected_sequence: int | None = None

        self._last_override = RELEASE_RC_OVERRIDE
        self._last_reason: str | None = BlockReason.NOT_ENABLED
        self._last_release_reason: str | None = None
        self._last_sent_at: float | None = None
        self._messages_sent = 0
        self._release_messages_sent = 0
        self._release_until = 0.0
        self._next_send = 0.0
        self._last_error: str | None = None
        # Browser/provider and transmit failures are latched until the client
        # explicitly establishes a safe neutral barrier (or re-enables the
        # channel).  A movement request alone must not clear a disconnect
        # failsafe and immediately recreate an override.
        self._forced_block_reason: str | None = None
        self._transmitting = False
        self._output_active = False
        self._override_owned = False
        self._failsafe_latched = False
        self._arming_input_barrier = False
        self._arming_barrier_confirmed = False
        self._command_arm_transaction = False
        self._last_observed_armed: bool | None = self._state.is_armed()

    # ------------------------------------------------------------------
    # Configuration and arming gates
    # ------------------------------------------------------------------

    @property
    def available(self) -> bool:
        return bool(getattr(self._settings, "allow_pilot_control", False))

    @property
    def enabled(self) -> bool:
        with self._lock:
            return self._enabled

    @property
    def bench_mode(self) -> bool:
        with self._lock:
            return self._bench_mode

    @property
    def props_removed_acknowledged(self) -> bool:
        with self._lock:
            return self._props_ack

    @property
    def limits(self) -> RcDeflectionLimits:
        return self._limits

    def set_worker_waker(self, wake_worker: Callable[[], None] | None) -> None:
        """Attach the link worker's thread-safe wake notification."""
        with self._lock:
            self._wake_worker = wake_worker

    def _bump_generation(self) -> None:
        """Caller holds ``_lock``; invalidate every captured tick decision."""
        self._generation += 1

    def _notify_worker(self) -> None:
        with self._lock:
            wake_worker = self._wake_worker
        if wake_worker is None:
            return
        try:
            wake_worker()
        except Exception:  # noqa: BLE001 - notification must not break safety state
            logger.warning("could not wake manual-pilot worker", exc_info=True)

    def _finish_control_update(self, *, wait_for_inflight: bool) -> None:
        """Wake the sender and optionally drain a transport call already begun."""
        self._notify_worker()
        if wait_for_inflight:
            with self._transport_barrier:
                pass

    def next_tick_delay(self, now: float | None = None) -> float | None:
        """Seconds until the next RC service deadline, for worker polling."""
        if not self.available:
            return None
        selected_now = self._clock() if now is None else now
        with self._lock:
            return max(0.0, self._next_send - selected_now)

    def observe_armed_state(self, armed: bool | None) -> None:
        """Latch an input barrier on every newly observed ARMED transition."""
        changed = False
        with self._lock:
            previous = self._last_observed_armed
            self._last_observed_armed = armed
            if armed is True and previous is not True:
                self._input = None
                self._arming_input_barrier = True
                # CommandService owns confirmation during its transaction.
                # An external transition (or enable while already armed) is
                # itself confirmed by this target heartbeat.
                if not self._command_arm_transaction:
                    self._arming_barrier_confirmed = True
                self._bump_generation()
                self._schedule_release(BlockReason.ARMING_INPUT_BARRIER)
                changed = True
            elif armed is False and not self._command_arm_transaction:
                if self._arming_input_barrier or self._arming_barrier_confirmed:
                    self._arming_input_barrier = False
                    self._arming_barrier_confirmed = False
                    self._bump_generation()
                    self._schedule_release(BlockReason.NO_INPUT)
                    changed = True
        if changed:
            self._finish_control_update(wait_for_inflight=True)

    def _active_limits(self, source: str | None = None) -> RcDeflectionLimits:
        if self._bench_mode:
            return pilot_limits.BENCH_RC_LIMITS
        if (source or "").strip().lower() in {"ps5", "gamepad", "controller"}:
            return self._limits
        # Unknown providers are treated like digital keyboard input.  A typo
        # in an untrusted diagnostic label must never grant full-stick limits.
        return pilot_limits.KEYBOARD_RC_LIMITS

    def _parameters(self) -> dict[str, float]:
        getter = getattr(self._state, "get_parameters", None)
        return {} if getter is None else getter(constants.MANUAL_CONTROL_PARAMETERS)

    def _configuration(self) -> RcInputConfiguration:
        return rc_configuration_from_parameters(
            self._parameters(),
            source_system=self._settings.source_system,
        )

    def _throttle_failsafe_diagnostics(self) -> dict[str, Any] | None:
        """Read-only ``FS_THR_ENABLE``/``FS_THR_VALUE``, for display next to the
        actual reported throttle RC input. Optional: many vehicles have the
        throttle failsafe disabled or this firmware may not expose it, and
        that is reported as absent, never assumed. Never enforced or written.
        """
        parameters = self._parameters()
        if "FS_THR_ENABLE" not in parameters:
            return None
        enable_raw = parameters.get("FS_THR_ENABLE")
        value_pwm = parameters.get("FS_THR_VALUE")
        return {
            # ArduPilot's FS_THR_ENABLE is multi-valued (which failsafe action),
            # not a plain boolean -- the raw value is shown so nothing is
            # paraphrased, plus a simple "is some throttle failsafe configured
            # at all" convenience flag.
            "enabled": None if enable_raw is None else bool(int(enable_raw)),
            "enableRaw": None if enable_raw is None else int(enable_raw),
            "valuePwm": None if value_pwm is None else int(value_pwm),
        }

    # ------------------------------------------------------------------
    # Browser input
    # ------------------------------------------------------------------

    def _schedule_release(self, reason: str, *, failsafe: bool = False) -> None:
        """Caller holds the lock."""
        now = self._clock()
        self._release_until = max(self._release_until, now + MANUAL_RELEASE_HOLD_SECONDS)
        self._next_send = min(self._next_send, now)
        self._transmitting = False
        self._output_active = False
        self._last_release_reason = reason
        self._last_reason = reason
        if failsafe:
            self._failsafe_latched = True

    def enable(self) -> dict[str, Any]:
        """Enable manual control without arming or changing flight mode."""
        if not self.available:
            return self.snapshot()
        with self._lock:
            self._enabled = True
            self._bench_mode = False
            self._props_ack = False
            self._input = None
            self._failsafe_latched = False
            self._forced_block_reason = None
            armed = self._state.is_armed()
            self._last_observed_armed = armed
            if armed is True:
                self._arming_input_barrier = True
                self._arming_barrier_confirmed = True
            elif armed is False:
                self._arming_input_barrier = False
                self._arming_barrier_confirmed = False
            self._bump_generation()
            self._schedule_release(BlockReason.NO_INPUT)
        self._finish_control_update(wait_for_inflight=True)
        logger.info("manual pilot channel enabled; aircraft state was not changed")
        return self.snapshot()

    def enable_bench(self, *, props_removed_ack: bool) -> dict[str, Any]:
        """Enable low-deflection bench control after an explicit props check.

        Mock mode is intentionally supported as a simulation for automated and
        browser acceptance.  In real mode the acknowledgement remains an
        operator assertion; it never bypasses ArduPilot safety checks.
        """
        if not self.available or not props_removed_ack:
            return self.snapshot()
        with self._lock:
            self._enabled = True
            self._bench_mode = True
            self._props_ack = True
            self._input = None
            self._failsafe_latched = False
            self._forced_block_reason = None
            armed = self._state.is_armed()
            self._last_observed_armed = armed
            if armed is True:
                self._arming_input_barrier = True
                self._arming_barrier_confirmed = True
            elif armed is False:
                self._arming_input_barrier = False
                self._arming_barrier_confirmed = False
            self._bump_generation()
            self._schedule_release(BlockReason.NO_INPUT)
        self._finish_control_update(wait_for_inflight=True)
        logger.warning("bench pilot enabled with propellers-removed acknowledgement")
        return self.snapshot()

    def disable(self) -> dict[str, Any]:
        with self._lock:
            had_output = self._override_owned or self._transmitting
            self._enabled = False
            self._bench_mode = False
            self._props_ack = False
            self._input = None
            self._forced_block_reason = None
            if self._state.is_armed() is False:
                self._arming_input_barrier = False
                self._arming_barrier_confirmed = False
            self._bump_generation()
            self._schedule_release(BlockReason.NOT_ENABLED, failsafe=had_output)
        self._finish_control_update(wait_for_inflight=True)
        logger.info("manual pilot disabled; RC override release scheduled")
        return self.snapshot()

    def submit(
        self,
        *,
        pitch: float | None = None,
        roll: float | None = None,
        throttle: float | None = None,
        yaw: float = 0.0,
        deadman: bool = False,
        neutral: bool = False,
        source: str = "keyboard",
        provider: str | None = None,
        sequence: int,
        # Backwards field aliases retained at the backend boundary only.
        forward: float | None = None,
        right: float | None = None,
        up: float | None = None,
    ) -> dict[str, Any]:
        """Accept one newer client frame; reject delayed or replayed frames."""
        if isinstance(sequence, bool) or not isinstance(sequence, int):
            raise ValueError("Pilot input sequence must be an integer.")
        with self._lock:
            if sequence <= self._last_client_sequence:
                self._last_rejected_sequence = sequence
                raise PilotSequenceRejected(sequence, self._last_client_sequence)

            canonical_pitch = forward if pitch is None else pitch
            canonical_roll = right if roll is None else roll
            canonical_throttle = up if throttle is None else throttle
            command = PilotInput(
                pitch=float(canonical_pitch or 0.0),
                roll=float(canonical_roll or 0.0),
                throttle=float(canonical_throttle or 0.0),
                yaw=float(yaw),
                deadman=bool(deadman),
                neutral=bool(neutral),
                source=str(source or "unknown")[:64],
                provider=str(
                    provider
                    or ("keyboard" if str(source).strip().lower() in {"keyboard", "keys"} else "browser")
                )[:32].strip().lower(),
                sequence=sequence,
                received_at=self._clock(),
            )
            self._last_client_sequence = sequence
            self._last_rejected_sequence = None
            self._input = command
            self._bump_generation()

            provider_rejected = (
                self._settings.is_real
                and command.provider == "mock"
                and not command.neutral
                and command.deadman
                and not command.is_zero
            )
            if provider_rejected:
                self._input = PilotInput(
                    neutral=True,
                    source=command.source,
                    provider=command.provider,
                    sequence=sequence,
                    received_at=command.received_at,
                )
                self._forced_block_reason = BlockReason.MOCK_PROVIDER_FORBIDDEN
                self._schedule_release(
                    BlockReason.MOCK_PROVIDER_FORBIDDEN,
                    failsafe=self._override_owned or self._transmitting,
                )

            # ARM confirmation deliberately does not unlock held controls.
            # A post-confirmation dead-man release/neutral frame consumes its
            # own sequence and opens the gate; only a later sequence with the
            # dead-man re-pressed may activate output.
            barrier_cleared = False
            if (
                not provider_rejected
                and
                self._arming_input_barrier
                and self._arming_barrier_confirmed
                and (command.neutral or not command.deadman)
            ):
                self._arming_input_barrier = False
                self._arming_barrier_confirmed = False
                barrier_cleared = True

            # Make the status inactive synchronously with the HTTP request;
            # the worker sends the zero-release frame on its next iteration.
            if not provider_rejected and (command.neutral or not command.deadman or command.is_zero):
                if command.neutral:
                    # A neutral/dead-man-up frame is the explicit release
                    # edge that consumes the post-arm inhibit. Report the
                    # ordinary no-input state once that edge has opened the
                    # gate; plain neutral commands retain their diagnostic.
                    reason = BlockReason.NO_INPUT if barrier_cleared else BlockReason.NEUTRAL_COMMANDED
                    self._forced_block_reason = None
                    self._failsafe_latched = False
                elif not command.deadman:
                    reason = BlockReason.DEADMAN_RELEASED
                else:
                    reason = BlockReason.NEUTRAL_COMMANDED
                self._schedule_release(
                    reason,
                    failsafe=(reason == BlockReason.DEADMAN_RELEASED and self._override_owned),
                )
            closes_gate = (
                provider_rejected or command.neutral or not command.deadman or command.is_zero
            )
        self._finish_control_update(wait_for_inflight=closes_gate)
        if provider_rejected:
            raise PilotProviderRejected(command.provider, sequence)
        return self.snapshot()

    def command_neutral(self, *, sequence: int | None = None) -> dict[str, Any]:
        """Release all first-eight overrides without disabling the channel."""
        with self._lock:
            if sequence is not None and (isinstance(sequence, bool) or not isinstance(sequence, int)):
                raise ValueError("Pilot neutral sequence must be an integer.")
            candidate = self._last_client_sequence + 1 if sequence is None else sequence
            if candidate <= self._last_client_sequence:
                self._last_rejected_sequence = candidate
                raise PilotSequenceRejected(candidate, self._last_client_sequence)
            self._last_client_sequence = candidate
            self._input = PilotInput(neutral=True, sequence=candidate, received_at=self._clock())
            self._forced_block_reason = None
            self._failsafe_latched = False
            if self._state.is_armed() is False or self._arming_barrier_confirmed:
                self._arming_input_barrier = False
                self._arming_barrier_confirmed = False
            self._bump_generation()
            self._schedule_release(BlockReason.NEUTRAL_COMMANDED, failsafe=False)
        self._finish_control_update(wait_for_inflight=True)
        return self.snapshot()

    def command_failsafe(self, reason: str) -> dict[str, Any]:
        """Drop desired movement for a browser/provider safety event."""
        safe_reason = str(reason or BlockReason.PROVIDER_DISCONNECTED)[:64]
        with self._lock:
            self._last_client_sequence += 1
            self._input = PilotInput(
                neutral=True,
                source="failsafe",
                provider="failsafe",
                sequence=self._last_client_sequence,
                received_at=self._clock(),
            )
            self._forced_block_reason = safe_reason
            self._bump_generation()
            self._schedule_release(safe_reason, failsafe=True)
        self._finish_control_update(wait_for_inflight=True)
        return self.snapshot()

    def begin_arming_input_barrier(self) -> dict[str, Any]:
        """Inhibit output before command 400 and discard all cached input."""
        with self._lock:
            self._arming_input_barrier = True
            self._arming_barrier_confirmed = False
            self._command_arm_transaction = True
            self._input = None
            self._bump_generation()
            self._schedule_release(BlockReason.ARMING_INPUT_BARRIER)
        self._finish_control_update(wait_for_inflight=True)
        return self.snapshot()

    def finish_arming_input_barrier(self, *, confirmed_armed: bool) -> dict[str, Any]:
        """End an ARM transaction with no reusable pre-confirmation input.

        Frames received while command ACK/HEARTBEAT verification was pending
        may advance the client sequence, but are deliberately discarded here.
        Only a strictly newer frame submitted after this method can activate.
        The same cleanup runs on timeout/rejection because the vehicle may
        still have armed even when the application did not observe the ACK.
        """
        with self._lock:
            self._input = None
            # ACK/HEARTBEAT timeouts are ambiguous: the aircraft can be armed
            # even though this request reports failure, so the inhibit stays
            # latched. A verified ARM moves it to "release required" rather
            # than opening it: held controls must be released/re-pressed.
            self._arming_barrier_confirmed = confirmed_armed
            self._command_arm_transaction = False
            self._last_observed_armed = self._state.is_armed()
            self._bump_generation()
            self._schedule_release(BlockReason.NO_INPUT)
        self._finish_control_update(wait_for_inflight=True)
        return self.snapshot()

    # ------------------------------------------------------------------
    # Gate evaluation
    # ------------------------------------------------------------------

    def _safe_idle_override(self) -> RcOverride | None:
        """Zero-deflection RC override: trim on roll/pitch/yaw, the calibrated
        safe-low endpoint on throttle. Computed through the same audited
        :func:`normalized_to_rc_override` used for real movement, just with
        every axis held at zero -- so bench mode's "resting" state keeps
        ArduPilot seeing valid, in-range RC input instead of no signal at all.

        Returns ``None`` (caller must fully release) when the configuration or
        flight mode is not currently known well enough to compute a safe
        value -- this never guesses a value it cannot justify.
        """
        try:
            configuration = self._configuration()
        except RcConfigurationError:
            return None
        mode = self._state.current_mode()
        if mode not in constants.MANUAL_CONTROL_MODES:
            return None
        return normalized_to_rc_override(
            pitch=0.0, roll=0.0, throttle=0.0, yaw=0.0,
            configuration=configuration, limits=self._active_limits(), mode=mode,
        )

    def _evaluate(
        self, now: float
    ) -> tuple[RcOverride | None, str | None, RcInputConfiguration | None, bool]:
        """Return an active override, or a fail-closed reason. Lock held.

        The fourth element is ``True`` exactly when the returned override is
        the zero-deflection "safe idle" frame rather than a genuine movement
        command -- ``tick()`` uses it to keep TRANSMITTING meaning "the
        aircraft may actually be moving", not merely "some frame went out".

        Safe idle only ever replaces a *release* for four specific bench-mode
        resting states (arming in progress, disarmed and waiting to arm,
        armed with no input yet, dead-man released): all of them mean
        "channel open, healthy, nobody is asking for movement right now".
        Every other reason here -- disconnected, stale, misconfigured, wrong
        mode, unknown arm state, stale input, an explicit neutral/panic --
        keeps releasing exactly as before. See docs/PILOT_CONTROL_GUIDE.md.
        """
        if not self.available:
            return None, BlockReason.DISABLED, None, False
        if not self._enabled:
            return None, BlockReason.NOT_ENABLED, None, False
        if self._forced_block_reason is not None:
            return None, self._forced_block_reason, None, False
        if self._arming_input_barrier:
            if self._bench_mode:
                idle = self._safe_idle_override()
                if idle is not None:
                    return idle, BlockReason.ARMING_INPUT_BARRIER, None, True
            return None, BlockReason.ARMING_INPUT_BARRIER, None, False

        link_state = self._state.get_connection_state()
        if link_state is not ConnectionState.CONNECTED:
            reason = (
                BlockReason.TELEMETRY_STALE
                if link_state is ConnectionState.TELEMETRY_STALE
                else BlockReason.NOT_CONNECTED
            )
            return None, reason, None, False

        try:
            configuration = self._configuration()
        except RcConfigurationError as error:
            return None, error.reason, None, False

        mode = self._state.current_mode()
        if mode not in constants.MANUAL_CONTROL_MODES:
            return None, BlockReason.WRONG_MODE, configuration, False

        def zero_override() -> RcOverride:
            return normalized_to_rc_override(
                pitch=0.0, roll=0.0, throttle=0.0, yaw=0.0,
                configuration=configuration, limits=self._active_limits(), mode=mode,
            )

        armed = self._state.is_armed()
        if armed is None:
            return None, BlockReason.ARM_STATE_UNKNOWN, configuration, False
        if not armed:
            if self._bench_mode:
                return zero_override(), BlockReason.DISARMED, configuration, True
            return None, BlockReason.DISARMED, configuration, False

        command = self._input
        if command is None:
            if self._bench_mode:
                return zero_override(), BlockReason.NO_INPUT, configuration, True
            return None, BlockReason.NO_INPUT, configuration, False
        if now - command.received_at > PILOT_INPUT_TIMEOUT:
            return None, BlockReason.INPUT_TIMEOUT, configuration, False
        if command.neutral:
            # The post-arm release edge is represented as NO_INPUT after it
            # consumes the inhibit; ordinary neutral commands remain visibly
            # NEUTRAL_COMMANDED. An explicit neutral (Space, panic, disable)
            # always fully releases -- it is a deliberate stop, not a resting
            # state, and must never be softened into safe idle.
            return None, (
                BlockReason.NO_INPUT
                if self._last_reason == BlockReason.NO_INPUT
                else BlockReason.NEUTRAL_COMMANDED
            ), configuration, False
        if not command.deadman:
            if self._bench_mode:
                return zero_override(), BlockReason.DEADMAN_RELEASED, configuration, True
            return None, BlockReason.DEADMAN_RELEASED, configuration, False
        if command.is_zero:
            return None, BlockReason.NEUTRAL_COMMANDED, configuration, False

        return (
            normalized_to_rc_override(
                pitch=command.pitch,
                roll=command.roll,
                throttle=command.throttle,
                yaw=command.yaw,
                configuration=configuration,
                limits=self._active_limits(command.source),
                mode=mode,
            ),
            None,
            configuration,
            False,
        )

    # ------------------------------------------------------------------
    # MAVLink-worker transmission
    # ------------------------------------------------------------------

    @staticmethod
    def _send_override(
        link: MavlinkLink,
        *,
        target_system: int,
        target_component: int,
        override: RcOverride,
    ) -> None:
        link.send_rc_channels_override(
            target_system=target_system,
            target_component=target_component,
            channels=override.channels,
        )

    def tick(self, link: MavlinkLink, *, target_system: int, target_component: int) -> bool:
        """Send one active override or one repeated all-channel release frame."""
        if not self.available:
            return False

        # LinkManager normally reports every heartbeat synchronously. This
        # poll is defence in depth for direct/service-only integrations.
        self.observe_armed_state(self._state.is_armed())

        now = self._clock()
        with self._lock:
            if now < self._next_send:
                return False

            override, reason, _configuration, _is_safe_idle = self._evaluate(now)
            was_active = self._override_owned or self._transmitting
            if override is None:
                if was_active:
                    self._schedule_release(
                        reason or BlockReason.NEUTRAL_COMMANDED,
                        failsafe=(reason in self._FAILSAFE_REASONS),
                    )
                self._transmitting = False
                self._output_active = False
                self._last_reason = reason
                if now >= self._release_until:
                    self._next_send = now + MANUAL_OVERRIDE_INTERVAL
                    return False
                outbound = RELEASE_RC_OVERRIDE
                releasing = True
            else:
                outbound = override
                releasing = False
                self._release_until = 0.0
                self._last_reason = None
            self._next_send = now + MANUAL_OVERRIDE_INTERVAL
            generation = self._generation

        error: Exception | None = None
        with self._transport_barrier:
            # A safety request may have landed after the first evaluation but
            # before this transport critical section.  It bumps generation;
            # abort this stale decision and let its worker wake drive the
            # release immediately.
            with self._lock:
                if generation != self._generation:
                    return False

                # Telemetry can close a gate without mutating PilotService.
                # Re-evaluate at the last safe point before starting a write.
                refreshed, refreshed_reason, _configuration, _refreshed_is_safe_idle = self._evaluate(self._clock())
                if not releasing and refreshed is None:
                    self._schedule_release(
                        refreshed_reason or BlockReason.NEUTRAL_COMMANDED,
                        failsafe=(refreshed_reason in self._FAILSAFE_REASONS),
                    )
                    outbound = RELEASE_RC_OVERRIDE
                    releasing = True
                elif not releasing and refreshed is not None:
                    outbound = refreshed

            try:
                self._send_override(
                    link,
                    target_system=target_system,
                    target_component=target_component,
                    override=outbound,
                )
            except Exception as caught:  # transport implementations normalize, fail closed if not
                error = caught
                with self._lock:
                    self._last_error = str(caught)
                    self._last_reason = BlockReason.TRANSMIT_FAILED
                    self._transmitting = False
                    self._output_active = False
                    self._override_owned = False
                    self._input = None
                    self._forced_block_reason = BlockReason.TRANSMIT_FAILED
                    self._bump_generation()
                    self._schedule_release(BlockReason.TRANSMIT_FAILED, failsafe=True)
            else:
                with self._lock:
                    changed_during_send = generation != self._generation
                    self._last_override = outbound
                    self._last_sent_at = now
                    self._messages_sent += 1
                    self._last_error = None
                    if releasing:
                        self._release_messages_sent += 1
                        self._override_owned = False
                        self._transmitting = False
                        self._output_active = False
                    elif changed_during_send:
                        # The active frame completed before the safety caller
                        # is allowed through the transport barrier. Preserve
                        # ownership so the already-scheduled release is sent,
                        # but never relight output after the gate closed.
                        self._override_owned = True
                        self._transmitting = False
                        self._output_active = False
                    else:
                        self._override_owned = True
                        self._transmitting = True
                        self._output_active = True
                        self._failsafe_latched = False

        if error is not None:
            self._notify_worker()
            logger.warning("could not transmit manual RC override: %s", error)
            return False
        return True

    def release_immediately(
        self,
        link: MavlinkLink,
        *,
        target_system: int,
        target_component: int,
        reason: str,
        repeats: int = 3,
    ) -> bool:
        """Best-effort release burst used before an intentional link close."""
        with self._lock:
            self._input = None
            if self._state.is_armed() is False:
                self._arming_input_barrier = False
                self._arming_barrier_confirmed = False
            self._bump_generation()
            self._schedule_release(reason, failsafe=self._override_owned or self._transmitting)
        self._notify_worker()
        sent = False
        with self._transport_barrier:
            for _ in range(max(1, repeats)):
                try:
                    self._send_override(
                        link,
                        target_system=target_system,
                        target_component=target_component,
                        override=RELEASE_RC_OVERRIDE,
                    )
                except Exception as error:  # best effort during link teardown
                    with self._lock:
                        self._last_error = str(error)
                        self._last_reason = BlockReason.TRANSMIT_FAILED
                    break
                else:
                    sent = True
                    with self._lock:
                        self._last_override = RELEASE_RC_OVERRIDE
                        self._last_sent_at = self._clock()
                        self._messages_sent += 1
                        self._release_messages_sent += 1
        with self._lock:
            self._override_owned = False
            self._transmitting = False
            self._output_active = False
        return sent

    def on_link_lost(self) -> None:
        """Never resume a pre-drop desired command after reconnect."""
        with self._lock:
            last_armed = self._state.is_armed()
            had_output = self._override_owned or self._transmitting
            self._input = None
            self._override_owned = False
            self._transmitting = False
            self._output_active = False
            self._release_until = 0.0
            self._next_send = 0.0
            self._last_reason = BlockReason.NOT_CONNECTED
            self._last_release_reason = BlockReason.NOT_CONNECTED
            self._forced_block_reason = None
            if last_armed is False and not had_output:
                self._arming_input_barrier = False
                self._arming_barrier_confirmed = False
            else:
                # A disconnect ends the observation epoch.  When the vehicle
                # may still be armed (or we owned an override), the next
                # session cannot reuse any held browser input: it must observe
                # a target heartbeat and then a fresh dead-man-up frame.
                self._arming_input_barrier = True
                self._arming_barrier_confirmed = True
            self._bump_generation()
            self._last_observed_armed = None
            if had_output:
                self._failsafe_latched = True

    # ------------------------------------------------------------------
    # Reporting
    # ------------------------------------------------------------------

    def snapshot(self) -> dict[str, Any]:
        now = self._clock()
        with self._lock:
            command = self._input
            age = None if command is None else max(0.0, now - command.received_at)
            _override, evaluated_reason, configuration, evaluated_is_safe_idle = self._evaluate(now)
            reason = (
                BlockReason.DISABLED
                if not self.available
                else (
                    BlockReason.TRANSMIT_FAILED
                    if self._last_error
                    and self._state.get_connection_state() is ConnectionState.CONNECTED
                    else evaluated_reason
                )
            )
            # True only for the four bench-mode resting states that keep a
            # zero-deflection RC frame flowing instead of fully releasing --
            # never while genuinely moving, and never if the reason above was
            # overridden by a real transmit failure.
            arming_input_active = evaluated_is_safe_idle and reason == evaluated_reason

            configuration_error: dict[str, str] | None = None
            if configuration is None and self.available:
                try:
                    configuration = self._configuration()
                except RcConfigurationError as error:
                    configuration_error = {"reason": error.reason, "message": error.message}

            current_output = self._output_active and evaluated_reason is None
            current_transmitting = self._transmitting and evaluated_reason is None
            armed = self._state.is_armed()
            ready_to_arm = (
                self.available
                and self._enabled
                and self._state.get_connection_state() is ConnectionState.CONNECTED
                and configuration is not None
                and self._state.current_mode() in constants.MANUAL_CONTROL_MODES
                and armed is False
                and self._forced_block_reason is None
                and not self._arming_input_barrier
            )
            failsafe = self._failsafe_latched or (
                reason in self._FAILSAFE_REASONS and armed is True and self._enabled
            )

            return {
                "available": self.available,
                "enabled": self._enabled,
                "transport": "RC_CHANNELS_OVERRIDE",
                "guidedVelocityTransportRetained": True,
                "supportedModes": list(constants.MANUAL_CONTROL_MODES),
                "requiredMode": None,
                "transmitting": current_transmitting,
                "outputActive": current_output,
                # Distinct from both of the above: a zero-deflection RC frame
                # is flowing (roll/pitch/yaw trim, safe-low throttle) so
                # ArduPilot keeps seeing valid RC input, but nothing is moving
                # and no operator command is being expressed. See
                # docs/PILOT_CONTROL_GUIDE.md's ARMING INPUT / SAFE IDLE
                # section -- this must never be shown merged into TRANSMITTING.
                "armingInputActive": bool(arming_input_active),
                "failsafe": failsafe,
                "readyToArm": ready_to_arm,
                "armingInputBarrier": self._arming_input_barrier,
                "armingReleaseRequired": (
                    self._arming_input_barrier and self._arming_barrier_confirmed
                ),
                "blockedReason": reason,
                "axes": {
                    "pitch": command.pitch if command else 0.0,
                    "roll": command.roll if command else 0.0,
                    "throttle": command.throttle if command else 0.0,
                    "yaw": command.yaw if command else 0.0,
                },
                "source": command.source if command else None,
                "provider": command.provider if command else None,
                "deadman": command.deadman if command else False,
                "deadmanRequired": True,
                "neutral": command.neutral if command else True,
                "benchMode": self._bench_mode,
                "propsRemovedAck": self._props_ack,
                "benchRequiresRealMode": False,
                "simulation": not self._settings.is_real,
                "limits": self._active_limits(command.source if command else "keyboard").to_dict(),
                "inputAgeSeconds": age,
                "inputTimeoutSeconds": PILOT_INPUT_TIMEOUT,
                "overrideRateHz": pilot_limits.MANUAL_OVERRIDE_RATE_HZ,
                "setpointRateHz": pilot_limits.SETPOINT_RATE_HZ,
                "override": self._last_override.to_dict(),
                "overrideOwned": self._override_owned,
                "releaseActive": now < self._release_until,
                "lastReleaseReason": self._last_release_reason,
                "rcConfiguration": configuration.to_dict() if configuration else None,
                "rcConfigurationError": configuration_error,
                "throttleFailsafe": self._throttle_failsafe_diagnostics(),
                "messagesSent": self._messages_sent,
                "setpointsSent": self._messages_sent,
                "releaseMessagesSent": self._release_messages_sent,
                "lastSentAt": self._last_sent_at,
                "sequence": self._last_client_sequence,
                "lastClientSequence": self._last_client_sequence,
                "nextSequence": self._last_client_sequence + 1,
                "lastRejectedSequence": self._last_rejected_sequence,
                "error": self._last_error,
                "aircraftArmedByPilotEnable": False,
                "modeChangedByPilotEnable": False,
            }
