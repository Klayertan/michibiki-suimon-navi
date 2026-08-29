// The DEFINITION of a QZ1 vertical-displacement experiment: which reference
// heights are visited, in what order, and how long the receiver dwells at
// each one. Pure data + validation — no acquisition, no analysis, no DOM.
//
// WHY THIS IS A SEPARATE MODULE
// ----------------------------
// The whole point of the experiment is to find out whether QZ1/QZ1LE altitude
// can resolve paddy-relevant water-level steps AT ALL. That question is only
// answerable if the experimental design is recorded alongside the data:
// "which heights, how long, in what order, with what settling time" is not a
// detail, it is half the result. A run whose dwell time is unknown cannot be
// compared against a run whose dwell time is known.
//
// NOTHING HERE ASSUMES AN ANSWER. In particular:
//   * no averaging duration is hard-coded as "the" correct one — the brief's
//     60 s / 120 s / 300 s are PRESETS, and any positive duration is legal;
//   * no accuracy target is baked in as a pass mark. `toleranceMm` is an
//     input the operator chooses and which is stored with the result, so a
//     later reader can see what bar was being cleared.
//
// UNITS. Reference heights are millimetres (mm), integers or not, and are
// SIGNED displacements from the experiment's own baseline position — not
// absolute elevations. Dwell/settle durations are seconds.

/**
 * The step sizes the project actually cares about, from the brief: the
 * changes that matter in paddy water management. 0 is the baseline and is
 * always present.
 */
export const DEFAULT_REFERENCE_HEIGHTS_MM = [0, 10, 20, 30, 50, 100];

/** Offered in the UI. Not limits — see `normalizeExperimentConfig`. */
export const DWELL_DURATION_PRESETS_S = [60, 120, 300];

/**
 * Two experimental stages, in the order the brief runs them.
 *
 * `controlled-rig` — the receiver is moved by a known amount on a rigid
 *   vertical reference (blocks, a lab jack, a marked post). The float and the
 *   water are NOT involved. This isolates the GNSS question.
 *
 * `floating-ball` — the real tethered float on real water. `reference_height`
 *   is then the independently measured WATER level, and the result folds in
 *   float motion, cable pull, waves and antenna tilt on top of GNSS noise.
 *
 * They share one data format on purpose: the second stage is only
 * interpretable by comparison with the first.
 */
export const EXPERIMENT_STAGES = {
  "controlled-rig": {
    id: "controlled-rig",
    labelJa: "固定治具による上下移動",
    labelEn: "Controlled vertical rig",
    referenceMeaning: "受信機アンテナの機械的な高さ（mm）"
  },
  "floating-ball": {
    id: "floating-ball",
    labelJa: "浮体ブイ（実水面）",
    labelEn: "Floating ball on water",
    referenceMeaning: "独立に実測した水面の高さ（mm）"
  }
};

/** Sensor identities this project has. Free text is allowed; these are hints. */
export const KNOWN_SENSORS = ["QZ1", "QZ1LE"];

/**
 * Seconds discarded at the start of every dwell before samples count.
 *
 * Moving the receiver disturbs the filter state inside the receiver itself,
 * and a Kalman-filtered altitude does not step instantly. Counting those
 * samples would smear each level into its neighbour and make small steps look
 * better OR worse than they are, depending on direction. Default is
 * deliberately non-zero, deliberately small, and always recorded in the
 * output so it can be varied and re-analysed.
 */
export const DEFAULT_SETTLE_SECONDS = 15;

/** The error the operator is willing to call "resolved", in mm. */
export const DEFAULT_TOLERANCE_MM = 10;

/**
 * Validates and completes a user/JSON-supplied configuration.
 *
 * Returns `{ config, errors }`. `config` is null when `errors` is non-empty —
 * a half-valid experiment definition is worse than none, because it would be
 * stored next to the data and read later as if it were the real design.
 */
export function normalizeExperimentConfig(raw = {}) {
  raw = raw && typeof raw === "object" ? raw : {};
  const errors = [];

  const experimentId = trimmedString(raw.experiment ?? raw.experimentId);
  if (!experimentId) {
    errors.push("experiment: 実験IDは必須です / experiment id is required");
  }

  const stageId = trimmedString(raw.stage) || "controlled-rig";
  if (!EXPERIMENT_STAGES[stageId]) {
    errors.push(`stage: 未知のステージ "${stageId}" / unknown stage`);
  }

  const sensor = trimmedString(raw.sensor);
  if (!sensor) {
    errors.push("sensor: 受信機名は必須です（例 QZ1LE）/ sensor is required");
  }

  const heights = normalizeReferenceHeights(
    raw.reference_heights_mm ?? raw.referenceHeightsMm ?? DEFAULT_REFERENCE_HEIGHTS_MM,
    errors
  );

  const dwellSeconds = positiveNumber(
    raw.sampling_configuration?.dwell_seconds ?? raw.dwellSeconds,
    errors,
    "dwell_seconds"
  );

  const settleSeconds = nonNegativeNumber(
    raw.sampling_configuration?.settle_seconds ?? raw.settleSeconds ?? DEFAULT_SETTLE_SECONDS,
    errors,
    "settle_seconds"
  );

  if (dwellSeconds !== null && settleSeconds !== null && settleSeconds >= dwellSeconds) {
    errors.push("settle_seconds: 整定時間が滞在時間以上です（有効サンプルが0になります）/ settle window consumes the whole dwell");
  }

  const toleranceMm = positiveNumber(
    raw.tolerance_mm ?? raw.toleranceMm ?? DEFAULT_TOLERANCE_MM,
    errors,
    "tolerance_mm"
  );

  const descending = raw.include_descending ?? raw.includeDescending ?? true;

  if (errors.length > 0) {
    return { config: null, errors };
  }

  return {
    config: {
      experimentId,
      stage: stageId,
      sensor,
      referenceHeightsMm: heights,
      includeDescending: Boolean(descending),
      dwellSeconds,
      settleSeconds,
      toleranceMm,
      location: trimmedString(raw.location),
      operator: trimmedString(raw.operator),
      notes: trimmedString(raw.notes)
    },
    errors: []
  };
}

/**
 * Reference heights, de-duplicated and sorted ascending, with 0 guaranteed
 * present because every displacement in this project is measured FROM the
 * baseline and a run with no baseline yields no ΔZ at all.
 */
export function normalizeReferenceHeights(input, errors = []) {
  if (!Array.isArray(input) || input.length === 0) {
    errors.push("reference_heights_mm: 1つ以上の基準高さが必要です / at least one reference height is required");
    return [];
  }
  const values = [];
  for (const entry of input) {
    const value = numberOrNull(entry);
    if (value === null) {
      errors.push(`reference_heights_mm: 数値でない値 ${JSON.stringify(entry)} / non-numeric height`);
      continue;
    }
    if (!values.includes(value)) {
      values.push(value);
    }
  }
  if (!values.includes(0)) {
    values.push(0);
  }
  return values.sort((a, b) => a - b);
}

/**
 * The ordered list of positions to visit.
 *
 * Ascending, then (optionally) descending back down. The descending leg is
 * not decoration: a receiver whose altitude drifts slowly produces a
 * hysteresis signature — the same reference height reads differently on the
 * way up and on the way down — and that difference is itself a measurement of
 * how much of the "signal" is really drift. Each visit is a separate step
 * with its own `visitIndex`, never merged with its ascending twin.
 */
export function buildExperimentPlan(config) {
  const heights = config.referenceHeightsMm;
  const ascending = [...heights];
  const descending = config.includeDescending
    ? [...heights].reverse().slice(1)
    : [];
  const ordered = [...ascending, ...descending];

  return ordered.map((referenceHeightMm, index) => ({
    stepIndex: index,
    referenceHeightMm,
    direction: index < ascending.length ? "ascending" : "descending",
    // How many times this same height has been visited before, so an
    // ascending 30 mm and a descending 30 mm never collapse into one bucket.
    visitIndex: ordered.slice(0, index).filter((value) => value === referenceHeightMm).length,
    dwellSeconds: config.dwellSeconds,
    settleSeconds: config.settleSeconds
  }));
}

/** Total wall-clock seconds the plan will take, excluding repositioning time. */
export function planDurationSeconds(plan) {
  return plan.reduce((total, step) => total + step.dwellSeconds, 0);
}

/**
 * The JSON metadata block written next to every experiment CSV.
 *
 * Deliberately carries no measurement values: this file describes the
 * INTENT of a run. Anything observed lives in the CSV, which is the only
 * artefact that may ever contain numbers read off the receiver.
 */
export function buildExperimentMetadata(config, extra = {}) {
  return {
    experiment: config.experimentId,
    stage: config.stage,
    sensor: config.sensor,
    reference_heights_mm: config.referenceHeightsMm,
    include_descending: config.includeDescending,
    location: config.location,
    operator: config.operator,
    notes: config.notes,
    sampling_configuration: {
      dwell_seconds: config.dwellSeconds,
      settle_seconds: config.settleSeconds
    },
    tolerance_mm: config.toleranceMm,
    created_at: extra.createdAt ?? null,
    software: extra.software ?? "michibiki-suimon-navi / qz1-water-level"
  };
}

function trimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function positiveNumber(value, errors, field) {
  const number = numberOrNull(value);
  if (number === null || number <= 0) {
    errors.push(`${field}: 正の数値が必要です / must be a positive number`);
    return null;
  }
  return number;
}

function nonNegativeNumber(value, errors, field) {
  const number = numberOrNull(value);
  if (number === null || number < 0) {
    errors.push(`${field}: 0以上の数値が必要です / must be zero or greater`);
    return null;
  }
  return number;
}

/** Numeric strings are accepted for JSON/UI inputs; missing values are not 0. */
function numberOrNull(value) {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) {
    return null;
  }
  if (typeof value !== "number" && typeof value !== "string") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
