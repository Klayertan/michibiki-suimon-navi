"""Props-off bench ARM diagnostics: RC-input evidence, pre-arm health, and
the safe-idle RC override bench mode sends while waiting to arm.

Scenarios A-H below are the reproduction matrix for the real-hardware report
this work was written against: "ARM rejected: FAILED" with no detailed
reason. None of these tests open a serial port or touch real hardware --
every one runs against MockMavlinkLink, and RC_CHANNELS/SYS_STATUS values are
injected the same way STATUSTEXT already is in test_command_service.py.

Nothing here disables ARMING_CHECK, writes a Pixhawk parameter, or sends
MAV_CMD_COMPONENT_ARM_DISARM with anything but the normal param2=0.
"""

from __future__ import annotations

import dataclasses
import time

import pytest

from app.config import Settings
from app.mavlink import constants, pilot_limits
from app.mavlink.command_service import CommandRejected, CommandService
from app.mavlink.link_manager import LinkManager
from app.mavlink.mock_connection import DEFAULT_MOCK_PARAMETERS, MockMavlinkLink, MockMessage, MockScenario
from app.mavlink.pilot_limits import RELEASE_RC_OVERRIDE, normalized_to_rc_override, rc_configuration_from_parameters
from app.mavlink.pilot_service import BlockReason, PilotService
from app.mavlink.telemetry_state import ConnectionState, TelemetryState

from .conftest import wait_until


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class RecordingLink:
    def __init__(self) -> None:
        self.overrides: list[dict] = []

    def send_rc_channels_override(self, *, target_system, target_component, channels):
        self.overrides.append({"target_system": target_system, "target_component": target_component, "channels": channels})


def tick(service: PilotService, link: RecordingLink, clock: FakeClock, *, times: int = 1, step: float = 0.1) -> None:
    for _ in range(times):
        service.tick(link, target_system=1, target_component=1)
        clock.advance(step)


def load_parameters(state: TelemetryState, values: dict[str, float] | None = None) -> None:
    selected = DEFAULT_MOCK_PARAMETERS if values is None else values
    for index, (name, value) in enumerate(selected.items()):
        state.apply_message(
            MockMessage("PARAM_VALUE", param_id=name.encode("ascii"), param_value=value, param_type=9,
                        param_count=len(selected), param_index=index),
            system_id=1, component_id=1,
        )


def set_vehicle(state: TelemetryState, *, mode: str = "STABILIZE", armed: bool = False,
                 connected: ConnectionState = ConnectionState.CONNECTED) -> None:
    custom_mode = next(number for number, name in constants.ARDUCOPTER_MODES.items() if name == mode)
    base_mode = constants.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED
    if armed:
        base_mode |= constants.MAV_MODE_FLAG_SAFETY_ARMED
    state.apply_message(
        MockMessage("HEARTBEAT", type=2, autopilot=3, base_mode=base_mode, custom_mode=custom_mode, system_status=3),
        system_id=1, component_id=1,
    )
    state.set_connection_state(connected)


def inject_rc_channels(state: TelemetryState, *, chan1=None, chan2=None, chan3=None, chan4=None) -> None:
    """The vehicle's own RC_CHANNELS report, as ArduPilot would send it."""
    fields = {"chancount": 4, "rssi": 200}
    for index, value in enumerate((chan1, chan2, chan3, chan4), start=1):
        fields[f"chan{index}_raw"] = 65535 if value is None else value
    for index in range(5, 9):
        fields[f"chan{index}_raw"] = 65535
    state.apply_message(MockMessage("RC_CHANNELS", **fields), system_id=1, component_id=1)


def inject_prearm_health(state: TelemetryState, *, prearm_ok: bool | None, rc_receiver_ok: bool | None = True) -> None:
    """SYS_STATUS with the PREARM_CHECK and RC_RECEIVER sensor bits set to a
    chosen health state. `None` means the bit is not reported present at
    all, matching real firmware that does not expose it."""
    present = 0
    enabled = 0
    health = 0
    if prearm_ok is not None:
        present |= constants.MAV_SYS_STATUS_PREARM_CHECK
        enabled |= constants.MAV_SYS_STATUS_PREARM_CHECK
        if prearm_ok:
            health |= constants.MAV_SYS_STATUS_PREARM_CHECK
    if rc_receiver_ok is not None:
        present |= constants.MAV_SYS_STATUS_SENSOR_RC_RECEIVER
        enabled |= constants.MAV_SYS_STATUS_SENSOR_RC_RECEIVER
        if rc_receiver_ok:
            health |= constants.MAV_SYS_STATUS_SENSOR_RC_RECEIVER
    state.apply_message(
        MockMessage(
            "SYS_STATUS",
            onboard_control_sensors_present=present,
            onboard_control_sensors_enabled=enabled,
            onboard_control_sensors_health=health,
            voltage_battery=16000, current_battery=-1, battery_remaining=-1,
            drop_rate_comm=0, errors_comm=0,
        ),
        system_id=1, component_id=1,
    )


def build_service(*, clock: FakeClock | None = None) -> tuple[PilotService, TelemetryState, FakeClock]:
    state = TelemetryState(stale_timeout=3.0, link_lost_timeout=10.0, max_statustext=20)
    settings = Settings(mode="mock", allow_pilot_control=True, source_system=255)
    return PilotService(settings, state, clock=clock or FakeClock()), state, clock or FakeClock()


# ===========================================================================
# Scenario A: no RC configuration yet -> full release, arm refused at our
# own gate (never reaches the vehicle with no valid RC picture at all).
# ===========================================================================


def test_scenario_a_no_rc_configuration_means_full_release_not_safe_idle() -> None:
    service, state, clock = build_service()
    set_vehicle(state, armed=False)
    # Deliberately no load_parameters(): RCMAP/calibration unknown.
    service.enable_bench(props_removed_ack=True)

    link = RecordingLink()
    tick(service, link, clock)

    assert link.overrides[-1]["channels"] == RELEASE_RC_OVERRIDE.channels
    snapshot = service.snapshot()
    assert snapshot["readyToArm"] is False
    assert snapshot["armingInputActive"] is False
    assert snapshot["blockedReason"] in (
        BlockReason.RC_CONFIGURATION_MISSING,
        BlockReason.RC_CONFIGURATION_INVALID,
    )


# ===========================================================================
# Scenario B: valid RC configuration, disarmed and waiting -> safe idle is
# active (throttle at the safe-low endpoint for STABILIZE), and a normal ARM
# through the full CommandService path succeeds.
# ===========================================================================


@pytest.fixture
def bench_arm_capable(settings: Settings):
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
        yield manager, service, link, pilot
    finally:
        manager.shutdown()


def test_scenario_b_safe_idle_present_and_normal_arm_succeeds(bench_arm_capable) -> None:
    manager, service, link, pilot = bench_arm_capable
    pilot.enable_bench(props_removed_ack=True)
    assert wait_until(lambda: pilot.snapshot()["armingInputActive"] is True)

    configuration = rc_configuration_from_parameters(DEFAULT_MOCK_PARAMETERS, source_system=255)
    expected_idle = normalized_to_rc_override(
        pitch=0.0, roll=0.0, throttle=0.0, yaw=0.0,
        configuration=configuration, limits=pilot_limits.BENCH_RC_LIMITS, mode="STABILIZE",
    )
    # STABILIZE's safe-low throttle endpoint is the calibrated minimum, not
    # RC trim -- the single most important number in this whole feature.
    assert expected_idle.channels[2] == 1100  # RCMAP_THROTTLE=3, RC3_MIN=1100
    assert wait_until(lambda: link.rc_override_log and link.rc_override_log[-1]["channels"] == expected_idle.channels)

    result = service.arm(confirmed=True)
    assert result.detail["finalArmed"] is True
    # Safe idle continues right through arming -- ArduPilot never loses valid
    # RC input across the transition. Real movement still requires the
    # explicit post-arm dead-man release + fresh repress (see
    # test_arm_requires_post_confirmation_deadman_release_and_newer_repress);
    # this snapshot is taken before that handshake, so it stays idle, not
    # blocked and not moving.
    assert pilot.snapshot()["armingInputActive"] is True
    assert pilot.snapshot()["blockedReason"] == BlockReason.ARMING_INPUT_BARRIER

    pilot.submit(deadman=False, source="keyboard", sequence=90)
    pilot.submit(throttle=0.1, deadman=True, source="keyboard", sequence=91)
    assert wait_until(lambda: pilot.snapshot()["transmitting"] is True)
    assert pilot.snapshot()["armingInputActive"] is False  # real movement now, not idle

    service.disarm(confirmed=True)


def test_scenario_b_bench_disabled_still_fully_releases_while_disarmed(bench_arm_capable) -> None:
    """The safe-idle behaviour is opt-in via Bench Pilot; general (non-bench)
    enable is completely unaffected."""
    manager, service, link, pilot = bench_arm_capable
    pilot.enable()
    assert wait_until(lambda: pilot.snapshot()["enabled"] is True)
    time.sleep(0.15)
    assert not any(entry["channels"] != RELEASE_RC_OVERRIDE.channels for entry in link.rc_override_log)
    assert pilot.snapshot()["armingInputActive"] is False


# ===========================================================================
# Scenarios C/D: throttle failsafe is diagnostic-only. This backend never
# reads FS_THR_* as an arming gate, only displays it -- these tests prove
# both halves: the values are exposed, and they do not change ARM eligibility.
# ===========================================================================


def test_scenario_c_throttle_above_failsafe_is_reported_but_never_blocks_arm() -> None:
    service, state, clock = build_service()
    load_parameters(state, {**DEFAULT_MOCK_PARAMETERS, "FS_THR_ENABLE": 1.0, "FS_THR_VALUE": 975.0})
    set_vehicle(state, armed=False)
    service.enable_bench(props_removed_ack=True)

    diagnostics = service.snapshot()["throttleFailsafe"]
    assert diagnostics == {"enabled": True, "enableRaw": 1, "valuePwm": 975}
    # Safe-idle throttle (1100, the calibrated minimum) sits comfortably above
    # 975 -- "too high to be in failsafe" is exactly the point of using the
    # minimum rather than some arbitrary low value.
    assert service.snapshot()["readyToArm"] is True


def test_scenario_d_throttle_failsafe_missing_is_reported_as_unknown_never_assumed() -> None:
    service, state, clock = build_service()
    load_parameters(state)  # DEFAULT_MOCK_PARAMETERS has no FS_THR_* at all
    set_vehicle(state, armed=False)
    service.enable_bench(props_removed_ack=True)

    assert service.snapshot()["throttleFailsafe"] is None
    assert service.snapshot()["readyToArm"] is True


# ===========================================================================
# Scenario E: rejected/default RC calibration -> fails closed, never a safe
# value invented from an invalid range.
# ===========================================================================


@pytest.mark.parametrize(
    "bad_channel_3",
    [
        {"RC3_MIN": 1500.0, "RC3_TRIM": 1500.0, "RC3_MAX": 1500.0},  # MIN==MAX
        {"RC3_MIN": 2200.0, "RC3_TRIM": 1500.0, "RC3_MAX": 1100.0},  # inverted
    ],
)
def test_scenario_e_invalid_rc_calibration_fails_closed(bad_channel_3: dict[str, float]) -> None:
    service, state, clock = build_service()
    load_parameters(state, {**DEFAULT_MOCK_PARAMETERS, **bad_channel_3})
    set_vehicle(state, armed=False)
    service.enable_bench(props_removed_ack=True)

    link = RecordingLink()
    tick(service, link, clock)
    assert link.overrides[-1]["channels"] == RELEASE_RC_OVERRIDE.channels
    snapshot = service.snapshot()
    assert snapshot["armingInputActive"] is False
    assert snapshot["readyToArm"] is False
    # RcChannelCalibration.validate() raises the more specific
    # "rc_calibration_invalid" (there is no BlockReason constant for it --
    # the reason string is propagated from pilot_limits.py verbatim).
    assert snapshot["blockedReason"] == "rc_calibration_invalid"


# ===========================================================================
# Scenario F: RCMAP remapped -- safe idle lands on the vehicle's actual
# channels, never a hardcoded CH1-4 assumption.
# ===========================================================================


def test_scenario_f_safe_idle_follows_a_remapped_rcmap() -> None:
    remapped = {
        **DEFAULT_MOCK_PARAMETERS,
        "RCMAP_ROLL": 5.0,
        "RCMAP_PITCH": 6.0,
        "RCMAP_THROTTLE": 7.0,
        "RCMAP_YAW": 8.0,
    }
    service, state, clock = build_service()
    load_parameters(state, remapped)
    set_vehicle(state, armed=False)
    service.enable_bench(props_removed_ack=True)

    link = RecordingLink()
    tick(service, link, clock)
    channels = link.overrides[-1]["channels"]

    configuration = rc_configuration_from_parameters(remapped, source_system=255)
    expected = normalized_to_rc_override(
        pitch=0.0, roll=0.0, throttle=0.0, yaw=0.0,
        configuration=configuration, limits=pilot_limits.BENCH_RC_LIMITS, mode="STABILIZE",
    )
    assert channels == expected.channels
    # The un-mapped low channels (1-4) must stay IGNORE, not accidentally
    # receive a value meant for 5-8.
    assert channels[0] == constants.RC_CHANNEL_IGNORE
    assert channels[1] == constants.RC_CHANNEL_IGNORE
    assert channels[2] == constants.RC_CHANNEL_IGNORE
    assert channels[3] == constants.RC_CHANNEL_IGNORE
    # CH7 (throttle) is the safe-low endpoint, matching STABILIZE semantics.
    assert channels[6] == 1100


# ===========================================================================
# Scenarios G/H: the vehicle's own pre-arm health bit, PASS vs FAIL vs
# UNKNOWN, surfaced without enumerating which underlying check failed.
# ===========================================================================


def test_scenario_g_prearm_health_false_is_exposed_as_fail() -> None:
    state = TelemetryState(stale_timeout=3.0, link_lost_timeout=10.0, max_statustext=10)
    inject_prearm_health(state, prearm_ok=False)
    assert state.snapshot()["prearmCheck"] is False


def test_scenario_h_prearm_health_true_is_exposed_as_pass() -> None:
    state = TelemetryState(stale_timeout=3.0, link_lost_timeout=10.0, max_statustext=10)
    inject_prearm_health(state, prearm_ok=True)
    assert state.snapshot()["prearmCheck"] is True


def test_prearm_health_absent_is_unknown_not_assumed_pass() -> None:
    state = TelemetryState(stale_timeout=3.0, link_lost_timeout=10.0, max_statustext=10)
    inject_prearm_health(state, prearm_ok=None, rc_receiver_ok=None)
    assert state.snapshot()["prearmCheck"] is None


def test_prearm_health_flows_into_the_arm_rejection_evidence(bench_arm_capable) -> None:
    manager, service, link, pilot = bench_arm_capable
    inject_prearm_health(manager.state, prearm_ok=False, rc_receiver_ok=False)
    pilot.enable_bench(props_removed_ack=True)
    assert wait_until(lambda: pilot.snapshot()["readyToArm"] is True)

    link.reject_next_commands(1)
    with pytest.raises(CommandRejected) as caught:
        service.arm(confirmed=True)

    evidence = caught.value.detail["armEvidence"]
    assert evidence["prearmCheck"] is False
    assert evidence["rc"]["receiverHealthy"] is False
    assert evidence["armed"] is False
    assert evidence["flightMode"] == "STABILIZE"
    # This is a snapshot, not a verdict: the module must never state that the
    # unhealthy bit *is* the cause, only report that it read that way.
    assert "prearmCheck" in evidence and "cause" not in evidence


# ===========================================================================
# RC_CHANNELS diagnostics reach the ARM evidence snapshot unfiltered.
# ===========================================================================


def test_rc_channels_and_override_state_reach_the_arm_evidence_snapshot(bench_arm_capable) -> None:
    manager, service, link, pilot = bench_arm_capable
    inject_rc_channels(manager.state, chan1=1500, chan2=1500, chan3=1100, chan4=1500)
    pilot.enable_bench(props_removed_ack=True)
    assert wait_until(lambda: pilot.snapshot()["readyToArm"] is True)

    link.reject_next_commands(1)
    with pytest.raises(CommandRejected) as caught:
        service.arm(confirmed=True)

    evidence = caught.value.detail["armEvidence"]
    assert evidence["rc"]["channels"][:4] == [1500, 1500, 1100, 1500]
    assert evidence["pilot"]["benchMode"] is True
    assert evidence["pilot"]["rcConfiguration"]["mapping"] == {"roll": 1, "pitch": 2, "throttle": 3, "yaw": 4}
