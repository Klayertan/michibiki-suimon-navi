export const clamp = (value, min = -1, max = 1) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0));

/** Semantic Mode 2 axes exposed by the common input layer. */
export const MODE2_AXIS_NAMES = Object.freeze(["yaw", "throttle", "roll", "pitch"]);
export const NEUTRAL_MODE2_AXES = Object.freeze({ pitch: 0, roll: 0, throttle: 0, yaw: 0 });

export function scaleAxis(value, min = -1, center = 0, max = 1) {
  const v = clamp(value, min, max);
  const span = v < center ? center - min : max - center;
  return span > 0 ? clamp((v - center) / span) : 0;
}
export const compensateCenter = (value, center = 0) => value - center;
export const invertAxis = (value, inverted = false) => inverted ? -value : value;
export function axialDeadzone(value, deadzone = 0.08) {
  const magnitude = Math.abs(value);
  if (magnitude <= deadzone) return 0;
  return Math.sign(value) * clamp((magnitude - deadzone) / (1 - deadzone), 0, 1);
}
export function radialDeadzone(x, y, deadzone = 0.1) {
  const magnitude = Math.hypot(x, y);
  if (magnitude <= deadzone) return { x: 0, y: 0 };
  const scaled = clamp((magnitude - deadzone) / (1 - deadzone), 0, 1) / magnitude;
  return { x: clamp(x * scaled), y: clamp(y * scaled) };
}
export const applyExpo = (value, expo = 0.25) => clamp((1 - clamp(expo, 0, 1)) * value + clamp(expo, 0, 1) * value ** 3);
export function normalizeTrigger(value, rest = -1, full = 1) {
  return full === rest ? 0 : clamp((value - rest) / (full - rest), 0, 1);
}
export const suppressNoise = (value, previous = 0, threshold = 0.01) => Math.abs(value - previous) < threshold ? previous : value;
export const isNeutral = (axes = [], triggers = [], tolerance = 0.08) => axes.every(v => Math.abs(v) <= tolerance) && triggers.every(v => v <= tolerance);
export const detectDrift = (samples = [], threshold = 0.08) => Math.abs(samples.reduce((a, b) => a + b, 0) / Math.max(samples.length, 1)) > threshold;
export function detectNoise(samples = [], threshold = 0.025) {
  if (samples.length < 2) return false;
  const mean = samples.reduce((a,b)=>a+b,0)/samples.length;
  return Math.sqrt(samples.reduce((a,b)=>a+(b-mean)**2,0)/samples.length) > threshold;
}
/**
 * Convert the four canonical provider axes into named Mode 2 intentions.
 *
 * `axisAssignments` is in semantic order `[yaw, throttle, roll, pitch]` and
 * contains raw Gamepad API axis indexes. Calibration arrays (including
 * inversion) remain indexed by raw axis, so a remapped axis keeps all of its
 * measured characteristics. Positive semantic values mean yaw-right, climb,
 * roll-right and pitch-forward respectively.
 */
export function normalizeMode2Axes(sample, calibration, { scale = 1, clampRadial = true } = {}) {
  const rawAxes = Array.isArray(sample?.axes) ? sample.axes : [];
  const assignments = calibration?.axisAssignments || [0, 1, 2, 3];

  const semantic = MODE2_AXIS_NAMES.map((_, semanticIndex) => {
    const rawIndex = assignments[semanticIndex] ?? semanticIndex;
    const rawValue = Number(rawAxes[rawIndex] ?? 0);
    const scaled = scaleAxis(
      rawValue,
      calibration?.axisMinimums?.[rawIndex] ?? -1,
      calibration?.axisCenters?.[rawIndex] ?? 0,
      calibration?.axisMaximums?.[rawIndex] ?? 1
    );
    const inverted = invertAxis(scaled, calibration?.axisInversions?.[rawIndex] ?? false);
    const deadzoned = axialDeadzone(inverted, calibration?.deadzones?.[rawIndex] ?? 0);
    return applyExpo(deadzoned, calibration?.expoValues?.[rawIndex] ?? 0);
  });

  // Clamp diagonal stick input to a unit circle without adding another
  // deadzone; each calibrated raw axis already applied its own deadzone.
  const left = clampRadial
    ? radialDeadzone(semantic[0], semantic[1], 0)
    : { x: semantic[0], y: semantic[1] };
  const right = clampRadial
    ? radialDeadzone(semantic[2], semantic[3], 0)
    : { x: semantic[2], y: semantic[3] };
  return {
    yaw: clamp(left.x * scale),
    throttle: clamp(-left.y * scale),
    roll: clamp(right.x * scale),
    pitch: clamp(-right.y * scale)
  };
}

export function gatePreview(values, { deadman, connected, focused, visible, stale, calibrated, captureActive = true }) {
  const reason = !connected
    ? "controller-disconnected"
    : !focused
      ? "focus-lost"
      : !visible
        ? "tab-hidden"
        : stale
          ? "stale-input"
          : !calibrated
            ? "calibration-incomplete"
            : !captureActive
              ? "capture-inactive"
              : !deadman
                ? "deadman-released"
                : null;
  return { active: !reason, reason, values: Object.fromEntries(Object.entries(values).map(([k,v]) => [k, reason ? 0 : v])) };
}
