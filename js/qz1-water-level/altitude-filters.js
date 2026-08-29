// Configurable filtering of GNSS altitude samples.
//
// FILTERING IS NOT MAGIC, AND IT IS NOT FREE
// ------------------------------------------
// Any filter can be tuned until a null result looks like a positive one. A
// 300-second moving mean over a 60-second dwell will produce beautifully
// smooth numbers that are mostly made of the PREVIOUS reference height. That
// is the specific failure this module is built to prevent:
//
//   1. A filter chain is DATA. It is declared, passed in, stored with the
//      result and printed in the report. There is no default chain applied
//      behind the caller's back — `applyFilterChain(samples, [])` returns the
//      samples untouched, and that is the honest baseline.
//   2. Every stage reports how many samples it removed and why. A chain that
//      discards 90% of the data says so in the output, next to the number it
//      produced.
//   3. Nothing is destroyed. Rejected samples are returned with the id of the
//      stage that rejected them, so every filtered value is traceable back to
//      the raw sample it came from, and the raw log is never rewritten.
//   4. Smoothing stages carry `windowSamples`, never seconds-that-secretly-
//      become-samples, and refuse to span more data than they were given.
//
// ORDER MATTERS and is preserved exactly as declared: quality gates first
// then outlier rejection then smoothing is the sane order, but this module
// does not enforce it, because "we reordered your filters" is exactly the
// kind of invisible processing it exists to avoid.

/** Every stage kind this module understands. Unknown kinds are an error. */
export const FILTER_KINDS = [
  "fix-quality",
  "min-satellites",
  "max-hdop",
  "max-vdop",
  "max-pdop",
  "require-altitude",
  "mad-outlier",
  "sigma-outlier",
  "moving-mean",
  "moving-median"
];

/**
 * A conservative starting point, offered as a NAMED preset so a report can
 * say "chain: standard-quality-gate" rather than burying six numbers.
 *
 * It is a suggestion with no empirical standing yet — the whole experiment
 * exists to find out what these thresholds should be. Chosen to be weak:
 * it removes fixes that are unusable by definition (no fix, no altitude)
 * and leaves the interesting judgement calls to the operator.
 */
export const PRESET_FILTER_CHAINS = {
  none: [],
  "valid-fix-only": [
    { kind: "require-altitude" },
    { kind: "fix-quality", allowed: [1, 2, 4, 5] }
  ],
  "standard-quality-gate": [
    { kind: "require-altitude" },
    { kind: "fix-quality", allowed: [1, 2, 4, 5] },
    { kind: "min-satellites", minimum: 5 },
    { kind: "max-hdop", maximum: 3 },
    { kind: "mad-outlier", threshold: 3 }
  ],
  "quality-gate-then-median-15": [
    { kind: "require-altitude" },
    { kind: "fix-quality", allowed: [1, 2, 4, 5] },
    { kind: "min-satellites", minimum: 5 },
    { kind: "max-hdop", maximum: 3 },
    { kind: "mad-outlier", threshold: 3 },
    { kind: "moving-median", windowSamples: 15 }
  ]
};

/** Validates a chain. Returns `{ chain, errors }`; chain is null if invalid. */
export function normalizeFilterChain(rawChain) {
  if (rawChain === null || rawChain === undefined) {
    return { chain: [], errors: [] };
  }
  if (typeof rawChain === "string") {
    const preset = PRESET_FILTER_CHAINS[rawChain];
    if (!preset) {
      return { chain: null, errors: [`filter chain: 未知のプリセット "${rawChain}" / unknown preset`] };
    }
    return { chain: preset.map((stage) => ({ ...stage })), errors: [] };
  }
  if (!Array.isArray(rawChain)) {
    return { chain: null, errors: ["filter chain: 配列またはプリセット名が必要です / must be an array or preset name"] };
  }

  const errors = [];
  const chain = [];
  rawChain.forEach((rawStage, index) => {
    const kind = rawStage?.kind;
    if (!FILTER_KINDS.includes(kind)) {
      errors.push(`filter[${index}]: 未知のフィルタ種別 "${kind}" / unknown filter kind`);
      return;
    }
    const stage = { kind };
    switch (kind) {
      case "fix-quality": {
        const allowed = Array.isArray(rawStage.allowed) ? rawStage.allowed.map(numberOrNull) : null;
        if (!allowed || allowed.length === 0 || allowed.some((value) => value === null)) {
          errors.push(`filter[${index}] fix-quality: allowed に数値の配列が必要です / allowed must be a numeric array`);
          return;
        }
        stage.allowed = allowed;
        break;
      }
      case "min-satellites":
        if (!requireFinite(rawStage.minimum, errors, index, "minimum")) return;
        stage.minimum = numberOrNull(rawStage.minimum);
        break;
      case "max-hdop":
      case "max-vdop":
      case "max-pdop":
        if (!requireFinite(rawStage.maximum, errors, index, "maximum")) return;
        stage.maximum = numberOrNull(rawStage.maximum);
        break;
      case "require-altitude":
        break;
      case "mad-outlier":
      case "sigma-outlier":
        if (!requirePositive(rawStage.threshold, errors, index, "threshold")) return;
        stage.threshold = numberOrNull(rawStage.threshold);
        break;
      case "moving-mean":
      case "moving-median": {
        const windowSamples = numberOrNull(rawStage.windowSamples);
        if (!Number.isInteger(windowSamples) || windowSamples < 1) {
          errors.push(`filter[${index}] ${kind}: windowSamples に1以上の整数が必要です / windowSamples must be an integer >= 1`);
          return;
        }
        stage.windowSamples = windowSamples;
        break;
      }
      default:
        break;
    }
    chain.push(stage);
  });

  return errors.length > 0 ? { chain: null, errors } : { chain, errors: [] };
}

/**
 * Runs the chain.
 *
 * Returns:
 *   `samples`  — survivors, in order. Smoothing stages replace `altitudeMm`
 *                and keep the original under `rawAltitudeMm`, so a smoothed
 *                value never masquerades as an observed one.
 *   `rejected` — every removed sample, each tagged `{ stageIndex, kind, reason }`
 *   `stages`   — per-stage `{ kind, inputCount, outputCount, removed }`
 */
export function applyFilterChain(samples, chain = []) {
  let current = samples.map((sample) => ({ ...sample }));
  const rejected = [];
  const stages = [];

  chain.forEach((stage, stageIndex) => {
    const inputCount = current.length;
    const result = applyStage(current, stage);
    result.rejected.forEach((entry) => {
      rejected.push({ ...entry, stageIndex, kind: stage.kind });
    });
    current = result.samples;
    stages.push({
      stageIndex,
      kind: stage.kind,
      config: { ...stage },
      inputCount,
      outputCount: current.length,
      removed: inputCount - current.length,
      // Smoothing removes nothing but changes every value; saying so keeps
      // "removed: 0" from reading as "this stage did nothing".
      transformed: result.transformed === true
    });
  });

  return { samples: current, rejected, stages };
}

/** Convenience: `{ raw, filtered, report }` for one set of samples. */
export function filterAltitudes(samples, rawChain) {
  const { chain, errors } = normalizeFilterChain(rawChain);
  if (!chain) {
    return { raw: samples, filtered: null, report: null, errors };
  }
  const applied = applyFilterChain(samples, chain);
  return {
    raw: samples,
    filtered: applied.samples,
    report: { chain, stages: applied.stages, rejectedCount: applied.rejected.length, rejected: applied.rejected },
    errors: []
  };
}

function applyStage(samples, stage) {
  switch (stage.kind) {
    case "require-altitude":
      return partition(samples, (sample) => Number.isFinite(sample.altitudeMm), "altitude missing");
    case "fix-quality":
      return partition(
        samples,
        (sample) => Number.isFinite(sample.fix) && stage.allowed.includes(sample.fix),
        `fix not in [${stage.allowed.join(",")}]`
      );
    case "min-satellites":
      return partition(
        samples,
        (sample) => Number.isFinite(sample.satellites) && sample.satellites >= stage.minimum,
        `satellites < ${stage.minimum}`
      );
    case "max-hdop":
      return partitionDop(samples, "hdop", stage.maximum);
    case "max-vdop":
      return partitionDop(samples, "vdop", stage.maximum);
    case "max-pdop":
      return partitionDop(samples, "pdop", stage.maximum);
    case "mad-outlier":
      return madOutlier(samples, stage.threshold);
    case "sigma-outlier":
      return sigmaOutlier(samples, stage.threshold);
    case "moving-mean":
      return { samples: smooth(samples, stage.windowSamples, mean), rejected: [], transformed: true };
    case "moving-median":
      return { samples: smooth(samples, stage.windowSamples, median), rejected: [], transformed: true };
    default:
      return { samples, rejected: [] };
  }
}

/**
 * A DOP gate keeps samples whose DOP is missing.
 *
 * Dropping them would silently delete every sample from a receiver that does
 * not report that DOP at all — QZ1's GGA has no VDOP field — turning a
 * "device does not report this" into "device produced no usable data". The
 * count of DOP-less samples is visible through `describeTelemetryCoverage()`
 * in experiment-samples.js, which is where that fact belongs.
 */
function partitionDop(samples, field, maximum) {
  return partition(
    samples,
    (sample) => !Number.isFinite(sample[field]) || sample[field] <= maximum,
    `${field} > ${maximum}`
  );
}

function partition(samples, predicate, reason) {
  const kept = [];
  const rejected = [];
  for (const sample of samples) {
    if (predicate(sample)) {
      kept.push(sample);
    } else {
      rejected.push({ sample, reason });
    }
  }
  return { samples: kept, rejected };
}

/**
 * Median Absolute Deviation outlier rejection.
 *
 * MAD rather than standard deviation because a single 40 m GNSS spike — which
 * these logs genuinely contain — inflates the SD enough to protect itself
 * from an SD-based gate. MAD is scaled by 1.4826 so `threshold` is
 * interpretable in units of a normal-distribution sigma.
 */
function madOutlier(samples, threshold) {
  const values = altitudeValues(samples);
  if (values.length < 3) {
    return { samples, rejected: [] };
  }
  const centre = median(values);
  const scaledMad = 1.4826 * median(values.map((value) => Math.abs(value - centre)));
  if (!(scaledMad > 0)) {
    // Every value identical (or all but a few): there is no spread to
    // measure against, so rejecting anything would be arbitrary.
    return { samples, rejected: [] };
  }
  return partition(
    samples,
    (sample) => !Number.isFinite(sample.altitudeMm)
      || Math.abs(sample.altitudeMm - centre) <= threshold * scaledMad,
    `|Δ| > ${threshold}×MAD`
  );
}

function sigmaOutlier(samples, threshold) {
  const values = altitudeValues(samples);
  if (values.length < 3) {
    return { samples, rejected: [] };
  }
  const centre = mean(values);
  const sd = standardDeviation(values, centre);
  if (!(sd > 0)) {
    return { samples, rejected: [] };
  }
  return partition(
    samples,
    (sample) => !Number.isFinite(sample.altitudeMm) || Math.abs(sample.altitudeMm - centre) <= threshold * sd,
    `|Δ| > ${threshold}σ`
  );
}

/**
 * Centred moving window.
 *
 * Centred, not trailing, because a trailing window lags the signal by half
 * its length — which for step-detection means every step appears late and
 * shallower than it is. Windows are truncated at the ends rather than padded,
 * and `smoothedFrom` records how many samples actually contributed, so an
 * edge value computed from 3 samples is not mistaken for one computed from 15.
 */
function smooth(samples, windowSamples, reducer) {
  const half = Math.floor(windowSamples / 2);
  return samples.map((sample, index) => {
    if (!Number.isFinite(sample.altitudeMm)) {
      return { ...sample };
    }
    const from = Math.max(0, index - half);
    const to = Math.min(samples.length, index + half + 1);
    const window = altitudeValues(samples.slice(from, to));
    if (window.length === 0) {
      return { ...sample };
    }
    return {
      ...sample,
      rawAltitudeMm: sample.rawAltitudeMm ?? sample.altitudeMm,
      altitudeMm: reducer(window),
      smoothedFrom: window.length
    };
  });
}

function altitudeValues(samples) {
  return samples.map((sample) => sample.altitudeMm).filter((value) => Number.isFinite(value));
}

function requireFinite(value, errors, index, field) {
  if (numberOrNull(value) === null) {
    errors.push(`filter[${index}]: ${field} に数値が必要です / ${field} must be a number`);
    return false;
  }
  return true;
}

function requirePositive(value, errors, index, field) {
  const number = numberOrNull(value);
  if (number === null || number <= 0) {
    errors.push(`filter[${index}]: ${field} に正の数値が必要です / ${field} must be positive`);
    return false;
  }
  return true;
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

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function standardDeviation(values, centre) {
  if (values.length < 2) {
    return 0;
  }
  const variance = values.reduce((total, value) => total + (value - centre) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}
