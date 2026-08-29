// Descriptive statistics for a set of altitude samples held at one fixed
// reference height, in millimetres.
//
// WHY THE CONFIDENCE INTERVAL HERE IS NOT THE TEXTBOOK ONE
// --------------------------------------------------------
// The naive standard error, sd/√n, assumes independent samples. Consecutive
// 1 Hz GNSS fixes are emphatically not independent: multipath and atmospheric
// error decorrelate over minutes, not seconds, so a 300-second dwell does not
// contain 300 independent measurements of the position. Using sd/√n would
// shrink the interval by roughly √300 ≈ 17× and would let this project
// announce sub-millimetre confidence from data that supports nothing of the
// kind — precisely the claim the brief forbids.
//
// So the interval is computed twice:
//
//   `ci95Naive`     sd/√n. Reported only so the difference is visible.
//   `ci95`          sd/√n_eff, with n_eff from the lag-1 autocorrelation
//                   under an AR(1) approximation: n_eff = n·(1−r₁)/(1+r₁).
//
// `ci95` is the one the analysis uses and the one the report prints. AR(1) is
// itself an approximation — real GNSS error has longer memory than one lag —
// so `ci95` is best read as a floor on the uncertainty, not a tight bound.
// The honest summary of both is: this interval is optimistic, and the naive
// one is wildly optimistic.
//
// EVERY FUNCTION HERE REFUSES TO INVENT DATA. An empty set has no mean; a
// single sample has no standard deviation. Those come back as null, and the
// analysis layer reports "insufficient samples" instead of printing a 0.

/**
 * The smallest AR(1) effective sample size that earns a confidence interval.
 *
 * Below 2, the t distribution has less than one degree of freedom and its
 * 95% critical value diverges. A dwell that lands here has not produced two
 * independent measurements of the position, however many fixes it contains --
 * the fix is to hold the position longer, not to quote a wide interval.
 */
export const MIN_EFFECTIVE_SAMPLES = 2;

/**
 * Summarizes altitude values (mm).
 *
 * @param values array of finite numbers. Non-finite entries are counted in
 *               `discarded` and excluded — never coerced to 0.
 */
export function summarizeAltitudes(values) {
  const clean = (values || []).filter((value) => Number.isFinite(value));
  const discarded = (values || []).length - clean.length;

  if (clean.length === 0) {
    return {
      count: 0,
      discarded,
      meanMm: null, medianMm: null, sdMm: null,
      minMm: null, maxMm: null, rangeMm: null, rmsMm: null,
      lag1Autocorrelation: null,
      effectiveCount: null,
      standardErrorMm: null,
      ci95Mm: null,
      ci95NaiveMm: null,
      ciMethod: "insufficient-samples"
    };
  }

  const sorted = [...clean].sort((a, b) => a - b);
  const meanMm = clean.reduce((total, value) => total + value, 0) / clean.length;
  const medianMm = quantileSorted(sorted, 0.5);
  const minMm = sorted[0];
  const maxMm = sorted[sorted.length - 1];

  if (clean.length === 1) {
    return {
      count: 1, discarded,
      meanMm, medianMm, sdMm: null,
      minMm, maxMm, rangeMm: 0, rmsMm: 0,
      lag1Autocorrelation: null,
      effectiveCount: 1,
      standardErrorMm: null,
      ci95Mm: null,
      ci95NaiveMm: null,
      ciMethod: "insufficient-samples"
    };
  }

  const variance = clean.reduce((total, value) => total + (value - meanMm) ** 2, 0) / (clean.length - 1);
  const sdMm = Math.sqrt(variance);
  // RMS variation ABOUT THE MEAN — i.e. the scatter, not the RMS of the
  // absolute altitudes (which would just be ~the altitude itself and would
  // say nothing about stability).
  const rmsMm = Math.sqrt(clean.reduce((total, value) => total + (value - meanMm) ** 2, 0) / clean.length);

  const lag1 = lag1Autocorrelation(clean, meanMm, variance);
  const effectiveCount = effectiveSampleSize(clean.length, lag1);
  const tNaive = tCritical95(clean.length - 1);
  const ci95NaiveMm = tNaive * sdMm / Math.sqrt(clean.length);

  // n_eff must reach MIN_EFFECTIVE_SAMPLES before an interval is quoted.
  // This is not a formality: the project's own QZ1 log has stretches with
  // r1 > 0.98, where n_eff collapses to ~1 and the t critical value diverges.
  // Returning Infinity there would be arithmetically defensible and
  // practically useless -- it would poison the JSON export, the plots and any
  // comparison. Reporting "no interval, the samples are too correlated" is
  // both true and actionable: it means dwell longer, not filter harder.
  const usableEffective = effectiveCount !== null && effectiveCount >= MIN_EFFECTIVE_SAMPLES;
  const standardErrorMm = usableEffective ? sdMm / Math.sqrt(effectiveCount) : null;
  const ci95Mm = usableEffective ? tCritical95(effectiveCount - 1) * standardErrorMm : null;

  return {
    count: clean.length,
    discarded,
    meanMm,
    medianMm,
    sdMm,
    minMm,
    maxMm,
    rangeMm: maxMm - minMm,
    rmsMm,
    lag1Autocorrelation: lag1,
    effectiveCount,
    standardErrorMm,
    ci95Mm,
    ci95NaiveMm,
    ciMethod: usableEffective ? "ar1-effective-n" : "insufficient-independent-samples"
  };
}

/**
 * Lag-1 autocorrelation of a series. Null when it cannot be computed.
 *
 * Not clamped to [0,1] on output: a negative r₁ is a real thing (it appears
 * when a receiver's output alternates), and hiding it would misreport the
 * data. `effectiveSampleSize` handles the negative case explicitly.
 */
export function lag1Autocorrelation(values, meanValue = null, varianceValue = null) {
  if (!Array.isArray(values) || values.length < 3) {
    return null;
  }
  const centre = meanValue === null
    ? values.reduce((total, value) => total + value, 0) / values.length
    : meanValue;
  const denominator = varianceValue === null
    ? values.reduce((total, value) => total + (value - centre) ** 2, 0) / (values.length - 1)
    : varianceValue;
  if (!(denominator > 0)) {
    return null;
  }
  let covariance = 0;
  for (let index = 1; index < values.length; index += 1) {
    covariance += (values[index] - centre) * (values[index - 1] - centre);
  }
  covariance /= values.length - 1;
  return covariance / denominator;
}

/**
 * AR(1) effective sample size: n·(1−r₁)/(1+r₁).
 *
 * A negative r₁ would make n_eff LARGER than n — i.e. would claim the samples
 * are better than independent. They are not; that is an artefact of the
 * approximation, so n_eff is capped at n. A strongly positive r₁ is capped at
 * 0.99 so an almost-constant series does not produce n_eff ≈ 0 and an
 * infinite interval; the cap is recorded by the resulting n_eff being
 * exactly n/199, which is already an extreme claim of dependence.
 */
export function effectiveSampleSize(count, lag1) {
  if (!Number.isFinite(count) || count < 2) {
    return count >= 1 ? count : null;
  }
  if (lag1 === null || !Number.isFinite(lag1)) {
    return count;
  }
  const r = Math.min(0.99, lag1);
  if (r <= 0) {
    return count;
  }
  return Math.max(1, count * (1 - r) / (1 + r));
}

/**
 * Two-sided 95% Student-t critical value.
 *
 * Small df come from a table (the Cornish–Fisher expansion below is poor
 * there); df ≥ 6 uses the expansion, which is accurate to <0.001 across the
 * range this project produces. df need not be an integer, because n_eff is
 * generally fractional.
 */
export function tCritical95(df) {
  if (!Number.isFinite(df) || df < 1) {
    return Number.POSITIVE_INFINITY;
  }
  const TABLE = {
    1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447
  };
  if (df <= 6) {
    const lower = Math.max(1, Math.floor(df));
    const upper = Math.min(6, Math.ceil(df));
    if (lower === upper) {
      return TABLE[lower];
    }
    const weight = df - lower;
    return TABLE[lower] + weight * (TABLE[upper] - TABLE[lower]);
  }
  const z = 1.959963985;
  const g1 = (z ** 3 + z) / 4;
  const g2 = (5 * z ** 5 + 16 * z ** 3 + 3 * z) / 96;
  const g3 = (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / 384;
  return z + g1 / df + g2 / df ** 2 + g3 / df ** 3;
}

/** Empirical quantile of an already-sorted array (linear interpolation). */
export function quantileSorted(sorted, probability) {
  if (sorted.length === 0) {
    return null;
  }
  if (sorted.length === 1) {
    return sorted[0];
  }
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) {
    return sorted[lower];
  }
  return sorted[lower] + (position - lower) * (sorted[upper] - sorted[lower]);
}

/**
 * The 2.5th–97.5th percentile band of the SAMPLES themselves.
 *
 * Distinct from `ci95Mm`, which is about the mean. This one answers "where do
 * individual fixes land", which is what matters for a live readout that shows
 * one number to a farmer, whereas the CI answers "how well do we know the
 * average", which is what matters for the displacement comparison. Confusing
 * the two is the easiest way to overstate this system's accuracy.
 */
export function sampleInterval95(values) {
  const clean = (values || []).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (clean.length < 2) {
    return { lowerMm: null, upperMm: null, widthMm: null, count: clean.length };
  }
  const lowerMm = quantileSorted(clean, 0.025);
  const upperMm = quantileSorted(clean, 0.975);
  return { lowerMm, upperMm, widthMm: upperMm - lowerMm, count: clean.length };
}

/**
 * Histogram bins for the per-position distribution plot.
 * Returns `[]` for fewer than two distinct values rather than a single
 * zero-width bin that would render as a misleading spike.
 */
export function histogram(values, binCount = 20) {
  const clean = (values || []).filter((value) => Number.isFinite(value));
  if (clean.length === 0) {
    return [];
  }
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  if (!(max > min)) {
    return [];
  }
  const width = (max - min) / binCount;
  const bins = Array.from({ length: binCount }, (unused, index) => ({
    fromMm: min + index * width,
    toMm: min + (index + 1) * width,
    count: 0
  }));
  for (const value of clean) {
    const index = Math.min(binCount - 1, Math.floor((value - min) / width));
    bins[index].count += 1;
  }
  return bins;
}
