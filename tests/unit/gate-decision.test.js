import test from "node:test";
import assert from "node:assert/strict";
import { decideGate, GATE_VERDICT, GATE_BASIS } from "../../js/water/gate-decision.js";

const DRY = { rain24hMm: 0, daysSinceRain: 5, forecastRainProbPct: 10 };
const TH = { heavyRain24hMm: 20, lightRain24hMm: 5, forecastRainProbPct: 60, drySpellDays: 3 };
const measured = (valueMm) => ({ valueMm, valueCm: valueMm / 10, reference: "soil-surface", source: "manual", measuredAt: Date.now() });

// ---------------------------------------------------------------------------
// THE BUG THIS MODULE EXISTS TO KILL
//
// The previous rainfall-only gate said 開ける (open, let water in) during 中干し
// and 落水期 whenever the field had been dry for a few days -- i.e. it told the
// farmer to flood a paddy that is deliberately being dried. These are the
// regression tests for that.
// ---------------------------------------------------------------------------

test("中干し NEVER recommends opening, no matter how dry it has been", () => {
  const result = decideGate({ growthStage: "midseason_drainage", weather: DRY, thresholds: TH });
  assert.equal(result.verdict, GATE_VERDICT.close);
  assert.notEqual(result.verdict, GATE_VERDICT.open, "flooding a field during 中干し defeats the practice");
  assert.equal(result.basis, GATE_BASIS.drainageStage);
  assert.equal(result.stageOverride, true);
  assert.match(result.reasonJa, /中干し/);
});

test("落水期 NEVER recommends opening either", () => {
  const result = decideGate({ growthStage: "final_drainage", weather: DRY, thresholds: TH });
  assert.equal(result.verdict, GATE_VERDICT.close);
  assert.equal(result.basis, GATE_BASIS.drainageStage);
});

test("the drainage override beats a measured low water level too", () => {
  // Even a bone-dry measurement must not produce a fill order while draining.
  const result = decideGate({
    growthStage: "midseason_drainage",
    measurement: measured(-150),
    weather: DRY,
    thresholds: TH
  });
  assert.equal(result.verdict, GATE_VERDICT.close);
  assert.equal(result.stageOverride, true);
});

test("a normal stage under the SAME dry weather does open -- the override is stage-specific, not blanket", () => {
  const result = decideGate({ growthStage: "tillering", weather: DRY, thresholds: TH });
  assert.equal(result.verdict, GATE_VERDICT.open);
  assert.equal(result.basis, GATE_BASIS.weatherOnly);
});

// ---------------------------------------------------------------------------
// Water level outranks the forecast
// ---------------------------------------------------------------------------

test("water below target opens the gate even with rain forecast; rain changes only the timing", () => {
  const rainComing = { rain24hMm: 0, daysSinceRain: 1, forecastRainProbPct: 80 };
  const result = decideGate({
    growthStage: "heading_flowering",   // target 40-60mm
    measurement: measured(10),
    weather: rainComing,
    thresholds: TH
  });
  assert.equal(result.verdict, GATE_VERDICT.open, "a field short of water at 出穂期 must not be left dry on a forecast");
  assert.equal(result.basis, GATE_BASIS.waterLevel);
  assert.equal(result.deficitMm, 30);
  assert.match(result.timingJa, /降水確率|再確認/, "the forecast moves the timing, not the verdict");
});

test("heavy rain that already fell still closes the gate, outranking the water level", () => {
  const result = decideGate({
    growthStage: "heading_flowering",
    measurement: measured(10),
    weather: { rain24hMm: 40, daysSinceRain: 0, forecastRainProbPct: 90 },
    thresholds: TH
  });
  assert.equal(result.verdict, GATE_VERDICT.close);
  assert.equal(result.basis, GATE_BASIS.heavyRain);
});

test("water above target holds and never orders a drain", () => {
  const result = decideGate({
    growthStage: "tillering",           // target 25-35mm
    measurement: measured(80),
    weather: DRY,
    thresholds: TH
  });
  assert.equal(result.verdict, GATE_VERDICT.hold);
  assert.equal(result.excessMm, 45);
  assert.doesNotMatch(result.reasonJa, /排水してください|落水してください/, "never an automatic drain order");
});

test("water inside the range holds", () => {
  const result = decideGate({ growthStage: "tillering", measurement: measured(30), weather: DRY, thresholds: TH });
  assert.equal(result.verdict, GATE_VERDICT.hold);
  assert.equal(result.basis, GATE_BASIS.waterLevel);
});

test("a signed AWD reading is treated as a real deficit, not as a missing measurement", () => {
  const result = decideGate({
    growthStage: "tillering",           // target 25-35mm
    measurement: measured(-150),
    weather: DRY,
    thresholds: TH
  });
  assert.equal(result.verdict, GATE_VERDICT.open);
  assert.equal(result.basis, GATE_BASIS.waterLevel);
  assert.equal(result.deficitMm, 175, "25 - (-150) = 175, no abs() and no clamp");
});

// ---------------------------------------------------------------------------
// No measurement: weather-only, and the farmer is told so
// ---------------------------------------------------------------------------

test("with no measurement the verdict is weather-only and says so", () => {
  const result = decideGate({ growthStage: "tillering", measurement: null, weather: DRY, thresholds: TH });
  assert.equal(result.basis, GATE_BASIS.weatherOnly);
  assert.match(result.reasonJa, /水位が未記録/, "the farmer must know the basis is weaker");
});

test("stages with no numeric target fall back to weather-only rather than inventing a comparison", () => {
  // 幼穂形成期 is managed by 間断灌漑, so there is no target range to compare against.
  const result = decideGate({ growthStage: "panicle_initiation", measurement: measured(20), weather: DRY, thresholds: TH });
  assert.equal(result.basis, GATE_BASIS.weatherOnly);
});

test("unknown stage never crashes and never claims a stage-based reason", () => {
  const result = decideGate({ growthStage: "nonsense", weather: DRY, thresholds: TH });
  assert.ok(Object.values(GATE_VERDICT).includes(result.verdict));
  assert.equal(result.basis, GATE_BASIS.weatherOnly);
});

test("missing weather and thresholds degrade to defaults instead of NaN", () => {
  const result = decideGate({ growthStage: "tillering" });
  assert.ok(Object.values(GATE_VERDICT).includes(result.verdict));
  assert.equal(typeof result.reasonJa, "string");
  assert.doesNotMatch(result.reasonJa, /NaN|undefined/);
});
