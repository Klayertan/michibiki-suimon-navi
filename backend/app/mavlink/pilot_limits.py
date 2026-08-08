"""The one place pilot-control limits and MAVLink framing constants live.

Everything about *how fast the aircraft may move* is here. Nothing else in the
codebase may hard-code a velocity, a yaw rate, a type mask, or a frame — the
frontend deals only in normalized -1..+1 axes and this module turns those into
metres per second at the MAVLink boundary.

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
from typing import Final

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

#: Flight mode name (as normalised by ``constants.mode_name``) required before
#: any velocity setpoint is transmitted.
REQUIRED_PILOT_MODE: Final = "GUIDED"


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

#: Setpoint transmission rate. ArduPilot expects a continuously refreshed
#: velocity target; it applies its own failsafe if the stream stops. 15 Hz sits
#: comfortably inside the 10-20 Hz the request calls for and well under what a
#: 57600-baud telemetry link can carry alongside the telemetry streams.
SETPOINT_RATE_HZ: Final = 15.0
SETPOINT_INTERVAL: Final = 1.0 / SETPOINT_RATE_HZ

#: If the frontend has not refreshed the desired state within this long, the
#: backend commands neutral. Deliberately a few frames of the browser's own
#: send rate, so one dropped frame is tolerated but a wedged tab is not.
PILOT_INPUT_TIMEOUT: Final = 0.5

#: After the pilot goes neutral (release, Space, timeout, gate failure) keep
#: transmitting explicit zero-velocity setpoints for this long. A single zero
#: frame can be lost on a lossy radio; repeating it makes "stop" as reliable
#: as "go", and ArduPilot holds position on a zero velocity target.
NEUTRAL_HOLD_SECONDS: Final = 2.0


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
