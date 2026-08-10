// Provider sample -> semantic manual-pilot axes.
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
// Manual convention (what the backend receives), all -1..+1:
//   pitch    + forward,  - backward
//   roll     + right,    - left
//   throttle + up,       - down
//   yaw      + right,    - left
//
// No speeds, units, or MAVLink concepts appear anywhere in this file. The
// browser expresses intent; the backend decides how fast that is.

/** Axis magnitudes below this are treated as exactly zero. */
export const AXIS_EPSILON = 0.02;

/**
 * Button index carrying the dead-man state in a provider sample. Must match
 * `DEADMAN_BUTTON_INDEX` in js/gamepad/*.js (kept as a separate literal here,
 * not an import, so this file stays dependency-free -- any provider that
 * emits the shared sample shape works here without a coupling to a specific
 * provider module).
 */
const DEADMAN_BUTTON_INDEX = 4;

export const NEUTRAL_AXES = Object.freeze({ pitch: 0, roll: 0, throttle: 0, yaw: 0 });

/** Keyboard keys are digital, so one press deliberately represents only a
 * quarter stick. The backend independently enforces its conservative RC
 * envelope; this keeps preview and operator muscle-memory honest too. */
export const KEYBOARD_DIGITAL_DEFLECTION = 0.25;

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
  const scale = sample?.provider === "keyboard" ? KEYBOARD_DIGITAL_DEFLECTION : 1;
  return {
    // Sticks read negative when pushed away from the pilot; forward and
    // climb are positive intentions, hence the inversion.
    pitch: clampUnit(-(axes[3] ?? 0) * scale),
    roll: clampUnit((axes[2] ?? 0) * scale),
    throttle: clampUnit(-(axes[1] ?? 0) * scale),
    yaw: clampUnit((axes[0] ?? 0) * scale)
  };
}

/**
 * Whether the dead-man button is currently held, from a raw provider sample.
 * Missing, malformed, or short button arrays all read as "not held" -- the
 * same fail-closed default every other field in this module uses.
 */
export function sampleDeadman(sample) {
  if (typeof sample?.deadmanHeld === "boolean") return sample.deadmanHeld;
  const buttons = sample?.buttons;
  if (!Array.isArray(buttons)) return false;
  return Boolean(buttons[DEADMAN_BUTTON_INDEX]?.pressed);
}

export function axesAreNeutral(axes) {
  return (
    clampUnit(axes?.pitch) === 0 &&
    clampUnit(axes?.roll) === 0 &&
    clampUnit(axes?.throttle) === 0 &&
    clampUnit(axes?.yaw) === 0
  );
}

export function axesEqual(a, b) {
  return (
    clampUnit(a?.pitch) === clampUnit(b?.pitch) &&
    clampUnit(a?.roll) === clampUnit(b?.roll) &&
    clampUnit(a?.throttle) === clampUnit(b?.throttle) &&
    clampUnit(a?.yaw) === clampUnit(b?.yaw)
  );
}

/**
 * Preview of the horizontal magnitude, 0..1.
 * Shown in the UI so the operator can see that a diagonal is not faster than
 * a straight line — the backend does the actual vector clamp.
 */
export function horizontalMagnitude(axes) {
  return Math.min(1, Math.hypot(clampUnit(axes?.pitch), clampUnit(axes?.roll)));
}
