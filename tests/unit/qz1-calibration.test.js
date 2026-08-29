import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CALIBRATION_AGE_MS,
  buildCalibration,
  calibrationAge,
  canDeriveWaterDepth,
  deriveWaterDepth,
  describeForDisplay,
  summarizeValidation
} from "../../js/qz1-water-level/calibration.js";
import { VERDICTS } from "../../js/qz1-water-level/displacement-analysis.js";

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

/** A SYNTHETIC validation record standing in for a real analysis result. */
function validation(overrides = {}) {
  return {
    experimentId: "vertical-displacement-001",
    stage: "controlled-rig",
    sensor: "QZ1LE",
    toleranceMm: 10,
    filterChain: [],
    verdicts: { 10: VERDICTS.FAIL, 20: VERDICTS.FAIL, 30: VERDICTS.INCONCLUSIVE, 50: VERDICTS.PASS, 100: VERDICTS.PASS },
    resolvedStepMm: 50,
    worstPassedErrorMm: 8,
    analyzedAt: NOW - 3600000,
    ...overrides
  };
}

function calibration(overrides = {}) {
  const { calibration: built, errors } = buildCalibration({
    baselineAltitudeMm: 50000,
    knownDepthMm: 60,
    deviceId: "QZ1LE-001",
    experimentId: "vertical-displacement-001",
    validation: validation(),
    calibratedAt: NOW - 3600000,
    ...overrides
  });
  assert.deepEqual(errors, []);
  return built;
}

test("a calibration requires Z0, H0, a device and a validating experiment", () => {
  for (const missing of [
    { baselineAltitudeMm: undefined },
    { knownDepthMm: undefined },
    { deviceId: "" },
    { experimentId: "" }
  ]) {
    const { calibration: built, errors } = buildCalibration({
      baselineAltitudeMm: 50000, knownDepthMm: 60, deviceId: "d", experimentId: "e", ...missing
    });
    assert.equal(built, null);
    assert.ok(errors.length > 0);
  }
});

test("no calibration means no depth, and the refusal says so", () => {
  const gate = canDeriveWaterDepth(null);
  assert.equal(gate.allowed, false);
  assert.ok(gate.reason.length > 0);
});

test("a calibration with no validating experiment cannot produce a depth", () => {
  const uncalibrated = calibration({ validation: null });
  const gate = canDeriveWaterDepth(uncalibrated, { nowMs: NOW });
  assert.equal(gate.allowed, false);
  assert.ok(gate.reason.includes("検証実験"));
});

test("an experiment that resolved nothing blocks depth entirely", () => {
  // The likely real outcome of this project. The formula still works; the
  // permission does not.
  const nothingResolved = calibration({ validation: validation({ resolvedStepMm: null }) });
  const gate = canDeriveWaterDepth(nothingResolved, { nowMs: NOW });
  assert.equal(gate.allowed, false);
  assert.ok(gate.reason.includes("負の結果"));
  assert.equal(deriveWaterDepth(nothingResolved, 50100, { nowMs: NOW }).measurement, null);
});

test("asking for finer precision than was demonstrated is refused", () => {
  const built = calibration();
  assert.equal(canDeriveWaterDepth(built, { requiredResolutionMm: 10, nowMs: NOW }).allowed, false,
    "50 mm demonstrated does not license a 10 mm claim");
  assert.equal(canDeriveWaterDepth(built, { requiredResolutionMm: 50, nowMs: NOW }).allowed, true);
  assert.equal(canDeriveWaterDepth(built, { requiredResolutionMm: 100, nowMs: NOW }).allowed, true);
});

test("a stale calibration expires rather than quietly producing plausible numbers", () => {
  const old = calibration({ calibratedAt: NOW - MAX_CALIBRATION_AGE_MS - 1 });
  const gate = canDeriveWaterDepth(old, { nowMs: NOW });
  assert.equal(gate.allowed, false);
  assert.ok(gate.reason.includes("古すぎ"));
});

test("a calibration stamped in the future is refused", () => {
  const future = calibration({ calibratedAt: NOW + 60000 });
  assert.equal(canDeriveWaterDepth(future, { nowMs: NOW }).allowed, false);
});

test("H(t) = H0 + (Z(t) - Z0), exactly", () => {
  const built = calibration();
  const result = deriveWaterDepth(built, 50100, { nowMs: NOW });
  assert.equal(result.allowed, true);
  assert.equal(result.derivation.deltaMm, 100);
  assert.equal(result.measurement.valueMm, 160, "60 mm of water plus a 100 mm rise");
  assert.equal(result.measurement.reference, "soil-surface");
});

test("a derived depth is labelled qz1-float so it cannot pass as a ruler reading", () => {
  const result = deriveWaterDepth(calibration(), 50100, { nowMs: NOW });
  assert.equal(result.measurement.source, "qz1-float");
});

test("the quoted uncertainty is the demonstrated error, not the arithmetic precision", () => {
  const result = deriveWaterDepth(calibration(), 50100.123456, { nowMs: NOW });
  assert.equal(result.uncertaintyMm, 8, "the worst error among the PASSing steps");
});

test("a falling water level produces a negative depth, not a clamped zero", () => {
  // Sub-surface water levels are where safe-AWD lives; clamping would make
  // that unrepresentable. See js/water/water-measurement.js.
  const result = deriveWaterDepth(calibration({ knownDepthMm: 0 }), 50000 - 150, { nowMs: NOW });
  assert.equal(result.measurement.valueMm, -150);
});

test("a missing current altitude produces a refusal, not a depth of H0", () => {
  for (const value of [null, undefined, NaN]) {
    const result = deriveWaterDepth(calibration(), value, { nowMs: NOW });
    assert.equal(result.measurement, null);
  }
});

test("summarizeValidation reports the smallest PASSing step, or null", () => {
  const analysis = {
    ok: true,
    config: { experimentId: "e", stage: "controlled-rig", sensor: "QZ1", toleranceMm: 10 },
    filterChain: [],
    verdicts: {},
    levels: [
      { referenceHeightMm: 0, resolvability: { verdict: null }, absoluteErrorMm: null },
      { referenceHeightMm: 10, resolvability: { verdict: VERDICTS.FAIL }, absoluteErrorMm: 30 },
      { referenceHeightMm: 50, resolvability: { verdict: VERDICTS.PASS }, absoluteErrorMm: 6 },
      { referenceHeightMm: 100, resolvability: { verdict: VERDICTS.PASS }, absoluteErrorMm: 9 }
    ]
  };
  const summary = summarizeValidation(analysis);
  assert.equal(summary.resolvedStepMm, 50);
  assert.equal(summary.worstPassedErrorMm, 9);

  const nothing = summarizeValidation({
    ...analysis,
    levels: analysis.levels.map((level) => ({ ...level, resolvability: { verdict: VERDICTS.FAIL } }))
  });
  assert.equal(nothing.resolvedStepMm, null);
});

test("the display object keeps altitude, displacement and depth as three fields", () => {
  const display = describeForDisplay({
    rawAltitudeMm: 50105,
    filteredAltitudeMm: 50100,
    baselineAltitudeMm: 50000,
    calibration: calibration(),
    options: { nowMs: NOW }
  });
  assert.equal(display.rawAltitudeMm, 50105);
  assert.equal(display.filteredAltitudeMm, 50100);
  assert.equal(display.relativeDisplacementMm, 100);
  assert.equal(display.depthMm, 160);
  assert.equal(display.depthBlockedReason, null);
});

test("with no calibration the display shows a displacement and a reason, never a depth", () => {
  const display = describeForDisplay({
    rawAltitudeMm: 50105,
    filteredAltitudeMm: 50100,
    baselineAltitudeMm: 50000,
    calibration: null
  });
  assert.equal(display.relativeDisplacementMm, 100, "the honest number is still shown");
  assert.equal(display.depthMm, null, "and the depth is not");
  assert.ok(display.depthBlockedReason.length > 0);
});

test("with no baseline yet the displacement is undefined, not zero", () => {
  const display = describeForDisplay({
    rawAltitudeMm: 50105, filteredAltitudeMm: 50100, baselineAltitudeMm: null, calibration: null
  });
  assert.equal(display.relativeDisplacementMm, null);
});

test("calibrationAge is null when there is no timestamp to age", () => {
  assert.equal(calibrationAge(null, NOW), null);
  assert.equal(calibrationAge({}, NOW), null);
  assert.equal(calibrationAge({ calibratedAt: NOW - 1000 }, NOW), 1000);
});
