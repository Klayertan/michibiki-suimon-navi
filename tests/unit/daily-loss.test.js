import test from "node:test";
import assert from "node:assert/strict";
import {
  RICE_KC,
  STAGE_KC,
  PERCOLATION_RANGE_MM_PER_DAY,
  ESTIMATION_ERROR_MM_PER_DAY,
  kcForStage,
  cropEvapotranspiration,
  estimateDailyLoss,
  volumePerTenMm
} from "../../js/water/daily-loss.js";

// ---------------------------------------------------------------------------
// FAO 56 Kc values, verbatim from Table 12 (rice)
// ---------------------------------------------------------------------------

test("rice Kc values match FAO 56 Table 12 exactly", () => {
  assert.equal(RICE_KC.initial, 1.05);
  assert.equal(RICE_KC.mid, 1.20);
  assert.equal(RICE_KC.endPonded, 0.90);
  assert.equal(RICE_KC.endDrained, 0.60);
});

test("every growth stage with a Kc maps into the FAO 56 range", () => {
  for (const [stage, kc] of Object.entries(STAGE_KC)) {
    assert.ok(kc >= RICE_KC.endDrained && kc <= RICE_KC.mid, `${stage} Kc ${kc} outside FAO 56 range`);
  }
});

test("unknown stages get no Kc rather than a plausible default", () => {
  assert.equal(kcForStage("nonsense"), null);
  assert.equal(kcForStage(undefined), null);
  assert.equal(kcForStage("unknown"), null);
});

// ---------------------------------------------------------------------------
// ETc = Kc x ETo  (FAO 56 Chapter 6)
// ---------------------------------------------------------------------------

test("ETc is Kc x ETo, using the live reference ET for the field", () => {
  // 4.2 mm/day is a real Open-Meteo et0_fao_evapotranspiration reading for the
  // project's Nara field on 2026-08-20.
  const etc = cropEvapotranspiration(4.2, "heading_flowering");
  assert.equal(etc, 4.2 * RICE_KC.mid);
  assert.ok(Math.abs(etc - 5.04) < 1e-9);
});

test("ETc refuses to invent a value from missing or invalid weather", () => {
  for (const eto of [null, undefined, NaN, "4.2", -1, Infinity]) {
    assert.equal(cropEvapotranspiration(eto, "tillering"), null, String(eto));
  }
  assert.equal(cropEvapotranspiration(4.2, "nonsense"), null, "unknown stage yields no ETc");
});

// ---------------------------------------------------------------------------
// Daily loss is a RANGE, never a single confident number
// ---------------------------------------------------------------------------

test("daily loss is reported as a range spanning the percolation uncertainty", () => {
  const loss = estimateDailyLoss({ etoMmPerDay: 4.2, growthStage: "heading_flowering", areaM2: 2143 });
  assert.equal(loss.applicable, true);
  const etc = 4.2 * RICE_KC.mid;
  assert.equal(loss.etcMmPerDay, etc);
  assert.equal(loss.minMmPerDay, etc + PERCOLATION_RANGE_MM_PER_DAY.minMm);
  assert.equal(loss.maxMmPerDay, etc + PERCOLATION_RANGE_MM_PER_DAY.maxMm);
  assert.ok(loss.maxMmPerDay > loss.minMmPerDay, "a single value would be false precision");
});

test("the range converts to volume with the same 1mm x 1m2 = 1L rule", () => {
  const loss = estimateDailyLoss({ etoMmPerDay: 4.2, growthStage: "heading_flowering", areaM2: 2143 });
  assert.ok(Math.abs(loss.minM3PerDay - (2143 * loss.minMmPerDay) / 1000) < 1e-9);
  assert.ok(Math.abs(loss.maxM3PerDay - (2143 * loss.maxMmPerDay) / 1000) < 1e-9);
});

test("Hanayama's +/-3 mm/day estimation error is carried as data, not buried", () => {
  // 華山 謙 (1964) 減水深法の再検討, 農業土木研究 32(1):15-23.
  // The UI must be able to state this rather than implying precision.
  assert.equal(ESTIMATION_ERROR_MM_PER_DAY, 3);
  const loss = estimateDailyLoss({ etoMmPerDay: 4.2, growthStage: "tillering", areaM2: 2143 });
  assert.equal(loss.errorMmPerDay, 3);
});

test("percolation is presented as a general range with its provenance, never as this field's value", () => {
  assert.ok(PERCOLATION_RANGE_MM_PER_DAY.minMm < PERCOLATION_RANGE_MM_PER_DAY.maxMm);
  assert.ok(PERCOLATION_RANGE_MM_PER_DAY.sourceId, "must name a source");
  assert.match(PERCOLATION_RANGE_MM_PER_DAY.noteJa, /実測値ではなく|一般的な範囲/);
});

test("drainage stages report no daily replacement requirement at all", () => {
  for (const stage of ["midseason_drainage", "final_drainage"]) {
    const loss = estimateDailyLoss({ etoMmPerDay: 4.2, growthStage: stage, areaM2: 2143 });
    assert.equal(loss.applicable, false, stage);
    assert.equal(loss.minMmPerDay, null, "a drying field must not be given a top-up figure");
    assert.equal(loss.minM3PerDay, null);
    assert.match(loss.reasonJa, /落水/);
  }
});

test("missing inputs produce nulls, never NaN and never 0", () => {
  const noWeather = estimateDailyLoss({ growthStage: "tillering", areaM2: 2143 });
  assert.equal(noWeather.etcMmPerDay, null);
  assert.equal(noWeather.minMmPerDay, null);

  const noArea = estimateDailyLoss({ etoMmPerDay: 4.2, growthStage: "tillering" });
  assert.ok(noArea.minMmPerDay > 0, "the mm/day rate does not need an area");
  assert.equal(noArea.minM3PerDay, null, "but the volume does");

  const nothing = estimateDailyLoss();
  for (const v of [nothing.etcMmPerDay, nothing.minMmPerDay, nothing.minM3PerDay]) {
    assert.equal(v, null);
    assert.ok(!Number.isNaN(v));
  }
});

// ---------------------------------------------------------------------------
// The honest answer before anyone has measured
// ---------------------------------------------------------------------------

test("volume per 10mm needs only the area, so it works with no measurement at all", () => {
  const rate = volumePerTenMm(2143);
  assert.equal(rate.depthMm, 10);
  assert.equal(rate.liters, 21430);
  assert.equal(rate.m3, 21.43);
});

test("the per-10mm rate assumes nothing about the current level", () => {
  // This is the whole point: it is a conversion factor, not a deficit. It must
  // be identical whether the field is full, empty or unmeasured.
  assert.deepEqual(volumePerTenMm(1000), { depthMm: 10, liters: 10000, m3: 10, areaM2: 1000 });
  assert.equal(volumePerTenMm(0), null, "a zero area yields no rate, not a division artefact");
  for (const area of [null, undefined, NaN, -5, "2143"]) {
    assert.equal(volumePerTenMm(area), null, String(area));
  }
});
