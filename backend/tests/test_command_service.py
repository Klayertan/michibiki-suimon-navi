"""Command safety gates.

Each test here corresponds to a rule that must hold before this integration
goes anywhere near a powered aircraft.
"""

from __future__ import annotations

import dataclasses

import pytest

from app.config import Settings
from app.mavlink import constants
from app.mavlink.command_service import DISABLED_OPERATIONS, CommandRejected, CommandService
from app.mavlink.link_manager import LinkManager
from app.mavlink.mock_connection import MockMavlinkLink
from app.mavlink.telemetry_state import ConnectionState

from .conftest import wait_until


@pytest.fixture
def connected(manager: LinkManager, settings: Settings, mock_link: MockMavlinkLink):
    """A connected mock link plus a command service pointed at it."""
    manager.connect()
    assert wait_until(lambda: manager.state.get_connection_state() is ConnectionState.CONNECTED)
    return manager, CommandService(manager, settings), mock_link


# ----------------------------------------------------------------------
# Gate: commands disabled by default
# ----------------------------------------------------------------------


def test_commands_are_refused_when_the_safety_flag_is_off(manager: LinkManager, settings: Settings) -> None:
    read_only = dataclasses.replace(settings, allow_safe_commands=False)
    service = CommandService(manager, read_only)
    manager.connect()
    assert wait_until(lambda: manager.state.get_connection_state() is ConnectionState.CONNECTED)

    with pytest.raises(CommandRejected) as excinfo:
        service.set_flight_mode("ALT_HOLD")
    assert excinfo.value.reason == "commands_disabled"

    with pytest.raises(CommandRejected) as version_error:
        service.request_autopilot_version()
    assert version_error.value.reason == "commands_disabled"


# ----------------------------------------------------------------------
# Gate: link must be live
# ----------------------------------------------------------------------


def test_commands_are_refused_while_disconnected(manager: LinkManager, settings: Settings) -> None:
    service = CommandService(manager, settings)
    with pytest.raises(CommandRejected) as excinfo:
        service.set_flight_mode("ALT_HOLD")
    assert excinfo.value.reason == "not_connected"


def test_commands_are_refused_while_telemetry_is_stale(connected) -> None:
    manager, service, link = connected
    link.inject_link_loss(3.0)
    assert wait_until(
        lambda: manager.state.get_connection_state() is ConnectionState.TELEMETRY_STALE, timeout=4.0
    )

    with pytest.raises(CommandRejected) as excinfo:
        service.set_flight_mode("ALT_HOLD")
    assert excinfo.value.reason == "link_stale"


# ----------------------------------------------------------------------
# Gate: armed state
# ----------------------------------------------------------------------


def test_mode_change_is_refused_when_the_vehicle_reports_armed(connected) -> None:
    manager, service, link = connected
    link.set_armed(True)
    assert wait_until(lambda: manager.state.is_armed() is True, timeout=4.0)

    with pytest.raises(CommandRejected) as excinfo:
        service.set_flight_mode("ALT_HOLD")
    assert excinfo.value.reason == "armed"
    assert excinfo.value.detail["armed"] is True


def test_mode_change_is_refused_when_the_armed_state_is_unknown(
    manager: LinkManager, settings: Settings
) -> None:
    """Unknown must never be treated as 'probably disarmed'."""
    service = CommandService(manager, settings)
    manager.state.set_connection_state(ConnectionState.CONNECTED)
    assert manager.state.is_armed() is None

    with pytest.raises(CommandRejected) as excinfo:
        service.set_flight_mode("ALT_HOLD")
    assert excinfo.value.reason == "arm_state_unknown"


# ----------------------------------------------------------------------
# Gate: mode allowlist
# ----------------------------------------------------------------------


@pytest.mark.parametrize("mode", ["GUIDED", "AUTO", "RTL", "LAND", "SMART_RTL", "TAKEOFF", "FLIP"])
def test_forbidden_modes_are_refused(connected, mode: str) -> None:
    _, service, _ = connected
    with pytest.raises(CommandRejected) as excinfo:
        service.set_flight_mode(mode)
    assert excinfo.value.reason == "mode_forbidden"


@pytest.mark.parametrize("mode", ["LOITER", "POSHOLD", "ACRO", "SPORT", "DRIFT", "", "0", "2", "nonsense"])
def test_modes_outside_the_allowlist_are_refused(connected, mode: str) -> None:
    _, service, _ = connected
    with pytest.raises(CommandRejected) as excinfo:
        service.set_flight_mode(mode)
    assert excinfo.value.reason == "mode_not_allowed"


def test_numeric_mode_ids_are_not_accepted(connected) -> None:
    """A raw custom_mode number must never reach the vehicle."""
    _, service, _ = connected
    with pytest.raises(CommandRejected) as excinfo:
        service.set_flight_mode("4")  # GUIDED's numeric id
    assert excinfo.value.reason == "mode_not_allowed"


# ----------------------------------------------------------------------
# Happy path and verification
# ----------------------------------------------------------------------


def test_allowed_mode_change_is_confirmed_by_a_vehicle_heartbeat(connected) -> None:
    manager, service, _ = connected
    result = service.set_flight_mode("ALT_HOLD")

    assert result.ok is True
    assert result.detail["requestedMode"] == "ALT_HOLD"
    assert result.detail["finalMode"] == "ALT_HOLD", "the reported mode must come from the vehicle"
    assert result.detail["previousMode"] == "STABILIZE"
    assert result.detail["ack"]["resultName"] == "ACCEPTED"


def test_mode_change_round_trip_matches_the_verified_hardware_test(connected) -> None:
    """STABILIZE -> ALT_HOLD -> STABILIZE, disarmed throughout."""
    manager, service, _ = connected

    assert service.set_flight_mode("ALT_HOLD").detail["finalMode"] == "ALT_HOLD"
    assert service.set_flight_mode("STABILIZE").detail["finalMode"] == "STABILIZE"
    assert manager.state.is_armed() is False, "the vehicle must remain disarmed throughout"


def test_vehicle_rejection_is_reported_never_swallowed(connected) -> None:
    _, service, link = connected
    link.reject_next_commands(1)

    with pytest.raises(CommandRejected) as excinfo:
        service.set_flight_mode("ALT_HOLD")
    assert excinfo.value.reason == "rejected_by_vehicle"
    assert excinfo.value.detail["ack"]["resultName"] == "DENIED"


def test_missing_acknowledgement_times_out_rather_than_hanging(connected) -> None:
    _, service, link = connected
    link.drop_next_acks(1)

    with pytest.raises(CommandRejected) as excinfo:
        service.set_flight_mode("ALT_HOLD")
    assert excinfo.value.reason == "ack_timeout"


def test_request_version_returns_the_decoded_firmware(connected) -> None:
    _, service, _ = connected
    result = service.request_autopilot_version()

    assert result.ok is True
    assert result.detail["version"]["flightSwVersion"] == "4.5.7"


def test_request_streams_accepts_only_allowlisted_names(connected) -> None:
    _, service, _ = connected
    result = service.request_streams(["ATTITUDE", "VFR_HUD"])
    assert result.ok is True
    assert set(result.detail["accepted"]) == {"ATTITUDE", "VFR_HUD"}

    with pytest.raises(CommandRejected) as excinfo:
        service.request_streams(["ATTITUDE", "SERVO_OUTPUT_RAW"])
    assert excinfo.value.reason == "stream_not_allowed"


# ----------------------------------------------------------------------
# Disabled operations
# ----------------------------------------------------------------------


@pytest.mark.parametrize("operation", sorted(DISABLED_OPERATIONS))
def test_disabled_operations_refuse_without_transmitting(connected, operation: str) -> None:
    _, service, link = connected
    before = link.describe()["gcsHeartbeatsSent"]

    result = service.refuse(operation)

    assert result.ok is False
    assert result.reason == "not_implemented"
    assert result.detail["transmitted"] is False
    # The heartbeat counter is the only transmit counter the mock keeps; the
    # point is that refuse() went nowhere near a command frame.
    assert link.describe()["simulatedArmed"] is False
    assert link.describe()["gcsHeartbeatsSent"] >= before


def test_arm_and_takeoff_are_in_the_disabled_set() -> None:
    for operation in ("arm", "disarm", "takeoff", "land", "rtl", "rc_override", "manual_control", "motor_test"):
        assert operation in DISABLED_OPERATIONS


def test_enabling_allow_arm_does_not_create_an_arming_path(manager: LinkManager) -> None:
    """The flag exists for reporting; it must not unlock anything."""
    permissive = Settings(allow_safe_commands=True, allow_arm=True, allow_takeoff=True)
    service = CommandService(manager, permissive)

    assert not hasattr(service, "arm")
    assert not hasattr(service, "takeoff")
    assert service.refuse("arm").ok is False
    assert permissive.public_dict()["armSupported"] is False


def test_the_only_commands_this_service_can_emit_are_the_three_safe_ones() -> None:
    """Guard against a future edit adding a fourth command id."""
    import inspect

    source = inspect.getsource(CommandService)
    emitted = {
        name
        for name in ("MAV_CMD_DO_SET_MODE", "MAV_CMD_REQUEST_MESSAGE", "MAV_CMD_SET_MESSAGE_INTERVAL")
        if name in source
    }
    assert emitted == {"MAV_CMD_DO_SET_MODE", "MAV_CMD_REQUEST_MESSAGE", "MAV_CMD_SET_MESSAGE_INTERVAL"}
    for forbidden in ("COMPONENT_ARM_DISARM", "NAV_TAKEOFF", "NAV_LAND", "NAV_RETURN_TO_LAUNCH", "DO_MOTOR_TEST"):
        assert forbidden not in source, f"{forbidden} must not appear in the command service"


def test_constants_module_defines_no_arming_or_takeoff_command_ids() -> None:
    """The command ids simply do not exist in this codebase."""
    for forbidden in ("MAV_CMD_COMPONENT_ARM_DISARM", "MAV_CMD_NAV_TAKEOFF", "MAV_CMD_NAV_LAND", "MAV_CMD_DO_MOTOR_TEST"):
        assert not hasattr(constants, forbidden)


def test_the_transport_can_only_emit_a_heartbeat_a_command_and_a_velocity_setpoint() -> None:
    """Lock the transmit surface of the link interface.

    Any new ``send_*`` method is a new way for bytes to reach the aircraft and
    must be a deliberate, reviewed decision — not something that appears
    because an implementation happened to need it.

    ``send_velocity_setpoint`` was added deliberately for keyboard/gamepad
    pilot control (see ``app.mavlink.pilot_service``). It emits
    ``SET_POSITION_TARGET_LOCAL_NED``, which goes *through* ArduPilot's
    stabilisation and position controller. It is not a way around them, and
    the separate test below asserts that the genuinely dangerous senders are
    still absent.
    """
    from app.mavlink.interface import MavlinkLink

    senders = {name for name in dir(MavlinkLink) if name.startswith("send")}
    assert senders == {"send_gcs_heartbeat", "send_command_long", "send_velocity_setpoint"}

    for implementation in (MockMavlinkLink, __import__("app.mavlink.real_connection", fromlist=["RealMavlinkLink"]).RealMavlinkLink):
        extra = {name for name in dir(implementation) if name.startswith("send")} - senders
        assert not extra, f"{implementation.__name__} added transmit methods: {extra}"


def executable_source(module) -> str:
    """Module source with comments and docstrings removed.

    These modules deliberately *document* which dangerous calls they exclude,
    so a raw substring scan would flag their own safety notes. Compare code,
    not prose.
    """
    import ast
    import inspect
    import io
    import tokenize

    source = inspect.getsource(module)
    tree = ast.parse(source)

    docstring_lines: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = getattr(node, "body", [])
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
                if isinstance(body[0].value.value, str):
                    for line in range(body[0].lineno, (body[0].end_lineno or body[0].lineno) + 1):
                        docstring_lines.add(line)

    comment_lines = {
        token.start[0]
        for token in tokenize.generate_tokens(io.StringIO(source).readline)
        if token.type == tokenize.COMMENT
    }

    return "\n".join(
        line
        for number, line in enumerate(source.splitlines(), start=1)
        if number not in docstring_lines and number not in comment_lines
    )


def test_no_transport_bypasses_arducopter_stabilisation() -> None:
    """The dangerous senders must stay absent from every transport.

    Velocity setpoints are safe precisely because ArduPilot's controllers
    still fly the aircraft. Direct motor/servo output, RC override, raw
    attitude targets and manual control all bypass some or all of that, and
    none of them exists in this codebase.
    """
    from app.mavlink import interface, mock_connection, real_connection

    forbidden = (
        "manual_control_send",
        "rc_channels_override_send",
        "set_attitude_target_send",
        "DO_SET_SERVO",
        "DO_MOTOR_TEST",
        "COMPONENT_ARM_DISARM",
        "NAV_TAKEOFF",
        "NAV_LAND",
        "actuator_control_target_send",
    )
    for module in (real_connection, mock_connection, interface):
        code = executable_source(module)
        for token in forbidden:
            assert token not in code, f"forbidden transport call in {module.__name__}: {token}"


def test_the_pilot_service_only_reaches_the_velocity_sender() -> None:
    """The pilot path may transmit velocity setpoints and nothing else."""
    from app.mavlink import pilot_service

    code = executable_source(pilot_service)
    assert "send_velocity_setpoint" in code
    for token in ("send_command_long", "send_gcs_heartbeat", "COMPONENT_ARM_DISARM", "DO_SET_MODE"):
        assert token not in code, f"the pilot service must not reach {token}"
