import test from "node:test";
import assert from "node:assert/strict";
import {
  cubicMetersForDepthChange,
  evaluateWaterManagement,
  formatDepthWithCm,
  formatVolumeRange,
  litersForDepthChange,
  STATUS
} from "../../js/water/water-recommendation.js";
import { GROWTH_STAGES, growthStageRule, hasNumericTarget } from "../../js/water/growth-stage-model.js";
import { buildWaterMeasurement } from "../../js/water/water-measurement.js";

const NOW = new Date("2026-08-18T00:00:00.000Z").getTime();

function manual(valueMm, measuredAt = NOW) {
  return buildWaterMeasurement({ valueMm, source: "manual", measuredAt });
}

// ---------------------------------------------------------------------------
// Unit conversion: 1 mm over 1 m² = 1 L
// ---------------------------------------------------------------------------

test("2,000 m² x 30 mm = 60,000 L = 60 m³", () => {
  assert.equal(litersForDepthChange(2000, 30), 60000);
  assert.equal(cubicMetersForDepthChange(2000, 30), 60);
});

test("1 mm over 1 m² is exactly 1 L", () => {
  assert.equal(litersForDepthChange(1, 1), 1);
  assert.equal(cubicMetersForDepthChange(1, 1), 0.001);
});

test("conversion never coerces missing/invalid inputs to 0", () => {
  assert.equal(litersForDepthChange(null, 30), null);
  assert.equal(litersForDepthChange(2000, null), null);
  assert.equal(litersForDepthChange(0, 30), null, "a zero-area field is not a real field");
  assert.equal(litersForDepthChange(-100, 30), null);
  assert.equal(cubicMetersForDepthChange(undefined, undefined), null);
});

// ---------------------------------------------------------------------------
// Area does NOT determine depth
// ---------------------------------------------------------------------------

test("field area never changes the target depth -- only the volume", () => {
  const small = evaluateWaterManagement({ areaM2: 200, growthStage: "tillering", measurement: manual(18), now: NOW });
  const large = evaluateWaterManagement({ areaM2: 20000, growthStage: "tillering", measurement: manual(18), now: NOW });
  assert.equal(small.target.targetMinMm, large.target.targetMinMm);
  assert.equal(small.target.targetMaxMm, large.target.targetMaxMm);
  assert.equal(small.deficitMinMm, large.deficitMinMm);
  // 100x the area -> 100x the volume, same depths.
  assert.equal(large.standingWaterAdjustment.minM3, small.standingWaterAdjustment.minM3 * 100);
});

// ---------------------------------------------------------------------------
// Below target
// ---------------------------------------------------------------------------

test("2,143 m² at 18 mm against a 30-50 mm range -> 12-32 mm deficit, 25.716-68.576 m³", () => {
  // Uses the stage whose table range is 30-50 mm, so the documented worked
  // example is exercised end to end rather than with an injected range.
  const rule = growthStageRule("after_transplanting");
  assert.equal(rule.targetMinMm, 30);
  assert.equal(rule.targetMaxMm, 50);

  const result = evaluateWaterManagement({
    areaM2: 2143,
    growthStage: "after_transplanting",
    measurement: manual(18),
    now: NOW
  });

  assert.equal(result.status, STATUS.belowRange);
  assert.equal(result.deficitMinMm, 12);
  assert.equal(result.deficitMaxMm, 32);
  assert.equal(result.standingWaterAdjustment.direction, "add");
  assert.equal(result.standingWaterAdjustment.minLiters, 25716);
  assert.equal(result.standingWaterAdjustment.maxLiters, 68576);
  assert.equal(result.standingWaterAdjustment.minM3, 25.716);
  assert.equal(result.standingWaterAdjustment.maxM3, 68.576);
  assert.equal(formatVolumeRange(result.standingWaterAdjustment.minM3, result.standingWaterAdjustment.maxM3), "25.7〜68.6 m³");
  assert.equal(
    formatVolumeRange(result.standingWaterAdjustment.minLiters, result.standingWaterAdjustment.maxLiters, { unit: "L", digits: 0 }),
    "25,716〜68,576 L"
  );
});

test("below-range keeps its provenance and its real-requirement caveat", () => {
  const result = evaluateWaterManagement({ areaM2: 2143, growthStage: "tillering", measurement: manual(18), now: NOW });
  assert.equal(result.status, STATUS.belowRange);
  assert.ok(result.sources.length > 0, "a recommendation must carry its sources");
  assert.ok(result.sources.every((source) => source.organization && (source.url || source.id === "regionalPractice")));
  assert.match(result.caveatJa, /浸透/);
  assert.match(result.recommendationJa, /実際の必要用水量/);
  assert.equal(result.waterRequirementReference.minMmPerDay, 11.0);
  assert.equal(result.waterRequirementReference.maxMmPerDay, 17.5);
});

test("below-range with an unknown area still reports the depth deficit, but no volume", () => {
  const result = evaluateWaterManagement({ growthStage: "tillering", measurement: manual(5), now: NOW });
  assert.equal(result.status, STATUS.belowRange);
  assert.equal(result.deficitMinMm, 20);
  assert.equal(result.standingWaterAdjustment.areaKnown, false);
  assert.equal(result.standingWaterAdjustment.minM3, null);
  assert.equal(result.standingWaterAdjustment.minLiters, null);
  assert.ok(result.missingInputs.includes("areaM2"));
});

// ---------------------------------------------------------------------------
// Within target
// ---------------------------------------------------------------------------

test("40 mm inside a 30-50 mm range -> within-range, no additional water", () => {
  const result = evaluateWaterManagement({
    areaM2: 2143,
    growthStage: "after_transplanting",
    measurement: manual(40),
    now: NOW
  });
  assert.equal(result.status, STATUS.withinRange);
  assert.equal(result.deficitMinMm, null);
  assert.equal(result.excessMm, null);
  assert.equal(result.standingWaterAdjustment.direction, "hold");
  assert.equal(result.standingWaterAdjustment.minM3, 0);
  assert.equal(result.standingWaterAdjustment.maxM3, 0);
  assert.match(result.recommendationJa, /現在の水位は推奨範囲内です。/);
});

test("both range edges count as within-range", () => {
  for (const valueMm of [30, 50]) {
    const result = evaluateWaterManagement({
      areaM2: 1000,
      growthStage: "after_transplanting",
      measurement: manual(valueMm),
      now: NOW
    });
    assert.equal(result.status, STATUS.withinRange, `${valueMm}mm should be within 30-50mm`);
  }
});

// ---------------------------------------------------------------------------
// Above target
// ---------------------------------------------------------------------------

test("65 mm against a 30-50 mm range -> above-range, 15 mm excess, no drainage instruction", () => {
  const result = evaluateWaterManagement({
    areaM2: 2000,
    growthStage: "after_transplanting",
    measurement: manual(65),
    now: NOW
  });
  assert.equal(result.status, STATUS.aboveRange);
  assert.equal(result.excessMm, 15);
  assert.equal(result.deficitMinMm, null);
  assert.equal(result.standingWaterAdjustment.direction, "remove");
  assert.equal(result.standingWaterAdjustment.minM3, 30);
  // The wording must not order a drain: this stage's rule is a standing-water
  // target, not a drainage rule.
  assert.match(result.recommendationJa, /入水は不要/);
  assert.match(result.recommendationJa, /人が判断/);
  assert.ok(!/落水してください/.test(result.recommendationJa));
});

// ---------------------------------------------------------------------------
// Drainage stages
// ---------------------------------------------------------------------------

test("中干し never produces a fill-to-X recommendation, with or without a measurement", () => {
  for (const measurement of [null, manual(0), manual(45)]) {
    const result = evaluateWaterManagement({
      areaM2: 2143,
      growthStage: "midseason_drainage",
      measurement,
      now: NOW
    });
    assert.equal(result.status, STATUS.noNumericTarget);
    assert.equal(result.target.targetMinMm, null);
    assert.equal(result.standingWaterAdjustment, null, "no volume may be offered during 中干し");
    assert.equal(result.deficitMinMm, null);
    assert.match(result.recommendationJa, /入水量の推奨は行いません/);
  }
});

test("落水期 behaves the same way as 中干し", () => {
  const result = evaluateWaterManagement({ areaM2: 2143, growthStage: "final_drainage", measurement: manual(0), now: NOW });
  assert.equal(result.status, STATUS.noNumericTarget);
  assert.equal(result.standingWaterAdjustment, null);
});

test("a stage with no numeric target is never treated as a 0 mm target", () => {
  // The failure mode this pins: "targetMin is missing -> read it as 0 ->
  // current 45mm is 45mm above 0 -> tell the farmer to drain 96 m³".
  const stagesWithoutTargets = GROWTH_STAGES.filter((stage) => !hasNumericTarget(stage.id));
  assert.ok(stagesWithoutTargets.length >= 4, "the model must keep its management-state-only stages");
  for (const stage of stagesWithoutTargets) {
    const result = evaluateWaterManagement({ areaM2: 5000, growthStage: stage.id, measurement: manual(45), now: NOW });
    assert.ok(
      [STATUS.noNumericTarget, STATUS.unknownStage].includes(result.status),
      `${stage.id} must not be range-compared`
    );
    assert.equal(result.standingWaterAdjustment, null);
    assert.equal(result.excessMm, null);
  }
});

test("登熟期 is reported as a management state (飽水管理), not as a depth", () => {
  const result = evaluateWaterManagement({ areaM2: 2143, growthStage: "ripening", measurement: manual(20), now: NOW });
  assert.equal(result.status, STATUS.noNumericTarget);
  assert.equal(result.target.mode, "saturated");
  assert.ok(!/落水・干し期間/.test(result.statusLabelJa), "登熟期 is not a drainage period");
});

// ---------------------------------------------------------------------------
// Missing measurement
// ---------------------------------------------------------------------------

test("missing measurement -> explicit request, never NaN / 0 mm / a fabricated volume", () => {
  const result = evaluateWaterManagement({ areaM2: 2143, growthStage: "tillering", measurement: null, now: NOW });
  assert.equal(result.status, STATUS.missingMeasurement);
  assert.equal(result.measurement, null);
  assert.equal(result.differenceMm, null);
  assert.equal(result.deficitMinMm, null);
  assert.equal(result.standingWaterAdjustment, null);
  assert.ok(result.missingInputs.includes("measurement"));
  // The target range is still shown -- it does not depend on the measurement.
  assert.equal(result.target.targetMinMm, 25);
  assert.match(result.recommendationJa, /現在の水位を記録すると/);
});

test("no output field is ever NaN, for any combination of missing inputs", () => {
  const cases = [
    {},
    { areaM2: 2143 },
    { growthStage: "tillering" },
    { measurement: manual(18) },
    { areaM2: NaN, growthStage: "tillering", measurement: { valueCm: NaN } },
    { areaM2: "2143", growthStage: 42, measurement: { valueMm: null } }
  ];
  for (const input of cases) {
    const result = evaluateWaterManagement({ ...input, now: NOW });
    for (const [key, value] of Object.entries(result)) {
      assert.ok(!(typeof value === "number" && Number.isNaN(value)), `${key} must not be NaN`);
    }
    if (result.standingWaterAdjustment) {
      for (const [key, value] of Object.entries(result.standingWaterAdjustment)) {
        assert.ok(!(typeof value === "number" && Number.isNaN(value)), `standingWaterAdjustment.${key} must not be NaN`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Missing / unknown growth stage
// ---------------------------------------------------------------------------

test("unknown stage asks for the stage instead of guessing one", () => {
  const result = evaluateWaterManagement({ areaM2: 2143, measurement: manual(18), now: NOW });
  assert.equal(result.status, STATUS.unknownStage);
  assert.equal(result.stage.id, "unknown");
  assert.equal(result.target.targetMinMm, null);
  assert.equal(result.standingWaterAdjustment, null);
  assert.ok(result.missingInputs.includes("growthStage"));
  assert.match(result.recommendationJa, /生育ステージを選択/);
  assert.match(result.recommendationJa, /圃場面積からは水深を決められません/);
});

test("a garbage stage id degrades to unknown, not to a plausible default", () => {
  for (const stage of ["", null, 0, "TILLERING", "分げつ期", {}]) {
    const result = evaluateWaterManagement({ areaM2: 1000, growthStage: stage, measurement: manual(18), now: NOW });
    assert.equal(result.status, STATUS.unknownStage, `${JSON.stringify(stage)} must resolve to unknown`);
  }
});

// ---------------------------------------------------------------------------
// Staleness / provenance passthrough
// ---------------------------------------------------------------------------

test("an old reading is flagged stale and keeps its source", () => {
  const fourDaysAgo = NOW - 4 * 86400000;
  const result = evaluateWaterManagement({
    areaM2: 2143,
    growthStage: "tillering",
    measurement: manual(18, fourDaysAgo),
    now: NOW
  });
  assert.equal(result.measurementAgeDays, 4);
  assert.equal(result.isStale, true);
  assert.equal(result.measurement.source, "manual");
});

test("a sensor-sourced measurement flows through unchanged (RealSense hook)", () => {
  const result = evaluateWaterManagement({
    areaM2: 2143,
    growthStage: "tillering",
    measurement: buildWaterMeasurement({ valueMm: 18, source: "realsense", measuredAt: NOW }),
    now: NOW
  });
  assert.equal(result.status, STATUS.belowRange);
  assert.equal(result.measurement.source, "realsense");
  assert.equal(result.deficitMinMm, 7);
});

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

test("depth is displayed in mm with a cm reading beside it", () => {
  assert.equal(formatDepthWithCm(18), "18 mm (1.8 cm)");
  assert.equal(formatDepthWithCm(0), "0 mm (0 cm)");
  assert.equal(formatDepthWithCm(null), "—");
});

test("a single-value volume range collapses instead of printing 60〜60", () => {
  assert.equal(formatVolumeRange(60, 60), "60 m³");
  assert.equal(formatVolumeRange(25.716, 68.576), "25.7〜68.6 m³");
  assert.equal(formatVolumeRange(null, 68.576), "—");
});

// ---------------------------------------------------------------------------
// Evidence discipline: numbers exist only where a checked source gives one
// ---------------------------------------------------------------------------

test("the high-demand stages the guidance manages by state carry no invented depth", () => {
  // 幼穂形成期 and 穂ばらみ期 are managed by intermittent irrigation (with deep
  // water only as a stated cold-weather exception) in the source this model is
  // built from, so they must NOT acquire a plausible-looking standing depth.
  for (const stage of ["panicle_initiation", "booting", "ripening"]) {
    const result = evaluateWaterManagement({ areaM2: 2143, growthStage: stage, measurement: manual(30), now: NOW });
    assert.equal(result.status, STATUS.noNumericTarget, `${stage} must not be range-compared`);
    assert.equal(result.standingWaterAdjustment, null);
    assert.ok(result.target.modeLabelJa, `${stage} must still name its management mode`);
  }
});

test("every numeric recommendation names a source that was actually read", () => {
  for (const stage of GROWTH_STAGES.filter((candidate) => hasNumericTarget(candidate.id))) {
    const result = evaluateWaterManagement({ areaM2: 1000, growthStage: stage.id, measurement: manual(5), now: NOW });
    assert.ok(result.sources.length > 0);
    assert.ok(
      result.sources.some((source) => source.verification?.level === "primary"),
      `${stage.id}'s range must rest on a fully-checked source`
    );
  }
});

// ---------------------------------------------------------------------------
// Signed water levels (safe AWD)
//
// A negative level is a REAL reading against the soil surface, not an error:
// IRRI's safe-AWD re-irrigation threshold is "about 15 cm below the surface of
// the soil" = -150 mm. These pin that the engine keeps the sign all the way
// through, and never collapses it with Math.abs() or a clamp to zero.
// ---------------------------------------------------------------------------

test("target +30 mm vs measured -150 mm gives a 180 mm deficit, not 30 and not 120", () => {
  const result = evaluateWaterManagement({
    areaM2: 1000,
    growthStage: "after_transplanting",   // target 30-50 mm
    measurement: { valueMm: -150, source: "manual", measuredAt: NOW },
    now: NOW
  });
  assert.equal(result.status, STATUS.belowRange);
  assert.equal(result.deficitMinMm, 180, "30 - (-150) = 180");
  assert.equal(result.deficitMaxMm, 200, "50 - (-150) = 200");
  // Math.abs(-150) would give 30-150 = -120 -> aboveRange, inverting the advice.
  assert.notEqual(result.status, STATUS.aboveRange, "no sign inversion");
  // Clamping -150 to 0 would give a 30 mm deficit, under-reporting by 150 mm.
  assert.notEqual(result.deficitMinMm, 30, "no clamp-to-zero");
  assert.equal(result.differenceMm, -180);
});

test("the signed deficit drives the volume, so AWD needs far more water", () => {
  const awd = evaluateWaterManagement({
    areaM2: 1000, growthStage: "after_transplanting",
    measurement: { valueMm: -150, source: "manual", measuredAt: NOW }, now: NOW
  });
  const ponded = evaluateWaterManagement({
    areaM2: 1000, growthStage: "after_transplanting",
    measurement: { valueMm: 150, source: "manual", measuredAt: NOW }, now: NOW
  });
  // 1000 m2 x 180 mm = 180,000 L = 180 m3.
  assert.equal(awd.standingWaterAdjustment.minLiters, 180000);
  assert.equal(awd.standingWaterAdjustment.minM3, 180);
  assert.equal(awd.standingWaterAdjustment.direction, "add");
  // +150 mm is the OPPOSITE state: above the range, nothing to add.
  assert.equal(ponded.status, STATUS.aboveRange);
  assert.equal(ponded.excessMm, 100);
});

test("0 mm (water exactly at the soil surface) is a reading, not a missing one", () => {
  const result = evaluateWaterManagement({
    areaM2: 1000, growthStage: "after_transplanting",
    measurement: { valueMm: 0, source: "manual", measuredAt: NOW }, now: NOW
  });
  assert.equal(result.status, STATUS.belowRange);
  assert.notEqual(result.status, STATUS.missingMeasurement);
  assert.equal(result.deficitMinMm, 30);
  assert.equal(result.measurement.valueMm, 0);
});

test("the same signed reading reaches the engine identically through both persisted shapes", () => {
  // The reconciliation requirement: -15 cm typed into the legacy input and
  // -150 mm written by the mm writer are ONE physical measurement.
  const viaCm = evaluateWaterManagement({
    areaM2: 1000, growthStage: "after_transplanting",
    measurement: { valueCm: -15, recordedAt: NOW }, now: NOW
  });
  const viaMm = evaluateWaterManagement({
    areaM2: 1000, growthStage: "after_transplanting",
    measurement: { valueMm: -150, source: "manual", measuredAt: NOW }, now: NOW
  });
  assert.equal(viaCm.status, viaMm.status);
  assert.equal(viaCm.status, STATUS.belowRange);
  assert.equal(viaCm.deficitMinMm, viaMm.deficitMinMm);
  assert.equal(viaCm.measurement.valueMm, -150);
  assert.equal(viaMm.measurement.valueMm, -150);
  assert.equal(viaCm.measurement.reference, "soil-surface");
});

test("signed support does NOT turn -150 mm into a target: the stage model is unchanged", () => {
  // Supporting the measurement must not invent AWD agronomy. Every stage keeps
  // the target range its cited source supports.
  const result = evaluateWaterManagement({
    areaM2: 1000, growthStage: "after_transplanting",
    measurement: { valueMm: -150, source: "manual", measuredAt: NOW }, now: NOW
  });
  assert.equal(result.target.targetMinMm, 30, "target still comes from the growth stage");
  assert.equal(result.target.targetMaxMm, 50);
  assert.ok(result.sources.length > 0, "and still carries its provenance");
  // Drainage stages still refuse to recommend a fill, sign or no sign.
  const drain = evaluateWaterManagement({
    areaM2: 1000, growthStage: "midseason_drainage",
    measurement: { valueMm: -150, source: "manual", measuredAt: NOW }, now: NOW
  });
  assert.equal(drain.status, STATUS.noNumericTarget);
  assert.equal(drain.standingWaterAdjustment, null);
});

test("a reading against an unknown datum is named, never silently re-read", () => {
  const result = evaluateWaterManagement({
    areaM2: 2143, growthStage: "tillering",
    measurement: { valueMm: -150, reference: "bund-top", source: "manual", measuredAt: NOW },
    now: NOW
  });
  assert.equal(result.status, STATUS.unreadableMeasurement);
  assert.notEqual(result.status, STATUS.missingMeasurement, "a stored value is not a missing one");
  assert.equal(result.storedDepthMm, -150, "reported as persisted, sign included");
  assert.equal(result.standingWaterAdjustment, null, "no arithmetic on an uninterpretable value");
  assert.equal(result.deficitMinMm, null);
  assert.match(result.recommendationJa, /記録し直して/);
});

test("genuinely absent readings are still 'not recorded', and 0 mm is still a real reading", () => {
  for (const stored of [null, undefined, {}, { valueCm: null }, { foo: 1 }]) {
    const result = evaluateWaterManagement({ areaM2: 1000, growthStage: "tillering", measurement: stored, now: NOW });
    assert.equal(result.status, STATUS.missingMeasurement, JSON.stringify(stored));
  }
  const zero = evaluateWaterManagement({ areaM2: 1000, growthStage: "tillering", measurement: manual(0), now: NOW });
  assert.equal(zero.status, STATUS.belowRange, "0 mm is a measurable depth, not a missing one");
});
