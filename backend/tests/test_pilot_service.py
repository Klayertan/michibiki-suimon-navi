"""Pilot velocity control: unit conversion, safety gates, timeout, framing.

Every test runs against the mock transport. Nothing here opens a serial port,
and nothing can move a real aircraft.

The two things these tests exist to protect are:

1. **Signs and units.** A sign error in ``vz`` means "climb" descends. These
   are checked against the conventions verified from the installed pymavlink
   and written down in ``app.mavlink.pilot_limits``.
2. **Fail-closed.** Every gate failure must yield exactly zero velocity, and
   no code path may keep an aircraft moving on stale input.
"""

from __future__ import annotations

import math

import pytest

from app.config import Settings
from app.mavlink import pilot_limits
from app.mavlink.link_manager import LinkManager
from app.mavlink.mock_connection import MockMavlinkLink, MockScenario
from app.mavlink.pilot_limits import (
    DEFAULT_PILOT_LIMITS,
    MAV_FRAME_BODY_NED,
    MSG_ID_SET_POSITION_TARGET_LOCAL_NED,
    TYPE_MASK_VELOCITY_YAW_RATE,
    PilotLimits,
    normalized_to_velocity,
)
from app.mavlink.pilot_service import BlockReason, PilotService
from app.mavlink.telemetry_state import ConnectionState, TelemetryState

from .conftest import wait_until

LIMITS = DEFAULT_PILOT_LIMITS


# ======================================================================
# MAVLink framing constants, verified against pymavlink
# ======================================================================


def test_message_id_frame_and_type_mask_match_pymavlink() -> None:
    from pymavlink.dialects.v20 import ardupilotmega as dialect

    assert MSG_ID_SET_POSITION_TARGET_LOCAL_NED == dialect.MAVLINK_MSG_ID_SET_POSITION_TARGET_LOCAL_NED
    assert MAV_FRAME_BODY_NED == dialect.MAV_FRAME_BODY_NED

    expected = (
        dialect.POSITION_TARGET_TYPEMASK_X_IGNORE
        | dialect.POSITION_TARGET_TYPEMASK_Y_IGNORE
        | dialect.POSITION_TARGET_TYPEMASK_Z_IGNORE
        | dialect.POSITION_TARGET_TYPEMASK_AX_IGNORE
        | dialect.POSITION_TARGET_TYPEMASK_AY_IGNORE
        | dialect.POSITION_TARGET_TYPEMASK_AZ_IGNORE
        | dialect.POSITION_TARGET_TYPEMASK_YAW_IGNORE
    )
    assert TYPE_MASK_VELOCITY_YAW_RATE == expected == 1479


def test_type_mask_uses_velocity_and_yaw_rate_and_ignores_everything_else() -> None:
    """A set bit means 'ignore'. Velocity and yaw-rate bits must stay clear or
    ArduPilot discards the very fields we are trying to send."""
    from pymavlink.dialects.v20 import ardupilotmega as dialect

    mask = TYPE_MASK_VELOCITY_YAW_RATE
    for used in ("VX_IGNORE", "VY_IGNORE", "VZ_IGNORE", "YAW_RATE_IGNORE"):
        bit = getattr(dialect, f"POSITION_TARGET_TYPEMASK_{used}")
        assert mask & bit == 0, f"{used} must be clear so the field is honoured"
    for ignored in ("X_IGNORE", "Y_IGNORE", "Z_IGNORE", "AX_IGNORE", "AY_IGNORE", "AZ_IGNORE", "YAW_IGNORE"):
        bit = getattr(dialect, f"POSITION_TARGET_TYPEMASK_{ignored}")
        assert mask & bit == bit, f"{ignored} must be set"
    assert mask & dialect.POSITION_TARGET_TYPEMASK_FORCE_SET == 0, "velocity, not force"


def test_guided_is_the_required_mode() -> None:
    from pymavlink.dialects.v20 import ardupilotmega as dialect

    assert pilot_limits.COPTER_MODE_GUIDED == dialect.COPTER_MODE_GUIDED == 4
    assert pilot_limits.REQUIRED_PILOT_MODE == "GUIDED"


# ======================================================================
# Normalized axes -> velocity: signs, limits, diagonal
# ======================================================================


def test_forward_and_backward_signs() -> None:
    assert normalized_to_velocity(forward=1, right=0, up=0, yaw=0).vx == pytest.approx(0.30)
    assert normalized_to_velocity(forward=-1, right=0, up=0, yaw=0).vx == pytest.approx(-0.30)


def test_right_and_left_signs() -> None:
    assert normalized_to_velocity(forward=0, right=1, up=0, yaw=0).vy == pytest.approx(0.30)
    assert normalized_to_velocity(forward=0, right=-1, up=0, yaw=0).vy == pytest.approx(-0.30)


def test_climb_is_negative_vz_because_ned_z_points_down() -> None:
    """The single most dangerous sign in this feature."""
    climb = normalized_to_velocity(forward=0, right=0, up=1, yaw=0)
    assert climb.vz == pytest.approx(-0.30), "climbing must be NEGATIVE vz in NED"


def test_descent_is_positive_vz_and_uses_the_lower_descent_limit() -> None:
    descend = normalized_to_velocity(forward=0, right=0, up=-1, yaw=0)
    assert descend.vz == pytest.approx(0.20), "descending must be POSITIVE vz, capped at 0.20"
    assert descend.vz < abs(normalized_to_velocity(forward=0, right=0, up=1, yaw=0).vz)


def test_yaw_sign_and_radian_conversion() -> None:
    right = normalized_to_velocity(forward=0, right=0, up=0, yaw=1)
    assert right.yaw_rate == pytest.approx(math.radians(12.0))
    assert right.yaw_rate > 0, "yaw right must be positive (clockwise from above)"
    assert normalized_to_velocity(forward=0, right=0, up=0, yaw=-1).yaw_rate == pytest.approx(-math.radians(12.0))


def test_diagonal_is_vector_normalized_to_the_horizontal_limit() -> None:
    """forward+right at full deflection must not travel sqrt(2) x the limit."""
    diagonal = normalized_to_velocity(forward=1, right=1, up=0, yaw=0)
    speed = math.hypot(diagonal.vx, diagonal.vy)
    assert speed == pytest.approx(LIMITS.max_horizontal_speed)
    assert diagonal.vx == pytest.approx(diagonal.vy), "a 45-degree input must stay at 45 degrees"


@pytest.mark.parametrize(
    ("forward", "right"),
    [(1, 1), (-1, 1), (1, -1), (-1, -1), (0.8, 0.8), (1, 0.5)],
)
def test_no_axis_combination_can_exceed_the_horizontal_limit(forward: float, right: float) -> None:
    setpoint = normalized_to_velocity(forward=forward, right=right, up=0, yaw=0)
    assert math.hypot(setpoint.vx, setpoint.vy) <= LIMITS.max_horizontal_speed + 1e-9


def test_partial_deflection_scales_linearly() -> None:
    assert normalized_to_velocity(forward=0.5, right=0, up=0, yaw=0).vx == pytest.approx(0.15)


def test_neutral_input_is_exactly_zero_with_no_negative_zero() -> None:
    neutral = normalized_to_velocity(forward=0, right=0, up=0, yaw=0)
    assert neutral.is_neutral
    assert str(neutral.vz) == "0.0", "a neutral setpoint must not render as -0.0"


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf"), None, "fast"])
def test_hostile_axis_values_become_zero_never_a_runaway(bad) -> None:
    """This is the boundary where untrusted browser input stops being trusted."""
    setpoint = normalized_to_velocity(forward=bad, right=bad, up=bad, yaw=bad)
    assert setpoint.is_neutral


def test_out_of_range_axes_are_clamped_not_amplified() -> None:
    setpoint = normalized_to_velocity(forward=1000, right=0, up=0, yaw=1000)
    assert setpoint.vx == pytest.approx(LIMITS.max_horizontal_speed)
    assert setpoint.yaw_rate == pytest.approx(LIMITS.max_yaw_rate_rad)


def test_limits_are_configurable_in_one_place() -> None:
    faster = PilotLimits(max_horizontal_speed=1.0, max_climb_speed=0.8, max_descent_speed=0.5, max_yaw_rate_deg=30.0)
    assert normalized_to_velocity(forward=1, right=0, up=0, yaw=0, limits=faster).vx == pytest.approx(1.0)
    assert normalized_to_velocity(forward=0, right=0, up=1, yaw=0, limits=faster).vz == pytest.approx(-0.8)


def test_first_flight_defaults_are_the_conservative_values() -> None:
    assert LIMITS.max_horizontal_speed == 0.30
    assert LIMITS.max_climb_speed == 0.30
    assert LIMITS.max_descent_speed == 0.20
    assert LIMITS.max_yaw_rate_deg == 12.0


# ======================================================================
# PilotService gates
# ======================================================================


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def build_service(*, allow: bool = True, clock: FakeClock | None = None):
    """A service wired to a state we can drive directly."""
    settings = Settings(mode="mock", allow_pilot_control=allow)
    state = TelemetryState(stale_timeout=1.0, link_lost_timeout=3.0, max_statustext=5)
    service = PilotService(settings, state, clock=clock or FakeClock())
    return service, state


def make_flyable(state: TelemetryState) -> None:
    """Put the telemetry state into the only condition that permits movement:
    connected, GUIDED, and armed."""
    from app.mavlink.constants import MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, MAV_MODE_FLAG_SAFETY_ARMED
    from app.mavlink.mock_connection import MockMessage

    state.apply_message(
        MockMessage(
            "HEARTBEAT",
            type=2,
            autopilot=3,
            base_mode=MAV_MODE_FLAG_CUSTOM_MODE_ENABLED | MAV_MODE_FLAG_SAFETY_ARMED,
            custom_mode=pilot_limits.COPTER_MODE_GUIDED,
        ),
        system_id=1,
        component_id=1,
    )
    state.set_connection_state(ConnectionState.CONNECTED)


class RecordingLink:
    """Captures setpoints without any transport."""

    def __init__(self) -> None:
        self.sent: list[tuple[float, float, float, float]] = []

    def send_velocity_setpoint(self, *, target_system, target_component, vx, vy, vz, yaw_rate):
        self.sent.append((vx, vy, vz, yaw_rate))


def tick(service, link, clock: FakeClock, *, times: int = 1, step: float = 0.1) -> None:
    for _ in range(times):
        service.tick(link, target_system=1, target_component=1)
        clock.advance(step)


def test_disabled_by_configuration_produces_nothing() -> None:
    clock = FakeClock()
    service, state = build_service(allow=False, clock=clock)
    make_flyable(state)
    service.enable()
    service.submit(forward=1, right=0, up=0, yaw=0)

    link = RecordingLink()
    tick(service, link, clock, times=5)

    assert link.sent == []
    assert service.snapshot()["available"] is False
    assert service.snapshot()["blockedReason"] == BlockReason.DISABLED


def test_channel_must_be_explicitly_enabled() -> None:
    clock = FakeClock()
    service, state = build_service(clock=clock)
    make_flyable(state)
    service.submit(forward=1, right=0, up=0, yaw=0)

    link = RecordingLink()
    tick(service, link, clock, times=3)
    assert link.sent == []
    assert service.snapshot()["blockedReason"] == BlockReason.NOT_ENABLED


def test_enabled_armed_guided_and_fresh_input_produces_forward_motion() -> None:
    clock = FakeClock()
    service, state = build_service(clock=clock)
    make_flyable(state)
    service.enable()
    service.submit(forward=1, right=0, up=0, yaw=0)

    link = RecordingLink()
    tick(service, link, clock, times=1)

    assert link.sent, "a fully-gated-open pilot must actually transmit"
    vx, vy, vz, yaw_rate = link.sent[-1]
    assert vx == pytest.approx(0.30)
    assert (vy, vz, yaw_rate) == (0.0, 0.0, 0.0)
    assert service.snapshot()["outputActive"] is True


def test_enabling_does_not_arm_the_aircraft() -> None:
    """Enabling the channel is not arming, and must never become arming."""
    import inspect

    from app.mavlink import pilot_service as module

    source = inspect.getsource(module)
    for token in ("COMPONENT_ARM_DISARM", "arm_disarm", "MAV_CMD_NAV_TAKEOFF", "DO_SET_SERVO", "DO_MOTOR_TEST"):
        code = "\n".join(l for l in source.splitlines() if not l.strip().startswith("#"))
        assert token not in code, f"{token} must not appear in the pilot service"

    clock = FakeClock()
    service, state = build_service(clock=clock)
    state.set_connection_state(ConnectionState.CONNECTED)
    service.enable()
    assert state.is_armed() is None, "enabling must not change the vehicle's armed state"


@pytest.mark.parametrize(
    ("link_state", "expected"),
    [
        (ConnectionState.DISCONNECTED, BlockReason.NOT_CONNECTED),
        (ConnectionState.CONNECTING, BlockReason.NOT_CONNECTED),
        (ConnectionState.RECONNECTING, BlockReason.NOT_CONNECTED),
        (ConnectionState.LINK_LOST, BlockReason.NOT_CONNECTED),
        (ConnectionState.ERROR, BlockReason.NOT_CONNECTED),
        (ConnectionState.TELEMETRY_STALE, BlockReason.TELEMETRY_STALE),
    ],
)
def test_no_movement_unless_the_link_is_solidly_connected(link_state, expected) -> None:
    clock = FakeClock()
    service, state = build_service(clock=clock)
    make_flyable(state)
    service.enable()
    service.submit(forward=1, right=0, up=0, yaw=0)
    state.set_connection_state(link_state)

    link = RecordingLink()
    tick(service, link, clock, times=3)

    assert all(sent == (0.0, 0.0, 0.0, 0.0) for sent in link.sent), "a bad link must never yield motion"
    assert service.snapshot()["blockedReason"] == expected


def test_wrong_flight_mode_fails_closed() -> None:
    """ArduPilot ignores velocity setpoints outside GUIDED, so we refuse
    rather than let the operator press keys with no effect."""
    from app.mavlink.constants import MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, MAV_MODE_FLAG_SAFETY_ARMED
    from app.mavlink.mock_connection import MockMessage

    clock = FakeClock()
    service, state = build_service(clock=clock)
    state.apply_message(
        MockMessage(
            "HEARTBEAT", type=2, autopilot=3,
            base_mode=MAV_MODE_FLAG_CUSTOM_MODE_ENABLED | MAV_MODE_FLAG_SAFETY_ARMED,
            custom_mode=0,  # STABILIZE
        ),
        system_id=1, component_id=1,
    )
    state.set_connection_state(ConnectionState.CONNECTED)
    service.enable()
    service.submit(forward=1, right=0, up=0, yaw=0)

    link = RecordingLink()
    tick(service, link, clock, times=3)
    assert all(s == (0.0, 0.0, 0.0, 0.0) for s in link.sent)
    assert service.snapshot()["blockedReason"] == BlockReason.WRONG_MODE


def test_disarmed_vehicle_produces_no_motion_command() -> None:
    from app.mavlink.constants import MAV_MODE_FLAG_CUSTOM_MODE_ENABLED
    from app.mavlink.mock_connection import MockMessage

    clock = FakeClock()
    service, state = build_service(clock=clock)
    state.apply_message(
        MockMessage(
            "HEARTBEAT", type=2, autopilot=3,
            base_mode=MAV_MODE_FLAG_CUSTOM_MODE_ENABLED,  # not armed
            custom_mode=pilot_limits.COPTER_MODE_GUIDED,
        ),
        system_id=1, component_id=1,
    )
    state.set_connection_state(ConnectionState.CONNECTED)
    service.enable()
    service.submit(forward=1, right=0, up=0, yaw=0)

    link = RecordingLink()
    tick(service, link, clock, times=3)
    assert all(s == (0.0, 0.0, 0.0, 0.0) for s in link.sent)
    assert service.snapshot()["blockedReason"] == BlockReason.DISARMED


def test_unknown_arm_state_is_treated_as_unsafe() -> None:
    clock = FakeClock()
    service, state = build_service(clock=clock)
    state.set_connection_state(ConnectionState.CONNECTED)
    service.enable()
    service.submit(forward=1, right=0, up=0, yaw=0)

    link = RecordingLink()
    tick(service, link, clock, times=2)
    assert all(s == (0.0, 0.0, 0.0, 0.0) for s in link.sent)
    # No heartbeat at all -> mode unknown too; either gate is a correct refusal.
    assert service.snapshot()["blockedReason"] in (BlockReason.WRONG_MODE, BlockReason.ARM_STATE_UNKNOWN)


# ======================================================================
# Timeout, neutral, stale input
# ======================================================================


def test_stale_input_times_out_into_neutral() -> None:
    """A wedged browser must not keep the aircraft flying."""
    clock = FakeClock()
    service, state = build_service(clock=clock)
    make_flyable(state)
    service.enable()
    service.submit(forward=1, right=0, up=0, yaw=0)

    link = RecordingLink()
    tick(service, link, clock, times=1)
    assert link.sent[-1][0] == pytest.approx(0.30)

    clock.advance(pilot_limits.PILOT_INPUT_TIMEOUT + 0.1)
    service.tick(link, target_system=1, target_component=1)

    assert link.sent[-1] == (0.0, 0.0, 0.0, 0.0)
    assert service.snapshot()["blockedReason"] == BlockReason.INPUT_TIMEOUT


def test_refreshed_input_keeps_flying() -> None:
    clock = FakeClock()
    service, state = build_service(clock=clock)
    make_flyable(state)
    service.enable()

    link = RecordingLink()
    for _ in range(6):
        service.submit(forward=1, right=0, up=0, yaw=0)
        clock.advance(0.1)
        service.tick(link, target_system=1, target_component=1)

    assert len(link.sent) >= 3
    assert all(s[0] == pytest.approx(0.30) for s in link.sent)


def test_explicit_neutral_stops_immediately() -> None:
    clock = FakeClock()
    service, state = build_service(clock=clock)
    make_flyable(state)
    service.enable()
    service.submit(forward=1, right=1, up=1, yaw=1)

    link = RecordingLink()
    tick(service, link, clock, times=1)
    assert link.sent[-1] != (0.0, 0.0, 0.0, 0.0)

    service.command_neutral()
    service.tick(link, target_system=1, target_component=1)
    assert link.sent[-1] == (0.0, 0.0, 0.0, 0.0)
    assert service.snapshot()["blockedReason"] == BlockReason.NEUTRAL_COMMANDED


def test_neutral_flag_on_an_input_overrides_its_axes() -> None:
    """Space arriving in the same frame as held keys must still stop."""
    clock = FakeClock()
    service, state = build_service(clock=clock)
    make_flyable(state)
    service.enable()
    service.submit(forward=1, right=1, up=1, yaw=1, neutral=True)

    link = RecordingLink()
    tick(service, link, clock, times=1)
    assert link.sent[-1] == (0.0, 0.0, 0.0, 0.0)


def test_neutral_is_repeated_briefly_so_a_lost_stop_frame_is_not_fatal() -> None:
    """One dropped zero frame on a lossy radio must not leave it flying."""
    clock = FakeClock()
    service, state = build_service(clock=clock)
    make_flyable(state)
    service.enable()
    service.command_neutral()

    link = RecordingLink()
    tick(service, link, clock, times=5, step=0.1)
    assert len(link.sent) >= 3, "stop must be transmitted more than once"
    assert all(s == (0.0, 0.0, 0.0, 0.0) for s in link.sent)


def test_idle_backend_eventually_stops_transmitting_entirely() -> None:
    """After the neutral-hold window, silence — no needless radio traffic."""
    clock = FakeClock()
    service, state = build_service(clock=clock)
    make_flyable(state)
    service.enable()
    service.command_neutral()

    link = RecordingLink()
    tick(service, link, clock, times=5, step=0.5)  # well past NEUTRAL_HOLD_SECONDS
    before = len(link.sent)
    tick(service, link, clock, times=5, step=0.5)
    assert len(link.sent) == before, "an idle pilot must go quiet"


def test_disable_commands_neutral_and_then_stops() -> None:
    clock = FakeClock()
    service, state = build_service(clock=clock)
    make_flyable(state)
    service.enable()
    service.submit(forward=1, right=0, up=0, yaw=0)

    link = RecordingLink()
    tick(service, link, clock, times=1)
    service.disable()
    service.tick(link, target_system=1, target_component=1)

    assert link.sent[-1] == (0.0, 0.0, 0.0, 0.0)
    assert service.snapshot()["enabled"] is False


def test_enable_does_not_inherit_a_stale_command() -> None:
    """Re-enabling must not resume whatever was last pressed."""
    clock = FakeClock()
    service, state = build_service(clock=clock)
    make_flyable(state)
    service.enable()
    service.submit(forward=1, right=0, up=0, yaw=0)
    service.disable()
    service.enable()

    link = RecordingLink()
    tick(service, link, clock, times=1)
    assert link.sent[-1] == (0.0, 0.0, 0.0, 0.0)


def test_link_loss_drops_the_desired_movement() -> None:
    clock = FakeClock()
    service, state = build_service(clock=clock)
    make_flyable(state)
    service.enable()
    service.submit(forward=1, right=0, up=0, yaw=0)

    service.on_link_lost()
    state.set_connection_state(ConnectionState.CONNECTED)  # reconnected

    link = RecordingLink()
    tick(service, link, clock, times=1)
    assert link.sent == [] or link.sent[-1] == (0.0, 0.0, 0.0, 0.0)


def test_transmit_failure_is_reported_and_does_not_raise() -> None:
    from app.mavlink.interface import LinkError

    class BrokenLink:
        def send_velocity_setpoint(self, **kwargs):
            raise LinkError("serial port went away")

    clock = FakeClock()
    service, state = build_service(clock=clock)
    make_flyable(state)
    service.enable()
    service.submit(forward=1, right=0, up=0, yaw=0)

    assert service.tick(BrokenLink(), target_system=1, target_component=1) is False
    assert service.snapshot()["blockedReason"] == BlockReason.TRANSMIT_FAILED


def test_setpoint_rate_is_limited() -> None:
    """Ticking far faster than the configured rate must not flood the link."""
    clock = FakeClock()
    service, state = build_service(clock=clock)
    make_flyable(state)
    service.enable()

    link = RecordingLink()
    for _ in range(100):
        service.submit(forward=1, right=0, up=0, yaw=0)
        service.tick(link, target_system=1, target_component=1)
        clock.advance(0.001)  # 1000 Hz of ticking

    # 100 ms of simulated time at 15 Hz is at most a couple of frames.
    assert len(link.sent) <= 3, f"rate limiting failed: {len(link.sent)} setpoints in 100 ms"


def test_rate_is_in_the_requested_10_to_20_hz_band() -> None:
    assert 10.0 <= pilot_limits.SETPOINT_RATE_HZ <= 20.0


# ======================================================================
# End-to-end through the real LinkManager worker and the mock transport
# ======================================================================


def test_pilot_setpoints_flow_through_the_link_worker(settings_factory=None) -> None:
    """The whole chain: LinkManager worker -> PilotService -> MockMavlinkLink."""
    settings = Settings(
        mode="mock",
        heartbeat_interval=0.2,
        stale_timeout=1.0,
        link_lost_timeout=2.0,
        connect_timeout=2.0,
        allow_pilot_control=True,
    )
    link = MockMavlinkLink()
    manager = LinkManager(settings, lambda: link)
    service = PilotService(settings, manager.state)
    manager.attach_pilot_service(service)
    try:
        manager.connect()
        assert wait_until(lambda: manager.state.get_connection_state() is ConnectionState.CONNECTED)

        # Mock vehicle boots disarmed in STABILIZE: both gates should refuse.
        service.enable()
        service.submit(forward=1, right=0, up=0, yaw=0)
        assert wait_until(lambda: service.snapshot()["blockedReason"] is not None)
        assert not any(
            (s["vx"], s["vy"], s["vz"], s["yaw_rate"]) != (0.0, 0.0, 0.0, 0.0)
            for s in link.velocity_setpoint_log
        ), "a disarmed STABILIZE vehicle must never receive motion"
    finally:
        manager.shutdown()


def test_no_setpoints_are_sent_when_the_feature_is_off() -> None:
    settings = Settings(mode="mock", heartbeat_interval=0.2, allow_pilot_control=False)
    link = MockMavlinkLink()
    manager = LinkManager(settings, lambda: link)
    service = PilotService(settings, manager.state)
    # Deliberately still attached: even wired up, the flag must stop it.
    manager.attach_pilot_service(service)
    try:
        manager.connect()
        assert wait_until(lambda: manager.state.get_connection_state() is ConnectionState.CONNECTED)
        service.enable()
        service.submit(forward=1, right=0, up=0, yaw=0)
        import time as _time

        _time.sleep(0.5)
        assert link.velocity_setpoint_log == []
    finally:
        manager.shutdown()


def test_link_manager_without_a_pilot_service_never_transmits_a_setpoint() -> None:
    """The default backend has no pilot service attached at all."""
    settings = Settings(mode="mock", heartbeat_interval=0.2)
    link = MockMavlinkLink()
    manager = LinkManager(settings, lambda: link)
    try:
        manager.connect()
        assert wait_until(lambda: manager.state.get_connection_state() is ConnectionState.CONNECTED)
        import time as _time

        _time.sleep(0.4)
        assert link.velocity_setpoint_log == []
    finally:
        manager.shutdown()
