"""Reviewed vehicle commands with acknowledgement and telemetry verification.

Scope, deliberately narrow
--------------------------
Five operations exist:

1. :meth:`CommandService.request_autopilot_version` -- ask for
   ``AUTOPILOT_VERSION``. Read-only; changes nothing on the vehicle.
2. :meth:`CommandService.request_streams` -- ask the vehicle to stream an
   allowlisted set of telemetry messages. Read-only.
3. :meth:`CommandService.set_flight_mode` -- change flight mode, **only while
   disarmed** and **only within a two-entry allowlist**.
4. :meth:`CommandService.arm` -- normal ArduPilot arming, after pilot and
   operator gates, with no safety-check bypass.
5. :meth:`CommandService.disarm` -- normal disarming, always available through
   the safe-command gate even if the pilot channel has since been disabled.

Takeoff, land, RTL, mission upload, raw caller-selected RC override,
MANUAL_CONTROL and motor test are **not implemented**. Manual RC output is
owned exclusively by ``PilotService``; it is not a generic command endpoint.

Gate order for every real transmission
--------------------------------------
``allow_safe_commands`` -> connected -> telemetry fresh -> operation-specific
gates -> transmit -> COMMAND_ACK within timeout -> for state changes, vehicle
HEARTBEAT confirms the requested final state within timeout.

A failure at any gate is reported with a machine-readable ``reason``; nothing
is ever silently ignored.
"""

from __future__ import annotations

import logging
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Final

from ..config import MODE_MOCK, Settings
from . import constants
from .interface import MavlinkLink
from .link_manager import LinkManager
from .telemetry_state import COMMANDABLE_STATES, ConnectionState

logger = logging.getLogger(__name__)


class CommandRejected(Exception):
    """A command was refused before or after transmission.

    Args:
        reason: Stable machine-readable token for the frontend.
        message: Operator-facing explanation.
        detail: Extra structured context (ack result, observed mode, ...).
    """

    def __init__(self, reason: str, message: str, detail: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.reason = reason
        self.message = message
        self.detail = detail or {}


@dataclass
class CommandResult:
    """Outcome of an attempted command."""

    ok: bool
    reason: str
    message: str
    detail: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {"ok": self.ok, "reason": self.reason, "message": self.message, "detail": self.detail}


#: STATUSTEXT prefixes ArduPilot uses for arming-relevant explanations. A
#: COMMAND_ACK for ARM carries only a numeric MAV_RESULT (e.g. FAILED); the
#: actual reason -- "PreArm: Hardware safety switch", "EKF: ...", etc. -- is a
#: separate STATUSTEXT the vehicle sends around the same moment. Matched by
#: prefix only, never inferred from any other telemetry field: a message this
#: module did not literally receive is never fabricated as a cause.
ARM_STATUSTEXT_PREFIXES: Final[tuple[str, ...]] = (
    "PreArm:",
    "Arm:",
    "Failsafe:",
    "EKF:",
    "GPS:",
    "RC:",
)

#: How far *before* an ARM attempt a still-standing relevant STATUSTEXT is
#: treated as its cause. ArduPilot re-broadcasts an unresolved PreArm reason
#: on its own cadence (roughly every ~1 s while disarmed and failing), so one
#: already sitting in the buffer when the operator clicks ARM is genuinely the
#: reason the click will fail, not stale chatter.
ARM_STATUSTEXT_LOOKBACK_SECONDS: Final = 2.0

#: Bounded wait for a relevant STATUSTEXT that arrives *after* a rejected
#: COMMAND_ACK -- ArduPilot commonly emits the explanatory text in direct
#: response to the rejected arm attempt rather than (or in addition to) its
#: periodic broadcast. Short enough that a genuinely silent vehicle is not
#: made to feel unresponsive.
ARM_STATUSTEXT_SETTLE_SECONDS: Final = 0.25
ARM_STATUSTEXT_SETTLE_POLL_SECONDS: Final = 0.02

#: Operations that exist in the aircraft's MAVLink vocabulary but are refused
#: unconditionally here. Mapped to the explanation the operator sees.
DISABLED_OPERATIONS: dict[str, str] = {
    "takeoff": "Takeoff is not implemented in this backend.",
    "land": "Land is not implemented in this backend.",
    "rtl": "Return-to-launch is not implemented in this backend.",
    "mission_upload": "Mission upload is not implemented in this backend.",
    "guided_goto": "GUIDED movement is not implemented in this backend.",
    "raw_rc_override": "Raw caller-selected RC override is not exposed; PilotService owns manual RC output.",
    "manual_control": "MANUAL_CONTROL is not implemented and will not be added.",
    "motor_test": "Motor test is not implemented and will not be added.",
    "set_parameter": "Parameter writes are not implemented; use QGroundControl.",
}


class CommandService:
    """Validates, transmits, and confirms the small set of safe commands."""

    def __init__(self, manager: LinkManager, settings: Settings, pilot: Any | None = None) -> None:
        self._manager = manager
        self._settings = settings
        self._pilot = pilot
        # ARM, DISARM, and disarmed mode changes are one vehicle-state
        # transaction.  Serializing the gate/COMMAND_ACK/HEARTBEAT sequence
        # prevents two callers from both observing DISARMED and then racing
        # contradictory commands onto the same transport.
        self._state_command_lock = threading.Lock()

    @contextmanager
    def _state_command(self):
        if not self._state_command_lock.acquire(blocking=False):
            raise CommandRejected(
                "command_in_progress",
                "Another ARM, DISARM, or flight-mode command is still being confirmed.",
                {"transmitted": False},
            )
        try:
            yield
        finally:
            self._state_command_lock.release()

    # ------------------------------------------------------------------
    # Gates
    # ------------------------------------------------------------------

    def _require_commands_enabled(self) -> None:
        if not self._settings.allow_safe_commands:
            raise CommandRejected(
                "commands_disabled",
                "Commands are disabled. The backend is running read-only. Set "
                "SUISUI_MAVLINK_ALLOW_SAFE_COMMANDS=1 and restart to enable the safe command set.",
                {"allowSafeCommands": False},
            )

    def _require_live_link(self) -> None:
        state = self._manager.state.get_connection_state()
        if state not in COMMANDABLE_STATES:
            if state is ConnectionState.TELEMETRY_STALE:
                raise CommandRejected(
                    "link_stale",
                    "Telemetry is stale. Commanding a vehicle that has stopped reporting would be "
                    "commanding blind; wait for the link to recover.",
                    {"connectionState": state.value},
                )
            raise CommandRejected(
                "not_connected",
                f"The MAVLink link is not ready (state: {state.value}).",
                {"connectionState": state.value},
            )

    def _require_disarmed(self) -> None:
        """Refuse unless the vehicle is *known* to be disarmed.

        ``None`` means no heartbeat has told us either way. That is treated as
        a refusal, not as "probably fine".
        """
        armed = self._manager.state.is_armed()
        if armed is None:
            raise CommandRejected(
                "arm_state_unknown",
                "The vehicle has not reported its armed state yet. Commands are refused until it does.",
                {"armed": None},
            )
        if armed:
            raise CommandRejected(
                "armed",
                "The vehicle reports ARMED. This backend refuses every command while armed.",
                {"armed": True},
            )

    def _require_explicit_confirmation(self, confirmed: bool, operation: str) -> None:
        if not confirmed:
            raise CommandRejected(
                "confirmation_required",
                f"{operation} requires an explicit operator confirmation.",
                {"confirmed": False, "operation": operation.lower()},
            )

    def _require_pilot_ready_to_arm(self) -> dict[str, Any]:
        pilot = self._pilot
        if pilot is None or not pilot.available:
            raise CommandRejected(
                "pilot_control_disabled",
                "Arming is refused because manual pilot control is disabled.",
                {"pilotAvailable": False},
            )
        snapshot = pilot.snapshot()
        if not snapshot.get("enabled"):
            raise CommandRejected(
                "pilot_not_enabled",
                "Enable the manual pilot channel before requesting ARM.",
                {"pilot": snapshot},
            )
        if snapshot.get("benchMode") and not snapshot.get("propsRemovedAck"):
            raise CommandRejected(
                "props_not_confirmed",
                "Bench ARM requires the operator to confirm every propeller is removed.",
                {"pilot": snapshot},
            )
        if not snapshot.get("readyToArm"):
            reason = snapshot.get("blockedReason")
            raise CommandRejected(
                "pilot_not_ready",
                "Manual control is not ready to arm. Resolve the reported pilot block first.",
                {"blockedReason": reason, "pilot": snapshot},
            )
        return snapshot

    def _recent_status_texts(self) -> list[dict[str, Any]]:
        entries = self._manager.state.snapshot().get("statusTexts", [])
        return list(entries[-5:])

    def _relevant_status_texts(self, *, since: float) -> list[dict[str, Any]]:
        """Arming-relevant STATUSTEXT entries received at or after ``since``.

        Scans the *entire* retained buffer, not just the most recent few: a
        burst of unrelated chatter between the real PreArm reason and the
        COMMAND_ACK must not push it out of a small fixed-size tail. Returned
        oldest-first, so ``[-1]`` is the most recent -- and therefore the most
        relevant when more than one arming-relevant message was seen.
        """
        entries = self._manager.state.snapshot().get("statusTexts", [])
        return [
            entry
            for entry in entries
            if str(entry.get("text", "")).startswith(ARM_STATUSTEXT_PREFIXES)
            and float(entry.get("receivedAt") or 0.0) >= since
        ]

    def _arm_attempt_evidence(self) -> dict[str, Any]:
        """Read-only snapshot of everything relevant to an ARM decision,
        taken at the moment ARM was rejected.

        Attached to every ``rejected_by_vehicle`` ARM failure so that when the
        vehicle's own STATUSTEXT explanation is missing, the operator is shown
        raw evidence (mode, armed state, the vehicle's own pre-arm health bit,
        its actually-reported RC input, this backend's override/RCMAP/
        calibration state, and the throttle failsafe parameters) instead of
        nothing. This never states a cause -- it reports facts already read
        from the vehicle, for the operator (or a later attempt) to interpret.
        """
        telemetry = self._manager.state.snapshot()
        vehicle = telemetry.get("vehicle") or {}
        pilot_snapshot = self._pilot.snapshot() if self._pilot is not None else None
        return {
            "flightMode": vehicle.get("flightMode"),
            "armed": vehicle.get("armed"),
            "prearmCheck": telemetry.get("prearmCheck"),
            "rc": telemetry.get("rc"),
            "pilot": None if pilot_snapshot is None else {
                "enabled": pilot_snapshot.get("enabled"),
                "benchMode": pilot_snapshot.get("benchMode"),
                "deadman": pilot_snapshot.get("deadman"),
                "override": pilot_snapshot.get("override"),
                "overrideOwned": pilot_snapshot.get("overrideOwned"),
                "transmitting": pilot_snapshot.get("transmitting"),
                "outputActive": pilot_snapshot.get("outputActive"),
                "armingInputActive": pilot_snapshot.get("armingInputActive"),
                "rcConfiguration": pilot_snapshot.get("rcConfiguration"),
                "throttleFailsafe": pilot_snapshot.get("throttleFailsafe"),
            },
            "recentStatusTexts": self._recent_status_texts(),
        }

    # ------------------------------------------------------------------
    # Normal arm/disarm, confirmed by HEARTBEAT
    # ------------------------------------------------------------------

    def arm(self, *, confirmed: bool) -> CommandResult:
        with self._state_command():
            return self._arm(confirmed=confirmed)

    def _arm(self, *, confirmed: bool) -> CommandResult:
        """Request normal arming; never supply an ArduPilot bypass value."""
        self._require_commands_enabled()
        self._require_live_link()
        self._require_explicit_confirmation(confirmed, "ARM")
        self._require_disarmed()
        pilot_snapshot = self._require_pilot_ready_to_arm()
        pilot = self._pilot
        assert pilot is not None  # established by _require_pilot_ready_to_arm
        pilot.begin_arming_input_barrier()
        arm_confirmed = False
        try:
            waiter = self._manager.register_arm_state_waiter(True)
            try:
                try:
                    ack_result = self._send_and_await_ack(
                        command=constants.MAV_CMD_COMPONENT_ARM_DISARM,
                        params=(1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0),
                        description="normal ARM",
                        capture_arm_reason=True,
                    )
                except CommandRejected as rejection:
                    rejection.detail.setdefault("statusTexts", self._recent_status_texts())
                    raise
                observed = waiter.wait(self._settings.mode_verify_timeout)
            finally:
                self._manager.release_arm_state_waiter(waiter)

            final_armed = self._manager.state.is_armed()
            if observed is None:
                raise CommandRejected(
                    "verify_timeout",
                    "The vehicle acknowledged ARM but did not report ARMED in HEARTBEAT before timeout.",
                    {
                        "requestedArmed": True,
                        "finalArmed": final_armed,
                        "ack": ack_result.detail.get("ack"),
                        "statusTexts": self._recent_status_texts(),
                    },
                )
            if final_armed is not True:
                raise CommandRejected(
                    "verify_mismatch",
                    "The vehicle reported ARMED during verification but its current telemetry no longer does.",
                    {
                        "requestedArmed": True,
                        "observedArmed": observed,
                        "finalArmed": final_armed,
                        "ack": ack_result.detail.get("ack"),
                        "statusTexts": self._recent_status_texts(),
                    },
                )
            arm_confirmed = True
        finally:
            # Run on success, ACK rejection/timeout, and HEARTBEAT timeout.
            # The vehicle can arm even when its ACK is lost; no frame received
            # during that uncertainty is allowed to become active later.
            pilot.finish_arming_input_barrier(confirmed_armed=arm_confirmed)
        return CommandResult(
            ok=True,
            reason="accepted",
            message="Vehicle telemetry confirms ARMED." + (
                " (Mock simulation.)" if self._settings.mode == MODE_MOCK else ""
            ),
            detail={
                "requestedArmed": True,
                "finalArmed": True,
                "ack": ack_result.detail.get("ack"),
                "simulated": self._settings.mode == MODE_MOCK,
                "benchMode": bool(pilot_snapshot.get("benchMode")),
                "normalSafetyChecks": True,
            },
        )

    def disarm(self, *, confirmed: bool) -> CommandResult:
        with self._state_command():
            return self._disarm(confirmed=confirmed)

    def _disarm(self, *, confirmed: bool) -> CommandResult:
        """Request normal disarming and require HEARTBEAT confirmation.

        This intentionally does not require PilotService to remain enabled or
        a bench acknowledgement. Those are arming gates; applying them to the
        safety-direction operation could trap an already armed operator.
        """
        self._require_commands_enabled()
        self._require_live_link()
        self._require_explicit_confirmation(confirmed, "DISARM")
        armed = self._manager.state.is_armed()
        if armed is None:
            raise CommandRejected(
                "arm_state_unknown",
                "The vehicle has not reported its armed state yet.",
                {"armed": None},
            )
        if armed is False:
            return CommandResult(
                ok=True,
                reason="already_disarmed",
                message="Vehicle telemetry already reports DISARMED.",
                detail={"requestedArmed": False, "finalArmed": False, "transmitted": False},
            )

        waiter = self._manager.register_arm_state_waiter(False)
        try:
            try:
                ack_result = self._send_and_await_ack(
                    command=constants.MAV_CMD_COMPONENT_ARM_DISARM,
                    params=(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0),
                    description="normal DISARM",
                )
            except CommandRejected as rejection:
                rejection.detail.setdefault("statusTexts", self._recent_status_texts())
                raise
            observed = waiter.wait(self._settings.mode_verify_timeout)
        finally:
            self._manager.release_arm_state_waiter(waiter)

        final_armed = self._manager.state.is_armed()
        if observed is None:
            raise CommandRejected(
                "verify_timeout",
                "The vehicle acknowledged DISARM but did not report DISARMED in HEARTBEAT before timeout.",
                {
                    "requestedArmed": False,
                    "finalArmed": final_armed,
                    "ack": ack_result.detail.get("ack"),
                    "statusTexts": self._recent_status_texts(),
                },
            )
        if final_armed is not False:
            raise CommandRejected(
                "verify_mismatch",
                "The vehicle reported DISARMED during verification but current telemetry reports ARMED.",
                {
                    "requestedArmed": False,
                    "observedArmed": observed,
                    "finalArmed": final_armed,
                    "ack": ack_result.detail.get("ack"),
                    "statusTexts": self._recent_status_texts(),
                },
            )
        if self._pilot is not None:
            # Intentional, telemetry-confirmed DISARM is a normal safe state,
            # not a browser/provider failure.  Drop any desired movement and
            # establish a fresh sequence barrier without latching an error
            # that would unnecessarily prevent a later deliberate ARM.
            self._pilot.command_neutral()
        return CommandResult(
            ok=True,
            reason="accepted",
            message="Vehicle telemetry confirms DISARMED." + (
                " (Mock simulation.)" if self._settings.mode == MODE_MOCK else ""
            ),
            detail={
                "requestedArmed": False,
                "finalArmed": False,
                "ack": ack_result.detail.get("ack"),
                "simulated": self._settings.mode == MODE_MOCK,
                "normalSafetyChecks": True,
            },
        )

    # ------------------------------------------------------------------
    # Safe command 1: firmware version (read-only)
    # ------------------------------------------------------------------

    def request_autopilot_version(self) -> CommandResult:
        """Ask the autopilot to send ``AUTOPILOT_VERSION``.

        Read-only: it neither changes vehicle state nor moves anything.
        """
        self._require_commands_enabled()
        self._require_live_link()

        result = self._send_and_await_ack(
            command=constants.MAV_CMD_REQUEST_MESSAGE,
            params=(float(constants.MSG_ID_AUTOPILOT_VERSION), 0.0, 0.0, 0.0, 0.0, 0.0, 0.0),
            description="AUTOPILOT_VERSION request",
        )
        version = self._manager.state.snapshot().get("version")
        result.detail["version"] = version
        return result

    # ------------------------------------------------------------------
    # Safe command 2: telemetry stream rates (read-only)
    # ------------------------------------------------------------------

    def request_streams(self, names: list[str] | None = None) -> CommandResult:
        """Ask the vehicle to stream allowlisted telemetry messages.

        Args:
            names: Stream names from
                :data:`~app.mavlink.constants.REQUESTABLE_STREAMS`. ``None``
                requests all of them.

        A caller cannot pass a raw message ID: the name is looked up in the
        allowlist and an unknown name is rejected outright.
        """
        self._require_commands_enabled()
        self._require_live_link()

        requested = list(constants.REQUESTABLE_STREAMS) if not names else names
        unknown = [name for name in requested if name not in constants.REQUESTABLE_STREAMS]
        if unknown:
            raise CommandRejected(
                "stream_not_allowed",
                f"Unknown or disallowed telemetry stream(s): {', '.join(sorted(unknown))}.",
                {"allowed": sorted(constants.REQUESTABLE_STREAMS), "requested": requested},
            )

        accepted: list[str] = []
        failures: list[dict[str, Any]] = []
        for name in requested:
            message_id, rate_hz = constants.REQUESTABLE_STREAMS[name]
            interval_us = 0.0 if rate_hz <= 0 else 1_000_000.0 / rate_hz
            try:
                outcome = self._send_and_await_ack(
                    command=constants.MAV_CMD_SET_MESSAGE_INTERVAL,
                    params=(float(message_id), interval_us, 0.0, 0.0, 0.0, 0.0, 0.0),
                    description=f"SET_MESSAGE_INTERVAL {name}",
                )
            except CommandRejected as rejection:
                failures.append({"stream": name, "reason": rejection.reason, "message": rejection.message})
                continue
            if outcome.ok:
                accepted.append(name)
            else:
                failures.append({"stream": name, "reason": outcome.reason, "message": outcome.message})

        if failures and not accepted:
            raise CommandRejected(
                "rejected_by_vehicle",
                "The vehicle accepted none of the requested telemetry streams.",
                {"failures": failures},
            )
        return CommandResult(
            ok=not failures,
            reason="accepted" if not failures else "partial",
            message=(
                f"Requested {len(accepted)} telemetry stream(s)."
                if not failures
                else f"Requested {len(accepted)} stream(s); {len(failures)} were refused."
            ),
            detail={"accepted": accepted, "failures": failures},
        )

    # ------------------------------------------------------------------
    # Safe command 3: flight mode while disarmed
    # ------------------------------------------------------------------

    def set_flight_mode(self, mode: str) -> CommandResult:
        with self._state_command():
            return self._set_flight_mode(mode)

    def _set_flight_mode(self, mode: str) -> CommandResult:
        """Change flight mode on a disarmed vehicle, within the allowlist.

        Returns only after the vehicle's own HEARTBEAT confirms the mode, so
        the reported ``finalMode`` is what the aircraft says it is -- not what
        was asked for.
        """
        self._require_commands_enabled()
        self._require_live_link()
        self._require_disarmed()

        requested = str(mode).strip().upper()
        if requested in constants.FORBIDDEN_MODES:
            # Defence in depth: this cannot be reached through the allowlist
            # check below, but it makes a future widening of the allowlist fail
            # loudly instead of quietly enabling a flight mode.
            logger.error("refused explicitly forbidden flight mode %s", requested)
            raise CommandRejected(
                "mode_forbidden",
                f"{requested} is a forbidden flight mode in this integration.",
                {"requested": requested},
            )
        if requested not in constants.COMMANDABLE_DISARMED_MODES:
            raise CommandRejected(
                "mode_not_allowed",
                f"{requested} is not in the allowed mode list.",
                {"requested": requested, "allowed": list(constants.COMMANDABLE_DISARMED_MODES)},
            )

        custom_mode = constants.COMMANDABLE_DISARMED_MODES[requested]
        state = self._manager.state
        previous_mode = state.current_mode()

        # Registered *before* transmitting: the vehicle can report the new mode
        # in the same burst as the ack, and a waiter registered afterwards
        # would miss it and time out on a mode change that actually worked.
        mode_waiter = self._manager.register_mode_waiter(requested)
        try:
            # Raises CommandRejected on timeout or a negative acknowledgement.
            ack_result = self._send_and_await_ack(
                command=constants.MAV_CMD_DO_SET_MODE,
                params=(
                    float(constants.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED),
                    float(custom_mode),
                    0.0,
                    0.0,
                    0.0,
                    0.0,
                    0.0,
                ),
                description=f"DO_SET_MODE {requested}",
            )
            observed = mode_waiter.wait(self._settings.mode_verify_timeout)
        finally:
            self._manager.release_mode_waiter(mode_waiter)

        final_mode = state.current_mode()
        if observed is None:
            raise CommandRejected(
                "verify_timeout",
                f"The vehicle acknowledged the mode change but did not report {requested} within "
                f"{self._settings.mode_verify_timeout:.0f}s. The mode may not have changed.",
                {
                    "requestedMode": requested,
                    "previousMode": previous_mode,
                    "finalMode": final_mode,
                    "ack": ack_result.detail.get("ack"),
                },
            )

        logger.info("flight mode confirmed: %s -> %s", previous_mode, final_mode)
        return CommandResult(
            ok=True,
            reason="accepted",
            message=f"Flight mode confirmed as {final_mode}.",
            detail={
                "requestedMode": requested,
                "previousMode": previous_mode,
                "finalMode": final_mode,
                "ack": ack_result.detail.get("ack"),
            },
        )

    # ------------------------------------------------------------------
    # Disabled operations
    # ------------------------------------------------------------------

    def refuse(self, operation: str) -> CommandResult:
        """Answer a request for an operation this backend does not implement.

        This never touches the transport. It exists so the API returns an
        explicit, documented refusal rather than a confusing 404, and so the
        list of things that are *deliberately* absent is visible in one place.
        """
        explanation = DISABLED_OPERATIONS.get(
            operation, "This operation is not implemented in this backend."
        )
        logger.warning("refused disabled operation %r", operation)
        return CommandResult(
            ok=False,
            reason="not_implemented",
            message=f"{explanation} No MAVLink message was sent.",
            detail={"operation": operation, "transmitted": False},
        )

    # ------------------------------------------------------------------
    # Transmit + acknowledge
    # ------------------------------------------------------------------

    def _send_and_await_ack(
        self,
        *,
        command: int,
        params: tuple[float, float, float, float, float, float, float],
        description: str,
        capture_arm_reason: bool = False,
    ) -> CommandResult:
        """Send one allowlisted COMMAND_LONG and wait for its COMMAND_ACK.

        ``capture_arm_reason`` scopes the STATUSTEXT diagnostic capture (and
        its short settle wait) to ARM specifically -- the only command this
        was reported broken for. Every other caller (DISARM, mode changes,
        version/stream requests) is unaffected and keeps its existing timing.
        """
        manager = self._manager
        target_system = self._settings.target_system
        target_component = manager.state.target_component(self._settings.target_component)
        attempt_started_at = time.time()

        waiter = manager.register_ack_waiter(command)
        try:
            def transmit(link: MavlinkLink) -> None:
                link.send_command_long(
                    target_system=target_system,
                    target_component=target_component,
                    command=command,
                    params=params,
                )

            future = manager.submit(transmit)
            try:
                future.result(timeout=self._settings.command_timeout)
            except Exception as error:  # noqa: BLE001 - reported, never swallowed
                logger.error("failed to transmit %s: %s", description, error)
                raise CommandRejected(
                    "transmit_failed",
                    f"Could not send {description}: {error}",
                    {"command": command},
                ) from error

            ack = waiter.wait(self._settings.command_timeout)
        finally:
            manager.release_ack_waiter(waiter)

        if ack is None:
            raise CommandRejected(
                "ack_timeout",
                f"No COMMAND_ACK for {description} within {self._settings.command_timeout:.0f}s.",
                {"command": command},
            )
        if not ack.get("accepted"):
            detail: dict[str, Any] = {"command": command, "ack": ack}
            if capture_arm_reason:
                since = attempt_started_at - ARM_STATUSTEXT_LOOKBACK_SECONDS
                relevant = self._relevant_status_texts(since=since)
                if not relevant:
                    # The real reason may not have arrived yet: ArduPilot
                    # commonly emits it in direct response to the rejection,
                    # a short moment after the ACK itself.
                    deadline = time.monotonic() + ARM_STATUSTEXT_SETTLE_SECONDS
                    while not relevant and time.monotonic() < deadline:
                        time.sleep(ARM_STATUSTEXT_SETTLE_POLL_SECONDS)
                        relevant = self._relevant_status_texts(since=since)
                detail["relevantStatusTexts"] = relevant
                # Most recent relevant message wins when more than one arrived.
                detail["vehicleReason"] = relevant[-1]["text"] if relevant else None
                # Evidence for when there is no vehicleReason to show -- read
                # after the settle wait above, so it reflects the same moment.
                detail["armEvidence"] = self._arm_attempt_evidence()
            raise CommandRejected(
                "rejected_by_vehicle",
                f"The vehicle rejected {description}: {ack.get('resultName')}.",
                detail,
            )

        return CommandResult(
            ok=True,
            reason="accepted",
            message=f"{description} accepted.",
            detail={"command": command, "ack": ack},
        )
