export const clamp = (value, min = -1, max = 1) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0));

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
export function gatePreview(values, { deadman, connected, focused, visible, stale, calibrated }) {
  const reason = !connected ? "controller-disconnected" : !focused ? "focus-lost" : !visible ? "tab-hidden" : stale ? "stale-input" : !calibrated ? "calibration-incomplete" : !deadman ? "deadman-released" : null;
  return { active: !reason, reason, values: Object.fromEntries(Object.entries(values).map(([k,v]) => [k, reason ? 0 : v])) };
}
