"""Unit tests for MAVLink message normalization.

These run against plain objects, with no link, no thread and no pymavlink.
"""

from __future__ import annotations

import math

import pytest

from app.mavlink import constants, normalizers
from app.mavlink.mock_connection import MockMessage


def test_heartbeat_decodes_mode_and_armed_flag() -> None:
    message = MockMessage(
        "HEARTBEAT",
        type=2,
        autopilot=3,
        base_mode=constants.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED,
        custom_mode=2,
        system_status=3,
    )
    values = normalizers.normalize_heartbeat(message)

    assert values["armed"] is False
    assert values["flightMode"] == "ALT_HOLD"
    assert values["vehicleTypeName"] == "QUADROTOR"
    assert values["autopilotName"] == "ARDUPILOTMEGA"


def test_heartbeat_armed_bit_is_detected() -> None:
    message = MockMessage(
        "HEARTBEAT",
        type=2,
        autopilot=3,
        base_mode=constants.MAV_MODE_FLAG_SAFETY_ARMED | constants.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED,
        custom_mode=0,
    )
    assert normalizers.normalize_heartbeat(message)["armed"] is True


def test_heartbeat_without_fields_reports_unknown_not_disarmed() -> None:
    """A heartbeat with no base_mode must not read as 'disarmed'."""
    values = normalizers.normalize_heartbeat(MockMessage("HEARTBEAT"))
    assert values["armed"] is None
    assert values["flightMode"] is None


def test_servo_output_raw_preserves_read_only_pwm_and_missing_extensions() -> None:
    values = normalizers.normalize_servo_output_raw(
        MockMessage(
            "SERVO_OUTPUT_RAW",
            port=0,
            time_usec=123456,
            servo1_raw=1100,
            servo2_raw=1200,
            servo3_raw=0,
            servo4_raw=1900,
        )
    )
    assert values["channels"][:4] == [1100, 1200, 0, 1900]
    assert values["channels"][4:] == [None] * 12
    assert values["port"] == 0
    assert values["timeUsec"] == 123456


def test_sys_status_scales_battery_units() -> None:
    values = normalizers.normalize_sys_status(
        MockMessage(
            "SYS_STATUS",
            voltage_battery=16210,
            current_battery=145,
            battery_remaining=87,
            onboard_control_sensors_present=0b111,
            onboard_control_sensors_enabled=0b111,
            onboard_control_sensors_health=0b111,
        )
    )
    assert values["voltage"] == pytest.approx(16.21)
    assert values["current"] == pytest.approx(1.45)
    assert values["remaining"] == 87
    assert values["sensorsOk"] is True


def test_sys_status_flags_unhealthy_enabled_sensor() -> None:
    values = normalizers.normalize_sys_status(
        MockMessage(
            "SYS_STATUS",
            onboard_control_sensors_present=0b111,
            onboard_control_sensors_enabled=0b111,
            onboard_control_sensors_health=0b101,
        )
    )
    assert values["sensorsOk"] is False


def test_sys_status_sentinels_become_none_not_absurd_numbers() -> None:
    values = normalizers.normalize_sys_status(
        MockMessage("SYS_STATUS", voltage_battery=0xFFFF, current_battery=-1, battery_remaining=-1)
    )
    assert values["voltage"] is None
    assert values["current"] is None
    assert values["remaining"] is None


def test_gps_raw_int_scales_position_and_names_fix() -> None:
    values = normalizers.normalize_gps_raw_int(
        MockMessage(
            "GPS_RAW_INT",
            fix_type=3,
            satellites_visible=14,
            lat=345400000,
            lon=1357350000,
            alt=62000,
            eph=110,
            epv=180,
        )
    )
    assert values["fixTypeName"] == "3D_FIX"
    assert values["lat"] == pytest.approx(34.54)
    assert values["lon"] == pytest.approx(135.735)
    assert values["altMsl"] == pytest.approx(62.0)
    assert values["eph"] == pytest.approx(1.10)


def test_gps_no_fix_reports_no_position_sentinel_as_none() -> None:
    values = normalizers.normalize_gps_raw_int(
        MockMessage("GPS_RAW_INT", fix_type=1, satellites_visible=0xFF, lat=0x7FFFFFFF, lon=0x7FFFFFFF)
    )
    assert values["fixTypeName"] == "NO_FIX"
    assert values["satellites"] is None
    assert values["lat"] is None


def test_attitude_converts_radians_to_degrees() -> None:
    values = normalizers.normalize_attitude(
        MockMessage("ATTITUDE", roll=math.radians(3.0), pitch=math.radians(-2.0), yaw=math.radians(200.0))
    )
    assert values["roll"] == pytest.approx(3.0)
    assert values["pitch"] == pytest.approx(-2.0)
    assert values["yawNormalized"] == pytest.approx(200.0)


def test_attitude_negative_yaw_normalizes_into_0_360() -> None:
    values = normalizers.normalize_attitude(MockMessage("ATTITUDE", yaw=math.radians(-90.0)))
    assert values["yaw"] == pytest.approx(-90.0)
    assert values["yawNormalized"] == pytest.approx(270.0)


def test_vfr_hud_passes_through_units() -> None:
    values = normalizers.normalize_vfr_hud(
        MockMessage("VFR_HUD", heading=137, groundspeed=0.4, airspeed=0.0, alt=62.1, climb=-0.02)
    )
    assert values["heading"] == 137
    assert values["groundSpeed"] == pytest.approx(0.4)
    assert values["climbRate"] == pytest.approx(-0.02)


def test_global_position_int_scales_altitudes_and_heading() -> None:
    values = normalizers.normalize_global_position_int(
        MockMessage(
            "GLOBAL_POSITION_INT",
            lat=345400000,
            lon=1357350000,
            alt=62000,
            relative_alt=1500,
            vx=120,
            vy=-30,
            vz=5,
            hdg=13700,
        )
    )
    assert values["altAmsl"] == pytest.approx(62.0)
    assert values["altRelative"] == pytest.approx(1.5)
    assert values["vx"] == pytest.approx(1.2)
    assert values["heading"] == pytest.approx(137.0)


def test_global_position_heading_sentinel_is_none() -> None:
    values = normalizers.normalize_global_position_int(MockMessage("GLOBAL_POSITION_INT", hdg=0xFFFF))
    assert values["heading"] is None


def test_statustext_decodes_bytes_and_severity() -> None:
    values = normalizers.normalize_statustext(
        MockMessage("STATUSTEXT", severity=4, text=b"PreArm: GPS horiz error\x00\x00")
    )
    assert values["severityName"] == "WARNING"
    assert values["text"] == "PreArm: GPS horiz error"


def test_autopilot_version_decodes_semver() -> None:
    packed = (4 << 24) | (5 << 16) | (7 << 8) | 255
    values = normalizers.normalize_autopilot_version(
        MockMessage("AUTOPILOT_VERSION", flight_sw_version=packed)
    )
    assert values["flightSwVersion"] == "4.5.7"


def test_command_ack_marks_non_zero_result_as_not_accepted() -> None:
    denied = normalizers.normalize_command_ack(MockMessage("COMMAND_ACK", command=176, result=2))
    assert denied["accepted"] is False
    assert denied["resultName"] == "DENIED"

    accepted = normalizers.normalize_command_ack(MockMessage("COMMAND_ACK", command=176, result=0))
    assert accepted["accepted"] is True


def test_param_value_normalizes_identifier_value_and_metadata() -> None:
    values = normalizers.normalize_param_value(
        MockMessage(
            "PARAM_VALUE",
            param_id=b"RC_OVERRIDE_TIME\x00\x00",
            param_value=3.0,
            param_type=9,
            param_count=42,
            param_index=40,
        )
    )
    assert values == {
        "paramId": "RC_OVERRIDE_TIME",
        "value": 3.0,
        "type": 9,
        "count": 42,
        "index": 40,
    }


def test_param_value_rejects_nonfinite_value_from_state_layer() -> None:
    values = normalizers.normalize_param_value(
        MockMessage("PARAM_VALUE", param_id="RC_OPTIONS", param_value=float("nan"))
    )
    assert values["paramId"] == "RC_OPTIONS"
    assert values["value"] is None


def test_forbidden_modes_are_absent_from_the_commandable_allowlist() -> None:
    """The two lists must never overlap, whatever future edits do."""
    overlap = set(constants.COMMANDABLE_DISARMED_MODES) & constants.FORBIDDEN_MODES
    assert overlap == set()


def test_commandable_allowlist_is_exactly_stabilize_and_alt_hold() -> None:
    assert set(constants.COMMANDABLE_DISARMED_MODES) == {"STABILIZE", "ALT_HOLD"}
