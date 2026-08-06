"""Pure MAVLink message -> normalized field conversion.

This module is the single place where raw MAVLink units are converted
(radians to degrees, millivolts to volts, 1e7 degrees to degrees, ...). Nothing
else in the backend is allowed to repeat one of these conversions -- if a value
looks wrong on screen there is exactly one function to inspect.

The functions accept anything with a ``get_type()`` method and message fields as
attributes, which is what pymavlink produces and what the mock link emits. They
never import pymavlink, so they are testable with no hardware and no dialect.

Unavailable values become ``None``. MAVLink transmits "unknown" as sentinel
values (``UINT16_MAX``, ``INT16_MAX``, ``0x7FFFFFFF``, ``-1``); those are
mapped to ``None`` rather than propagated as absurd numbers.
"""

from __future__ import annotations

import math
from typing import Any, Protocol

from . import constants

UINT8_MAX = 0xFF
UINT16_MAX = 0xFFFF
INT16_MAX = 0x7FFF
INT32_MAX = 0x7FFFFFFF


class MavMessage(Protocol):
    """Structural type for a decoded MAVLink message."""

    def get_type(self) -> str:  # pragma: no cover - protocol declaration
        ...


def _field(message: Any, name: str) -> Any:
    return getattr(message, name, None)


def _finite(value: Any) -> float | None:
    """Return ``value`` as a float, or ``None`` if it is not usable."""
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _sentinel_none(value: Any, sentinel: int) -> float | None:
    """Map a MAVLink "unknown" sentinel to ``None``."""
    number = _finite(value)
    if number is None or int(number) == sentinel:
        return None
    return number


def _degrees(radians: Any) -> float | None:
    value = _finite(radians)
    return None if value is None else math.degrees(value)


def _scaled(value: Any, divisor: float, *, sentinel: int | None = None) -> float | None:
    if sentinel is not None:
        number = _sentinel_none(value, sentinel)
    else:
        number = _finite(value)
    return None if number is None else number / divisor


def normalize_heartbeat(message: Any) -> dict[str, Any]:
    """HEARTBEAT -> flight mode, armed flag, vehicle and autopilot identity."""
    base_mode = _finite(_field(message, "base_mode"))
    custom_mode = _finite(_field(message, "custom_mode"))
    mav_type = _finite(_field(message, "type"))
    autopilot = _finite(_field(message, "autopilot"))

    armed = None
    if base_mode is not None:
        armed = bool(int(base_mode) & constants.MAV_MODE_FLAG_SAFETY_ARMED)

    custom_mode_int = None if custom_mode is None else int(custom_mode)
    return {
        "armed": armed,
        "baseMode": None if base_mode is None else int(base_mode),
        "customMode": custom_mode_int,
        "flightMode": constants.mode_name(custom_mode_int),
        "vehicleType": None if mav_type is None else int(mav_type),
        "vehicleTypeName": None if mav_type is None else constants.MAV_TYPE_NAMES.get(int(mav_type)),
        "autopilot": None if autopilot is None else int(autopilot),
        "autopilotName": None if autopilot is None else constants.MAV_AUTOPILOT_NAMES.get(int(autopilot)),
        "systemStatus": _finite(_field(message, "system_status")),
    }


def normalize_sys_status(message: Any) -> dict[str, Any]:
    """SYS_STATUS -> battery and sensor-health summary."""
    present = _finite(_field(message, "onboard_control_sensors_present"))
    enabled = _finite(_field(message, "onboard_control_sensors_enabled"))
    health = _finite(_field(message, "onboard_control_sensors_health"))

    sensors_ok: bool | None = None
    if present is not None and enabled is not None and health is not None:
        # A sensor is a problem only if it is both enabled and unhealthy.
        expected = int(present) & int(enabled)
        sensors_ok = (expected & int(health)) == expected

    return {
        "voltage": _scaled(_field(message, "voltage_battery"), 1000.0, sentinel=UINT16_MAX),
        "current": _scaled(_field(message, "current_battery"), 100.0, sentinel=-1),
        "remaining": _sentinel_none(_field(message, "battery_remaining"), -1),
        "dropRateComm": _scaled(_field(message, "drop_rate_comm"), 100.0),
        "errorsComm": _finite(_field(message, "errors_comm")),
        "sensorsPresent": None if present is None else int(present),
        "sensorsEnabled": None if enabled is None else int(enabled),
        "sensorsHealth": None if health is None else int(health),
        "sensorsOk": sensors_ok,
    }


def normalize_gps_raw_int(message: Any) -> dict[str, Any]:
    """GPS_RAW_INT -> fix quality, satellite count and raw GNSS position."""
    fix_type = _finite(_field(message, "fix_type"))
    fix_type_int = None if fix_type is None else int(fix_type)
    satellites = _sentinel_none(_field(message, "satellites_visible"), UINT8_MAX)

    return {
        "fixType": fix_type_int,
        "fixTypeName": constants.gps_fix_name(fix_type_int),
        "satellites": None if satellites is None else int(satellites),
        "lat": _scaled(_field(message, "lat"), 1e7, sentinel=INT32_MAX),
        "lon": _scaled(_field(message, "lon"), 1e7, sentinel=INT32_MAX),
        "altMsl": _scaled(_field(message, "alt"), 1000.0, sentinel=INT32_MAX),
        "eph": _scaled(_field(message, "eph"), 100.0, sentinel=UINT16_MAX),
        "epv": _scaled(_field(message, "epv"), 100.0, sentinel=UINT16_MAX),
    }


def normalize_attitude(message: Any) -> dict[str, Any]:
    """ATTITUDE -> roll/pitch/yaw in degrees."""
    yaw = _degrees(_field(message, "yaw"))
    return {
        "roll": _degrees(_field(message, "roll")),
        "pitch": _degrees(_field(message, "pitch")),
        "yaw": yaw,
        "yawNormalized": None if yaw is None else yaw % 360.0,
        "rollRate": _degrees(_field(message, "rollspeed")),
        "pitchRate": _degrees(_field(message, "pitchspeed")),
        "yawRate": _degrees(_field(message, "yawspeed")),
    }


def normalize_vfr_hud(message: Any) -> dict[str, Any]:
    """VFR_HUD -> heading, speeds, altitude, climb rate."""
    heading = _finite(_field(message, "heading"))
    return {
        "heading": None if heading is None else int(heading) % 360,
        "groundSpeed": _finite(_field(message, "groundspeed")),
        "airSpeed": _finite(_field(message, "airspeed")),
        "altitude": _finite(_field(message, "alt")),
        "climbRate": _finite(_field(message, "climb")),
        "throttle": _finite(_field(message, "throttle")),
    }


def normalize_global_position_int(message: Any) -> dict[str, Any]:
    """GLOBAL_POSITION_INT -> fused position, relative altitude, velocity."""
    hdg = _sentinel_none(_field(message, "hdg"), UINT16_MAX)
    return {
        "lat": _scaled(_field(message, "lat"), 1e7, sentinel=INT32_MAX),
        "lon": _scaled(_field(message, "lon"), 1e7, sentinel=INT32_MAX),
        "altAmsl": _scaled(_field(message, "alt"), 1000.0, sentinel=INT32_MAX),
        "altRelative": _scaled(_field(message, "relative_alt"), 1000.0, sentinel=INT32_MAX),
        "vx": _scaled(_field(message, "vx"), 100.0, sentinel=INT16_MAX),
        "vy": _scaled(_field(message, "vy"), 100.0, sentinel=INT16_MAX),
        "vz": _scaled(_field(message, "vz"), 100.0, sentinel=INT16_MAX),
        "heading": None if hdg is None else (hdg / 100.0) % 360.0,
    }


def normalize_statustext(message: Any) -> dict[str, Any]:
    """STATUSTEXT -> severity name and cleaned text."""
    severity = _finite(_field(message, "severity"))
    raw_text = _field(message, "text")
    if isinstance(raw_text, bytes):
        text = raw_text.decode("utf-8", errors="replace")
    else:
        text = "" if raw_text is None else str(raw_text)
    return {
        "severity": None if severity is None else int(severity),
        "severityName": constants.severity_name(None if severity is None else int(severity)),
        "text": text.rstrip("\x00").strip(),
    }


def normalize_autopilot_version(message: Any) -> dict[str, Any]:
    """AUTOPILOT_VERSION -> decoded flight-software version string."""
    raw_version = _finite(_field(message, "flight_sw_version"))
    version_string = None
    if raw_version is not None:
        packed = int(raw_version)
        major = (packed >> 24) & 0xFF
        minor = (packed >> 16) & 0xFF
        patch = (packed >> 8) & 0xFF
        version_string = f"{major}.{minor}.{patch}"

    def _hex_id(name: str) -> str | None:
        value = _field(message, name)
        if value is None:
            return None
        if isinstance(value, (bytes, bytearray)):
            return value.hex()
        try:
            return f"{int(value):016x}"
        except (TypeError, ValueError):
            return None

    return {
        "flightSwVersion": version_string,
        "flightSwVersionRaw": None if raw_version is None else int(raw_version),
        "boardVersion": _finite(_field(message, "board_version")),
        "vendorId": _finite(_field(message, "vendor_id")),
        "productId": _finite(_field(message, "product_id")),
        "uid": _hex_id("uid"),
        "capabilities": _finite(_field(message, "capabilities")),
    }


def normalize_command_ack(message: Any) -> dict[str, Any]:
    """COMMAND_ACK -> command id and human-readable result."""
    command = _finite(_field(message, "command"))
    result = _finite(_field(message, "result"))
    result_int = None if result is None else int(result)
    return {
        "command": None if command is None else int(command),
        "result": result_int,
        "resultName": constants.command_result_name(result_int),
        "accepted": result_int == constants.MAV_RESULT_ACCEPTED,
    }


#: Dispatch table used by :class:`app.mavlink.telemetry_state.TelemetryState`.
#: Message types absent from this table are counted but otherwise ignored --
#: the backend never acts on a message it has not been taught to read.
NORMALIZERS = {
    "HEARTBEAT": normalize_heartbeat,
    "SYS_STATUS": normalize_sys_status,
    "GPS_RAW_INT": normalize_gps_raw_int,
    "ATTITUDE": normalize_attitude,
    "VFR_HUD": normalize_vfr_hud,
    "GLOBAL_POSITION_INT": normalize_global_position_int,
    "STATUSTEXT": normalize_statustext,
    "AUTOPILOT_VERSION": normalize_autopilot_version,
    "COMMAND_ACK": normalize_command_ack,
}
