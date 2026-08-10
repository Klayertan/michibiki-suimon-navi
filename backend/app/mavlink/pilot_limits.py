"""Manual-RC mapping plus the separately retained GUIDED velocity transport.

These are deliberately two mapping families, not one control stack:

* the first section retains normalized axes -> body-frame velocity conversion
  for a future Guided external-control feature;
* the Manual RC section maps normalized axes through the vehicle's read-only
  RCMAP/RCx calibration into ``RC_CHANNELS_OVERRIDE`` values.

The current Manual Control UI uses only the second family. It never converts
joystick input into metres per second or requires GUIDED.

All values verified against the installed pymavlink
(``pymavlink.dialects.v20.ardupilotmega``) rather than from memory:

* ``SET_POSITION_TARGET_LOCAL_NED`` message id 84
* ``MAV_FRAME_BODY_NED`` = 8
* ``POSITION_TARGET_TYPEMASK_*`` bit values as listed below
* ``COPTER_MODE_GUIDED`` = 4

First-flight defaults are deliberately slower than walking pace.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Final, Mapping

from . import constants

# --------------------------------------------------------------------------
# MAVLink framing
# --------------------------------------------------------------------------

#: MAVLINK_MSG_ID_SET_POSITION_TARGET_LOCAL_NED.
MSG_ID_SET_POSITION_TARGET_LOCAL_NED: Final = 84

#: MAV_FRAME_BODY_NED. Velocities are interpreted relative to the vehicle's
#: current heading: +vx forward, +vy right, +vz **down**. This is what makes
#: "arrow up = fly forward" mean forward *from the pilot's point of view of
#: the airframe*, independent of compass heading.
#:
#: ArduPilot Copter accepts LOCAL_NED (1), LOCAL_OFFSET_NED (7), BODY_NED (8)
#: and BODY_OFFSET_NED (9) for SET_POSITION_TARGET_LOCAL_NED. BODY_NED is used
#: here because body-relative is the only sane frame for a human flying by
#: eye. (MAV_FRAME_BODY_FRD = 12 is the modern spelling but is not accepted by
#: ArduPilot on this message, so it is deliberately not used.)
MAV_FRAME_BODY_NED: Final = 8

# POSITION_TARGET_TYPEMASK bits. A **set** bit means "ignore this field".
_TYPEMASK_X_IGNORE: Final = 1
_TYPEMASK_Y_IGNORE: Final = 2
_TYPEMASK_Z_IGNORE: Final = 4
_TYPEMASK_VX_IGNORE: Final = 8
_TYPEMASK_VY_IGNORE: Final = 16
_TYPEMASK_VZ_IGNORE: Final = 32
_TYPEMASK_AX_IGNORE: Final = 64
_TYPEMASK_AY_IGNORE: Final = 128
_TYPEMASK_AZ_IGNORE: Final = 256
_TYPEMASK_FORCE_SET: Final = 512
_TYPEMASK_YAW_IGNORE: Final = 1024
_TYPEMASK_YAW_RATE_IGNORE: Final = 2048

#: Use velocity + yaw rate; ignore position, acceleration and absolute yaw.
#: 1+2+4 (position) + 64+128+256 (acceleration) + 1024 (absolute yaw) = 1479.
#: The velocity bits (8/16/32) and the yaw-rate bit (2048) stay clear, which
#: is what tells ArduPilot those fields are meaningful.
TYPE_MASK_VELOCITY_YAW_RATE: Final = (
    _TYPEMASK_X_IGNORE
    | _TYPEMASK_Y_IGNORE
    | _TYPEMASK_Z_IGNORE
    | _TYPEMASK_AX_IGNORE
    | _TYPEMASK_AY_IGNORE
    | _TYPEMASK_AZ_IGNORE
    | _TYPEMASK_YAW_IGNORE
)

#: ArduCopter custom_mode for GUIDED. Velocity setpoints are only honoured in
#: GUIDED; in any other mode ArduPilot ignores them, so the pilot service
#: refuses to transmit rather than pretending to fly.
COPTER_MODE_GUIDED: Final = 4

#: Flight mode required by the retained external velocity sender. Manual RC
#: input instead uses ``constants.MANUAL_CONTROL_MODES``.
REQUIRED_GUIDED_MODE: Final = "GUIDED"


# --------------------------------------------------------------------------
# First-flight limits
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class PilotLimits:
    """Maximum commanded rates. Change these to change the aircraft's speed.

    Defaults are the conservative first-hover values: slower than a walk, so
    a mistake is a drift rather than a dash.
    """

    #: Metres per second, horizontal. Applies to the *combined* forward/right
    #: vector, not per-axis -- see :func:`normalized_to_velocity`.
    max_horizontal_speed: float = 0.30
    #: Metres per second, climbing.
    max_climb_speed: float = 0.30
    #: Metres per second, descending. Lower than climb on purpose: an
    #: unintended descent ends at the ground.
    max_descent_speed: float = 0.20
    #: Degrees per second. Converted to rad/s at the MAVLink boundary.
    max_yaw_rate_deg: float = 12.0

    @property
    def max_yaw_rate_rad(self) -> float:
        """MAVLink carries ``yaw_rate`` in radians per second."""
        return math.radians(self.max_yaw_rate_deg)

    def to_dict(self) -> dict[str, float]:
        """Limits as shown to the operator in the UI and diagnostics."""
        return {
            "maxHorizontalSpeed": self.max_horizontal_speed,
            "maxClimbSpeed": self.max_climb_speed,
            "maxDescentSpeed": self.max_descent_speed,
            "maxYawRateDeg": self.max_yaw_rate_deg,
        }


#: The active limits. Import this rather than writing numbers anywhere else.
DEFAULT_PILOT_LIMITS: Final = PilotLimits()

#: Propellers-removed bench test. Deliberately smaller than the already
#: conservative flight defaults: a bench test exists to prove the command
#: path and the failsafes, not to produce any real displacement, and with no
#: propellers attached the actual speed is irrelevant to the aircraft -- it
#: is only relevant to the strength of the belief the operator can place in
#: the numbers on screen matching what would happen with props on.
BENCH_PILOT_LIMITS: Final = PilotLimits(
    max_horizontal_speed=0.10,
    max_climb_speed=0.10,
    max_descent_speed=0.08,
    max_yaw_rate_deg=6.0,
)

#: Manual RC override transmission rate. 15 Hz keeps the override refreshed
#: while remaining modest on a 57600-baud telemetry link.
MANUAL_OVERRIDE_RATE_HZ: Final = 15.0
MANUAL_OVERRIDE_INTERVAL: Final = 1.0 / MANUAL_OVERRIDE_RATE_HZ
# Backwards-compatible names for older diagnostics/tests. Manual code should
# use the explicit ``MANUAL_OVERRIDE_*`` names above.
SETPOINT_RATE_HZ: Final = MANUAL_OVERRIDE_RATE_HZ
SETPOINT_INTERVAL: Final = MANUAL_OVERRIDE_INTERVAL

#: If the frontend has not refreshed the desired state within this long, the
#: backend commands neutral. Deliberately a few frames of the browser's own
#: send rate, so one dropped frame is tolerated but a wedged tab is not.
PILOT_INPUT_TIMEOUT: Final = 0.5

# The autopilot timeout must span several complete override refresh periods
# and the backend's own browser-input freshness window.  Values below this
# can expire during ordinary scheduler/serial jitter even when the 15 Hz
# sender is healthy, so they are diagnosed rather than silently accepted.
RC_OVERRIDE_TIME_MIN_SAFE_SECONDS: Final = max(
    PILOT_INPUT_TIMEOUT,
    3.0 * MANUAL_OVERRIDE_INTERVAL,
)

#: After Manual Control goes neutral (release, Space, timeout, gate failure),
#: repeat all-channel RC release frames for this long. A single frame can be
#: lost on a lossy telemetry radio.
MANUAL_RELEASE_HOLD_SECONDS: Final = 2.0
NEUTRAL_HOLD_SECONDS: Final = MANUAL_RELEASE_HOLD_SECONDS


# --------------------------------------------------------------------------
# Normalized axes -> physical setpoint
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class VelocitySetpoint:
    """A body-frame velocity command, in MAVLink's own units and signs."""

    #: +forward, -backward (m/s)
    vx: float
    #: +right, -left (m/s)
    vy: float
    #: **+down, -up** (m/s) -- NED convention, so climbing is negative.
    vz: float
    #: +clockwise seen from above / nose-right (rad/s)
    yaw_rate: float

    @property
    def is_neutral(self) -> bool:
        return self.vx == 0.0 and self.vy == 0.0 and self.vz == 0.0 and self.yaw_rate == 0.0

    def to_dict(self) -> dict[str, float]:
        return {"vx": self.vx, "vy": self.vy, "vz": self.vz, "yawRate": self.yaw_rate}


NEUTRAL_SETPOINT: Final = VelocitySetpoint(0.0, 0.0, 0.0, 0.0)


def _clamp_unit(value: float) -> float:
    """Coerce anything to a finite -1..+1 axis value.

    A NaN or a missing field becomes 0, never a runaway command: this is the
    boundary where untrusted browser input stops being untrusted.
    """
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(number):
        return 0.0
    return max(-1.0, min(1.0, number))


def normalized_to_velocity(
    *,
    forward: float,
    right: float,
    up: float,
    yaw: float,
    limits: PilotLimits = DEFAULT_PILOT_LIMITS,
) -> VelocitySetpoint:
    """Turn normalized -1..+1 pilot axes into a body-frame velocity setpoint.

    Args:
        forward: +1 full forward, -1 full backward.
        right: +1 full right, -1 full left.
        up: +1 full climb, -1 full descent (pilot-facing sign; inverted below
            because NED's +Z points down).
        yaw: +1 full yaw right, -1 full yaw left.

    Diagonal handling: the horizontal pair is scaled as a *vector*, so
    forward+right at full deflection travels at ``max_horizontal_speed``, not
    at ``sqrt(2) x`` it. Without this, a diagonal would be 41% faster than the
    configured limit -- exactly the kind of quiet overshoot that matters on a
    first flight.
    """
    forward = _clamp_unit(forward)
    right = _clamp_unit(right)
    up = _clamp_unit(up)
    yaw = _clamp_unit(yaw)

    magnitude = math.hypot(forward, right)
    if magnitude > 1.0:
        forward /= magnitude
        right /= magnitude

    vx = forward * limits.max_horizontal_speed
    vy = right * limits.max_horizontal_speed

    # Pilot "up" is positive; NED "down" is positive. Climb and descent have
    # different ceilings, so the sign decides which limit applies.
    if up >= 0.0:
        vz = -up * limits.max_climb_speed
    else:
        vz = -up * limits.max_descent_speed

    return VelocitySetpoint(
        # `+ 0.0` collapses the negative zero that -0 * limit produces, so a
        # neutral setpoint reads as 0.0 everywhere instead of -0.0.
        vx=vx + 0.0,
        vy=vy + 0.0,
        vz=vz + 0.0,
        yaw_rate=yaw * limits.max_yaw_rate_rad + 0.0,
    )


# --------------------------------------------------------------------------
# Manual RC input (primary keyboard / PS5 transport)
# --------------------------------------------------------------------------


class RcConfigurationError(ValueError):
    """The vehicle's read-only RC configuration is unsafe or incomplete."""

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason
        self.message = message


@dataclass(frozen=True)
class RcDeflectionLimits:
    """Maximum normalized stick deflection accepted by the backend."""

    pitch: float = 1.0
    roll: float = 1.0
    throttle: float = 1.0
    yaw: float = 1.0

    def to_dict(self) -> dict[str, float]:
        return {
            "pitch": self.pitch,
            "roll": self.roll,
            "throttle": self.throttle,
            "yaw": self.yaw,
        }


DEFAULT_RC_LIMITS: Final = RcDeflectionLimits()

# A keyboard is four digital switches, not an analogue stick. Keep its normal
# (non-bench) output deliberately inside a small stick box so one key cannot
# become a full-deflection RC command.
KEYBOARD_RC_LIMITS: Final = RcDeflectionLimits(
    pitch=0.25,
    roll=0.25,
    throttle=0.15,
    yaw=0.25,
)

# Propellers-removed mode is intentionally a small stick box. Keyboard input
# is reduced independently in its provider too; this backend ceiling means a
# hostile or incorrectly calibrated browser still cannot request full stick on
# the bench.
BENCH_RC_LIMITS: Final = RcDeflectionLimits(
    pitch=0.15,
    roll=0.15,
    throttle=0.10,
    yaw=0.15,
)


@dataclass(frozen=True)
class RcChannelCalibration:
    """One channel's vehicle-side RC calibration, in PWM microseconds."""

    minimum: int
    trim: int
    maximum: int
    reversed: bool = False

    def validate(self, channel: int) -> None:
        if not (800 <= self.minimum <= self.trim <= self.maximum <= 2200):
            raise RcConfigurationError(
                "rc_calibration_invalid",
                f"RC{channel} calibration must satisfy 800 <= MIN <= TRIM <= MAX <= 2200 "
                f"(got {self.minimum}/{self.trim}/{self.maximum}).",
            )
        if self.minimum == self.maximum:
            raise RcConfigurationError(
                "rc_calibration_invalid",
                f"RC{channel}_MIN and RC{channel}_MAX are identical ({self.minimum}).",
            )

    def pwm_for(self, value: float) -> int:
        """Map a semantic -1..+1 deflection around this channel's trim."""
        axis = _clamp_unit(value)
        if self.reversed:
            axis = -axis
        if axis >= 0.0:
            pwm = self.trim + axis * (self.maximum - self.trim)
        else:
            pwm = self.trim + axis * (self.trim - self.minimum)
        return max(self.minimum, min(self.maximum, int(round(pwm))))

    def pwm_for_unipolar(self, value: float) -> int:
        """Map 0..+1 from safe low throttle to high throttle.

        ``RCx_REVERSED`` changes which PWM endpoint ArduPilot interprets as
        low stick.  This method follows that configured endpoint directly;
        it never treats trim as zero throttle.
        """
        fraction = max(0.0, _clamp_unit(value))
        low = self.maximum if self.reversed else self.minimum
        high = self.minimum if self.reversed else self.maximum
        return int(round(low + fraction * (high - low)))

    def pwm_for_centered_range(self, value: float) -> int:
        """Map -1..+1 around the MIN/MAX range midpoint, not RC trim.

        ArduPilot throttle channels use ``ControlType::RANGE`` and derive the
        no-climb midpoint from the calibrated endpoints. ``RCx_TRIM`` is not
        the throttle midpoint in this conversion.
        """
        axis = _clamp_unit(value)
        if self.reversed:
            axis = -axis
        midpoint = (self.minimum + self.maximum) / 2.0
        if axis >= 0.0:
            pwm = midpoint + axis * (self.maximum - midpoint)
        else:
            pwm = midpoint + axis * (midpoint - self.minimum)
        return int(round(pwm))

    def to_dict(self) -> dict[str, int | bool]:
        return {
            "min": self.minimum,
            "trim": self.trim,
            "max": self.maximum,
            "reversed": self.reversed,
        }


@dataclass(frozen=True)
class RcInputConfiguration:
    """Validated ArduPilot primary-axis mapping and timeout diagnostics."""

    roll_channel: int
    pitch_channel: int
    throttle_channel: int
    yaw_channel: int
    calibrations: tuple[RcChannelCalibration, ...]
    override_timeout: float
    rc_options: int
    source_id_parameter: str | None = None
    sysid_mygcs: int | None = None
    mav_gcs_sysid: int | None = None
    mav_gcs_sysid_hi: int | None = None
    mav_options: int | None = None

    def calibration(self, channel: int) -> RcChannelCalibration:
        return self.calibrations[channel - 1]

    def to_dict(self) -> dict[str, object]:
        return {
            "mapping": {
                "roll": self.roll_channel,
                "pitch": self.pitch_channel,
                "throttle": self.throttle_channel,
                "yaw": self.yaw_channel,
            },
            "channels": {
                str(channel): self.calibration(channel).to_dict()
                for channel in range(1, 9)
            },
            "overrideTimeoutSeconds": self.override_timeout,
            "rcOptions": self.rc_options,
            "sourceIdParameter": self.source_id_parameter,
            "sysidMygcs": self.sysid_mygcs,
            "mavGcsSysid": self.mav_gcs_sysid,
            "mavGcsSysidHi": self.mav_gcs_sysid_hi,
            "mavOptions": self.mav_options,
        }


@dataclass(frozen=True)
class RcOverride:
    """The first eight RC_CHANNELS_OVERRIDE fields, in channel order."""

    channels: tuple[int, int, int, int, int, int, int, int]

    @property
    def is_release(self) -> bool:
        return all(value == constants.RC_CHANNEL_RELEASE for value in self.channels)

    def to_dict(self) -> dict[str, object]:
        return {
            "channels": list(self.channels),
            "released": self.is_release,
        }


RELEASE_RC_OVERRIDE: Final = RcOverride((0, 0, 0, 0, 0, 0, 0, 0))


def _parameter_number(parameters: Mapping[str, float], name: str) -> float:
    value = parameters.get(name)
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise RcConfigurationError("rc_configuration_missing", f"Required vehicle parameter {name} is missing.")
    if not math.isfinite(number):
        raise RcConfigurationError("rc_configuration_invalid", f"Vehicle parameter {name} is not finite.")
    return number


def _parameter_integer(parameters: Mapping[str, float], name: str) -> int:
    number = _parameter_number(parameters, name)
    if not number.is_integer():
        raise RcConfigurationError(
            "rc_configuration_invalid",
            f"Vehicle parameter {name} must be an integer (got {number}).",
        )
    return int(number)


def rc_configuration_from_parameters(
    parameters: Mapping[str, float],
    *,
    source_system: int,
) -> RcInputConfiguration:
    """Build a fail-closed mapping from read-only ArduPilot parameters.

    No fallback values are invented here. A real vehicle must report the
    mapping/calibration it is actually using before this application can own
    RC input.
    """
    missing = [name for name in constants.REQUIRED_MANUAL_CONTROL_PARAMETERS if name not in parameters]
    if missing:
        raise RcConfigurationError(
            "rc_configuration_missing",
            "Waiting for vehicle RC parameters: " + ", ".join(missing),
        )

    mapping = {
        "roll": _parameter_integer(parameters, "RCMAP_ROLL"),
        "pitch": _parameter_integer(parameters, "RCMAP_PITCH"),
        "throttle": _parameter_integer(parameters, "RCMAP_THROTTLE"),
        "yaw": _parameter_integer(parameters, "RCMAP_YAW"),
    }
    if any(channel < 1 or channel > 8 for channel in mapping.values()):
        raise RcConfigurationError(
            "rc_mapping_invalid",
            f"RCMAP primary channels must all be in 1..8 (got {mapping}).",
        )
    if len(set(mapping.values())) != 4:
        raise RcConfigurationError(
            "rc_mapping_invalid",
            f"RCMAP primary channels must be unique (got {mapping}).",
        )

    calibrations: list[RcChannelCalibration] = []
    for channel in range(1, 9):
        reversed_value = _parameter_integer(parameters, f"RC{channel}_REVERSED")
        if reversed_value not in (0, 1):
            raise RcConfigurationError(
                "rc_calibration_invalid",
                f"RC{channel}_REVERSED must be 0 or 1 (got {reversed_value}).",
            )
        calibration = RcChannelCalibration(
            minimum=_parameter_integer(parameters, f"RC{channel}_MIN"),
            trim=_parameter_integer(parameters, f"RC{channel}_TRIM"),
            maximum=_parameter_integer(parameters, f"RC{channel}_MAX"),
            reversed=bool(reversed_value),
        )
        calibration.validate(channel)
        calibrations.append(calibration)

    timeout = _parameter_number(parameters, "RC_OVERRIDE_TIME")
    if timeout == 0.0:
        raise RcConfigurationError(
            "rc_override_disabled",
            "RC_OVERRIDE_TIME is 0, so ArduPilot has RC overrides disabled.",
        )
    if timeout < 0.0:
        raise RcConfigurationError(
            "rc_override_timeout_infinite",
            "RC_OVERRIDE_TIME is negative (no timeout). Manual control requires an autopilot-side timeout.",
        )
    if timeout < RC_OVERRIDE_TIME_MIN_SAFE_SECONDS:
        raise RcConfigurationError(
            "rc_override_timeout_too_short",
            f"RC_OVERRIDE_TIME is {timeout:g}s, below this sender's safe minimum of "
            f"{RC_OVERRIDE_TIME_MIN_SAFE_SECONDS:g}s.",
        )
    if timeout > constants.RC_OVERRIDE_TIME_MAX_SECONDS:
        raise RcConfigurationError(
            "rc_override_timeout_invalid",
            f"RC_OVERRIDE_TIME is {timeout:g}s, outside ArduPilot's supported maximum of "
            f"{constants.RC_OVERRIDE_TIME_MAX_SECONDS:g}s.",
        )

    rc_options = _parameter_integer(parameters, "RC_OPTIONS")
    if rc_options < 0:
        raise RcConfigurationError(
            "rc_configuration_invalid",
            f"RC_OPTIONS cannot be negative (got {rc_options}).",
        )
    if rc_options & constants.RC_OPTIONS_IGNORE_OVERRIDES:
        raise RcConfigurationError(
            "rc_overrides_ignored",
            "RC_OPTIONS bit 1 is set, so ArduPilot will ignore MAVLink RC overrides.",
        )

    sysid_mygcs = None
    mav_gcs_sysid = None
    mav_gcs_sysid_hi = None
    mav_options = None
    if "SYSID_MYGCS" in parameters:
        sysid_mygcs = _parameter_integer(parameters, "SYSID_MYGCS")
        if not 1 <= sysid_mygcs <= 255:
            raise RcConfigurationError(
                "rc_configuration_invalid",
                f"SYSID_MYGCS must be in 1..255 (got {sysid_mygcs}).",
            )
    if "MAV_GCS_SYSID" in parameters:
        mav_gcs_sysid = _parameter_integer(parameters, "MAV_GCS_SYSID")
        if not 1 <= mav_gcs_sysid <= 255:
            raise RcConfigurationError(
                "rc_configuration_invalid",
                f"MAV_GCS_SYSID must be in 1..255 (got {mav_gcs_sysid}).",
            )
    if "MAV_GCS_SYSID_HI" in parameters:
        mav_gcs_sysid_hi = _parameter_integer(parameters, "MAV_GCS_SYSID_HI")
        if mav_gcs_sysid is None:
            raise RcConfigurationError(
                "rc_configuration_missing",
                "MAV_GCS_SYSID_HI was reported without MAV_GCS_SYSID.",
            )
        if not 0 <= mav_gcs_sysid_hi <= 255:
            raise RcConfigurationError(
                "rc_configuration_invalid",
                f"MAV_GCS_SYSID_HI must be in 0..255 (got {mav_gcs_sysid_hi}).",
            )
    if "MAV_OPTIONS" in parameters:
        mav_options = _parameter_integer(parameters, "MAV_OPTIONS")
        if mav_options < 0:
            raise RcConfigurationError(
                "rc_configuration_invalid",
                f"MAV_OPTIONS cannot be negative (got {mav_options}).",
            )
    source_id_parameter: str
    if mav_gcs_sysid is not None:
        source_id_parameter = "MAV_GCS_SYSID"
        # ArduPilot enables a range only when HI >= LOW. A lower HI (commonly
        # zero/default) leaves the exact LOW system ID as the sole match.
        source_high = (
            mav_gcs_sysid
            if mav_gcs_sysid_hi is None or mav_gcs_sysid_hi < mav_gcs_sysid
            else mav_gcs_sysid_hi
        )
        if not mav_gcs_sysid <= source_system <= source_high:
            raise RcConfigurationError(
                "rc_gcs_sysid_mismatch",
                f"MAVLink RC overrides allow source systems {mav_gcs_sysid}..{source_high}, "
                f"but this backend sends as system {source_system}.",
            )
    elif sysid_mygcs is not None:
        source_id_parameter = "SYSID_MYGCS"
        if sysid_mygcs != source_system:
            raise RcConfigurationError(
                "rc_gcs_sysid_mismatch",
                f"SYSID_MYGCS is {sysid_mygcs}, but this backend sends as system {source_system}.",
            )
    else:
        raise RcConfigurationError(
            "rc_configuration_missing",
            "Vehicle did not report SYSID_MYGCS or MAV_GCS_SYSID; RC override source cannot be verified.",
        )

    return RcInputConfiguration(
        roll_channel=mapping["roll"],
        pitch_channel=mapping["pitch"],
        throttle_channel=mapping["throttle"],
        yaw_channel=mapping["yaw"],
        calibrations=tuple(calibrations),
        override_timeout=timeout,
        rc_options=rc_options,
        source_id_parameter=source_id_parameter,
        sysid_mygcs=sysid_mygcs,
        mav_gcs_sysid=mav_gcs_sysid,
        mav_gcs_sysid_hi=mav_gcs_sysid_hi,
        mav_options=mav_options,
    )


def _limited(value: float, maximum: float) -> float:
    axis = _clamp_unit(value)
    ceiling = max(0.0, min(1.0, float(maximum)))
    return math.copysign(min(abs(axis), ceiling), axis)


def normalized_to_rc_override(
    *,
    pitch: float,
    roll: float,
    throttle: float,
    yaw: float,
    configuration: RcInputConfiguration,
    limits: RcDeflectionLimits = DEFAULT_RC_LIMITS,
    mode: str = "STABILIZE",
) -> RcOverride:
    """Map semantic pilot axes to vehicle-calibrated RC channels 1-8.

    Semantic signs are independent of raw PWM conventions: positive pitch is
    forward (normally low PWM), while positive roll/throttle/yaw normally use
    high PWM. RCx_REVERSED is then respected for the vehicle's actual setup.
    Unowned channels are UINT16_MAX (ignore), never arbitrary auxiliary values.
    """
    values = [constants.RC_CHANNEL_IGNORE] * 8
    semantic = {
        configuration.roll_channel: _limited(roll, limits.roll),
        configuration.pitch_channel: -_limited(pitch, limits.pitch),
        configuration.yaw_channel: _limited(yaw, limits.yaw),
    }
    for channel, value in semantic.items():
        values[channel - 1] = configuration.calibration(channel).pwm_for(value)

    throttle_value = _limited(throttle, limits.throttle)
    throttle_calibration = configuration.calibration(configuration.throttle_channel)
    selected_mode = str(mode or "").strip().upper()
    if selected_mode == "STABILIZE":
        # STABILIZE uses absolute throttle. Browser zero is the safe low-stick
        # endpoint, not RC trim (which is typically about half throttle).
        throttle_pwm = throttle_calibration.pwm_for_unipolar(throttle_value)
    elif selected_mode == "ALT_HOLD":
        # ALT_HOLD interprets the centered throttle stick as descent/hold/
        # climb, so semantic zero deliberately maps to calibrated trim.
        throttle_pwm = throttle_calibration.pwm_for_centered_range(throttle_value)
    else:
        raise RcConfigurationError(
            "wrong_mode",
            f"Manual RC throttle mapping is not defined for mode {selected_mode or 'UNKNOWN'}.",
        )
    values[configuration.throttle_channel - 1] = throttle_pwm
    return RcOverride(tuple(values))
