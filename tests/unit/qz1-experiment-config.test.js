import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_REFERENCE_HEIGHTS_MM,
  buildExperimentMetadata,
  buildExperimentPlan,
  normalizeExperimentConfig,
  normalizeReferenceHeights,
  planDurationSeconds
} from "../../js/qz1-water-level/experiment-config.js";

const VALID = {
  experiment: "vertical-displacement-001",
  sensor: "QZ1LE",
  reference_heights_mm: [0, 10, 20, 30, 50, 100],
  sampling_configuration: { dwell_seconds: 120, settle_seconds: 15 },
  tolerance_mm: 10
};

test("a complete configuration normalizes", () => {
  const { config, errors } = normalizeExperimentConfig(VALID);
  assert.deepEqual(errors, []);
  assert.equal(config.experimentId, "vertical-displacement-001");
  assert.equal(config.stage, "controlled-rig", "stage defaults to the rig, not the float");
  assert.deepEqual(config.referenceHeightsMm, [0, 10, 20, 30, 50, 100]);
  assert.equal(config.dwellSeconds, 120);
  assert.equal(config.settleSeconds, 15);
});

test("an invalid configuration yields no config at all, never a half-valid one", () => {
  // A partially-applied design would be stored next to the data and read
  // later as if it were what actually happened.
  for (const broken of [
    { ...VALID, experiment: "" },
    { ...VALID, sensor: "  " },
    { ...VALID, sampling_configuration: { dwell_seconds: 0, settle_seconds: 15 } },
    { ...VALID, sampling_configuration: { dwell_seconds: -5, settle_seconds: 15 } },
    { ...VALID, tolerance_mm: 0 },
    { ...VALID, stage: "levitation" }
  ]) {
    const { config, errors } = normalizeExperimentConfig(broken);
    assert.equal(config, null, `${JSON.stringify(broken)} must not normalize`);
    assert.ok(errors.length > 0, "and must say why");
  }
});

test("a settle window that eats the whole dwell is rejected", () => {
  const { config, errors } = normalizeExperimentConfig({
    ...VALID,
    sampling_configuration: { dwell_seconds: 60, settle_seconds: 60 }
  });
  assert.equal(config, null);
  assert.ok(errors.some((error) => error.includes("settle_seconds")));
});

test("no averaging duration is privileged: any positive dwell is legal", () => {
  for (const dwell of [1, 45, 60, 120, 300, 3600]) {
    const { config } = normalizeExperimentConfig({
      ...VALID,
      sampling_configuration: { dwell_seconds: dwell, settle_seconds: 0 }
    });
    assert.equal(config.dwellSeconds, dwell);
  }
});

test("a baseline of 0 mm is always present, because ΔZ is undefined without it", () => {
  assert.deepEqual(normalizeReferenceHeights([10, 20]), [0, 10, 20]);
  assert.deepEqual(normalizeReferenceHeights([50, 10, 10, 0]), [0, 10, 50], "duplicates collapse");
});

test("non-numeric heights are reported, not coerced", () => {
  const errors = [];
  assert.deepEqual(normalizeReferenceHeights([0, "ten", 20], errors), [0, 20]);
  assert.equal(errors.length, 1);
});

test("blank and null heights are not silently converted to a zero baseline", () => {
  const errors = [];
  assert.deepEqual(normalizeReferenceHeights([null, "", "  ", false], errors), [0]);
  assert.equal(errors.length, 4);
});

test("a null configuration is rejected as invalid input, not allowed to throw", () => {
  const result = normalizeExperimentConfig(null);
  assert.equal(result.config, null);
  assert.ok(result.errors.length > 0);
});

test("the plan ascends then descends, and the two visits stay distinguishable", () => {
  const { config } = normalizeExperimentConfig({ ...VALID, reference_heights_mm: [0, 10, 20] });
  const plan = buildExperimentPlan(config);
  assert.deepEqual(plan.map((step) => step.referenceHeightMm), [0, 10, 20, 10, 0]);
  assert.deepEqual(plan.map((step) => step.direction),
    ["ascending", "ascending", "ascending", "descending", "descending"]);
  // The turning point is visited once; 0 and 10 are visited twice, and the
  // second visit carries visitIndex 1 so a drifting receiver's hysteresis is
  // measurable rather than averaged away.
  assert.deepEqual(plan.map((step) => step.visitIndex), [0, 0, 0, 1, 1]);
});

test("descending can be switched off", () => {
  const { config } = normalizeExperimentConfig({
    ...VALID, reference_heights_mm: [0, 10, 20], include_descending: false
  });
  assert.deepEqual(buildExperimentPlan(config).map((step) => step.referenceHeightMm), [0, 10, 20]);
});

test("plan duration excludes repositioning time, and says so by being exactly dwell × steps", () => {
  const { config } = normalizeExperimentConfig({ ...VALID, reference_heights_mm: [0, 10] });
  const plan = buildExperimentPlan(config);
  assert.equal(plan.length, 3);
  assert.equal(planDurationSeconds(plan), 3 * 120);
});

test("metadata describes the design and carries no measurements", () => {
  const { config } = normalizeExperimentConfig(VALID);
  const meta = buildExperimentMetadata(config, { createdAt: "2026-01-15T00:00:00.000Z" });
  assert.equal(meta.experiment, "vertical-displacement-001");
  assert.deepEqual(meta.reference_heights_mm, DEFAULT_REFERENCE_HEIGHTS_MM);
  assert.deepEqual(meta.sampling_configuration, { dwell_seconds: 120, settle_seconds: 15 });
  const serialized = JSON.stringify(meta);
  for (const key of ["altitude", "mean", "error_mm", "verdict"]) {
    assert.ok(!serialized.includes(key), `metadata must not carry ${key}`);
  }
});
