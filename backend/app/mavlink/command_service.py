"""The only place in this backend that transmits a command to the aircraft.

Scope, deliberately narrow
--------------------------
Three operations exist:

1. :meth:`CommandService.request_autopilot_version` -- ask for
   ``AUTOPILOT_VERSION``. Read-only; changes nothing on the vehicle.
2. :meth:`CommandService.request_streams` -- ask the vehicle to stream an
   allowlisted set of telemetry messages. Read-only.
3. :meth:`CommandService.set_flight_mode` -- change flight mode, **only while
   disarmed** and **only within a two-entry allowlist**.

Arm, disarm, takeoff, land, RTL, mission upload, GUIDED movement, RC override,
MANUAL_CONTROL and motor test are **not implemented**. The corresponding
methods exist so the API can answer a caller honestly, and every one of them
returns a refusal without touching the transport. Setting
``SUISUI_MAVLINK_ALLOW_ARM=1`` does not change that: there is no code path from
any endpoint to an arming frame.

Gate order for every real transmission
--------------------------------------
``allow_safe_commands`` -> connected -> telemetry fresh -> disarmed (known,
not merely "not reported armed") -> allowlist -> forbidden-mode guard ->
transmit -> COMMAND_ACK within timeout -> vehicle HEARTBEAT confirms the new
mode within timeout.

A failure at any gate is reported with a machine-readable ``reason``; nothing
is ever silently ignored.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from ..config import Settings
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


#: Operations that exist in the aircraft's MAVLink vocabulary but are refused
#: unconditionally here. Mapped to the explanation the operator sees.
DISABLED_OPERATIONS: dict[str, str] = {
    "arm": "Arming is not implemented in this backend and will not be added by configuration.",
    "disarm": "Disarm is not implemented; use the transmitter or QGroundControl.",
    "takeoff": "Takeoff is not implemented in this backend.",
    "land": "Land is not implemented in this backend.",
    "rtl": "Return-to-launch is not implemented in this backend.",
    "mission_upload": "Mission upload is not implemented in this backend.",
    "guided_goto": "GUIDED movement is not implemented in this backend.",
    "rc_override": "RC override is not implemented and will not be added.",
    "manual_control": "MANUAL_CONTROL is not implemented and will not be added.",
    "motor_test": "Motor test is not implemented and will not be added.",
    "set_parameter": "Parameter writes are not implemented; use QGroundControl.",
}


class CommandService:
    """Validates, transmits, and confirms the small set of safe commands."""

    def __init__(self, manager: LinkManager, settings: Settings) -> None:
        self._manager = manager
        self._settings = settings

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
    ) -> CommandResult:
        """Send one allowlisted COMMAND_LONG and wait for its COMMAND_ACK."""
        manager = self._manager
        target_system = self._settings.target_system
        target_component = manager.state.target_component(self._settings.target_component)

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
            raise CommandRejected(
                "rejected_by_vehicle",
                f"The vehicle rejected {description}: {ack.get('resultName')}.",
                {"command": command, "ack": ack},
            )

        return CommandResult(
            ok=True,
            reason="accepted",
            message=f"{description} accepted.",
            detail={"command": command, "ack": ack},
        )
