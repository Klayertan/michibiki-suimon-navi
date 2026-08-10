"""Telemetry state machine: freshness, staleness, link loss, reset."""

from __future__ import annotations

import time

import pytest

from app.mavlink.constants import MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, MAV_MODE_FLAG_SAFETY_ARMED
from app.mavlink.mock_connection import MockMessage
from app.mavlink.telemetry_state import COMMANDABLE_STATES, ConnectionState, TelemetryState


@pytest.fixture
def state() -> TelemetryState:
    return TelemetryState(stale_timeout=1.0, link_lost_timeout=3.0, max_statustext=5)


def heartbeat(*, armed: bool = False, custom_mode: int = 0) -> MockMessage:
    base = MAV_MODE_FLAG_CUSTOM_MODE_ENABLED | (MAV_MODE_FLAG_SAFETY_ARMED if armed else 0)
    return MockMessage("HEARTBEAT", type=2, autopilot=3, base_mode=base, custom_mode=custom_mode)


def test_fresh_state_is_disconnected_with_no_invented_values(state: TelemetryState) -> None:
    snapshot = state.snapshot()
    assert snapshot["connectionState"] == ConnectionState.DISCONNECTED.value
    assert snapshot["battery"]["voltage"] is None
    assert snapshot["gps"]["lat"] is None
    assert snapshot["vehicle"]["armed"] is None
    assert snapshot["link"]["stale"] is True


def test_heartbeat_populates_vehicle_identity(state: TelemetryState) -> None:
    state.apply_message(heartbeat(custom_mode=2), system_id=1, component_id=1)
    vehicle = state.snapshot()["vehicle"]

    assert vehicle["flightMode"] == "ALT_HOLD"
    assert vehicle["armed"] is False
    assert vehicle["systemId"] == 1
    assert vehicle["componentId"] == 1


def test_target_component_prefers_the_observed_autopilot_component(state: TelemetryState) -> None:
    state.apply_message(heartbeat(), system_id=1, component_id=1)
    assert state.target_component(fallback=99) == 1


def test_target_component_falls_back_when_nothing_observed(state: TelemetryState) -> None:
    assert state.target_component(fallback=1) == 1


def test_gcs_heartbeat_does_not_claim_to_be_the_autopilot(state: TelemetryState) -> None:
    """A MAV_AUTOPILOT_INVALID heartbeat must not set the target component."""
    gcs = MockMessage("HEARTBEAT", type=6, autopilot=8, base_mode=0, custom_mode=0)
    state.apply_message(gcs, system_id=1, component_id=190)
    assert state.target_component(fallback=1) == 1


def test_state_goes_stale_after_the_timeout(state: TelemetryState) -> None:
    state.apply_message(heartbeat(), system_id=1, component_id=1)
    state.set_connection_state(ConnectionState.CONNECTED)
    assert state.evaluate_freshness() is ConnectionState.CONNECTED

    # Evaluate against a simulated future rather than sleeping.
    future = time.monotonic() + 1.5
    assert state.evaluate_freshness(future) is ConnectionState.TELEMETRY_STALE
    assert state.is_stale(future) is True


def test_state_goes_link_lost_after_the_longer_timeout(state: TelemetryState) -> None:
    state.apply_message(heartbeat(), system_id=1, component_id=1)
    state.set_connection_state(ConnectionState.CONNECTED)

    future = time.monotonic() + 4.0
    assert state.evaluate_freshness(future) is ConnectionState.LINK_LOST


def test_freshness_recovers_when_messages_resume(state: TelemetryState) -> None:
    state.apply_message(heartbeat(), system_id=1, component_id=1)
    state.set_connection_state(ConnectionState.CONNECTED)
    state.evaluate_freshness(time.monotonic() + 1.5)
    assert state.get_connection_state() is ConnectionState.TELEMETRY_STALE

    state.apply_message(heartbeat(), system_id=1, component_id=1)
    assert state.evaluate_freshness() is ConnectionState.CONNECTED


def test_fresh_nonheartbeat_telemetry_cannot_mask_stale_vehicle_heartbeat(
    state: TelemetryState,
) -> None:
    state.apply_message(heartbeat(armed=False, custom_mode=0), system_id=1, component_id=1)
    state.apply_message(MockMessage("SYS_STATUS", voltage_battery=16000))
    state.set_connection_state(ConnectionState.CONNECTED)
    with state._lock:
        state._last_heartbeat_mono = 100.0
        state._last_message_mono = 101.5

    assert state.evaluate_freshness(101.5) is ConnectionState.TELEMETRY_STALE
    assert state.is_stale(101.5) is True


def test_freshness_never_overwrites_a_deliberate_state(state: TelemetryState) -> None:
    """Losing telemetry while reconnecting must not relabel the state."""
    for deliberate in (
        ConnectionState.DISCONNECTED,
        ConnectionState.CONNECTING,
        ConnectionState.RECONNECTING,
        ConnectionState.ERROR,
    ):
        state.set_connection_state(deliberate)
        assert state.evaluate_freshness(time.monotonic() + 99) is deliberate


def test_stale_state_is_not_commandable(state: TelemetryState) -> None:
    """Freshness is recomputed live, so this is asserted against the clock the
    evaluation is given rather than a snapshot taken later (``snapshot()``
    re-evaluates at "now" and would report connected again)."""
    state.apply_message(heartbeat(), system_id=1, component_id=1)
    state.set_connection_state(ConnectionState.CONNECTED)
    assert state.snapshot()["commandable"] is True

    stale = state.evaluate_freshness(time.monotonic() + 1.5)
    assert stale is ConnectionState.TELEMETRY_STALE
    assert stale not in COMMANDABLE_STATES, "a stale link must never be commandable"

    lost = state.evaluate_freshness(time.monotonic() + 4.0)
    assert lost is ConnectionState.LINK_LOST
    assert lost not in COMMANDABLE_STATES


def test_armed_state_is_reported_and_unknown_is_not_disarmed(state: TelemetryState) -> None:
    assert state.is_armed() is None
    state.apply_message(heartbeat(armed=True), system_id=1, component_id=1)
    assert state.is_armed() is True


def test_statustext_ring_buffer_is_bounded(state: TelemetryState) -> None:
    for index in range(12):
        state.apply_message(MockMessage("STATUSTEXT", severity=6, text=f"line {index}"))
    texts = state.snapshot()["statusTexts"]

    assert len(texts) == 5, "the buffer must not grow without bound"
    assert texts[-1]["text"] == "line 11"
    assert all("receivedAt" in entry for entry in texts)


def test_reset_clears_vehicle_data_so_stale_values_cannot_look_live(state: TelemetryState) -> None:
    state.apply_message(heartbeat(), system_id=1, component_id=1)
    state.apply_message(MockMessage("SYS_STATUS", voltage_battery=16000))
    assert state.snapshot()["battery"]["voltage"] is not None

    state.reset_vehicle_data()
    snapshot = state.snapshot()
    assert snapshot["battery"]["voltage"] is None
    assert snapshot["vehicle"]["armed"] is None
    assert snapshot["statusTexts"] == []


def test_parameter_cache_is_normalized_filterable_and_session_scoped(state: TelemetryState) -> None:
    state.apply_message(
        MockMessage(
            "PARAM_VALUE",
            param_id=b"rcmap_roll\x00",
            param_value=1.0,
            param_type=9,
            param_count=2,
            param_index=0,
        )
    )
    state.apply_message(
        MockMessage(
            "PARAM_VALUE",
            param_id=b"RC_OVERRIDE_TIME",
            param_value=3.0,
            param_type=9,
            param_count=2,
            param_index=1,
        )
    )
    assert state.get_parameters(["RCMAP_ROLL"]) == {"RCMAP_ROLL": 1.0}
    assert state.snapshot()["parameters"]["RC_OVERRIDE_TIME"] == 3.0

    state.reset_vehicle_data()
    assert state.get_parameters() == {}
    assert state.snapshot()["parameters"] == {}


def test_errors_are_recorded_not_swallowed(state: TelemetryState) -> None:
    state.set_error("COM10 is already in use", kind="PortBusyError")
    error = state.snapshot()["error"]

    assert error["kind"] == "PortBusyError"
    assert "COM10" in error["message"]

    state.clear_error()
    assert state.snapshot()["error"] is None


def test_malformed_message_does_not_raise(state: TelemetryState) -> None:
    class Broken:
        def get_type(self):
            raise ValueError("corrupt frame")

    assert state.apply_message(Broken()) is None


def test_bad_data_frames_are_ignored(state: TelemetryState) -> None:
    assert state.apply_message(MockMessage("BAD_DATA")) is None
    assert state.snapshot()["link"]["totalMessages"] == 0


def test_unknown_message_types_count_as_link_activity(state: TelemetryState) -> None:
    """An unrecognised type is evidence the link is alive, nothing more."""
    assert state.apply_message(MockMessage("SCALED_IMU2", xacc=1)) == "SCALED_IMU2"
    snapshot = state.snapshot()
    assert snapshot["link"]["totalMessages"] == 1
    assert snapshot["vehicle"]["flightMode"] is None


def test_snapshot_returns_an_independent_copy(state: TelemetryState) -> None:
    state.apply_message(MockMessage("STATUSTEXT", severity=6, text="hello"))
    first = state.snapshot()
    first["statusTexts"].clear()
    first["vehicle"]["flightMode"] = "TAMPERED"

    assert len(state.snapshot()["statusTexts"]) == 1
    assert state.snapshot()["vehicle"]["flightMode"] is None


def test_position_availability_is_derived_not_assumed(state: TelemetryState) -> None:
    """A fused position is not, on its own, evidence of a usable fix -- see
    test_gps_availability.py for the full defect coverage. GPS fix quality
    (from GPS_RAW_INT) gates availability; GLOBAL_POSITION_INT lat/lon alone
    does not."""
    assert state.snapshot()["position"]["available"] is False
    state.apply_message(
        MockMessage("GLOBAL_POSITION_INT", lat=345400000, lon=1357350000, alt=62000, relative_alt=0)
    )
    assert state.snapshot()["position"]["available"] is False, "no GPS_RAW_INT fix type has been received yet"

    state.apply_message(MockMessage("GPS_RAW_INT", fix_type=3, satellites_visible=11, lat=345400000, lon=1357350000))
    assert state.snapshot()["position"]["available"] is True
