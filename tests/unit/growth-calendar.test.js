import test from "node:test";
import assert from "node:assert/strict";
import {
  REGIONAL_CALENDARS,
  regionForLatitude,
  regionForField,
  stageForDate,
  suggestGrowthStage,
  resolveGrowthStage,
  manualOverridesCalendar
} from "../../js/water/growth-calendar.js";
import { GROWTH_STAGES, UNKNOWN_STAGE_ID } from "../../js/water/growth-stage-model.js";

// The project's own field, from data/field.json (Nara).
const NARA_FIELD = {
  coordinates: [[34.65480, 135.82982], [34.65477, 135.83069], [34.65452, 135.83074], [34.65425, 135.83061]]
};

test("the project's own Nara field resolves to 近畿・東海", () => {
  const region = regionForField(NARA_FIELD);
  assert.equal(region.id, "kinki_tokai");
  assert.equal(region.labelJa, "近畿・東海");
});

test("latitude bands cover Japan north to south without gaps or overlaps", () => {
  const sorted = [...REGIONAL_CALENDARS].sort((a, b) => a.minLat - b.minLat);
  for (let i = 0; i < sorted.length - 1; i += 1) {
    assert.equal(sorted[i].maxLat, sorted[i + 1].minLat, `gap/overlap between ${sorted[i].id} and ${sorted[i + 1].id}`);
  }
  assert.equal(regionForLatitude(43.0).id, "hokkaido");
  assert.equal(regionForLatitude(38.5).id, "tohoku");
  assert.equal(regionForLatitude(36.0).id, "hokuriku_kanto");
  assert.equal(regionForLatitude(34.65).id, "kinki_tokai");
  assert.equal(regionForLatitude(32.0).id, "chugoku_shikoku_kyushu");
});

test("a field outside Japan, or with no coordinates, still returns a usable region", () => {
  for (const lat of [NaN, null, undefined, 80, -10]) {
    const region = regionForLatitude(lat);
    assert.ok(region && region.id, `${lat} must still yield a region`);
  }
  assert.ok(regionForField({}).id);
  assert.ok(regionForField({ coordinates: [] }).id);
  assert.ok(regionForField(null).id);
});

test("every stage id in every calendar exists in the growth-stage model", () => {
  const known = new Set(GROWTH_STAGES.map((s) => s.id));
  for (const region of REGIONAL_CALENDARS) {
    for (const [stageId] of region.stages) {
      assert.ok(known.has(stageId), `${region.id} references unknown stage ${stageId}`);
    }
  }
});

test("calendar windows within a region are ordered and non-overlapping", () => {
  const key = (md) => { const [m, d] = md.split("-").map(Number); return m * 100 + d; };
  for (const region of REGIONAL_CALENDARS) {
    for (let i = 0; i < region.stages.length; i += 1) {
      const [, from, to] = region.stages[i];
      assert.ok(key(from) <= key(to), `${region.id}: window ${from}..${to} is inverted`);
      if (i > 0) {
        const prevTo = key(region.stages[i - 1][2]);
        assert.ok(key(from) > prevTo, `${region.id}: ${from} overlaps the previous window`);
      }
    }
  }
});

test("dates map to the expected stage for Nara (近畿)", () => {
  const region = regionForLatitude(34.65);
  assert.equal(stageForDate(region, new Date("2026-06-10T00:00:00+09:00")), "after_transplanting");
  assert.equal(stageForDate(region, new Date("2026-07-10T00:00:00+09:00")), "tillering");
  assert.equal(stageForDate(region, new Date("2026-08-01T00:00:00+09:00")), "midseason_drainage");
  assert.equal(stageForDate(region, new Date("2026-08-30T00:00:00+09:00")), "heading_flowering");
  assert.equal(stageForDate(region, new Date("2026-09-20T00:00:00+09:00")), "ripening");
});

test("out of season returns unknown rather than guessing a stage", () => {
  const region = regionForLatitude(34.65);
  // There is no rice in the field in January; saying so is the honest answer.
  assert.equal(stageForDate(region, new Date("2026-01-15T00:00:00+09:00")), UNKNOWN_STAGE_ID);
  assert.equal(stageForDate(region, new Date("2026-12-01T00:00:00+09:00")), UNKNOWN_STAGE_ID);
});

test("each region's stages advance monotonically through its own season", () => {
  // NOT asserted across regions by latitude: Japanese transplanting is not
  // monotonic with latitude. 近畿・東海 transplants in JUNE -- later than 関東
  // in early May -- because of 二毛作 (wheat double-cropping). An earlier
  // version of this test assumed north-to-south ordering and failed on exactly
  // that, correctly.
  //
  // What must hold is per-region: walking a region's own calendar forward in
  // time never moves the crop backwards through the stage list.
  const order = GROWTH_STAGES.map((s) => s.id);
  for (const region of REGIONAL_CALENDARS) {
    let lastRank = -1;
    for (let month = 1; month <= 12; month += 1) {
      for (const day of [1, 15, 28]) {
        const date = new Date(Date.UTC(2026, month - 1, day, 3)); // ~noon JST
        const stage = stageForDate(region, date);
        if (stage === UNKNOWN_STAGE_ID) continue;
        const rank = order.indexOf(stage);
        assert.ok(
          rank >= lastRank,
          `${region.id}: ${month}-${day} gave ${stage} (rank ${rank}) after rank ${lastRank}`
        );
        lastRank = rank;
      }
    }
    assert.ok(lastRank > 0, `${region.id} produced no in-season stages at all`);
  }
});

test("cold regions transplant later than 関東, which is the real latitude effect", () => {
  const key = (regionId, stageId) => {
    const region = REGIONAL_CALENDARS.find((r) => r.id === regionId);
    const [, from] = region.stages.find(([id]) => id === stageId);
    const [m, d] = from.split("-").map(Number);
    return m * 100 + d;
  };
  const transplant = (id) => key(id, "after_transplanting");
  assert.ok(transplant("hokkaido") > transplant("hokuriku_kanto"), "Hokkaido transplants after Kanto");
  assert.ok(transplant("tohoku") > transplant("hokuriku_kanto"), "Tohoku transplants after Kanto");
});

test("a suggestion is always marked as an estimate and names its region", () => {
  const s = suggestGrowthStage(NARA_FIELD, new Date("2026-07-10T00:00:00+09:00"));
  assert.equal(s.stage, "tillering");
  assert.equal(s.source, "calendar");
  assert.equal(s.isEstimate, true);
  assert.equal(s.regionId, "kinki_tokai");
  assert.match(s.noteJa, /推定/, "the UI must be able to label it 推定, never as observed fact");
});

// ---------------------------------------------------------------------------
// The one rule: a farmer's own eyes beat a regional average
// ---------------------------------------------------------------------------

test("a manual choice always wins and is never overwritten by the calendar", () => {
  // Calendar would say 中干し on this date; the farmer says the crop is still tillering.
  const date = new Date("2026-08-01T00:00:00+09:00");
  assert.equal(stageForDate(regionForLatitude(34.65), date), "midseason_drainage");

  const stored = { stage: "tillering", source: "manual", updatedAt: Date.now() };
  const resolved = resolveGrowthStage(stored, NARA_FIELD, date);
  assert.equal(resolved.stage, "tillering", "the farmer's correction must survive");
  assert.equal(resolved.source, "manual");
  assert.equal(resolved.isEstimate, false);
});

test("a calendar-sourced stored record does NOT suppress a fresh suggestion", () => {
  // Yesterday's estimate must not freeze the stage as the season moves on.
  const stored = { stage: "tillering", source: "calendar", updatedAt: Date.now() };
  const resolved = resolveGrowthStage(stored, NARA_FIELD, new Date("2026-08-30T00:00:00+09:00"));
  assert.equal(resolved.stage, "heading_flowering");
  assert.equal(resolved.source, "calendar");
});

test("manualOverridesCalendar only counts a real manual stage", () => {
  assert.equal(manualOverridesCalendar({ stage: "tillering", source: "manual" }), true);
  assert.equal(manualOverridesCalendar({ stage: "tillering", source: "calendar" }), false);
  assert.equal(manualOverridesCalendar({ stage: UNKNOWN_STAGE_ID, source: "manual" }), false);
  for (const raw of [null, undefined, {}, "tillering"]) {
    assert.equal(manualOverridesCalendar(raw), false, JSON.stringify(raw));
  }
});

test("no stored record at all falls back to the calendar suggestion", () => {
  const resolved = resolveGrowthStage(null, NARA_FIELD, new Date("2026-07-10T00:00:00+09:00"));
  assert.equal(resolved.stage, "tillering");
  assert.equal(resolved.isEstimate, true);
});
