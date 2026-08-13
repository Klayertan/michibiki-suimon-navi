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
#: Normal, safety-checked arm/disarm command. ``param2`` must remain ``0``;
#: the ArduPilot force-arm magic value is intentionally not defined anywhere
#: in this backend.
MAV_CMD_COMPONENT_ARM_DISARM: Final = 400

# --------------------------------------------------------------------------
# Manual RC input
# --------------------------------------------------------------------------

#: MAVLINK_MSG_ID_RC_CHANNELS_OVERRIDE.
MSG_ID_RC_CHANNELS_OVERRIDE: Final = 70

#: MAVLINK_MSG_ID_RC_CHANNELS -- the vehicle's own view of its RC input,
#: independent of source (physical receiver or MAVLink override). This is
#: what ArduPilot's arming/pre-arm RC checks actually evaluate; it is not the
#: same thing as the override frame this backend last sent.
MSG_ID_RC_CHANNELS: Final = 65

#: MAVLINK_MSG_ID_SERVO_OUTPUT_RAW -- read-only autopilot actuator PWM
#: telemetry. It is intentionally used only for diagnostics; the transport
#: exposes no servo/motor command method.
MSG_ID_SERVO_OUTPUT_RAW: Final = 36

#: SYS_STATUS.onboard_control_sensors_* bit for MAV_SYS_STATUS_PREARM_CHECK.
#: Verified against the installed pymavlink dialect, not memory. Exposed only
#: as an overall PASS/FAIL/UNKNOWN -- this backend does not enumerate which of
#: the ~32 individual sensor bits failed, since that would mean guessing at a
#: cause instead of reading one the vehicle explicitly reports.
MAV_SYS_STATUS_PREARM_CHECK: Final = 0x10000000

#: SYS_STATUS.onboard_control_sensors_* bit for the RC receiver sensor. Used
#: only to report whether the vehicle currently considers its own RC input
#: healthy -- a direct, vehicle-reported fact, not an inference from any other
#: telemetry field.
MAV_SYS_STATUS_SENSOR_RC_RECEIVER: Final = 0x10000

#: RC_CHANNELS_OVERRIDE semantics for channels 1-8. An ignored field leaves
#: that channel's existing source/override untouched; zero releases it back to
#: the normal RC input. Manual control owns/release all first eight channels so
#: a stale primary-axis override cannot remain latched.
RC_CHANNEL_IGNORE: Final = 0xFFFF
RC_CHANNEL_RELEASE: Final = 0

#: Manual modes supported by this application. RC-style input does not require
#: GUIDED and the application never changes mode automatically.
MANUAL_CONTROL_MODES: Final = ("STABILIZE", "ALT_HOLD")

#: RC_OPTIONS bit 1 tells ArduPilot to ignore MAVLink RC overrides.
RC_OPTIONS_IGNORE_OVERRIDES: Final = 1 << 1
#: Upper bound from ArduPilot's RC_OVERRIDE_TIME parameter metadata.
RC_OVERRIDE_TIME_MAX_SECONDS: Final = 120.0
#: Parameters read (never written) before manual override is allowed. All
#: eight calibrations are requested because RCMAP may put a primary control on
#: any channel 1-8.
RC_MAPPING_PARAMETERS: Final = (
    "RCMAP_ROLL",
    "RCMAP_PITCH",
    "RCMAP_THROTTLE",
    "RCMAP_YAW",
)
RC_CALIBRATION_PARAMETERS: Final = tuple(
    f"RC{channel}_{suffix}"
    for channel in range(1, 9)
    for suffix in ("MIN", "TRIM", "MAX", "REVERSED")
)
RC_DIAGNOSTIC_PARAMETERS: Final = (
    "RC_OVERRIDE_TIME",
    "RC_OPTIONS",
    "SYSID_MYGCS",
    "MAV_GCS_SYSID",
    "MAV_GCS_SYSID_HI",
    "MAV_OPTIONS",
    # Diagnostic only, never enforced or written: shown next to the actual
    # reported throttle RC input so an operator can see whether it sits inside
    # or outside the vehicle's own configured failsafe band. Optional -- older
    # firmware or a vehicle with the failsafe disabled may not expose these,
    # and that is reported as "Unknown", never assumed.
    "FS_THR_ENABLE",
    "FS_THR_VALUE",
)
#: Read-only output-function mapping. These are optional diagnostics and are
#: requested once per vehicle session; missing values never block pilot input.
SERVO_FUNCTION_PARAMETERS: Final = tuple(
    f"SERVO{channel}_FUNCTION" for channel in range(1, 17)
)
RC_OVERRIDE_SOURCE_PARAMETERS: Final = (
    "SYSID_MYGCS",
    "MAV_GCS_SYSID",
    "MAV_GCS_SYSID_HI",
)
REQUIRED_MANUAL_CONTROL_PARAMETERS: Final = (
    *RC_MAPPING_PARAMETERS,
    *RC_CALIBRATION_PARAMETERS,
    "RC_OVERRIDE_TIME",
    "RC_OPTIONS",
)
MANUAL_CONTROL_PARAMETERS: Final = (
    *RC_MAPPING_PARAMETERS,
    *RC_CALIBRATION_PARAMETERS,
    *RC_DIAGNOSTIC_PARAMETERS,
    *SERVO_FUNCTION_PARAMETERS,
)

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


# --------------------------------------------------------------------------
# Automatic telemetry bootstrap (sent once per connection, unconditionally)
# --------------------------------------------------------------------------

#: The telemetry this backend needs to function at all, requested
#: automatically by :class:`app.mavlink.link_manager.LinkManager` right after
#: the first vehicle HEARTBEAT of every connection and every reconnect --
#: never gated by ``SUISUI_MAVLINK_ALLOW_SAFE_COMMANDS``, because without it
#: battery, GPS, attitude and VFR_HUD stay null forever on real hardware. See
#: the "Why a fresh ArduPilot boot ..." note in docs/MAVLINK_OPERATOR_GUIDE.md.
#:
#: Deliberately a separate table from :data:`REQUESTABLE_STREAMS`: that one is
#: the browser-facing, user-triggered allowlist (different rates, no
#: BATTERY_STATUS, gated behind the safe-commands flag); this one is the
#: backend-internal bootstrap that must work read-only and unattended.
#:
#: Each entry is ``(message_name, mavlink_message_id, interval_microseconds)``
#: -- the exact ``param1``/``param2`` pair for
#: ``MAV_CMD_SET_MESSAGE_INTERVAL``. Order is send order, used for best-effort
#: FIFO correlation of the COMMAND_ACKs that come back (see
#: ``LinkManager.StreamRequestTracker``).
ESSENTIAL_TELEMETRY_STREAMS: Final[tuple[tuple[str, int, int], ...]] = (
    ("SYS_STATUS", 1, 1_000_000),  # 1 Hz
    ("GPS_RAW_INT", 24, 500_000),  # 2 Hz
    ("ATTITUDE", 30, 100_000),  # 10 Hz
    ("GLOBAL_POSITION_INT", 33, 200_000),  # 5 Hz
    ("VFR_HUD", 74, 500_000),  # 2 Hz
    ("BATTERY_STATUS", 147, 1_000_000),  # 1 Hz
    # Read-only: what the vehicle itself reports seeing on its RC input,
    # independent of source. Requested unconditionally like the rest of this
    # table so "RC INPUT SEEN BY PIXHAWK" in Manual Control reflects the
    # vehicle's own view, not merely what the browser intended to send.
    ("RC_CHANNELS", 65, 200_000),  # 5 Hz
    # Read-only PWM output evidence. SERVOx_FUNCTION parameters decide which
    # of these channels are labelled as motors; output numbers are never
    # assumed to equal motor numbers.
    ("SERVO_OUTPUT_RAW", MSG_ID_SERVO_OUTPUT_RAW, 200_000),  # 5 Hz
)
