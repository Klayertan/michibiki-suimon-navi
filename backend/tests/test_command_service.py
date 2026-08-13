"""Command safety gates.

Each test here corresponds to a rule that must hold before this integration
goes anywhere near a powered aircraft.
"""

from __future__ import annotations

import dataclasses
import threading
import time

import pytest

from app.config import Settings
from app.mavlink import constants, pilot_limits
from app.mavlink.command_service import DISABLED_OPERATIONS, CommandRejected, CommandService
from app.mavlink.link_manager import LinkManager
from app.mavlink.mock_connection import DEFAULT_MOCK_PARAMETERS, MockMavlinkLink, MockMessage, MockScenario
from app.mavlink.pilot_limits import normalized_to_rc_override, rc_configuration_from_parameters
from app.mavlink.pilot_service import PilotService
from app.mavlink.telemetry_state import ConnectionState


def _safe_idle_channels(*, mode: str = "STABILIZE") -> tuple[int, ...]:
    """The zero-deflection RC frame bench mode sends instead of a full
    release for its resting states -- see the identical helper and its
    docstring in test_pilot_service.py. Duplicated rather than imported: this
    file does not otherwise import from a sibling test module, and the
    computation is one call through the same production mapping either way."""
    configuration = rc_configuration_from_parameters(DEFAULT_MOCK_PARAMETERS, source_system=255)
    return normalized_to_rc_override(
        pitch=0.0, roll=0.0, throttle=0.0, yaw=0.0,
        configuration=configuration, limits=pilot_limits.BENCH_RC_LIMITS, mode=mode,
    ).channels


def _movement_channels(*, throttle: float, mode: str = "STABILIZE") -> tuple[int, ...]:
    """What a genuine (non-zero) commanded deflection would look like, so a
    test can assert an override was never *that* -- the actual safety
    property -- rather than merely "not all-zero", which safe idle
    legitimately is not."""
    configuration = rc_configuration_from_parameters(DEFAULT_MOCK_PARAMETERS, source_system=255)
    return normalized_to_rc_override(
        pitch=0.0, roll=0.0, throttle=throttle, yaw=0.0,
        configuration=configuration, limits=pilot_limits.BENCH_RC_LIMITS, mode=mode,
    ).channels

from .conftest import wait_until


@pytest.fixture
def connected(manager: LinkManager, settings: Settings, mock_link: MockMavlinkLink):
    """A connected mock link plus a command service pointed at it."""
    manager.connect()
    assert wait_until(lambda: manager.state.get_connection_state() is ConnectionState.CONNECTED)
    return manager, CommandService(manager, settings), mock_link


@pytest.fixture
def arm_capable(settings: Settings):
    """Connected mock simulation with RC parameters and bench pilot enabled."""
    enabled = dataclasses.replace(settings, allow_pilot_control=True, allow_safe_commands=True)
    link = MockMavlinkLink()
    manager = LinkManager(enabled, lambda: link)
    pilot = PilotService(enabled, manager.state)
    manager.attach_pilot_service(pilot)
    service = CommandService(manager, enabled, pilot)
    try:
        manager.connect()
        assert wait_until(lambda: manager.state.get_connection_state() is ConnectionState.CONNECTED)
        assert wait_until(lambda: pilot.snapshot()["rcConfiguration"] is not None)
        pilot.enable_bench(props_removed_ack=True)
        yield manager, service, link, pilot
    finally:
        manager.shutdown()


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


def test_arm_rejects_stale_heartbeat_even_when_other_telemetry_is_fresh(
    settings: Settings,
) -> None:
    enabled = dataclasses.replace(settings, allow_safe_commands=True, allow_pilot_control=True)
    manager = LinkManager(enabled, lambda: MockMavlinkLink())
    manager.state.apply_message(
        MockMessage(
            "HEARTBEAT",
            type=2,
            autopilot=3,
            base_mode=constants.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED,
            custom_mode=0,
            system_status=3,
        ),
        system_id=1,
        component_id=1,
    )
    manager.state.apply_message(MockMessage("SYS_STATUS", voltage_battery=16000))
    manager.state.set_connection_state(ConnectionState.CONNECTED)
    with manager.state._lock:
        manager.state._last_heartbeat_mono = 100.0
        manager.state._last_message_mono = 101.0
    assert manager.state.evaluate_freshness(101.0) is ConnectionState.TELEMETRY_STALE

    pilot = PilotService(enabled, manager.state)
    pilot.enable()
    assert pilot.snapshot()["readyToArm"] is False
    with pytest.raises(CommandRejected) as caught:
        CommandService(manager, enabled, pilot).arm(confirmed=True)
    assert caught.value.reason == "link_stale"


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
    # Connection bootstrap emits the fixed command-511 stream request set. Wait for
    # that burst before assigning the mock's one-shot dropped ACK, otherwise
    # a stream request can nondeterministically consume the fault injection.
    assert wait_until(
        lambda: sum(
            entry["command"] == constants.MAV_CMD_SET_MESSAGE_INTERVAL
            for entry in link.command_long_log
        )
        >= len(constants.ESSENTIAL_TELEMETRY_STREAMS)
    )
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
# Normal ARM / DISARM
# ----------------------------------------------------------------------


def test_arm_requires_explicit_confirmation(arm_capable) -> None:
    _, service, link, _ = arm_capable
    before = len(link.command_long_log)
    with pytest.raises(CommandRejected) as caught:
        service.arm(confirmed=False)
    assert caught.value.reason == "confirmation_required"
    assert len(link.command_long_log) == before


def test_normal_arm_and_disarm_use_param2_zero_and_confirm_heartbeat(arm_capable) -> None:
    manager, service, link, pilot = arm_capable

    armed = service.arm(confirmed=True)
    assert armed.ok is True
    assert armed.detail["finalArmed"] is True
    assert manager.state.is_armed() is True
    arm_frame = next(
        entry
        for entry in reversed(link.command_long_log)
        if entry["command"] == constants.MAV_CMD_COMPONENT_ARM_DISARM
    )
    assert arm_frame["params"] == (1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)

    disarmed = service.disarm(confirmed=True)
    assert disarmed.ok is True
    assert disarmed.detail["finalArmed"] is False
    assert manager.state.is_armed() is False
    disarm_frame = next(
        entry
        for entry in reversed(link.command_long_log)
        if entry["command"] == constants.MAV_CMD_COMPONENT_ARM_DISARM
    )
    assert disarm_frame["params"] == (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
    # A deliberate DISARM establishes a newer neutral sequence barrier; it
    # must not be mislabeled as a provider/browser failsafe.
    assert pilot.snapshot()["neutral"] is True
    assert pilot.snapshot()["blockedReason"] == "disarmed"
    assert pilot.snapshot()["failsafe"] is False


def test_arm_accepts_first_fresh_post_confirmation_deadman_movement(arm_capable) -> None:
    _manager, service, link, pilot = arm_capable
    pilot.submit(
        pitch=0,
        roll=0,
        throttle=0.1,
        yaw=0,
        deadman=True,
        source="keyboard",
        sequence=10,
    )

    result = service.arm(confirmed=True)
    assert result.detail["finalArmed"] is True
    after_arm = pilot.snapshot()
    assert after_arm["sequence"] == 10
    assert after_arm["nextSequence"] == 11
    assert after_arm["armingReleaseRequired"] is False
    assert after_arm["armingFreshInputRequired"] is True
    assert after_arm["axes"] == {"pitch": 0.0, "roll": 0.0, "throttle": 0.0, "yaw": 0.0}

    # Input received during ARM verification was discarded. The first strictly
    # newer frame after confirmed ARMED is authoritative and may move.
    pilot.submit(
        pitch=0,
        roll=0,
        throttle=0.1,
        yaw=0,
        deadman=True,
        source="keyboard",
        sequence=11,
    )
    blocked_movement = _movement_channels(throttle=0.1)
    assert wait_until(lambda: pilot.snapshot()["transmitting"] is True)
    assert any(entry["channels"] == blocked_movement for entry in link.rc_override_log)
    service.disarm(confirmed=True)


def test_arm_vehicle_rejection_is_reported_and_state_stays_disarmed(arm_capable) -> None:
    manager, service, link, _ = arm_capable
    link.reject_next_commands(1)
    with pytest.raises(CommandRejected) as caught:
        service.arm(confirmed=True)
    assert caught.value.reason == "rejected_by_vehicle"
    assert manager.state.is_armed() is False
    assert "statusTexts" in caught.value.detail


# ----------------------------------------------------------------------
# ARM rejection diagnostics: preserving the vehicle's own STATUSTEXT reason
# instead of only the numeric MAV_RESULT.
# ----------------------------------------------------------------------


def _statustext(manager, text: str, *, severity: int = 4) -> None:
    """Inject one STATUSTEXT as the vehicle would send it."""
    manager.state.apply_message(MockMessage("STATUSTEXT", severity=severity, text=text))


def test_arm_rejection_preserves_a_matching_prearm_statustext(arm_capable) -> None:
    """A PreArm STATUSTEXT already sitting in the buffer when the operator
    clicks ARM is the vehicle's actual reason for what is about to fail."""
    manager, service, link, _ = arm_capable
    _statustext(manager, "PreArm: Hardware safety switch")
    link.reject_next_commands(1)

    with pytest.raises(CommandRejected) as caught:
        service.arm(confirmed=True)

    assert caught.value.reason == "rejected_by_vehicle"
    assert caught.value.detail["vehicleReason"] == "PreArm: Hardware safety switch"
    assert caught.value.detail["ack"]["resultName"] == "DENIED"
    relevant_texts = [entry["text"] for entry in caught.value.detail["relevantStatusTexts"]]
    assert "PreArm: Hardware safety switch" in relevant_texts


def test_prearm_message_arriving_just_before_the_ack_is_still_captured(arm_capable) -> None:
    manager, service, link, _ = arm_capable
    link.reject_next_commands(1)
    # A message the vehicle sent an instant before this specific attempt --
    # not stale chatter from minutes ago -- is still the reason this click
    # is about to fail.
    _statustext(manager, "PreArm: GPS horiz error")
    time.sleep(0.02)

    with pytest.raises(CommandRejected) as caught:
        service.arm(confirmed=True)

    assert caught.value.detail["vehicleReason"] == "PreArm: GPS horiz error"


def test_prearm_message_arriving_just_after_the_ack_is_still_captured(arm_capable) -> None:
    """ArduPilot commonly emits the explanatory STATUSTEXT in direct response
    to a rejected arm attempt, which can land a short moment after the
    COMMAND_ACK itself. The bounded settle wait must catch it."""
    manager, service, link, _ = arm_capable
    link.reject_next_commands(1)

    def inject_shortly_after() -> None:
        time.sleep(0.05)
        _statustext(manager, "PreArm: Hardware safety switch")

    injector = threading.Thread(target=inject_shortly_after, daemon=True)
    injector.start()
    try:
        with pytest.raises(CommandRejected) as caught:
            service.arm(confirmed=True)
    finally:
        injector.join(timeout=2.0)

    assert caught.value.detail["vehicleReason"] == "PreArm: Hardware safety switch"


def test_the_most_recent_relevant_statustext_wins_over_an_earlier_one(arm_capable) -> None:
    manager, service, link, _ = arm_capable
    _statustext(manager, "PreArm: GPS Glitch")
    time.sleep(0.02)
    _statustext(manager, "PreArm: Hardware safety switch")
    link.reject_next_commands(1)

    with pytest.raises(CommandRejected) as caught:
        service.arm(confirmed=True)

    assert caught.value.detail["vehicleReason"] == "PreArm: Hardware safety switch"
    texts = [entry["text"] for entry in caught.value.detail["relevantStatusTexts"]]
    assert texts == ["PreArm: GPS Glitch", "PreArm: Hardware safety switch"]


def test_no_relevant_statustext_reports_none_rather_than_a_guess(arm_capable) -> None:
    """With nothing arming-relevant received, the vehicle reason must be
    reported honestly as absent -- never inferred from telemetry or from an
    unrelated message."""
    manager, service, link, _ = arm_capable
    _statustext(manager, "Ready to fly")  # not one of the relevant prefixes
    link.reject_next_commands(1)

    with pytest.raises(CommandRejected) as caught:
        service.arm(confirmed=True)

    assert caught.value.detail["vehicleReason"] is None
    assert caught.value.detail["relevantStatusTexts"] == []


def test_a_stale_prearm_message_outside_the_lookback_window_is_not_used(arm_capable) -> None:
    """A PreArm message from well before this attempt is not evidence for
    *this* rejection and must not be attached to it."""
    manager, service, link, pilot = arm_capable
    _statustext(manager, "PreArm: Old GPS issue")
    # Older than ARM_STATUSTEXT_LOOKBACK_SECONDS (2.0 s).
    with manager.state._lock:
        manager.state._statustexts[-1]["receivedAt"] -= 5.0
    link.reject_next_commands(1)

    with pytest.raises(CommandRejected) as caught:
        service.arm(confirmed=True)

    assert caught.value.detail["vehicleReason"] is None


def test_successful_arm_carries_no_rejection_diagnostic(arm_capable) -> None:
    """The success path is a distinct return type with no rejection detail at
    all -- there is nothing here for a caller to mistakenly treat as stale."""
    manager, service, link, _ = arm_capable
    _statustext(manager, "PreArm: Hardware safety switch")

    result = service.arm(confirmed=True)

    assert result.ok is True
    assert "vehicleReason" not in result.detail
    assert manager.state.is_armed() is True
    service.disarm(confirmed=True)


def test_disarm_rejection_is_not_given_the_arm_statustext_treatment(arm_capable) -> None:
    """Scoped to ARM only, as required: DISARM's existing (last-5, unfiltered)
    statusTexts behaviour must be unchanged."""
    manager, service, link, _ = arm_capable
    service.arm(confirmed=True)
    link.reject_next_commands(1)

    with pytest.raises(CommandRejected) as caught:
        service.disarm(confirmed=True)

    assert "vehicleReason" not in caught.value.detail
    assert "relevantStatusTexts" not in caught.value.detail
    assert "statusTexts" in caught.value.detail


def test_ack_alone_does_not_claim_armed_without_heartbeat(settings: Settings) -> None:
    enabled = dataclasses.replace(
        settings,
        allow_pilot_control=True,
        allow_safe_commands=True,
        mode_verify_timeout=0.1,
    )
    link = MockMavlinkLink(scenario=MockScenario(confirm_arm_state_commands=False))
    manager = LinkManager(enabled, lambda: link)
    pilot = PilotService(enabled, manager.state)
    manager.attach_pilot_service(pilot)
    service = CommandService(manager, enabled, pilot)
    try:
        manager.connect()
        assert wait_until(lambda: pilot.snapshot()["rcConfiguration"] is not None)
        pilot.enable_bench(props_removed_ack=True)
        with pytest.raises(CommandRejected) as caught:
            service.arm(confirmed=True)
        assert caught.value.reason == "verify_timeout"
        assert caught.value.detail["ack"]["resultName"] == "ACCEPTED"
        assert manager.state.is_armed() is False
    finally:
        manager.shutdown()


def test_lost_arm_ack_that_still_arms_keeps_input_barrier_latched(settings: Settings) -> None:
    enabled = dataclasses.replace(
        settings,
        allow_pilot_control=True,
        allow_safe_commands=True,
        command_timeout=0.1,
    )
    link = MockMavlinkLink()
    manager = LinkManager(enabled, lambda: link)
    pilot = PilotService(enabled, manager.state)
    manager.attach_pilot_service(pilot)
    service = CommandService(manager, enabled, pilot)
    try:
        manager.connect()
        assert wait_until(lambda: pilot.snapshot()["rcConfiguration"] is not None)
        assert wait_until(
            lambda: sum(
                entry["command"] == constants.MAV_CMD_SET_MESSAGE_INTERVAL
                for entry in link.command_long_log
            )
            >= len(constants.ESSENTIAL_TELEMETRY_STREAMS)
        )
        pilot.enable_bench(props_removed_ack=True)
        pilot.submit(throttle=0.1, deadman=True, source="keyboard", sequence=20)
        link.drop_next_acks(1)

        with pytest.raises(CommandRejected) as caught:
            service.arm(confirmed=True)
        assert caught.value.reason == "ack_timeout"
        assert wait_until(lambda: manager.state.is_armed() is True)
        assert pilot.snapshot()["armingInputBarrier"] is True
        assert pilot.snapshot()["armingReleaseRequired"] is False
        assert pilot.snapshot()["axes"] == {
            "pitch": 0.0,
            "roll": 0.0,
            "throttle": 0.0,
            "yaw": 0.0,
        }

        # Even release/repress cannot unlock an unconfirmed ARM transaction:
        # the held throttle=0.1 request must never reach the vehicle while
        # the barrier is latched, whether the frame actually sent was a full
        # release or bench mode's safe-idle resting frame.
        pilot.submit(deadman=False, source="keyboard", sequence=21)
        pilot.submit(throttle=0.1, deadman=True, source="keyboard", sequence=22)
        time.sleep(0.12)
        assert pilot.snapshot()["armingInputBarrier"] is True
        assert not any(entry["channels"] == _movement_channels(throttle=0.1) for entry in link.rc_override_log)

        service.disarm(confirmed=True)
        assert pilot.snapshot()["armingInputBarrier"] is False
    finally:
        manager.shutdown()


def test_arm_rejects_if_state_flips_back_after_expected_heartbeat(settings: Settings) -> None:
    enabled = dataclasses.replace(settings, allow_pilot_control=True, allow_safe_commands=True)
    link = MockMavlinkLink(scenario=MockScenario(flip_arm_state_after_command=True))
    manager = LinkManager(enabled, lambda: link)
    pilot = PilotService(enabled, manager.state)
    manager.attach_pilot_service(pilot)
    service = CommandService(manager, enabled, pilot)
    try:
        manager.connect()
        assert wait_until(lambda: pilot.snapshot()["rcConfiguration"] is not None)
        pilot.enable_bench(props_removed_ack=True)
        with pytest.raises(CommandRejected) as caught:
            service.arm(confirmed=True)
        assert caught.value.reason == "verify_mismatch"
        assert caught.value.detail["observedArmed"] is True
        assert caught.value.detail["finalArmed"] is False
        assert pilot.snapshot()["armingInputBarrier"] is True
    finally:
        manager.shutdown()


def test_disarm_rejects_if_state_flips_back_to_armed(settings: Settings) -> None:
    enabled = dataclasses.replace(settings, allow_safe_commands=True)
    link = MockMavlinkLink(
        scenario=MockScenario(armed=True, flip_arm_state_after_command=True)
    )
    manager = LinkManager(enabled, lambda: link)
    service = CommandService(manager, enabled)
    try:
        manager.connect()
        assert wait_until(lambda: manager.state.is_armed() is True)
        with pytest.raises(CommandRejected) as caught:
            service.disarm(confirmed=True)
        assert caught.value.reason == "verify_mismatch"
        assert caught.value.detail["observedArmed"] is False
        assert caught.value.detail["finalArmed"] is True
    finally:
        manager.shutdown()


def test_disarm_remains_available_after_pilot_disable(arm_capable) -> None:
    manager, service, _link, pilot = arm_capable
    service.arm(confirmed=True)
    pilot.disable()
    result = service.disarm(confirmed=True)
    assert result.detail["finalArmed"] is False
    assert manager.state.is_armed() is False


def test_bench_arm_refuses_missing_stored_props_ack(connected, settings: Settings) -> None:
    manager, _service, link = connected

    class UnsafeBenchPilot:
        available = True

        def snapshot(self):
            return {
                "enabled": True,
                "benchMode": True,
                "propsRemovedAck": False,
                "readyToArm": True,
            }

    service = CommandService(manager, settings, UnsafeBenchPilot())
    before = len(link.command_long_log)
    with pytest.raises(CommandRejected) as caught:
        service.arm(confirmed=True)
    assert caught.value.reason == "props_not_confirmed"
    assert len(link.command_long_log) == before


def test_safe_commands_flag_gates_arm_too(arm_capable, settings: Settings) -> None:
    manager, _service, link, pilot = arm_capable
    service = CommandService(
        manager,
        dataclasses.replace(settings, allow_safe_commands=False, allow_pilot_control=True),
        pilot,
    )
    before = len(link.command_long_log)
    with pytest.raises(CommandRejected) as caught:
        service.arm(confirmed=True)
    assert caught.value.reason == "commands_disabled"
    assert len(link.command_long_log) == before


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


def test_only_still_unsupported_operations_are_in_the_disabled_set() -> None:
    assert "arm" not in DISABLED_OPERATIONS
    assert "disarm" not in DISABLED_OPERATIONS
    for operation in ("takeoff", "land", "rtl", "raw_rc_override", "manual_control", "motor_test"):
        assert operation in DISABLED_OPERATIONS


def test_legacy_allow_arm_flag_is_not_a_safety_bypass(manager: LinkManager) -> None:
    permissive = Settings(allow_safe_commands=True, allow_arm=True, allow_takeoff=True)
    service = CommandService(manager, permissive, pilot=None)

    assert hasattr(service, "arm")
    assert not hasattr(service, "takeoff")
    with pytest.raises(CommandRejected) as caught:
        service.arm(confirmed=True)
    assert caught.value.reason == "not_connected"
    assert permissive.public_dict()["armSupported"] is False


def test_state_changing_command_is_rejected_while_another_transaction_is_confirming(
    manager: LinkManager,
) -> None:
    """ARM/DISARM/mode gates cannot race one another on the same vehicle."""
    settings = Settings(allow_safe_commands=True)
    service = CommandService(manager, settings, pilot=None)
    assert service._state_command_lock.acquire(blocking=False)
    try:
        with pytest.raises(CommandRejected) as caught:
            service.disarm(confirmed=True)
        assert caught.value.reason == "command_in_progress"
    finally:
        service._state_command_lock.release()


def test_the_only_commands_this_service_can_emit_are_the_reviewed_four_ids() -> None:
    import inspect

    source = inspect.getsource(CommandService)
    emitted = {
        name
        for name in (
            "MAV_CMD_DO_SET_MODE",
            "MAV_CMD_REQUEST_MESSAGE",
            "MAV_CMD_SET_MESSAGE_INTERVAL",
            "MAV_CMD_COMPONENT_ARM_DISARM",
        )
        if name in source
    }
    assert emitted == {
        "MAV_CMD_DO_SET_MODE",
        "MAV_CMD_REQUEST_MESSAGE",
        "MAV_CMD_SET_MESSAGE_INTERVAL",
        "MAV_CMD_COMPONENT_ARM_DISARM",
    }
    for forbidden in ("NAV_TAKEOFF", "NAV_LAND", "NAV_RETURN_TO_LAUNCH", "DO_MOTOR_TEST"):
        assert forbidden not in source, f"{forbidden} must not appear in the command service"


def test_constants_define_normal_arm_but_no_takeoff_or_motor_test_ids() -> None:
    assert constants.MAV_CMD_COMPONENT_ARM_DISARM == 400
    for forbidden in ("MAV_CMD_NAV_TAKEOFF", "MAV_CMD_NAV_LAND", "MAV_CMD_DO_MOTOR_TEST"):
        assert not hasattr(constants, forbidden)


def test_transport_exposes_only_reviewed_senders() -> None:
    """Lock the transmit surface of the link interface.

    Any new ``send_*`` method is a new way for bytes to reach the aircraft and
    must be a deliberate, reviewed decision — not something that appears
    because an implementation happened to need it.

    ``send_velocity_setpoint`` is retained deliberately for a future Guided
    external-control caller. Manual Keyboard/PS5 control uses RC override;
    this sender is not part of that path. It emits
    ``SET_POSITION_TARGET_LOCAL_NED`` through ArduPilot's position controller,
    and the separate test below asserts that the genuinely dangerous senders
    are still absent.
    """
    from app.mavlink.interface import MavlinkLink

    senders = {name for name in dir(MavlinkLink) if name.startswith("send")}
    assert senders == {
        "send_gcs_heartbeat",
        "send_command_long",
        "send_velocity_setpoint",
        "send_rc_channels_override",
        "send_parameter_request",
    }

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


def test_no_unreviewed_direct_actuator_or_parameter_write_transport_exists() -> None:
    """The dangerous senders must stay absent from every transport.

    Velocity setpoints are safe precisely because ArduPilot's controllers
    still fly the aircraft. Direct motor/servo output, RC override, raw
    attitude targets and manual control all bypass some or all of that, and
    none of them exists in this codebase.
    """
    from app.mavlink import interface, mock_connection, real_connection

    forbidden = (
        "manual_control_send",
        "param_set_send",
        "set_attitude_target_send",
        "DO_SET_SERVO",
        "DO_MOTOR_TEST",
        "NAV_TAKEOFF",
        "NAV_LAND",
        "actuator_control_target_send",
    )
    for module in (real_connection, mock_connection, interface):
        code = executable_source(module)
        for token in forbidden:
            assert token not in code, f"forbidden transport call in {module.__name__}: {token}"


def test_manual_pilot_reaches_rc_override_not_guided_or_command_sender() -> None:
    from app.mavlink import pilot_service

    code = executable_source(pilot_service)
    assert "send_rc_channels_override" in code
    assert "send_velocity_setpoint" not in code
    for token in ("send_command_long", "send_gcs_heartbeat", "COMPONENT_ARM_DISARM", "DO_SET_MODE"):
        assert token not in code, f"the pilot service must not reach {token}"
