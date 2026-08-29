import test from "node:test";
import assert from "node:assert/strict";
import {
  MIN_EFFECTIVE_SAMPLES,
  effectiveSampleSize,
  histogram,
  lag1Autocorrelation,
  quantileSorted,
  sampleInterval95,
  summarizeAltitudes,
  tCritical95
} from "../../js/qz1-water-level/displacement-statistics.js";

test("descriptive statistics over a known set", () => {
  const summary = summarizeAltitudes([10, 20, 30, 40, 50]);
  assert.equal(summary.count, 5);
  assert.equal(summary.meanMm, 30);
  assert.equal(summary.medianMm, 30);
  assert.equal(summary.minMm, 10);
  assert.equal(summary.maxMm, 50);
  assert.equal(summary.rangeMm, 40);
  // Sample SD (n-1): sqrt(1000/4) = sqrt(250)
  assert.ok(Math.abs(summary.sdMm - Math.sqrt(250)) < 1e-9);
  // RMS about the mean uses n, not n-1 — it is the scatter, not an estimator.
  assert.ok(Math.abs(summary.rmsMm - Math.sqrt(200)) < 1e-9);
});

test("an empty set has no mean — it does not have a mean of zero", () => {
  const summary = summarizeAltitudes([]);
  assert.equal(summary.count, 0);
  assert.equal(summary.meanMm, null);
  assert.equal(summary.sdMm, null);
  assert.equal(summary.ci95Mm, null);
  assert.equal(summary.ciMethod, "insufficient-samples");
});

test("one sample has a mean but no standard deviation and no interval", () => {
  const summary = summarizeAltitudes([42]);
  assert.equal(summary.meanMm, 42);
  assert.equal(summary.sdMm, null);
  assert.equal(summary.ci95Mm, null);
});

test("non-finite values are counted as discarded, never coerced to 0", () => {
  const summary = summarizeAltitudes([10, null, 20, NaN, undefined, 30, Infinity]);
  assert.equal(summary.count, 3);
  assert.equal(summary.discarded, 4);
  assert.equal(summary.meanMm, 20, "a coerced 0 would have dragged this to ~8.6");
});

test("the AR(1) interval is wider than the naive one for correlated data", () => {
  // A slow random walk: consecutive samples are near-identical, so sd/√n
  // massively overstates how much independent information is present.
  const values = [];
  let value = 0;
  for (let index = 0; index < 300; index += 1) {
    value += Math.sin(index / 40) * 3;
    values.push(value);
  }
  const summary = summarizeAltitudes(values);
  assert.ok(summary.lag1Autocorrelation > 0.9, "this series is strongly autocorrelated");
  assert.ok(summary.effectiveCount < summary.count, "effective n must shrink");
  if (summary.ci95Mm !== null) {
    assert.ok(summary.ci95Mm > summary.ci95NaiveMm,
      "the corrected interval must be WIDER — this is the whole point");
  }
});

test("independent data leaves the effective sample size at n", () => {
  // Deterministic alternating-ish series with no positive lag-1 correlation.
  const values = Array.from({ length: 100 }, (unused, index) => (index % 2 === 0 ? 10 : -10));
  const summary = summarizeAltitudes(values);
  assert.ok(summary.lag1Autocorrelation < 0, "alternating data is negatively correlated");
  assert.equal(summary.effectiveCount, 100, "n_eff is capped at n; it never exceeds it");
});

test("a near-constant, near-perfectly-correlated series gets NO interval, not an infinite one", () => {
  // The real failure mode: the project's own QZ1 log has stretches with
  // r1 > 0.98. An Infinity here would poison JSON export and the plots.
  const values = Array.from({ length: 200 }, (unused, index) => 1000 + index * 0.001);
  const summary = summarizeAltitudes(values);
  assert.equal(summary.ci95Mm, null);
  assert.equal(summary.ciMethod, "insufficient-independent-samples");
  assert.ok(summary.effectiveCount < MIN_EFFECTIVE_SAMPLES);
});

test("effectiveSampleSize never exceeds n and never reaches zero", () => {
  assert.equal(effectiveSampleSize(100, 0), 100);
  assert.equal(effectiveSampleSize(100, -0.5), 100, "negative r1 is not a bonus");
  assert.ok(effectiveSampleSize(100, 0.5) < 100);
  assert.ok(effectiveSampleSize(100, 0.9999) >= 1, "the r1 cap prevents a zero effective n");
  assert.equal(effectiveSampleSize(100, null), 100, "an uncomputable r1 falls back to n");
});

test("lag-1 autocorrelation is null when it cannot be computed", () => {
  assert.equal(lag1Autocorrelation([1, 2]), null, "too few points");
  assert.equal(lag1Autocorrelation([5, 5, 5, 5]), null, "no variance");
  assert.equal(lag1Autocorrelation(null), null);
});

test("t critical values match the standard table", () => {
  assert.ok(Math.abs(tCritical95(1) - 12.706) < 0.001);
  assert.ok(Math.abs(tCritical95(5) - 2.571) < 0.001);
  assert.ok(Math.abs(tCritical95(10) - 2.228) < 0.005);
  assert.ok(Math.abs(tCritical95(30) - 2.042) < 0.005);
  assert.ok(Math.abs(tCritical95(1e6) - 1.96) < 0.001, "converges to z");
  assert.equal(tCritical95(0.5), Number.POSITIVE_INFINITY, "less than 1 df carries no information");
});

test("the sample interval describes fixes, and is distinct from the interval on the mean", () => {
  const values = Array.from({ length: 1000 }, (unused, index) => index - 500);
  const interval = sampleInterval95(values);
  const summary = summarizeAltitudes(values);
  assert.ok(interval.widthMm > 900, "individual fixes span nearly the whole range");
  if (summary.ci95Mm !== null) {
    assert.ok(interval.widthMm > summary.ci95Mm * 2,
      "where individual fixes land is far wider than how well the mean is known");
  }
});

test("quantiles interpolate and handle degenerate input", () => {
  assert.equal(quantileSorted([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantileSorted([7], 0.5), 7);
  assert.equal(quantileSorted([], 0.5), null);
});

test("a histogram of identical values produces no bins rather than a fake spike", () => {
  assert.deepEqual(histogram([5, 5, 5, 5]), []);
  assert.deepEqual(histogram([]), []);
  const bins = histogram([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 5);
  assert.equal(bins.length, 5);
  assert.equal(bins.reduce((total, bin) => total + bin.count, 0), 10, "every value lands in exactly one bin");
});
