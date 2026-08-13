export const CALIBRATION_SCHEMA_VERSION = 1;

/** Semantic order used by `axisAssignments`. */
export const DEFAULT_AXIS_ASSIGNMENTS = Object.freeze([0, 1, 2, 3]);

export function defaultCalibration(meta = {}) {
  const n = meta.axesCount ?? 4;
  const now = new Date().toISOString();
  return {
    schemaVersion: CALIBRATION_SCHEMA_VERSION,
    controllerId: meta.id || "",
    mapping: meta.mapping || "",
    axesCount: n,
    buttonsCount: meta.buttonsCount ?? 18,
    createdAt: now,
    updatedAt: now,
    // Semantic order: yaw, throttle, roll, pitch -> raw Gamepad API index.
    axisAssignments: [...DEFAULT_AXIS_ASSIGNMENTS],
    axisCenters: Array(n).fill(0),
    axisMinimums: Array(n).fill(-1),
    axisMaximums: Array(n).fill(1),
    // These arrays remain raw-axis indexed even when assignments change.
    axisInversions: Array(n).fill(false),
    deadzones: Array(n).fill(0.08),
    expoValues: Array(n).fill(0.25),
    triggerRanges: { l2: { rest: 0, full: 1 }, r2: { rest: 0, full: 1 } },
    deadmanButtonIndex: 4,
    warnings: [],
    validationState: "incomplete"
  };
}

export function validateCalibration(value) {
  if (
    !value
    || value.schemaVersion !== CALIBRATION_SCHEMA_VERSION
    || typeof value.controllerId !== "string"
    || !Number.isInteger(value.axesCount)
    || value.axesCount < 1
    || !Number.isInteger(value.buttonsCount)
    || value.buttonsCount < 1
  ) {
    return { valid: false, errors: ["malformed calibration data"] };
  }

  const arrays = ["axisCenters", "axisMinimums", "axisMaximums", "axisInversions", "deadzones", "expoValues"];
  const errors = arrays
    .filter((key) => !Array.isArray(value[key]) || value[key].length !== value.axesCount)
    .map((key) => `invalid ${key}`);

  for (let index = 0; index < value.axesCount; index += 1) {
    const minimum = value.axisMinimums?.[index];
    const center = value.axisCenters?.[index];
    const maximum = value.axisMaximums?.[index];
    if (![minimum, center, maximum].every(Number.isFinite)) {
      errors.push(`axis ${index}: non-finite calibration`);
    } else if ((maximum - minimum) < 0.5) {
      errors.push(`axis ${index}: insufficient range`);
    } else if (center < minimum || center > maximum) {
      errors.push(`axis ${index}: centre outside range`);
    }
    if (typeof value.axisInversions?.[index] !== "boolean") errors.push(`axis ${index}: invalid inversion`);
    if (!Number.isFinite(value.deadzones?.[index]) || value.deadzones[index] < 0 || value.deadzones[index] >= 1) errors.push(`axis ${index}: invalid deadzone`);
    if (!Number.isFinite(value.expoValues?.[index]) || value.expoValues[index] < 0 || value.expoValues[index] > 1) errors.push(`axis ${index}: invalid expo`);
  }

  const assignments = value.axisAssignments || DEFAULT_AXIS_ASSIGNMENTS;
  if (
    !Array.isArray(assignments)
    || assignments.length !== DEFAULT_AXIS_ASSIGNMENTS.length
    || assignments.some((index) => !Number.isInteger(index) || index < 0 || index >= value.axesCount)
  ) {
    errors.push("invalid axis assignments");
  } else if (new Set(assignments).size !== assignments.length) {
    errors.push("duplicate axis assignments");
  }

  if (
    !Number.isInteger(value.deadmanButtonIndex)
    || value.deadmanButtonIndex < 0
    || value.deadmanButtonIndex >= value.buttonsCount
  ) {
    errors.push("invalid dead-man button");
  }

  return { valid: errors.length === 0, errors };
}

export function observeAxis(stats, value) {
  return {
    min: Math.min(stats?.min ?? value, value),
    max: Math.max(stats?.max ?? value, value),
    center: stats?.center ?? value
  };
}

/** Hydrate older schema-v1 records that predate configurable assignments. */
export function migrateCalibration(value) {
  if (value?.schemaVersion !== CALIBRATION_SCHEMA_VERSION) return null;
  return {
    ...value,
    axisAssignments: Array.isArray(value.axisAssignments)
      ? [...value.axisAssignments]
      : [...DEFAULT_AXIS_ASSIGNMENTS]
  };
}
