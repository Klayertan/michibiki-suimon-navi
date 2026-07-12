import test from "node:test";
import assert from "node:assert/strict";
import { calculateAssurance } from "../../js/assurance/assurance-engine.js";

function observations(prefix, eastOffsetM = 0, simulated = false) {
  const baseLat = 35;
  const baseLon = 135;
  return [0, 1, 2, 3].map((index) => ({
    id: `${prefix}${index}`,
    sequence: index,
    receiverId: prefix,
    timestampUtcMs: 1_700_000_000_000 + index * 1000,
    timeOfDayMs: index * 1000,
    lat: baseLat + index * 0.000005,
    lon: baseLon + eastOffsetM / (111320 * Math.cos(baseLat * Math.PI / 180)),
    fixQuality: 1,
    fixValid: true,
    satellites: 10,
    hdop: 0.8,
    augmentation: { service: null, status: "inactive", evidence: [] },
    simulated
  }));
}

const boundary = [[34.9999, 134.9999], [34.9999, 135.0001], [35.0001, 135.0001], [35.0001, 134.9999]];

test("rule-based assurance reports measured cells without interpolating unknown cells", () => {
  const result = calculateAssurance({
    qz1Observations: observations("q"),
    referenceObservations: observations("r", 0.4),
    profileId: "manual",
    gridSizeM: 10,
    boundary,
    fieldId: "field",
    toleranceMs: 100
  });
  assert.equal(result.summary.pairedCount, 4);
  assert.ok(result.cells.some((cell) => cell.pairs.length > 0));
  assert.ok(result.cells.some((cell) => cell.classification === "grey"));
  assert.ok(result.summary.unknownAreaPercent > 0);
  assert.equal(result.calculationVersion, "satellite-assurance.v1");
});

test("simulated data can never produce an operational green classification", () => {
  const result = calculateAssurance({
    qz1Observations: observations("q"),
    referenceObservations: observations("r", 0.4),
    profileId: "manual",
    gridSizeM: 50,
    boundary,
    fieldId: "field",
    toleranceMs: 100,
    simulated: true
  });
  assert.ok(result.cells.filter((cell) => cell.pairs.length).every((cell) => cell.classification === "simulated"));
  assert.ok(result.warnings.some((warning) => warning.includes("SIMULATED")));
});
