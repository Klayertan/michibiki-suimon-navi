import test from "node:test";
import assert from "node:assert/strict";
import {
  MIN_SAMPLES_FOR_VERDICT,
  VERDICTS,
  analyzeExperiment,
  buildResultTable,
  confidenceIntervalsDisjoint,
  summarizeOutcome
} from "../../js/qz1-water-level/displacement-analysis.js";
import { normalizeExperimentConfig } from "../../js/qz1-water-level/experiment-config.js";
import { summarizeAltitudes } from "../../js/qz1-water-level/displacement-statistics.js";

const T0 = Date.UTC(2026, 0, 15, 2, 0, 0);
const DWELL_S = 120;

function config(overrides = {}) {
  const { config: normalized } = normalizeExperimentConfig({
    experiment: "unit-test",
    sensor: "SYNTHETIC",
    reference_heights_mm: [0, 10, 100],
    include_descending: false,
    sampling_configuration: { dwell_seconds: DWELL_S, settle_seconds: 0 },
    tolerance_mm: 10,
    ...overrides
  });
  return normalized;
}

/**
 * SYNTHETIC samples: a deterministic saw pattern around each level's true
 * altitude. Alternating noise makes consecutive samples uncorrelated, so the
 * AR(1) correction leaves n_eff = n and a verdict is actually reachable.
 * Real GNSS does not behave like this — that is exactly why the real
 * experiment has to be run on hardware.
 */
function levelSamples(startMs, count, trueHeightMm, noiseAmplitudeMm, baseAltitudeMm = 50000) {
  return Array.from({ length: count }, (unused, index) => ({
    timestampUtcMs: startMs + index * 1000,
    altitudeMm: baseAltitudeMm + trueHeightMm + (index % 2 === 0 ? noiseAmplitudeMm : -noiseAmplitudeMm),
    fix: 1,
    satellites: 9,
    hdop: 0.9
  }));
}

function buildRun({ noiseAmplitudeMm = 1, heights = [0, 10, 100], offsets = {} } = {}) {
  const samples = [];
  const marks = [];
  let cursor = T0;
  heights.forEach((height, stepIndex) => {
    samples.push(...levelSamples(cursor, DWELL_S, height + (offsets[height] ?? 0), noiseAmplitudeMm));
    marks.push({
      stepIndex,
      referenceHeightMm: height,
      visitIndex: 0,
      direction: "ascending",
      startMs: cursor,
      endMs: cursor + DWELL_S * 1000,
      settleSeconds: 0
    });
    cursor += DWELL_S * 1000;
  });
  return { samples, marks };
}

test("a clean run resolves every step and the errors are ~0", () => {
  const { samples, marks } = buildRun({ noiseAmplitudeMm: 1 });
  const analysis = analyzeExperiment({ samples, marks, config: config() });
  assert.equal(analysis.ok, true);

  const ten = analysis.levels.find((level) => level.referenceHeightMm === 10);
  assert.equal(ten.deltaReferenceMm, 10);
  assert.ok(Math.abs(ten.deltaGnssMm - 10) < 0.001);
  assert.ok(Math.abs(ten.errorMm) < 0.001);
  assert.equal(ten.resolvability.verdict, VERDICTS.PASS);
});

test("the five required quantities stay separate and never collapse into one", () => {
  const { samples, marks } = buildRun({ noiseAmplitudeMm: 1 });
  const analysis = analyzeExperiment({
    samples, marks, config: config(), filterChain: "valid-fix-only"
  });
  const level = analysis.levels.find((entry) => entry.referenceHeightMm === 100);
  // 1 raw altitude, 2 filtered altitude, 3 observed ΔZ, 4 actual ΔZ, 5 error
  assert.ok(Number.isFinite(level.raw.meanMm));
  assert.ok(Number.isFinite(level.filtered.meanMm));
  assert.ok(Number.isFinite(level.deltaGnssMm));
  assert.equal(level.deltaReferenceMm, 100);
  assert.ok(Math.abs(level.errorMm - (level.deltaGnssMm - level.deltaReferenceMm)) < 1e-9);
  assert.ok(level.raw.meanMm > 40000, "raw altitude is an absolute altitude, not a displacement");
  assert.ok(Math.abs(level.deltaGnssMm) < 200, "the displacement is a displacement");
});

test("a step buried in noise FAILs, and that is a result rather than an error", () => {
  // 400 mm of alternating noise on a 10 mm step: the confidence intervals of
  // the two levels overlap and the receiver cannot tell them apart.
  const { samples, marks } = buildRun({ noiseAmplitudeMm: 400, heights: [0, 10] });
  const analysis = analyzeExperiment({ samples, marks, config: config({ reference_heights_mm: [0, 10] }) });
  assert.equal(analysis.ok, true, "a null result is a successful analysis");
  assert.equal(analysis.verdicts[10], VERDICTS.FAIL);
  assert.ok(analysis.levels.find((level) => level.referenceHeightMm === 10)
    .resolvability.reasons.some((reason) => reason.includes("重なります")));
});

test("a detected but mis-measured step is INCONCLUSIVE, never PASS", () => {
  // The receiver reliably reports +40 mm when the rig moved +10 mm: clearly
  // separated from the baseline, but the magnitude is wrong. Detection and
  // measurement are different claims.
  const { samples, marks } = buildRun({ noiseAmplitudeMm: 1, heights: [0, 10], offsets: { 10: 30 } });
  const analysis = analyzeExperiment({ samples, marks, config: config({ reference_heights_mm: [0, 10] }) });
  const level = analysis.levels.find((entry) => entry.referenceHeightMm === 10);
  assert.equal(level.resolvability.separated, true);
  assert.equal(level.resolvability.verdict, VERDICTS.INCONCLUSIVE);
  assert.ok(Math.abs(level.errorMm - 30) < 0.001);
});

test("a displacement with the wrong sign is INCONCLUSIVE, never PASS", () => {
  const { samples, marks } = buildRun({ noiseAmplitudeMm: 1, heights: [0, 10], offsets: { 10: -60 } });
  const analysis = analyzeExperiment({ samples, marks, config: config({ reference_heights_mm: [0, 10] }) });
  const level = analysis.levels.find((entry) => entry.referenceHeightMm === 10);
  assert.equal(level.resolvability.verdict, VERDICTS.INCONCLUSIVE);
  assert.ok(level.resolvability.reasons.some((reason) => reason.includes("符号")));
});

test("too few samples yields INSUFFICIENT rather than a confident verdict", () => {
  const samples = [
    ...levelSamples(T0, MIN_SAMPLES_FOR_VERDICT - 1, 0, 1),
    ...levelSamples(T0 + 60000, MIN_SAMPLES_FOR_VERDICT - 1, 100, 1)
  ];
  const marks = [
    { stepIndex: 0, referenceHeightMm: 0, startMs: T0, endMs: T0 + 30000, settleSeconds: 0 },
    { stepIndex: 1, referenceHeightMm: 100, startMs: T0 + 60000, endMs: T0 + 90000, settleSeconds: 0 }
  ];
  const analysis = analyzeExperiment({ samples, marks, config: config({ reference_heights_mm: [0, 100] }) });
  assert.equal(analysis.verdicts[100], VERDICTS.INSUFFICIENT);
});

test("a run with no 0 mm baseline is refused: ΔZ is undefined without one", () => {
  const analysis = analyzeExperiment({
    samples: levelSamples(T0, 60, 10, 1),
    marks: [{ stepIndex: 0, referenceHeightMm: 10, startMs: T0, endMs: T0 + 60000, settleSeconds: 0 }],
    config: config()
  });
  assert.equal(analysis.ok, false);
  assert.ok(analysis.errors.some((error) => error.includes("baseline")));
});

test("an unfiltered run warns that filtered equals raw", () => {
  const { samples, marks } = buildRun();
  const analysis = analyzeExperiment({ samples, marks, config: config(), filterChain: [] });
  assert.ok(analysis.warnings.some((warning) => warning.includes("フィルタ未適用")));
});

test("a smoothing chain warns that smoothing cannot buy statistical power", () => {
  const { samples, marks } = buildRun();
  const analysis = analyzeExperiment({
    samples, marks, config: config(), filterChain: [{ kind: "moving-median", windowSamples: 5 }]
  });
  assert.ok(analysis.warnings.some((warning) => warning.includes("平滑化")));
});

test("telemetry the receiver never sent is named in the warnings, not imputed", () => {
  const { samples, marks } = buildRun();
  const analysis = analyzeExperiment({ samples, marks, config: config() });
  assert.ok(analysis.alwaysMissingFields.includes("vdop"));
  assert.ok(analysis.warnings.some((warning) => warning.includes("vdop")));
});

test("hysteresis exposes drift between an up-visit and a down-visit", () => {
  // Same height, 40 mm apart between the two visits: the receiver drifted.
  const samples = [
    ...levelSamples(T0, DWELL_S, 0, 1),
    ...levelSamples(T0 + DWELL_S * 1000, DWELL_S, 100, 1),
    ...levelSamples(T0 + DWELL_S * 2000, DWELL_S, 40, 1)
  ];
  const marks = [
    { stepIndex: 0, referenceHeightMm: 0, visitIndex: 0, direction: "ascending", startMs: T0, endMs: T0 + DWELL_S * 1000, settleSeconds: 0 },
    { stepIndex: 1, referenceHeightMm: 100, visitIndex: 0, direction: "ascending", startMs: T0 + DWELL_S * 1000, endMs: T0 + DWELL_S * 2000, settleSeconds: 0 },
    { stepIndex: 2, referenceHeightMm: 0, visitIndex: 1, direction: "descending", startMs: T0 + DWELL_S * 2000, endMs: T0 + DWELL_S * 3000, settleSeconds: 0 }
  ];
  const analysis = analyzeExperiment({ samples, marks, config: config({ reference_heights_mm: [0, 100] }) });
  const baseline = analysis.levels.find((level) => level.referenceHeightMm === 0);
  assert.ok(Math.abs(baseline.hysteresis.differenceMm - 40) < 0.001,
    "the descending visit reads 40 mm above the ascending one");
});

test("a step that only works in one direction is downgraded from PASS", () => {
  // The pooled mean is exactly right (90 up, 110 down, average 100), so the
  // error test passes and a tool that only checked the pooled figure would
  // report PASS. The two visits are 20 mm apart, which is what actually
  // happened and is twice the tolerance, so the verdict must not be PASS.
  // This is the case hysteresis exists to catch.
  const samples = [
    ...levelSamples(T0, DWELL_S, 0, 1),
    ...levelSamples(T0 + DWELL_S * 1000, DWELL_S, 90, 1),
    ...levelSamples(T0 + DWELL_S * 2000, DWELL_S, 110, 1)
  ];
  const marks = [
    { stepIndex: 0, referenceHeightMm: 0, visitIndex: 0, direction: "ascending", startMs: T0, endMs: T0 + DWELL_S * 1000, settleSeconds: 0 },
    { stepIndex: 1, referenceHeightMm: 100, visitIndex: 0, direction: "ascending", startMs: T0 + DWELL_S * 1000, endMs: T0 + DWELL_S * 2000, settleSeconds: 0 },
    { stepIndex: 2, referenceHeightMm: 100, visitIndex: 1, direction: "descending", startMs: T0 + DWELL_S * 2000, endMs: T0 + DWELL_S * 3000, settleSeconds: 0 }
  ];
  const analysis = analyzeExperiment({ samples, marks, config: config({ reference_heights_mm: [0, 100] }) });
  const level = analysis.levels.find((entry) => entry.referenceHeightMm === 100);
  assert.ok(Math.abs(level.errorMm) < 0.001, "the pooled estimate is exactly right");
  assert.equal(level.resolvability.accurate, true, "and passes the error test on its own");
  assert.equal(level.resolvability.repeatable, false, "but the two visits disagree");
  assert.equal(level.resolvability.verdict, VERDICTS.INCONCLUSIVE);
  assert.ok(level.resolvability.reasons.some((reason) => reason.includes("往路と復路")));
});

test("the result table exposes raw and filtered estimates side by side", () => {
  const { samples, marks } = buildRun();
  const analysis = analyzeExperiment({ samples, marks, config: config(), filterChain: "valid-fix-only" });
  const rows = buildResultTable(analysis);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].referenceMm, 0);
  for (const row of rows) {
    assert.ok("rawEstimateMm" in row && "filteredEstimateMm" in row,
      "both must be present so filtering can never hide behind one number");
  }
});

test("the outcome sentence reports a negative result plainly", () => {
  const { samples, marks } = buildRun({ noiseAmplitudeMm: 4000, heights: [0, 10] });
  const analysis = analyzeExperiment({ samples, marks, config: config({ reference_heights_mm: [0, 10] }) });
  const outcome = summarizeOutcome(analysis);
  assert.ok(outcome.includes("負の結果"), "a null result is stated, not hidden");
});

test("the outcome sentence limits its claim to this run", () => {
  const { samples, marks } = buildRun({ noiseAmplitudeMm: 1 });
  const analysis = analyzeExperiment({ samples, marks, config: config() });
  const outcome = summarizeOutcome(analysis);
  assert.ok(outcome.includes("この受信機"), "the claim is scoped to this receiver and site");
});

test("non-overlapping confidence intervals is a conservative separation test", () => {
  const a = summarizeAltitudes(Array.from({ length: 100 }, (unused, index) => (index % 2 ? 1 : -1)));
  const b = summarizeAltitudes(Array.from({ length: 100 }, (unused, index) => 100 + (index % 2 ? 1 : -1)));
  assert.equal(confidenceIntervalsDisjoint(a, b), true);
  assert.equal(confidenceIntervalsDisjoint(a, a), false);
  assert.equal(confidenceIntervalsDisjoint(a, summarizeAltitudes([])), null);
});

test("hysteresis large enough to split a level also widens its own interval", () => {
  // A level whose samples sit in two clusters 40 mm apart does not have a
  // well-determined mean, and the AR(1) correction says so: the pooled
  // interval inflates until the level is no longer separable from the
  // baseline. Pooling a badly non-repeatable level cannot buy a PASS by
  // averaging the two visits together.
  const samples = [
    ...levelSamples(T0, DWELL_S, 0, 1),
    ...levelSamples(T0 + DWELL_S * 1000, DWELL_S, 80, 1),
    ...levelSamples(T0 + DWELL_S * 2000, DWELL_S, 120, 1)
  ];
  const marks = [
    { stepIndex: 0, referenceHeightMm: 0, visitIndex: 0, direction: "ascending", startMs: T0, endMs: T0 + DWELL_S * 1000, settleSeconds: 0 },
    { stepIndex: 1, referenceHeightMm: 100, visitIndex: 0, direction: "ascending", startMs: T0 + DWELL_S * 1000, endMs: T0 + DWELL_S * 2000, settleSeconds: 0 },
    { stepIndex: 2, referenceHeightMm: 100, visitIndex: 1, direction: "descending", startMs: T0 + DWELL_S * 2000, endMs: T0 + DWELL_S * 3000, settleSeconds: 0 }
  ];
  const analysis = analyzeExperiment({ samples, marks, config: config({ reference_heights_mm: [0, 100] }) });
  const level = analysis.levels.find((entry) => entry.referenceHeightMm === 100);
  assert.ok(Math.abs(level.errorMm) < 0.001, "the pooled estimate still averages to exactly 100 mm");
  assert.equal(level.resolvability.verdict, VERDICTS.FAIL, "and is still not a resolved step");
});
