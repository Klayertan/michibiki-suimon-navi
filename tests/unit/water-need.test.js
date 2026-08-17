import test from "node:test";
import assert from "node:assert/strict";
import { computeWaterNeed } from "../../js/water/water-need.js";

const NOW = new Date("2026-08-17T00:00:00.000Z").getTime();
const ONE_DAY_MS = 86400000;

test("4,286m² x 2.3cm depth deficit -> 98,578 L / 98.578 m3 (rounded to 98.6)", () => {
  const need = computeWaterNeed({
    fieldId: "f1",
    areaM2: 4286,
    currentWaterLevelCm: 3.2,
    currentLevelRecordedAt: NOW,
    targetWaterLevelCm: 5.5,
    now: NOW
  });
  assert.equal(need.direction, "add");
  assert.equal(need.deltaWaterDepthCm, 2.3);
  assert.equal(need.volumeLiters, 98578);
  assert.equal(need.volumeM3, 98.6);
});

test("zero deficit -> hold, with zero volume", () => {
  const need = computeWaterNeed({
    fieldId: "f2",
    areaM2: 1000,
    currentWaterLevelCm: 5,
    currentLevelRecordedAt: NOW,
    targetWaterLevelCm: 5,
    now: NOW
  });
  assert.equal(need.direction, "hold");
  assert.equal(need.volumeM3, 0);
  assert.equal(need.volumeLiters, 0);
});

test("a deficit smaller than the hold epsilon is also treated as hold", () => {
  const need = computeWaterNeed({
    areaM2: 1000,
    currentWaterLevelCm: 5.02,
    currentLevelRecordedAt: NOW,
    targetWaterLevelCm: 5.0,
    now: NOW
  });
  assert.equal(need.direction, "hold");
});

test("negative delta (current above target) -> remove, with a positive volume", () => {
  const need = computeWaterNeed({
    areaM2: 2000,
    currentWaterLevelCm: 8,
    currentLevelRecordedAt: NOW,
    targetWaterLevelCm: 5,
    now: NOW
  });
  assert.equal(need.direction, "remove");
  assert.equal(need.deltaWaterDepthCm, -3);
  // Volume is always reported as a positive amount to move.
  assert.equal(need.volumeM3, 60);
  assert.ok(need.volumeM3 > 0, "volume for 'remove' must not be negative");
});

test("missing current level -> unknown, no fabricated 0 cm", () => {
  const need = computeWaterNeed({
    areaM2: 1000,
    targetWaterLevelCm: 5,
    now: NOW
  });
  assert.equal(need.direction, "unknown");
  assert.equal(need.currentWaterLevelCm, null);
  assert.equal(need.deltaWaterDepthCm, null);
  assert.equal(need.volumeM3, null);
  assert.ok(need.missingInputs.includes("currentWaterLevelCm"));
});

test("missing target level -> unknown, no fabricated 0 cm", () => {
  const need = computeWaterNeed({
    areaM2: 1000,
    currentWaterLevelCm: 3,
    currentLevelRecordedAt: NOW,
    now: NOW
  });
  assert.equal(need.direction, "unknown");
  assert.equal(need.targetWaterLevelCm, null);
  assert.ok(need.missingInputs.includes("targetWaterLevelCm"));
});

test("missing area -> depth still computed, but no volume", () => {
  const need = computeWaterNeed({
    currentWaterLevelCm: 3,
    currentLevelRecordedAt: NOW,
    targetWaterLevelCm: 5,
    now: NOW
  });
  assert.equal(need.direction, "add");
  assert.equal(need.deltaWaterDepthCm, 2);
  assert.equal(need.volumeLiters, null);
  assert.equal(need.volumeM3, null);
  assert.ok(need.missingInputs.includes("areaM2"));
});

test("null/non-numeric inputs never silently become 0 (guards the historical Number(null) === 0 bug)", () => {
  const need = computeWaterNeed({
    areaM2: null,
    currentWaterLevelCm: null,
    targetWaterLevelCm: undefined,
    now: NOW
  });
  assert.equal(need.direction, "unknown");
  assert.equal(need.areaM2, null);
  assert.equal(need.currentWaterLevelCm, null);
  assert.equal(need.targetWaterLevelCm, null);
  assert.notEqual(need.deltaWaterDepthCm, 0);
  assert.equal(need.deltaWaterDepthCm, null);

  const needWithString = computeWaterNeed({
    areaM2: 1000,
    currentWaterLevelCm: "3.2",
    targetWaterLevelCm: 5,
    now: NOW
  });
  // A string slipping through must not be coerced into a number either.
  assert.equal(needWithString.direction, "unknown");
  assert.ok(needWithString.missingInputs.includes("currentWaterLevelCm"));
});

test("rounding: depth to 1 decimal cm, volume to 1 decimal m3", () => {
  const need = computeWaterNeed({
    areaM2: 3333,
    currentWaterLevelCm: 1.234,
    currentLevelRecordedAt: NOW,
    targetWaterLevelCm: 4.567,
    now: NOW
  });
  assert.equal(need.deltaWaterDepthCm, 3.3);
  // 3333 * 3.3 * 10 = 109989 L = 109.989 m3 -> rounds to 110.0
  assert.equal(need.volumeM3, 110);
});

test("no negative 'water to add' is ever displayed for either direction", () => {
  const add = computeWaterNeed({ areaM2: 500, currentWaterLevelCm: 1, currentLevelRecordedAt: NOW, targetWaterLevelCm: 4, now: NOW });
  const remove = computeWaterNeed({ areaM2: 500, currentWaterLevelCm: 9, currentLevelRecordedAt: NOW, targetWaterLevelCm: 4, now: NOW });
  assert.ok(add.volumeM3 >= 0);
  assert.ok(remove.volumeM3 >= 0);
});

test("data-source timestamps propagate into staleDays / isStale", () => {
  const fresh = computeWaterNeed({
    areaM2: 1000,
    currentWaterLevelCm: 3,
    currentLevelRecordedAt: NOW - ONE_DAY_MS,
    targetWaterLevelCm: 5,
    now: NOW
  });
  assert.equal(fresh.staleDays, 1);
  assert.equal(fresh.isStale, false);

  const stale = computeWaterNeed({
    areaM2: 1000,
    currentWaterLevelCm: 3,
    currentLevelRecordedAt: NOW - 3 * ONE_DAY_MS,
    targetWaterLevelCm: 5,
    now: NOW
  });
  assert.equal(stale.staleDays, 3);
  assert.equal(stale.isStale, true);

  const noTimestamp = computeWaterNeed({
    areaM2: 1000,
    currentWaterLevelCm: 3,
    targetWaterLevelCm: 5,
    now: NOW
  });
  assert.equal(noTimestamp.staleDays, null);
  assert.equal(noTimestamp.isStale, false);
});
