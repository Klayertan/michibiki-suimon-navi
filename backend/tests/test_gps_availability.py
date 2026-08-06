"""GNSS position-availability defect.

Observed on real hardware: GPS_RAW_INT reported fix type NO_FIX, 0 satellites,
and lat/lon of exactly 0.0000000 -- yet the panel showed 測位可否: 利用可能
(position available). Two independent bugs stacked to produce this:

1. Backend (`TelemetryState.snapshot()`): `position.available` was computed
   as ``lat is not None and lon is not None`` on GLOBAL_POSITION_INT alone,
   with no reference to GPS fix quality at all. ArduPilot reports
   GLOBAL_POSITION_INT lat/lon as a literal ``0`` -- a real, non-sentinel
   integer -- while it has no fix, so "not null" was never evidence of a
   usable position.
2. Frontend (`drone-view.js` renderGps): independently re-derived
   availability as ``position.available || (gps.lat !== null ...)``, which
   would have shown 利用可能 from a bad-fix ``gps.lat`` even if (1) were
   fixed and the backend correctly sent ``available: false``. See
   ``tests/browser/drone-panel.spec.js`` for the frontend-side regression
   test proving the OR was removed.

Every test here exercises `TelemetryState` directly -- no link, no thread, no
hardware -- proving the corrected `_is_position_available()` logic.
"""

from __future__ import annotations

import time

import pytest

from app.mavlink.mock_connection import MockMessage
from app.mavlink.telemetry_state import ConnectionState, TelemetryState


@pytest.fixture
def state() -> TelemetryState:
    return TelemetryState(stale_timeout=1.0, link_lost_timeout=3.0, max_statustext=5)


def gps_raw_int(*, fix_type, satellites=10, lat=0, lon=0, alt=0) -> MockMessage:
    """Build a GPS_RAW_INT with MAVLink's actual integer encoding (1e7 deg)."""
    return MockMessage(
        "GPS_RAW_INT",
        fix_type=fix_type,
        satellites_visible=satellites,
        lat=lat,
        lon=lon,
        alt=alt,
        eph=100,
        epv=100,
    )


def global_position_int(*, lat=0, lon=0, alt=0, relative_alt=0) -> MockMessage:
    return MockMessage(
        "GLOBAL_POSITION_INT",
        lat=lat,
        lon=lon,
        alt=alt,
        relative_alt=relative_alt,
        vx=0,
        vy=0,
        vz=0,
        hdg=0,
    )


# A real, non-zero coordinate for "valid fix" cases: 34.54 N, 135.735 E
# (Nara, matching the mock's own sample location), encoded as 1e7 degrees.
VALID_LAT = 345_400_000
VALID_LON = 1_357_350_000


# --------------------------------------------------------------------------
# 1. fix type 1, satellites 0, coordinates 0/0 -> unavailable
# --------------------------------------------------------------------------


def test_no_fix_with_zero_satellites_and_zero_zero_coordinates_is_unavailable(state: TelemetryState) -> None:
    """The exact scenario observed on real hardware."""
    state.apply_message(gps_raw_int(fix_type=1, satellites=0, lat=0, lon=0))
    state.apply_message(global_position_int(lat=0, lon=0))

    snapshot = state.snapshot()
    assert snapshot["gps"]["fixTypeName"] == "NO_FIX"
    assert snapshot["gps"]["satellites"] == 0
    assert snapshot["position"]["available"] is False


# --------------------------------------------------------------------------
# 2. fix type 0 -> unavailable
# --------------------------------------------------------------------------


def test_fix_type_zero_no_gps_is_unavailable(state: TelemetryState) -> None:
    state.apply_message(gps_raw_int(fix_type=0, lat=VALID_LAT, lon=VALID_LON))
    assert state.snapshot()["position"]["available"] is False


# --------------------------------------------------------------------------
# 3. fix type null -> unavailable/unknown
# --------------------------------------------------------------------------


def test_no_gps_raw_int_ever_received_is_unavailable(state: TelemetryState) -> None:
    """fix type stays None until the first GPS_RAW_INT arrives; a fused
    position without any fix-type information yet must not read as usable."""
    state.apply_message(global_position_int(lat=VALID_LAT, lon=VALID_LON))

    snapshot = state.snapshot()
    assert snapshot["gps"]["fixType"] is None
    assert snapshot["position"]["available"] is False
    # And the raw coordinate is not fabricated to make it look otherwise.
    assert snapshot["position"]["lat"] == pytest.approx(34.54)


# --------------------------------------------------------------------------
# 4 & 5. fix type 2 / 3 with valid nonzero coordinates -> available
# --------------------------------------------------------------------------


def test_2d_fix_with_valid_coordinates_is_available(state: TelemetryState) -> None:
    state.apply_message(gps_raw_int(fix_type=2, lat=VALID_LAT, lon=VALID_LON))
    state.apply_message(global_position_int(lat=VALID_LAT, lon=VALID_LON))
    assert state.snapshot()["position"]["available"] is True


def test_3d_fix_with_valid_coordinates_is_available(state: TelemetryState) -> None:
    state.apply_message(gps_raw_int(fix_type=3, lat=VALID_LAT, lon=VALID_LON))
    state.apply_message(global_position_int(lat=VALID_LAT, lon=VALID_LON))
    assert state.snapshot()["position"]["available"] is True


@pytest.mark.parametrize("fix_type", [4, 5, 6, 7, 8])
def test_better_than_3d_fix_types_remain_available(state: TelemetryState, fix_type: int) -> None:
    """DGPS/RTK-float/RTK-fixed/static/PPP are all >= 2D_FIX quality."""
    state.apply_message(gps_raw_int(fix_type=fix_type, lat=VALID_LAT, lon=VALID_LON))
    state.apply_message(global_position_int(lat=VALID_LAT, lon=VALID_LON))
    assert state.snapshot()["position"]["available"] is True


# --------------------------------------------------------------------------
# 6. stale telemetry -> unavailable/stale
# --------------------------------------------------------------------------


def test_stale_telemetry_with_a_bad_fix_remains_unavailable(state: TelemetryState) -> None:
    state.apply_message(gps_raw_int(fix_type=1, satellites=0, lat=0, lon=0))
    state.set_connection_state(ConnectionState.CONNECTED)

    future = time.monotonic() + 5.0  # past both stale_timeout and link_lost_timeout
    stale_state = state.evaluate_freshness(future)

    assert stale_state in (ConnectionState.TELEMETRY_STALE, ConnectionState.LINK_LOST)
    assert state.snapshot()["position"]["available"] is False


def test_position_availability_is_not_reset_by_staleness_alone(state: TelemetryState) -> None:
    """Staleness (link.stale) and GPS position availability are independent
    axes: a fix that was genuinely obtained does not stop having been
    obtained just because the radio has gone quiet for a while. The
    freshness/staleness badge is the correct place to warn the operator the
    *reading is old*; flipping `available` back to false on top of that would
    conflate "no fix" with "no news", which are different problems calling
    for different operator actions."""
    state.apply_message(gps_raw_int(fix_type=3, lat=VALID_LAT, lon=VALID_LON))
    state.apply_message(global_position_int(lat=VALID_LAT, lon=VALID_LON))
    state.set_connection_state(ConnectionState.CONNECTED)
    assert state.snapshot()["position"]["available"] is True

    future = time.monotonic() + 1.5  # past stale_timeout (1.0s), not link_lost (3.0s)
    # snapshot() always re-evaluates freshness against the real clock, so the
    # injected future is checked directly via evaluate_freshness()/is_stale()
    # rather than through a snapshot() taken afterward (which would recompute
    # against "now" and see no real elapsed time).
    assert state.evaluate_freshness(future) is ConnectionState.TELEMETRY_STALE
    assert state.is_stale(future) is True

    assert state.snapshot()["position"]["available"] is True, "a previously-good fix must not be erased by staleness"


# --------------------------------------------------------------------------
# 7. mock mode with a valid 3D fix remains available
# --------------------------------------------------------------------------


def test_mock_link_default_scenario_reports_a_usable_3d_fix() -> None:
    """End-to-end through LinkManager + MockMavlinkLink, no stubbing of
    TelemetryState -- proving the real message-ingestion path, not just the
    availability helper in isolation."""
    from app.config import Settings
    from app.mavlink.link_manager import LinkManager
    from app.mavlink.mock_connection import MockMavlinkLink

    from .conftest import wait_until

    settings = Settings(
        mode="mock",
        heartbeat_interval=0.2,
        stale_timeout=1.0,
        link_lost_timeout=2.0,
        connect_timeout=2.0,
        allow_safe_commands=True,
    )
    link = MockMavlinkLink()
    manager = LinkManager(settings, lambda: link)
    try:
        manager.connect()
        assert wait_until(lambda: manager.state.get_connection_state() is ConnectionState.CONNECTED)
        assert wait_until(lambda: manager.state.snapshot()["position"]["available"] is True)

        snapshot = manager.state.snapshot()
        assert snapshot["gps"]["fixTypeName"] == "3D_FIX"
        assert snapshot["position"]["lat"] is not None
        assert snapshot["position"]["lon"] is not None
    finally:
        manager.shutdown()


# --------------------------------------------------------------------------
# 8 & 9. a single zero coordinate does not spoil an otherwise-valid fix
# --------------------------------------------------------------------------


def test_latitude_exactly_zero_is_valid_when_longitude_is_nonzero_and_fix_is_good(
    state: TelemetryState,
) -> None:
    """A vehicle sitting exactly on the equator, with a real fix and a real
    (nonzero) longitude, is a legitimate position -- lat=0 alone must not be
    treated as "no data"."""
    state.apply_message(gps_raw_int(fix_type=3, lat=0, lon=VALID_LON))
    state.apply_message(global_position_int(lat=0, lon=VALID_LON))

    snapshot = state.snapshot()
    assert snapshot["position"]["available"] is True
    assert snapshot["position"]["lat"] == 0.0
    assert snapshot["position"]["lon"] == pytest.approx(135.735)


def test_longitude_exactly_zero_is_valid_when_latitude_is_nonzero_and_fix_is_good(
    state: TelemetryState,
) -> None:
    """Symmetric case: a vehicle on the prime meridian."""
    state.apply_message(gps_raw_int(fix_type=3, lat=VALID_LAT, lon=0))
    state.apply_message(global_position_int(lat=VALID_LAT, lon=0))

    snapshot = state.snapshot()
    assert snapshot["position"]["available"] is True
    assert snapshot["position"]["lat"] == pytest.approx(34.54)
    assert snapshot["position"]["lon"] == 0.0


# --------------------------------------------------------------------------
# 10. true geographic (0, 0) with a valid fix: deliberate, documented, not
#     rejected merely because both numbers are zero
# --------------------------------------------------------------------------


def test_true_zero_zero_coordinate_with_a_valid_fix_is_available_not_rejected(
    state: TelemetryState,
) -> None:
    """(0, 0) -- the "Null Island" point in the Gulf of Guinea -- is a real,
    reachable geographic coordinate. Once the fix quality is good enough
    (>= 2D_FIX), this backend must not second-guess the vehicle by treating
    an exact-zero pair as evidence of "no fix"; that would be inventing a
    rule the MAVLink message itself does not support, and is the mirror
    image of the original bug (which trusted zero coordinates too much,
    rather than not enough). The gate is fix type, never the coordinate
    value -- see TelemetryState._is_position_available."""
    state.apply_message(gps_raw_int(fix_type=3, satellites=12, lat=0, lon=0))
    state.apply_message(global_position_int(lat=0, lon=0))

    snapshot = state.snapshot()
    assert snapshot["gps"]["fixTypeName"] == "3D_FIX"
    assert snapshot["position"]["available"] is True
    assert snapshot["position"]["lat"] == 0.0
    assert snapshot["position"]["lon"] == 0.0


# --------------------------------------------------------------------------
# Additional coverage: fallback preference, no fabrication, live transitions
# --------------------------------------------------------------------------


def test_raw_position_fields_are_never_fabricated_or_backfilled(state: TelemetryState) -> None:
    """position.lat/lon are a pure passthrough of GLOBAL_POSITION_INT --
    never synthesized from GPS_RAW_INT, even when GPS_RAW_INT is what made
    `available` true."""
    state.apply_message(gps_raw_int(fix_type=3, lat=VALID_LAT, lon=VALID_LON))
    # No GLOBAL_POSITION_INT sent at all.

    snapshot = state.snapshot()
    assert snapshot["position"]["available"] is True, "GPS_RAW_INT alone is enough once the fix is good"
    assert snapshot["position"]["lat"] is None, "the fused field must stay null, not be backfilled"
    assert snapshot["position"]["lon"] is None
    # The raw reading is still visible via the gps section, undisturbed.
    assert snapshot["gps"]["lat"] == pytest.approx(34.54)


def test_losing_fix_quality_mid_session_flips_availability_back_off(state: TelemetryState) -> None:
    state.apply_message(gps_raw_int(fix_type=3, lat=VALID_LAT, lon=VALID_LON))
    state.apply_message(global_position_int(lat=VALID_LAT, lon=VALID_LON))
    assert state.snapshot()["position"]["available"] is True

    # GPS glitches out mid-flight -- fix drops to NO_FIX.
    state.apply_message(gps_raw_int(fix_type=1, satellites=2, lat=0, lon=0))
    assert state.snapshot()["position"]["available"] is False


def test_regaining_fix_quality_mid_session_flips_availability_back_on(state: TelemetryState) -> None:
    state.apply_message(gps_raw_int(fix_type=1, satellites=0, lat=0, lon=0))
    assert state.snapshot()["position"]["available"] is False

    state.apply_message(gps_raw_int(fix_type=3, satellites=11, lat=VALID_LAT, lon=VALID_LON))
    state.apply_message(global_position_int(lat=VALID_LAT, lon=VALID_LON))
    assert state.snapshot()["position"]["available"] is True


def test_reset_vehicle_data_clears_gps_fix_type_so_availability_reverts_to_unavailable(
    state: TelemetryState,
) -> None:
    state.apply_message(gps_raw_int(fix_type=3, lat=VALID_LAT, lon=VALID_LON))
    state.apply_message(global_position_int(lat=VALID_LAT, lon=VALID_LON))
    assert state.snapshot()["position"]["available"] is True

    state.reset_vehicle_data()

    snapshot = state.snapshot()
    assert snapshot["gps"]["fixType"] is None
    assert snapshot["position"]["available"] is False
    assert snapshot["position"]["lat"] is None
