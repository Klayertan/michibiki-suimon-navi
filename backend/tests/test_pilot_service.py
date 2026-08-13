"""Manual RC mapping, safety gates, release behavior, and sequence ordering."""

from __future__ import annotations

import math
import threading
import time

import pytest

from app.config import Settings
from app.mavlink import constants, pilot_limits
from app.mavlink.interface import LinkError
from app.mavlink.mock_connection import (
    DEFAULT_MOCK_PARAMETERS,
    MockMessage,
    MockMavlinkLink,
    MockScenario,
)
from app.mavlink.pilot_limits import (
    RELEASE_RC_OVERRIDE,
    RcConfigurationError,
    normalized_to_rc_override,
    normalized_to_velocity,
    rc_configuration_from_parameters,
)
from app.mavlink.pilot_service import (
    BlockReason,
    PilotProviderRejected,
    PilotSequenceRejected,
    PilotService,
)
from app.mavlink.telemetry_state import ConnectionState, TelemetryState


class FakeClock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class RecordingLink:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.overrides: list[dict[str, object]] = []

    def send_rc_channels_override(self, **payload: object) -> None:
        if self.fail:
            raise LinkError("serial port went away")
        self.overrides.append(payload)


class BlockingActiveLink(RecordingLink):
    """Hold one active write so release-vs-send ordering is deterministic."""

    def __init__(self) -> None:
        super().__init__()
        self.active_send_started = threading.Event()
        self.allow_active_send = threading.Event()
        self.release_returned = threading.Event()
        self.sent_after_release_return: list[tuple[int, ...]] = []

    def send_rc_channels_override(self, **payload: object) -> None:
        channels = tuple(payload["channels"])
        if channels != RELEASE_RC_OVERRIDE.channels and not self.active_send_started.is_set():
            self.active_send_started.set()
            assert self.allow_active_send.wait(2.0)
        if self.release_returned.is_set():
            self.sent_after_release_return.append(channels)
        super().send_rc_channels_override(**payload)


def build_state() -> TelemetryState:
    return TelemetryState(stale_timeout=2.0, link_lost_timeout=5.0, max_statustext=10)


def load_parameters(state: TelemetryState, values: dict[str, float] | None = None) -> None:
    selected = DEFAULT_MOCK_PARAMETERS if values is None else values
    for index, (name, value) in enumerate(selected.items()):
        state.apply_message(
            MockMessage(
                "PARAM_VALUE",
                param_id=name.encode("ascii"),
                param_value=value,
                param_type=9,
                param_count=len(selected),
                param_index=index,
            ),
            system_id=1,
            component_id=1,
        )


def set_vehicle(
    state: TelemetryState,
    *,
    mode: str = "STABILIZE",
    armed: bool = True,
    connected: ConnectionState = ConnectionState.CONNECTED,
) -> None:
    custom_mode = next(number for number, name in constants.ARDUCOPTER_MODES.items() if name == mode)
    base_mode = constants.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED
    if armed:
        base_mode |= constants.MAV_MODE_FLAG_SAFETY_ARMED
    state.apply_message(
        MockMessage(
            "HEARTBEAT",
            type=2,
            autopilot=3,
            base_mode=base_mode,
            custom_mode=custom_mode,
            system_status=3,
        ),
        system_id=1,
        component_id=1,
    )
    state.set_connection_state(connected)


def build_service(
    *,
    allow: bool = True,
    clock: FakeClock | None = None,
    state: TelemetryState | None = None,
) -> tuple[PilotService, TelemetryState, FakeClock]:
    selected_state = state or build_state()
    selected_clock = clock or FakeClock()
    settings = Settings(mode="mock", allow_pilot_control=allow, source_system=255)
    return PilotService(settings, selected_state, clock=selected_clock), selected_state, selected_clock


def ready_service(*, bench: bool = False) -> tuple[PilotService, TelemetryState, FakeClock, RecordingLink]:
    service, state, clock = build_service()
    load_parameters(state)
    set_vehicle(state)
    if bench:
        service.enable_bench(props_removed_ack=True)
    else:
        service.enable()
    # Most service tests start from an already-armed fixture. Exercise the
    # required dead-man-up handshake once so their subject can be the next
    # gate/mapping behavior; dedicated tests below cover this barrier itself.
    service.submit(deadman=False, neutral=True, source="keyboard", sequence=0)
    return service, state, clock, RecordingLink()


def send_active(
    service: PilotService,
    sequence: int,
    *,
    source: str = "ps5",
    pitch: float = 1.0,
    roll: float = 0.0,
    throttle: float = 0.0,
    yaw: float = 0.0,
) -> None:
    service.submit(
        pitch=pitch,
        roll=roll,
        throttle=throttle,
        yaw=yaw,
        deadman=True,
        neutral=False,
        source=source,
        sequence=sequence,
    )


def tick(service: PilotService, link: RecordingLink, clock: FakeClock, *, step: float = 0.1) -> bool:
    sent = service.tick(link, target_system=1, target_component=1)
    clock.advance(step)
    return sent


def expected_safe_idle_channels(*, mode: str = "STABILIZE") -> tuple[int, ...]:
    """The zero-deflection RC frame bench mode sends instead of a full
    release for its four resting states -- computed through the exact same
    production mapping the service itself uses, from the same fixture
    parameters `ready_service` loads. Deflection is zero on every axis, so
    which deflection-limit object is passed does not affect the result."""
    configuration = rc_configuration_from_parameters(DEFAULT_MOCK_PARAMETERS, source_system=255)
    return normalized_to_rc_override(
        pitch=0.0, roll=0.0, throttle=0.0, yaw=0.0,
        configuration=configuration, limits=pilot_limits.BENCH_RC_LIMITS, mode=mode,
    ).channels


# ---------------------------------------------------------------------------
# The old GUIDED transport is retained, but separate from manual control.
# ---------------------------------------------------------------------------


def test_guided_velocity_conversion_is_retained_separately() -> None:
    target = normalized_to_velocity(forward=1, right=1, up=1, yaw=1)
    assert math.hypot(target.vx, target.vy) == pytest.approx(
        pilot_limits.DEFAULT_PILOT_LIMITS.max_horizontal_speed
    )
    assert target.vz == -pilot_limits.DEFAULT_PILOT_LIMITS.max_climb_speed
    assert target.yaw_rate == pytest.approx(pilot_limits.DEFAULT_PILOT_LIMITS.max_yaw_rate_rad)
    assert hasattr(MockMavlinkLink, "send_velocity_setpoint")


def test_mavlink_rc_override_constants_match_installed_dialect() -> None:
    from pymavlink.dialects.v20 import ardupilotmega as dialect

    assert constants.MSG_ID_RC_CHANNELS_OVERRIDE == dialect.MAVLINK_MSG_ID_RC_CHANNELS_OVERRIDE == 70
    assert constants.RC_CHANNEL_RELEASE == 0
    assert constants.RC_CHANNEL_IGNORE == 0xFFFF


# ---------------------------------------------------------------------------
# Pure vehicle-calibrated mapping
# ---------------------------------------------------------------------------


def configuration(values: dict[str, float] | None = None):
    return rc_configuration_from_parameters(values or DEFAULT_MOCK_PARAMETERS, source_system=255)


def test_conventional_ps5_axes_map_to_primary_channels_and_ignore_auxiliaries() -> None:
    result = normalized_to_rc_override(
        pitch=1,
        roll=1,
        throttle=1,
        yaw=1,
        configuration=configuration(),
    )
    assert result.channels == (1900, 1100, 1900, 1900, 65535, 65535, 65535, 65535)


def test_keyboard_output_is_deliberately_reduced() -> None:
    result = normalized_to_rc_override(
        pitch=1,
        roll=1,
        throttle=1,
        yaw=1,
        configuration=configuration(),
        limits=pilot_limits.KEYBOARD_RC_LIMITS,
    )
    assert result.channels == (1600, 1400, 1220, 1600, 65535, 65535, 65535, 65535)


def test_frontend_keyboard_quarter_axis_is_not_scaled_twice() -> None:
    result = normalized_to_rc_override(
        pitch=0.25,
        roll=0.25,
        throttle=0.25,
        yaw=0.25,
        configuration=configuration(),
        limits=pilot_limits.KEYBOARD_RC_LIMITS,
        mode="STABILIZE",
    )
    # 25% pitch/roll/yaw and 15%-ceiling absolute throttle from the safe
    # endpoint. The frontend already emits the reduced 0.25 magnitude.
    assert result.channels[:4] == (1600, 1400, 1220, 1600)


def test_limits_are_magnitude_ceilings_for_analogue_input() -> None:
    limits = pilot_limits.RcDeflectionLimits(pitch=0.5, roll=0.5, throttle=0.5, yaw=0.5)
    below = normalized_to_rc_override(
        pitch=0.2,
        roll=0.2,
        throttle=0.2,
        yaw=0.2,
        configuration=configuration(),
        limits=limits,
        mode="ALT_HOLD",
    )
    above = normalized_to_rc_override(
        pitch=0.8,
        roll=0.8,
        throttle=0.8,
        yaw=0.8,
        configuration=configuration(),
        limits=limits,
        mode="ALT_HOLD",
    )
    assert below.channels[:4] == (1580, 1420, 1580, 1580)
    assert above.channels[:4] == (1700, 1300, 1700, 1700)


def test_bench_output_is_smaller_again() -> None:
    result = normalized_to_rc_override(
        pitch=1,
        roll=1,
        throttle=1,
        yaw=1,
        configuration=configuration(),
        limits=pilot_limits.BENCH_RC_LIMITS,
    )
    assert result.channels == (1560, 1440, 1180, 1560, 65535, 65535, 65535, 65535)


def test_stabilize_pitch_only_uses_safe_low_throttle_endpoint() -> None:
    result = normalized_to_rc_override(
        pitch=0.25,
        roll=0,
        throttle=0,
        yaw=0,
        configuration=configuration(),
        mode="STABILIZE",
    )
    assert result.channels[2] == 1100


def test_stabilize_bench_throttle_rises_no_more_than_ten_percent_from_low() -> None:
    result = normalized_to_rc_override(
        pitch=0,
        roll=0,
        throttle=0.25,
        yaw=0,
        configuration=configuration(),
        limits=pilot_limits.BENCH_RC_LIMITS,
        mode="STABILIZE",
    )
    assert result.channels[2] == 1180
    assert result.channels == (1500, 1500, 1180, 1500, 65535, 65535, 65535, 65535)


def test_throttle_only_changes_the_vehicle_mapped_throttle_channel() -> None:
    values = dict(DEFAULT_MOCK_PARAMETERS)
    values.update({"RCMAP_ROLL": 5, "RCMAP_PITCH": 6, "RCMAP_THROTTLE": 7, "RCMAP_YAW": 8})
    result = normalized_to_rc_override(
        pitch=0,
        roll=0,
        throttle=0.25,
        yaw=0,
        configuration=configuration(values),
        limits=pilot_limits.BENCH_RC_LIMITS,
        mode="STABILIZE",
    )
    assert result.channels == (65535, 65535, 65535, 65535, 1500, 1500, 1180, 1500)


def test_stabilize_reversed_throttle_uses_max_as_safe_low_endpoint() -> None:
    values = dict(DEFAULT_MOCK_PARAMETERS)
    values["RC3_REVERSED"] = 1
    low = normalized_to_rc_override(
        pitch=0.1,
        roll=0,
        throttle=0,
        yaw=0,
        configuration=configuration(values),
        mode="STABILIZE",
    )
    raised = normalized_to_rc_override(
        pitch=0,
        roll=0,
        throttle=0.1,
        yaw=0,
        configuration=configuration(values),
        mode="STABILIZE",
    )
    assert low.channels[2] == 1900
    assert raised.channels[2] == 1820


def test_alt_hold_throttle_uses_range_midpoint_not_rc_trim() -> None:
    values = dict(DEFAULT_MOCK_PARAMETERS)
    values["RC3_TRIM"] = 1375
    result = normalized_to_rc_override(
        pitch=0.1,
        roll=0,
        throttle=0,
        yaw=0,
        configuration=configuration(values),
        mode="ALT_HOLD",
    )
    assert result.channels[2] != 1375
    assert result.channels[2] == 1500


def test_mapping_and_channel_reversal_follow_vehicle_parameters() -> None:
    values = dict(DEFAULT_MOCK_PARAMETERS)
    values.update(
        {
            "RCMAP_ROLL": 4,
            "RCMAP_PITCH": 3,
            "RCMAP_THROTTLE": 2,
            "RCMAP_YAW": 1,
            "RC3_REVERSED": 1,
        }
    )
    result = normalized_to_rc_override(
        pitch=1,
        roll=1,
        throttle=1,
        yaw=1,
        configuration=configuration(values),
    )
    # yaw CH1 high, throttle CH2 high, pitch normally low but RC3 is reversed,
    # roll CH4 high.
    assert result.channels[:4] == (1900, 1900, 1900, 1900)


def test_release_owns_and_releases_all_first_eight_channels() -> None:
    assert RELEASE_RC_OVERRIDE.channels == (0, 0, 0, 0, 0, 0, 0, 0)
    assert RELEASE_RC_OVERRIDE.is_release is True


@pytest.mark.parametrize(
    ("name", "value", "reason"),
    [
        ("RC_OVERRIDE_TIME", 0.0, "rc_override_disabled"),
        ("RC_OVERRIDE_TIME", -1.0, "rc_override_timeout_infinite"),
        ("RC_OVERRIDE_TIME", float("inf"), "rc_configuration_invalid"),
        ("RC_OVERRIDE_TIME", 0.1, "rc_override_timeout_too_short"),
        ("RC_OVERRIDE_TIME", 121.0, "rc_override_timeout_invalid"),
        ("RC_OPTIONS", 2.0, "rc_overrides_ignored"),
        ("RCMAP_ROLL", 1.5, "rc_configuration_invalid"),
        ("RC1_REVERSED", 2.0, "rc_calibration_invalid"),
    ],
)
def test_incompatible_rc_configuration_fails_closed(name: str, value: float, reason: str) -> None:
    values = dict(DEFAULT_MOCK_PARAMETERS)
    values[name] = value
    with pytest.raises(RcConfigurationError) as caught:
        configuration(values)
    assert caught.value.reason == reason


def test_missing_rc_parameter_fails_closed_without_inventing_a_default() -> None:
    values = dict(DEFAULT_MOCK_PARAMETERS)
    del values["RC7_TRIM"]
    with pytest.raises(RcConfigurationError) as caught:
        configuration(values)
    assert caught.value.reason == "rc_configuration_missing"
    assert "RC7_TRIM" in caught.value.message


def test_enforced_gcs_system_id_mismatch_fails_closed() -> None:
    values = dict(DEFAULT_MOCK_PARAMETERS)
    values["MAV_OPTIONS"] = 1
    values["MAV_GCS_SYSID"] = 42
    with pytest.raises(RcConfigurationError) as caught:
        configuration(values)
    assert caught.value.reason == "rc_gcs_sysid_mismatch"


def test_legacy_sysid_mygcs_is_always_verified() -> None:
    accepted = configuration()
    assert accepted.source_id_parameter == "SYSID_MYGCS"
    assert accepted.sysid_mygcs == 255

    values = dict(DEFAULT_MOCK_PARAMETERS)
    values["SYSID_MYGCS"] = 42
    with pytest.raises(RcConfigurationError) as caught:
        configuration(values)
    assert caught.value.reason == "rc_gcs_sysid_mismatch"


def test_new_mav_gcs_sysid_exact_and_high_range_are_verified() -> None:
    exact = dict(DEFAULT_MOCK_PARAMETERS)
    del exact["SYSID_MYGCS"]
    exact["MAV_GCS_SYSID"] = 255
    accepted = configuration(exact)
    assert accepted.source_id_parameter == "MAV_GCS_SYSID"
    assert accepted.mav_gcs_sysid_hi is None

    exact_with_disabled_high = dict(exact)
    exact_with_disabled_high["MAV_GCS_SYSID_HI"] = 0
    assert configuration(exact_with_disabled_high).mav_gcs_sysid_hi == 0

    ranged = dict(exact)
    ranged["MAV_GCS_SYSID"] = 200
    ranged["MAV_GCS_SYSID_HI"] = 255
    accepted_range = configuration(ranged)
    assert accepted_range.mav_gcs_sysid == 200
    assert accepted_range.mav_gcs_sysid_hi == 255


def test_new_mav_gcs_sysid_range_mismatch_fails_closed() -> None:
    values = dict(DEFAULT_MOCK_PARAMETERS)
    del values["SYSID_MYGCS"]
    values["MAV_GCS_SYSID"] = 1
    values["MAV_GCS_SYSID_HI"] = 100
    with pytest.raises(RcConfigurationError) as caught:
        configuration(values)
    assert caught.value.reason == "rc_gcs_sysid_mismatch"


def test_missing_legacy_and_new_source_id_parameters_fails_closed() -> None:
    values = dict(DEFAULT_MOCK_PARAMETERS)
    del values["SYSID_MYGCS"]
    with pytest.raises(RcConfigurationError) as caught:
        configuration(values)
    assert caught.value.reason == "rc_configuration_missing"


# ---------------------------------------------------------------------------
# Service gates and release transitions
# ---------------------------------------------------------------------------


def test_stabilize_and_alt_hold_are_supported_manual_modes() -> None:
    for index, mode in enumerate(constants.MANUAL_CONTROL_MODES, start=1):
        service, state, clock = build_service()
        load_parameters(state)
        set_vehicle(state, mode=mode)
        service.enable()
        service.submit(deadman=False, neutral=True, source="keyboard", sequence=0)
        send_active(service, index)
        link = RecordingLink()
        assert tick(service, link, clock)
        assert service.snapshot()["transmitting"] is True
        assert link.overrides[-1]["channels"][1] == 1100


def test_guided_is_not_a_manual_rc_mode() -> None:
    service, state, clock = build_service()
    load_parameters(state)
    set_vehicle(state, mode="GUIDED")
    service.enable()
    service.submit(deadman=False, neutral=True, source="keyboard", sequence=0)
    send_active(service, 1)
    link = RecordingLink()
    tick(service, link, clock)
    assert link.overrides[-1]["channels"] == RELEASE_RC_OVERRIDE.channels
    assert service.snapshot()["blockedReason"] == BlockReason.WRONG_MODE


def test_disarmed_is_ready_to_arm_not_a_failsafe_error() -> None:
    service, state, _clock = build_service()
    load_parameters(state)
    set_vehicle(state, armed=False)
    service.enable()
    snapshot = service.snapshot()
    assert snapshot["blockedReason"] == BlockReason.DISARMED
    assert snapshot["readyToArm"] is True
    assert snapshot["failsafe"] is False


def test_missing_configuration_blocks_output_and_reports_diagnostic() -> None:
    service, state, clock = build_service()
    set_vehicle(state)
    service.enable()
    service.submit(deadman=False, neutral=True, source="keyboard", sequence=0)
    send_active(service, 1)
    link = RecordingLink()
    tick(service, link, clock)
    snapshot = service.snapshot()
    assert snapshot["transmitting"] is False
    assert snapshot["blockedReason"] == BlockReason.RC_CONFIGURATION_MISSING
    assert snapshot["rcConfigurationError"]["reason"] == "rc_configuration_missing"


def test_stale_heartbeat_with_fresh_other_telemetry_is_not_ready_and_sends_no_output() -> None:
    service, state, clock = build_service()
    load_parameters(state)
    set_vehicle(state, mode="STABILIZE", armed=False)
    service.enable()
    send_active(service, 1)
    with state._lock:
        state._last_heartbeat_mono = 100.0
        state._last_message_mono = 103.0  # e.g. a fresh SYS_STATUS frame
    assert state.evaluate_freshness(103.0) is ConnectionState.TELEMETRY_STALE

    link = RecordingLink()
    tick(service, link, clock)
    snapshot = service.snapshot()
    assert snapshot["readyToArm"] is False
    assert snapshot["blockedReason"] == BlockReason.TELEMETRY_STALE
    assert not any(item["channels"] != RELEASE_RC_OVERRIDE.channels for item in link.overrides)


def test_deadman_is_required_in_normal_and_bench_modes() -> None:
    """Movement never leaks through without the dead-man, in either mode --
    but bench mode's *specific* response to that is safe idle rather than a
    full release; see test_bench_deadman_released_sends_safe_idle_not_release
    for that distinction in detail."""
    for bench in (False, True):
        service, _state, clock, link = ready_service(bench=bench)
        service.submit(
            pitch=1,
            roll=0,
            throttle=0,
            yaw=0,
            deadman=False,
            source="keyboard",
            sequence=1,
        )
        tick(service, link, clock)
        sent = link.overrides[-1]["channels"]
        # Whichever frame it is, it must never contain the requested pitch=1
        # deflection: the safety property under test is "no movement without
        # dead-man", not "which specific idle frame is used".
        assert sent != normalized_to_rc_override(
            pitch=1, roll=0, throttle=0, yaw=0,
            configuration=rc_configuration_from_parameters(DEFAULT_MOCK_PARAMETERS, source_system=255),
            limits=pilot_limits.BENCH_RC_LIMITS if bench else pilot_limits.KEYBOARD_RC_LIMITS,
            mode="STABILIZE",
        ).channels
        assert sent == (RELEASE_RC_OVERRIDE.channels if not bench else expected_safe_idle_channels())
        assert service.snapshot()["blockedReason"] == BlockReason.DEADMAN_RELEASED


def test_deadman_release_takes_precedence_over_zero_axes() -> None:
    service, _state, clock, link = ready_service()
    service.submit(
        pitch=0,
        roll=0,
        throttle=0,
        yaw=0,
        deadman=False,
        neutral=False,
        source="keyboard",
        sequence=1,
    )
    tick(service, link, clock)
    assert service.snapshot()["blockedReason"] == BlockReason.DEADMAN_RELEASED


def test_deadman_release_cannot_return_before_an_inflight_active_send_is_drained() -> None:
    service, _state, clock, _recording = ready_service()
    worker_woke = threading.Event()
    service.set_worker_waker(worker_woke.set)
    send_active(service, 1)
    link = BlockingActiveLink()

    tick_thread = threading.Thread(
        target=lambda: service.tick(link, target_system=1, target_component=1),
        daemon=True,
    )
    tick_thread.start()
    assert link.active_send_started.wait(1.0)

    release_entered = threading.Event()

    def release_deadman() -> None:
        release_entered.set()
        service.submit(
            pitch=0,
            roll=0,
            throttle=0,
            yaw=0,
            deadman=False,
            neutral=False,
            source="keyboard",
            sequence=2,
        )
        link.release_returned.set()

    release_thread = threading.Thread(target=release_deadman, daemon=True)
    release_thread.start()
    assert release_entered.wait(1.0)
    assert worker_woke.wait(1.0)
    assert not link.release_returned.wait(0.05), "release returned while active send was in flight"

    link.allow_active_send.set()
    tick_thread.join(1.0)
    release_thread.join(1.0)
    assert link.release_returned.is_set()
    assert link.sent_after_release_return == []
    assert service.snapshot()["outputActive"] is False

    clock.advance(0.1)
    assert tick(service, link, clock)
    assert link.overrides[-1]["channels"] == RELEASE_RC_OVERRIDE.channels


def test_zero_axes_and_explicit_neutral_release_instead_of_sending_trims() -> None:
    service, _state, clock, link = ready_service()
    service.submit(
        pitch=0,
        roll=0,
        throttle=0,
        yaw=0,
        deadman=True,
        source="ps5",
        sequence=1,
    )
    tick(service, link, clock)
    assert link.overrides[-1]["channels"] == RELEASE_RC_OVERRIDE.channels

    service.submit(
        pitch=1,
        roll=1,
        throttle=1,
        yaw=1,
        deadman=True,
        neutral=True,
        source="ps5",
        sequence=2,
    )
    tick(service, link, clock)
    assert link.overrides[-1]["channels"] == RELEASE_RC_OVERRIDE.channels


def test_input_timeout_starts_a_new_repeated_release_window_after_long_flight() -> None:
    """Regression: release timing must not be tied to when enable happened."""
    service, _state, clock, link = ready_service()
    for sequence in range(1, 31):
        send_active(service, sequence)
        tick(service, link, clock, step=0.1)
    assert clock.now > 100.0 + pilot_limits.NEUTRAL_HOLD_SECONDS
    active_count = len(link.overrides)

    clock.advance(pilot_limits.PILOT_INPUT_TIMEOUT + 0.01)
    tick(service, link, clock)
    assert len(link.overrides) == active_count + 1
    assert link.overrides[-1]["channels"] == RELEASE_RC_OVERRIDE.channels
    assert service.snapshot()["blockedReason"] == BlockReason.INPUT_TIMEOUT
    assert service.snapshot()["failsafe"] is True

    for _ in range(3):
        tick(service, link, clock)
    assert all(entry["channels"] == RELEASE_RC_OVERRIDE.channels for entry in link.overrides[-4:])


@pytest.mark.parametrize(
    ("state_value", "reason"),
    [
        (ConnectionState.TELEMETRY_STALE, BlockReason.TELEMETRY_STALE),
        (ConnectionState.LINK_LOST, BlockReason.NOT_CONNECTED),
        (ConnectionState.DISCONNECTED, BlockReason.NOT_CONNECTED),
    ],
)
def test_link_gate_closure_releases_active_override(state_value: ConnectionState, reason: str) -> None:
    service, state, clock, link = ready_service()
    send_active(service, 1)
    tick(service, link, clock)
    state.set_connection_state(state_value)
    tick(service, link, clock)
    assert link.overrides[-1]["channels"] == RELEASE_RC_OVERRIDE.channels
    assert service.snapshot()["blockedReason"] == reason
    assert service.snapshot()["outputActive"] is False


def test_disable_releases_and_does_not_resume_old_input() -> None:
    service, _state, clock, link = ready_service()
    send_active(service, 1)
    tick(service, link, clock)
    service.disable()
    tick(service, link, clock)
    assert link.overrides[-1]["channels"] == RELEASE_RC_OVERRIDE.channels
    assert service.snapshot()["enabled"] is False
    service.enable()
    tick(service, link, clock)
    assert link.overrides[-1]["channels"] == RELEASE_RC_OVERRIDE.channels
    # Re-enabling an already-armed vehicle starts behind the universal
    # post-arm barrier; only a fresh deadman-up frame may clear it.
    assert service.snapshot()["blockedReason"] == BlockReason.ARMING_INPUT_BARRIER
    service.submit(deadman=False, neutral=True, source="keyboard", sequence=2)
    assert service.snapshot()["blockedReason"] == BlockReason.NO_INPUT


def test_mock_bench_is_supported_for_automated_acceptance() -> None:
    service, _state, _clock = build_service()
    snapshot = service.enable_bench(props_removed_ack=True)
    assert snapshot["benchMode"] is True
    assert snapshot["propsRemovedAck"] is True
    assert snapshot["benchRequiresRealMode"] is False
    assert snapshot["simulation"] is True


def test_real_mode_rejects_active_mock_provider_and_forces_release() -> None:
    state = build_state()
    clock = FakeClock()
    service = PilotService(
        Settings(mode="real", allow_pilot_control=True, source_system=255),
        state,
        clock=clock,
    )
    load_parameters(state)
    set_vehicle(state)
    service.enable()
    service.submit(deadman=False, neutral=True, source="keyboard", sequence=0)
    link = RecordingLink()
    service.submit(
        pitch=0.2,
        deadman=True,
        source="keyboard",
        provider="keyboard",
            sequence=1,
    )
    tick(service, link, clock)
    assert link.overrides[-1]["channels"] != RELEASE_RC_OVERRIDE.channels

    with pytest.raises(PilotProviderRejected):
        service.submit(
            pitch=0.2,
            deadman=True,
            source="ps5",
            provider="mock",
            sequence=2,
        )
    assert service.snapshot()["blockedReason"] == BlockReason.MOCK_PROVIDER_FORBIDDEN
    tick(service, link, clock)
    assert link.overrides[-1]["channels"] == RELEASE_RC_OVERRIDE.channels

    # Simulator-originated release is always accepted; safety requests are
    # never rejected merely because their provider cannot command movement.
    service.submit(deadman=False, neutral=True, source="ps5", provider="mock", sequence=3)
    assert service.snapshot()["blockedReason"] == BlockReason.NEUTRAL_COMMANDED


def test_mock_mode_accepts_active_mock_provider_for_browser_acceptance() -> None:
    service, _state, clock, link = ready_service()
    service.submit(
        pitch=0.2,
        deadman=True,
        source="ps5",
        provider="mock",
        sequence=1,
    )
    tick(service, link, clock)
    assert service.snapshot()["provider"] == "mock"
    assert link.overrides[-1]["channels"] != RELEASE_RC_OVERRIDE.channels


def test_bench_requires_props_acknowledgement() -> None:
    service, _state, _clock = build_service()
    snapshot = service.enable_bench(props_removed_ack=False)
    assert snapshot["enabled"] is False
    assert snapshot["propsRemovedAck"] is False


def test_out_of_order_sequence_cannot_reactivate_after_newer_neutral() -> None:
    service, _state, _clock, _link = ready_service()
    send_active(service, 10)
    service.submit(
        pitch=0,
        roll=0,
        throttle=0,
        yaw=0,
        deadman=False,
        neutral=True,
        source="keyboard",
        sequence=11,
    )
    with pytest.raises(PilotSequenceRejected) as caught:
        send_active(service, 10)
    assert caught.value.last_sequence == 11
    snapshot = service.snapshot()
    assert snapshot["sequence"] == 11
    assert snapshot["nextSequence"] == 12
    assert snapshot["neutral"] is True


def test_sequence_high_water_mark_survives_disable_and_enable() -> None:
    service, _state, _clock, _link = ready_service()
    send_active(service, 50)
    service.disable()
    service.enable()
    with pytest.raises(PilotSequenceRejected):
        send_active(service, 50)
    assert service.snapshot()["nextSequence"] == 51


def test_first_fresh_throttle_frame_after_confirmed_arm_exits_safe_idle_and_transmits() -> None:
    service, state, clock, link = ready_service(bench=True)
    set_vehicle(state, armed=False)
    send_active(service, 10)
    assert service.snapshot()["sequence"] == 10

    service.begin_arming_input_barrier()
    send_active(service, 11)  # arrives while command 400 verification is pending
    set_vehicle(state, armed=True)
    tick(service, link, clock)
    assert link.overrides[-1]["channels"] == expected_safe_idle_channels()

    service.finish_arming_input_barrier(confirmed_armed=True)
    barrier = service.snapshot()
    assert barrier["armingInputBarrier"] is True
    assert barrier["armingReleaseRequired"] is False
    assert barrier["armingFreshInputRequired"] is True
    assert barrier["axes"] == {"pitch": 0.0, "roll": 0.0, "throttle": 0.0, "yaw": 0.0}
    assert barrier["nextSequence"] == 12

    send_active(service, 12, source="keyboard", pitch=0, throttle=0.25)
    assert service.snapshot()["armingInputBarrier"] is False
    tick(service, link, clock)
    expected = (1500, 1500, 1180, 1500, 65535, 65535, 65535, 65535)
    assert link.overrides[-1]["channels"] == expected
    snapshot = service.snapshot()
    assert snapshot["transmitting"] is True
    assert snapshot["outputActive"] is True
    assert snapshot["blockedReason"] is None
    assert snapshot["lastOutgoingOverride"]["channels"] == list(expected)
    assert snapshot["lastOutgoingOverride"]["state"] == "TRANSMITTING"
    assert snapshot["lastOutgoingOverride"]["reason"] == "deadman_held_fresh_input"


def test_snapshot_uses_only_canonical_axis_names_and_source() -> None:
    service, _state, _clock, _link = ready_service()
    service.submit(
        forward=0.1,
        right=-0.2,
        up=0.3,
        yaw=-0.4,
        deadman=True,
        source="keyboard",
        sequence=1,
    )
    snapshot = service.snapshot()
    assert snapshot["axes"] == {"pitch": 0.1, "roll": -0.2, "throttle": 0.3, "yaw": -0.4}
    assert set(snapshot["axes"]) == {"pitch", "roll", "throttle", "yaw"}
    assert snapshot["source"] == "keyboard"


def test_unknown_input_source_gets_keyboard_not_full_analogue_limits() -> None:
    service, _state, clock, link = ready_service()
    send_active(service, 1, source="typo-provider")
    tick(service, link, clock)
    assert link.overrides[-1]["channels"][1] == 1400


def test_provider_failsafe_requires_a_newer_neutral_barrier_before_recovery() -> None:
    service, _state, clock, link = ready_service()
    send_active(service, 1)
    tick(service, link, clock)

    service.command_failsafe(BlockReason.PROVIDER_DISCONNECTED)
    next_sequence = service.snapshot()["nextSequence"]
    send_active(service, next_sequence)
    tick(service, link, clock)
    assert link.overrides[-1]["channels"] == RELEASE_RC_OVERRIDE.channels
    assert service.snapshot()["blockedReason"] == BlockReason.PROVIDER_DISCONNECTED

    service.command_neutral(sequence=service.snapshot()["nextSequence"])
    neutral = service.snapshot()
    assert neutral["blockedReason"] == BlockReason.NEUTRAL_COMMANDED
    assert neutral["failsafe"] is False
    send_active(service, service.snapshot()["nextSequence"])
    tick(service, link, clock)
    assert link.overrides[-1]["channels"] != RELEASE_RC_OVERRIDE.channels


def test_neutral_input_frame_clears_a_latched_provider_failsafe() -> None:
    service, _state, _clock, _link = ready_service()
    service.command_failsafe(BlockReason.PROVIDER_DISCONNECTED)
    service.submit(
        pitch=0,
        roll=0,
        throttle=0,
        yaw=0,
        deadman=False,
        neutral=True,
        source="keyboard",
        sequence=service.snapshot()["nextSequence"],
    )
    snapshot = service.snapshot()
    assert snapshot["blockedReason"] == BlockReason.NEUTRAL_COMMANDED
    assert snapshot["failsafe"] is False


def test_transmit_failure_is_visible_and_never_raises_from_tick() -> None:
    service, _state, clock, _link = ready_service()
    send_active(service, 1)
    assert tick(service, RecordingLink(fail=True), clock) is False
    snapshot = service.snapshot()
    assert snapshot["blockedReason"] == BlockReason.TRANSMIT_FAILED
    assert snapshot["transmitting"] is False
    assert snapshot["failsafe"] is True


def test_transmit_failure_drops_movement_and_retries_only_release() -> None:
    service, _state, clock, _link = ready_service()
    send_active(service, 1)
    link = RecordingLink(fail=True)
    assert tick(service, link, clock) is False

    link.fail = False
    assert tick(service, link, clock) is True
    assert link.overrides == [
        {
            "target_system": 1,
            "target_component": 1,
            "channels": RELEASE_RC_OVERRIDE.channels,
        }
    ]
    assert service.snapshot()["axes"] == {
        "pitch": 0.0,
        "roll": 0.0,
        "throttle": 0.0,
        "yaw": 0.0,
    }


def test_transmit_rate_is_limited() -> None:
    service, _state, clock, link = ready_service()
    for sequence in range(1, 101):
        send_active(service, sequence)
        service.tick(link, target_system=1, target_component=1)
        clock.advance(0.001)
    assert 1 <= len(link.overrides) <= 2


def test_immediate_release_burst_uses_all_zero_first_eight_channels() -> None:
    service, _state, _clock, link = ready_service()
    send_active(service, 1)
    assert service.release_immediately(
        link,
        target_system=1,
        target_component=1,
        reason="mavlink_disconnected",
    )
    assert len(link.overrides) == 3
    assert all(item["channels"] == RELEASE_RC_OVERRIDE.channels for item in link.overrides)


def test_worker_requests_parameters_then_transmits_manual_rc() -> None:
    settings = Settings(
        mode="mock",
        allow_pilot_control=True,
        heartbeat_interval=0.05,
        connect_timeout=1.0,
        stale_timeout=1.0,
        link_lost_timeout=2.0,
    )
    link = MockMavlinkLink()
    from app.mavlink.link_manager import LinkManager

    manager = LinkManager(settings, lambda: link)
    service = PilotService(settings, manager.state)
    manager.attach_pilot_service(service)
    try:
        manager.connect()
        deadline = time.monotonic() + 2.0
        while service.snapshot()["rcConfiguration"] is None and time.monotonic() < deadline:
            time.sleep(0.01)
        assert service.snapshot()["rcConfiguration"] is not None
        assert set(constants.REQUIRED_MANUAL_CONTROL_PARAMETERS).issubset(
            {entry["name"] for entry in link.parameter_request_log}
        )

        service.enable_bench(props_removed_ack=True)
        link.set_armed(True)
        # Let the next mock heartbeat update TelemetryState.
        deadline = time.monotonic() + 1.5
        while manager.state.is_armed() is not True and time.monotonic() < deadline:
            time.sleep(0.01)
        service.submit(deadman=False, neutral=True, source="keyboard", sequence=1)
        send_active(service, 2, source="keyboard", throttle=0.1, pitch=0)
        deadline = time.monotonic() + 1.0
        while (
            not any(entry["channels"] != RELEASE_RC_OVERRIDE.channels for entry in link.rc_override_log)
            and time.monotonic() < deadline
        ):
            time.sleep(0.01)
        assert link.rc_override_log
        assert any(entry["channels"] != RELEASE_RC_OVERRIDE.channels for entry in link.rc_override_log)
        assert link.velocity_setpoint_log == []
    finally:
        manager.shutdown()


def test_silent_receive_link_still_refreshes_active_override_at_manual_cadence() -> None:
    settings = Settings(
        mode="mock",
        allow_pilot_control=True,
        heartbeat_interval=0.2,
        connect_timeout=1.0,
        stale_timeout=1.0,
        link_lost_timeout=2.0,
    )
    link = MockMavlinkLink()
    from app.mavlink.link_manager import LinkManager

    manager = LinkManager(settings, lambda: link)
    service = PilotService(settings, manager.state)
    manager.attach_pilot_service(service)
    try:
        manager.connect()
        assert wait_until_local(lambda: service.snapshot()["rcConfiguration"] is not None)
        service.enable_bench(props_removed_ack=True)
        link.set_armed(True)
        assert wait_until_local(lambda: manager.state.is_armed() is True, timeout=1.5)

        service.submit(deadman=False, neutral=True, source="keyboard", sequence=1)
        sequence = 2
        service.submit(throttle=0.05, deadman=True, source="keyboard", sequence=sequence)
        assert wait_until_local(
            lambda: sum(entry["channels"] != RELEASE_RC_OVERRIDE.channels for entry in link.rc_override_log)
            >= 2
        )

        silence_started = time.monotonic()
        link.inject_link_loss(0.45)
        deadline = silence_started + 0.4
        while time.monotonic() < deadline:
            sequence += 1
            service.submit(throttle=0.05, deadman=True, source="keyboard", sequence=sequence)
            time.sleep(0.04)

        active_times = [
            entry["at"]
            for entry in link.rc_override_log
            if entry["at"] >= silence_started
            and entry["channels"] != RELEASE_RC_OVERRIDE.channels
        ]
        assert len(active_times) >= 5
        gaps = [later - earlier for earlier, later in zip(active_times, active_times[1:])]
        assert gaps and max(gaps) <= 0.14, gaps
    finally:
        manager.shutdown()


def test_source_id_discovery_retries_alternatives_after_first_reply_is_lost() -> None:
    class DropFirstLegacySourceReply(MockMavlinkLink):
        def __init__(self) -> None:
            super().__init__()
            self.legacy_requests = 0

        def send_parameter_request(self, *, target_system, target_component, name) -> None:
            if name == "SYSID_MYGCS":
                self.legacy_requests += 1
                if self.legacy_requests == 1:
                    self.parameter_request_log.append(
                        {
                            "target_system": target_system,
                            "target_component": target_component,
                            "name": name,
                            "at": time.monotonic(),
                        }
                    )
                    return
            super().send_parameter_request(
                target_system=target_system,
                target_component=target_component,
                name=name,
            )

    settings = Settings(mode="mock", allow_pilot_control=True, connect_timeout=1.0)
    link = DropFirstLegacySourceReply()
    from app.mavlink.link_manager import LinkManager

    manager = LinkManager(settings, lambda: link)
    service = PilotService(settings, manager.state)
    manager.attach_pilot_service(service)
    try:
        manager.connect()
        assert wait_until_local(
            lambda: service.snapshot()["rcConfiguration"] is not None,
            timeout=3.5,
        )
        assert link.legacy_requests >= 2
        assert service.snapshot()["rcConfiguration"]["sourceIdParameter"] == "SYSID_MYGCS"
    finally:
        manager.shutdown()


def test_auto_reconnect_clears_old_rc_session_before_using_new_vehicle_config() -> None:
    class FirstSessionLink(MockMavlinkLink):
        def __init__(self) -> None:
            super().__init__()
            self.fail_receive = threading.Event()

        def receive(self, timeout):
            if self.fail_receive.is_set():
                raise LinkError("first radio disconnected")
            return super().receive(timeout)

    class DelayedSecondSessionLink(MockMavlinkLink):
        def __init__(self, allow_parameters: threading.Event) -> None:
            super().__init__(
                target_component=42,
                scenario=MockScenario(
                    armed=True,
                    parameters={
                        "RCMAP_ROLL": 4,
                        "RCMAP_YAW": 1,
                        "RC4_MIN": 1000,
                        "RC4_TRIM": 1400,
                        "RC4_MAX": 1800,
                        "SYSID_MYGCS": None,
                        "MAV_GCS_SYSID": 200,
                        "MAV_GCS_SYSID_HI": 255,
                    },
                )
            )
            self.allow_parameters = allow_parameters

        def send_parameter_request(self, *, target_system, target_component, name) -> None:
            if not self.allow_parameters.is_set():
                self.parameter_request_log.append(
                    {
                        "target_system": target_system,
                        "target_component": target_component,
                        "name": name,
                        "at": time.monotonic(),
                    }
                )
                return
            super().send_parameter_request(
                target_system=target_system,
                target_component=target_component,
                name=name,
            )

    settings = Settings(
        mode="mock",
        allow_pilot_control=True,
        heartbeat_interval=0.1,
        connect_timeout=1.0,
        reconnect_delay=0.05,
        auto_reconnect=True,
        stale_timeout=1.0,
        link_lost_timeout=2.0,
    )
    first = FirstSessionLink()
    allow_second_parameters = threading.Event()
    links: list[MockMavlinkLink] = []

    def factory() -> MockMavlinkLink:
        link = first if not links else DelayedSecondSessionLink(allow_second_parameters)
        links.append(link)
        return link

    from app.mavlink.link_manager import LinkManager

    manager = LinkManager(settings, factory)
    service = PilotService(settings, manager.state)
    manager.attach_pilot_service(service)
    try:
        manager.connect()
        assert wait_until_local(lambda: service.snapshot()["rcConfiguration"] is not None)
        service.enable_bench(props_removed_ack=True)
        first.set_armed(True)
        assert wait_until_local(lambda: manager.state.is_armed() is True, timeout=1.5)
        service.submit(
            deadman=False,
            neutral=True,
            source="ps5",
            provider="browser",
            sequence=1,
        )
        service.submit(roll=0.1, deadman=True, source="ps5", provider="browser", sequence=2)
        assert wait_until_local(
            lambda: any(
                entry["channels"] != RELEASE_RC_OVERRIDE.channels
                for entry in first.rc_override_log
            )
        )

        first.fail_receive.set()
        first._wake.set()  # end the mock receive wait; no transport write
        assert wait_until_local(lambda: len(links) >= 2, timeout=2.0)
        second = links[1]
        assert wait_until_local(
            lambda: manager.state.get_connection_state() is ConnectionState.CONNECTED,
            timeout=2.0,
        )

        # The new heartbeat is live, but no new parameter replies have been
        # allowed. Old session calibration/source data must already be gone.
        waiting = service.snapshot()
        assert waiting["rcConfiguration"] is None
        assert waiting["rcConfigurationError"]["reason"] == "rc_configuration_missing"
        assert manager.state.get_parameters() == {}
        assert manager.state.target_component(settings.target_component) == 42
        assert not any(
            entry["channels"] != RELEASE_RC_OVERRIDE.channels
            for entry in second.rc_override_log
        )

        allow_second_parameters.set()
        assert wait_until_local(
            lambda: service.snapshot()["rcConfiguration"] is not None,
            timeout=3.5,
        )
        new_config = service.snapshot()["rcConfiguration"]
        assert new_config["mapping"]["roll"] == 4
        assert new_config["sourceIdParameter"] == "MAV_GCS_SYSID"
        assert new_config["mavGcsSysidHi"] == 255

        sequence = service.snapshot()["nextSequence"]
        service.submit(
            deadman=False,
            neutral=True,
            source="ps5",
            provider="browser",
            sequence=sequence,
        )
        sequence += 1
        service.submit(
            roll=0.1,
            deadman=True,
            source="ps5",
            provider="browser",
            sequence=sequence,
        )
        assert wait_until_local(
            lambda: any(
                entry["channels"] != RELEASE_RC_OVERRIDE.channels
                and entry["channels"][3] == 1440
                and entry["target_component"] == 42
                for entry in second.rc_override_log
            )
        )
    finally:
        manager.shutdown()


def wait_until_local(predicate, *, timeout: float = 1.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return bool(predicate())


def test_link_manager_runtime_tick_error_latches_failsafe_and_attempts_release() -> None:
    class ExplodingPilot:
        def __init__(self) -> None:
            self.failed = False
            self.failsafe_reasons: list[str] = []
            self.release_reasons: list[str] = []

        def set_worker_waker(self, wake_worker) -> None:
            self.wake_worker = wake_worker

        def next_tick_delay(self) -> float:
            return 0.0 if not self.failed else 0.05

        def tick(self, *_args, **_kwargs) -> bool:
            if not self.failed:
                self.failed = True
                raise RuntimeError("mapper exploded")
            return False

        def command_failsafe(self, reason: str) -> None:
            self.failsafe_reasons.append(reason)

        def release_immediately(self, _link, **kwargs) -> bool:
            self.release_reasons.append(kwargs["reason"])
            return True

        def on_link_lost(self) -> None:
            pass

    settings = Settings(mode="mock", allow_pilot_control=True, connect_timeout=1.0)
    link = MockMavlinkLink()
    from app.mavlink.link_manager import LinkManager

    manager = LinkManager(settings, lambda: link)
    pilot = ExplodingPilot()
    manager.attach_pilot_service(pilot)
    try:
        manager.connect()
        assert wait_until_local(lambda: "transmit_failed" in pilot.failsafe_reasons)
        assert "transmit_failed" in pilot.release_reasons
        assert manager.is_running() is True
    finally:
        manager.shutdown()
