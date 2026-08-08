// Provider sample -> semantic pilot axes.
//
// The single place gamepad-convention axis indices become named intentions.
// Both the keyboard provider and the physical gamepad provider emit the same
// sample shape, so both arrive here and neither needs to know what the other
// does.
//
// Gamepad convention (what providers emit):
//   axes[0] yaw       (+ right)
//   axes[1] vertical  (- up, as a physical stick pushed forward)
//   axes[2] roll      (+ right)
//   axes[3] pitch     (- forward, as a physical stick pushed forward)
//
// Pilot convention (what the backend receives), all -1..+1:
//   forward  + forward,  - backward
//   right    + right,    - left
//   up       + climb,    - descend
//   yaw      + yaw right,- yaw left
//
// No speeds, units, or MAVLink concepts appear anywhere in this file. The
// browser expresses intent; the backend decides how fast that is.

/** Axis magnitudes below this are treated as exactly zero. */
export const AXIS_EPSILON = 0.02;

export const NEUTRAL_AXES = Object.freeze({ forward: 0, right: 0, up: 0, yaw: 0 });

function clampUnit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  if (number > 1) return 1;
  if (number < -1) return -1;
  // Collapse stick noise and -0 so "released" is unambiguously zero.
  return Math.abs(number) < AXIS_EPSILON ? 0 : number;
}

/**
 * Convert a provider sample into semantic pilot axes.
 * A missing or malformed sample yields neutral — never a partial command.
 */
export function sampleToPilotAxes(sample) {
  const axes = sample?.axes;
  if (!Array.isArray(axes)) return { ...NEUTRAL_AXES };
  return {
    // Sticks read negative when pushed away from the pilot; forward and
    // climb are positive intentions, hence the inversion.
    forward: clampUnit(-(axes[3] ?? 0)),
    right: clampUnit(axes[2] ?? 0),
    up: clampUnit(-(axes[1] ?? 0)),
    yaw: clampUnit(axes[0] ?? 0)
  };
}

export function axesAreNeutral(axes) {
  return (
    clampUnit(axes?.forward) === 0 &&
    clampUnit(axes?.right) === 0 &&
    clampUnit(axes?.up) === 0 &&
    clampUnit(axes?.yaw) === 0
  );
}

export function axesEqual(a, b) {
  return (
    clampUnit(a?.forward) === clampUnit(b?.forward) &&
    clampUnit(a?.right) === clampUnit(b?.right) &&
    clampUnit(a?.up) === clampUnit(b?.up) &&
    clampUnit(a?.yaw) === clampUnit(b?.yaw)
  );
}

/**
 * Preview of the horizontal magnitude, 0..1.
 * Shown in the UI so the operator can see that a diagonal is not faster than
 * a straight line — the backend does the actual vector clamp.
 */
export function horizontalMagnitude(axes) {
  return Math.min(1, Math.hypot(clampUnit(axes?.forward), clampUnit(axes?.right)));
}
