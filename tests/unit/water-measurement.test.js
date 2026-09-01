import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWaterMeasurement,
  cmToMm,
  hasStoredDepthValue,
  hasUnknownReference,
  measurementAge,
  mmToCm,
  normalizeWaterMeasurement,
  STALE_MEASUREMENT_DAYS,
  storedDepthMm,
  toPersistedEntry
} from "../../js/water/water-measurement.js";

const NOW = new Date("2026-08-18T00:00:00.000Z").getTime();

test("mm/cm conversion is exact in both directions", () => {
  assert.equal(mmToCm(18), 1.8);
  assert.equal(cmToMm(1.8), 18);
  assert.equal(mmToCm(0), 0);
  assert.equal(mmToCm(null), null);
  assert.equal(cmToMm(undefined), null);
});

test("a manual measurement carries value, unit pair, source and timestamp", () => {
  const measurement = buildWaterMeasurement({ valueMm: 18, measuredAt: NOW });
  assert.deepEqual(measurement, {
    valueMm: 18, valueCm: 1.8, reference: "soil-surface", source: "manual", measuredAt: NOW
  });
});

test("a sensor writer only has to change `source`", () => {
  const measurement = buildWaterMeasurement({ valueMm: 18, source: "realsense", measuredAt: NOW });
  assert.equal(measurement.source, "realsense");
  assert.equal(measurement.valueMm, 18);
});

test("non-finite depths produce no measurement, and never a fabricated zero", () => {
  // Number(null) === 0 and Number("") === 0, so a lax guard would turn "no
  // reading" into "water exactly at the soil surface" -- a real measurement
  // the farmer never took.
  for (const valueMm of [null, undefined, "", "  ", NaN, Infinity, -Infinity, "18", "-150", {}, [], true]) {
    assert.equal(
      buildWaterMeasurement({ valueMm }),
      null,
      `${JSON.stringify(valueMm)} must not become a measurement`
    );
  }
  assert.equal(buildWaterMeasurement(), null, "no argument at all is not a measurement");
  assert.equal(buildWaterMeasurement({}), null, "an empty object is not a measurement");
});

test("every finite signed depth is a valid reading (+30 / 0 / -150)", () => {
  for (const valueMm of [30, 0, -150]) {
    const measurement = buildWaterMeasurement({ valueMm, measuredAt: NOW });
    assert.notEqual(measurement, null, `${valueMm} mm must be a measurement`);
    assert.equal(measurement.valueMm, valueMm, "the sign is preserved exactly");
  }
  assert.equal(buildWaterMeasurement({ valueMm: 0, measuredAt: NOW }).valueMm, 0, "0 mm is a real reading");
});

test("-150 mm is the safe-AWD threshold and is never confused with +150 mm", () => {
  const awd = buildWaterMeasurement({ valueMm: -150, measuredAt: NOW });
  const ponded = buildWaterMeasurement({ valueMm: 150, measuredAt: NOW });
  assert.equal(awd.valueMm, -150);
  assert.equal(awd.valueCm, -15, "cm view carries the sign too");
  assert.equal(ponded.valueMm, 150);
  assert.notEqual(awd.valueMm, ponded.valueMm, "opposite field states must never collapse");
  assert.equal(awd.valueMm, -ponded.valueMm);
});

test("every measurement names its datum, defaulting to soil-surface", () => {
  assert.equal(buildWaterMeasurement({ valueMm: 18 }).reference, "soil-surface");
  assert.equal(
    buildWaterMeasurement({ valueMm: 18, reference: "soil-surface" }).reference,
    "soil-surface"
  );
  // An unrecognised datum must not silently redefine what the number means.
  assert.equal(buildWaterMeasurement({ valueMm: 18, reference: "bund-top" }).reference, "soil-surface");
});

test("an ISO measuredAt is accepted and normalized to epoch ms", () => {
  const measurement = buildWaterMeasurement({ valueMm: 25, measuredAt: "2026-08-18T00:00:00.000Z" });
  assert.equal(measurement.measuredAt, NOW);
});

// ---------------------------------------------------------------------------
// Backward compatibility with the pre-existing cm store
// ---------------------------------------------------------------------------

test("a legacy { valueCm, recordedAt } entry loads as a manual mm measurement", () => {
  const measurement = normalizeWaterMeasurement({ valueCm: 1.8, recordedAt: NOW });
  assert.equal(measurement.valueMm, 18);
  assert.equal(measurement.valueCm, 1.8);
  assert.equal(measurement.source, "manual");
  assert.equal(measurement.measuredAt, NOW);
});

test("a legacy entry with no timestamp still loads (timestamp defaults, value is preserved)", () => {
  const measurement = normalizeWaterMeasurement({ valueCm: 5 });
  assert.equal(measurement.valueMm, 50);
  assert.ok(Number.isFinite(measurement.measuredAt));
});

test("persisting writes BOTH shapes so older readers keep working", () => {
  const entry = toPersistedEntry(buildWaterMeasurement({ valueMm: 18, source: "realsense", measuredAt: NOW }));
  // New readers.
  assert.equal(entry.valueMm, 18);
  assert.equal(entry.source, "realsense");
  assert.equal(entry.measuredAt, NOW);
  // js/water/water-need.js and the existing 今日の水門判断 hero read these two.
  assert.equal(entry.valueCm, 1.8);
  assert.equal(entry.recordedAt, NOW);
});

test("a persisted entry round-trips back to the same measurement", () => {
  const original = buildWaterMeasurement({ valueMm: 37, source: "sensor", measuredAt: NOW });
  assert.deepEqual(normalizeWaterMeasurement(toPersistedEntry(original)), original);
});

test("missing / corrupt storage entries normalize to null, never to 0 mm", () => {
  for (const raw of [null, undefined, {}, "18", { valueCm: null }, { valueMm: "18" }, { foo: 1 }]) {
    assert.equal(normalizeWaterMeasurement(raw), null, `${JSON.stringify(raw)} must not become a measurement`);
  }
  assert.equal(toPersistedEntry(null), null);
});

// ---------------------------------------------------------------------------
// Age / staleness
// ---------------------------------------------------------------------------

test("age is reported in whole days and goes stale at the threshold", () => {
  const days = (n) => measurementAge(buildWaterMeasurement({ valueMm: 18, measuredAt: NOW - n * 86400000 }), NOW);
  assert.deepEqual(days(0), { ageDays: 0, isStale: false });
  assert.deepEqual(days(STALE_MEASUREMENT_DAYS - 1), { ageDays: STALE_MEASUREMENT_DAYS - 1, isStale: false });
  assert.deepEqual(days(STALE_MEASUREMENT_DAYS), { ageDays: STALE_MEASUREMENT_DAYS, isStale: true });
});

test("a missing measurement has a null age, not an age of 0 days", () => {
  assert.deepEqual(measurementAge(null, NOW), { ageDays: null, isStale: false });
});

// ---------------------------------------------------------------------------
// "nothing stored" vs "stored but uninterpretable"
// ---------------------------------------------------------------------------

test("hasStoredDepthValue separates an empty slot from an unreadable one", () => {
  assert.equal(hasStoredDepthValue({ valueCm: -15, recordedAt: NOW }), true);
  assert.equal(hasStoredDepthValue({ valueMm: -150 }), true);
  assert.equal(hasStoredDepthValue({ valueMm: 18 }), true);
  for (const raw of [null, undefined, {}, "18", { valueCm: null }, { foo: 1 }]) {
    assert.equal(hasStoredDepthValue(raw), false, JSON.stringify(raw));
  }
});

test("storedDepthMm reports what is on disk, sign included, without interpreting it", () => {
  assert.equal(storedDepthMm({ valueCm: -15, recordedAt: NOW }), -150);
  assert.equal(storedDepthMm({ valueMm: -150 }), -150);
  assert.equal(storedDepthMm({ valueCm: 1.8 }), 18);
  assert.equal(storedDepthMm({}), null);
  // A negative is now INTERPRETABLE -- it is a safe-AWD reading against the
  // soil surface, so the two functions agree about it. They still diverge for
  // a value stored against a datum this build does not know.
  assert.equal(normalizeWaterMeasurement({ valueCm: -15, recordedAt: NOW }).valueMm, -150);
  assert.equal(normalizeWaterMeasurement({ valueMm: -150, reference: "bund-top" }), null);
});

// ---------------------------------------------------------------------------
// Signed levels: round-trip and cross-path equivalence
//
// The bug these pin: before signed support, buildWaterMeasurement() rejected
// negatives, so the mm writer CLEARED a -150 mm reading while the legacy cm
// writer's fallback persisted -15 cm as a bare { valueCm, recordedAt }. One
// farmer action produced two different stored states, and the two cards
// disagreed about whether a measurement existed at all.
// ---------------------------------------------------------------------------

test("-150 mm survives a persist/reload round-trip with sign and datum intact", () => {
  const measurement = buildWaterMeasurement({ valueMm: -150, source: "manual", measuredAt: NOW });
  const persisted = toPersistedEntry(measurement);

  // Storage keeps the legacy pair too, so water-need.js still reads a value.
  assert.equal(persisted.valueMm, -150);
  assert.equal(persisted.valueCm, -15);
  assert.equal(persisted.reference, "soil-surface");
  assert.equal(persisted.recordedAt, NOW);

  // Reload: a real JSON round-trip, not just an object copy.
  const reloaded = normalizeWaterMeasurement(JSON.parse(JSON.stringify(persisted)));
  assert.equal(reloaded.valueMm, -150, "no sign inversion across storage");
  assert.equal(reloaded.valueCm, -15);
  assert.equal(reloaded.reference, "soil-surface");
  assert.equal(reloaded.source, "manual");
});

test("-15 cm and -150 mm normalize to the SAME physical measurement", () => {
  const viaCm = normalizeWaterMeasurement({ valueCm: -15, recordedAt: NOW });
  const viaMm = normalizeWaterMeasurement({ valueMm: -150, source: "manual", measuredAt: NOW });

  assert.equal(viaCm.valueMm, -150, "the legacy cm path yields the same mm value");
  assert.equal(viaMm.valueMm, -150);
  assert.equal(viaCm.valueMm, viaMm.valueMm, "the two write paths must not disagree");
  assert.equal(viaCm.reference, viaMm.reference);
  assert.equal(viaCm.valueCm, viaMm.valueCm);
});

test("legacy entries load unchanged and are read against the soil surface", () => {
  const legacyPositive = normalizeWaterMeasurement({ valueCm: 3, recordedAt: NOW });
  assert.equal(legacyPositive.valueMm, 30, "legacy +3 cm is 30 mm of standing water");
  assert.equal(legacyPositive.reference, "soil-surface");
  assert.equal(legacyPositive.source, "manual");

  const legacyNegative = normalizeWaterMeasurement({ valueCm: -15, recordedAt: NOW });
  assert.equal(legacyNegative.valueMm, -150, "legacy -15 cm is 150 mm below the soil surface");
  assert.equal(legacyNegative.reference, "soil-surface");
});

test("a datum this build does not know is unreadable, not silently re-read", () => {
  // Reinterpreting a bund-top reading against the soil surface would be wrong
  // by the height of the bund and would look entirely plausible on screen.
  const raw = { valueMm: -150, reference: "bund-top", source: "manual", measuredAt: NOW };
  assert.equal(hasUnknownReference(raw), true);
  assert.equal(normalizeWaterMeasurement(raw), null, "unknown datum -> no measurement");
  assert.equal(hasStoredDepthValue(raw), true, "but a value IS stored -- not 'never recorded'");
  assert.equal(storedDepthMm(raw), -150);

  // An ABSENT datum is the legacy case and must still load fine.
  assert.equal(hasUnknownReference({ valueMm: 18 }), false);
  assert.notEqual(normalizeWaterMeasurement({ valueMm: 18, measuredAt: NOW }), null);
});
