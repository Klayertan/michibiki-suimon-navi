"""MAVLink enumeration tables and the flight-mode allowlist.

These are plain literals rather than ``pymavlink.dialects...`` lookups so the
normalizers and their tests never need pymavlink installed. The numbers are
fixed by the MAVLink 2 common dialect and by ArduCopter 4.5.
"""

from __future__ import annotations

from typing import Final

# --------------------------------------------------------------------------
# Flight modes
# --------------------------------------------------------------------------

#: ArduCopter custom_mode values. This table is used for *display* of any mode
#: the vehicle reports, so it is intentionally complete.
ARDUCOPTER_MODES: Final[dict[int, str]] = {
    0: "STABILIZE",
    1: "ACRO",
    2: "ALT_HOLD",
    3: "AUTO",
    4: "GUIDED",
    5: "LOITER",
    6: "RTL",
    7: "CIRCLE",
    9: "LAND",
    11: "DRIFT",
    13: "SPORT",
    14: "FLIP",
    15: "AUTOTUNE",
    16: "POSHOLD",
    17: "BRAKE",
    18: "THROW",
    19: "AVOID_ADSB",
    20: "GUIDED_NOGPS",
    21: "SMART_RTL",
    22: "FLOWHOLD",
    23: "FOLLOW",
    24: "ZIGZAG",
    25: "SYSTEMID",
    26: "AUTOROTATE",
    27: "AUTO_RTL",
    28: "TURTLE",
}

#: The only modes this backend will ever *command*, and only while disarmed.
#: Deliberately much smaller than :data:`ARDUCOPTER_MODES`: every entry here is
#: a mode that cannot by itself make a disarmed aircraft move. Adding AUTO,
#: GUIDED, RTL, LAND or any other mode to this tuple would be a safety change,
#: not a feature change.
COMMANDABLE_DISARMED_MODES: Final[dict[str, int]] = {
    "STABILIZE": 0,
    "ALT_HOLD": 2,
}

#: Modes that must never be commanded by this backend, listed explicitly so a
#: future edit that tries to widen the allowlist trips the guard in
#: :mod:`app.mavlink.command_service`.
FORBIDDEN_MODES: Final[frozenset[str]] = frozenset(
    {
        "AUTO",
        "AUTO_RTL",
        "GUIDED",
        "GUIDED_NOGPS",
        "RTL",
        "SMART_RTL",
        "LAND",
        "TAKEOFF",
        "THROW",
        "FLIP",
        "AUTOTUNE",
        "TURTLE",
        "AUTOROTATE",
        "CIRCLE",
        "FOLLOW",
        "ZIGZAG",
    }
)


def mode_name(custom_mode: int | None) -> str | None:
    """Human-readable ArduCopter mode name, or ``None`` when unknown."""
    if custom_mode is None:
        return None
    return ARDUCOPTER_MODES.get(int(custom_mode))


# --------------------------------------------------------------------------
# MAV_TYPE / MAV_AUTOPILOT
# --------------------------------------------------------------------------

MAV_TYPE_NAMES: Final[dict[int, str]] = {
    0: "GENERIC",
    1: "FIXED_WING",
    2: "QUADROTOR",
    3: "COAXIAL",
    4: "HELICOPTER",
    5: "ANTENNA_TRACKER",
    6: "GCS",
    10: "GROUND_ROVER",
    11: "SURFACE_BOAT",
    12: "SUBMARINE",
    13: "HEXAROTOR",
    14: "OCTOROTOR",
    15: "TRICOPTER",
    18: "ONBOARD_CONTROLLER",
}

MAV_AUTOPILOT_NAMES: Final[dict[int, str]] = {
    0: "GENERIC",
    3: "ARDUPILOTMEGA",
    8: "INVALID",
    12: "PX4",
}

#: MAV_TYPE_GCS -- what this backend announces itself as.
MAV_TYPE_GCS: Final = 6
#: MAV_AUTOPILOT_INVALID -- required for a ground station heartbeat.
MAV_AUTOPILOT_INVALID: Final = 8
#: MAV_STATE_ACTIVE.
MAV_STATE_ACTIVE: Final = 4

#: MAV_MODE_FLAG_SAFETY_ARMED, the armed bit inside HEARTBEAT.base_mode.
MAV_MODE_FLAG_SAFETY_ARMED: Final = 128
#: MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, required when commanding a custom mode.
MAV_MODE_FLAG_CUSTOM_MODE_ENABLED: Final = 1


# --------------------------------------------------------------------------
# GPS
# --------------------------------------------------------------------------

GPS_FIX_TYPE_NAMES: Final[dict[int, str]] = {
    0: "NO_GPS",
    1: "NO_FIX",
    2: "2D_FIX",
    3: "3D_FIX",
    4: "DGPS",
    5: "RTK_FLOAT",
    6: "RTK_FIXED",
    7: "STATIC",
    8: "PPP",
}


def gps_fix_name(fix_type: int | None) -> str | None:
    if fix_type is None:
        return None
    return GPS_FIX_TYPE_NAMES.get(int(fix_type), f"UNKNOWN_{int(fix_type)}")


# --------------------------------------------------------------------------
# STATUSTEXT severity (MAV_SEVERITY == syslog levels)
# --------------------------------------------------------------------------

SEVERITY_NAMES: Final[dict[int, str]] = {
    0: "EMERGENCY",
    1: "ALERT",
    2: "CRITICAL",
    3: "ERROR",
    4: "WARNING",
    5: "NOTICE",
    6: "INFO",
    7: "DEBUG",
}


def severity_name(severity: int | None) -> str:
    if severity is None:
        return "UNKNOWN"
    return SEVERITY_NAMES.get(int(severity), f"UNKNOWN_{int(severity)}")


# --------------------------------------------------------------------------
# Commands and results
# --------------------------------------------------------------------------

MAV_CMD_DO_SET_MODE: Final = 176
MAV_CMD_REQUEST_MESSAGE: Final = 512
MAV_CMD_SET_MESSAGE_INTERVAL: Final = 511

MAV_RESULT_NAMES: Final[dict[int, str]] = {
    0: "ACCEPTED",
    1: "TEMPORARILY_REJECTED",
    2: "DENIED",
    3: "UNSUPPORTED",
    4: "FAILED",
    5: "IN_PROGRESS",
    6: "CANCELLED",
    7: "COMMAND_LONG_ONLY",
    8: "COMMAND_INT_ONLY",
    9: "COMMAND_UNSUPPORTED_MAV_FRAME",
}

MAV_RESULT_ACCEPTED: Final = 0


def command_result_name(result: int | None) -> str:
    if result is None:
        return "UNKNOWN"
    return MAV_RESULT_NAMES.get(int(result), f"UNKNOWN_{int(result)}")


# --------------------------------------------------------------------------
# Telemetry streams the frontend needs
# --------------------------------------------------------------------------

#: Message IDs the browser may ask the vehicle to stream, mapped to the rate
#: this backend requests (Hz). Any other message ID from the browser is
#: rejected -- the API never forwards a caller-supplied numeric ID.
REQUESTABLE_STREAMS: Final[dict[str, tuple[int, float]]] = {
    "ATTITUDE": (30, 4.0),
    "GLOBAL_POSITION_INT": (33, 2.0),
    "GPS_RAW_INT": (24, 1.0),
    "SYS_STATUS": (1, 1.0),
    "VFR_HUD": (74, 2.0),
}

#: MAVLINK_MSG_ID_AUTOPILOT_VERSION.
MSG_ID_AUTOPILOT_VERSION: Final = 148
