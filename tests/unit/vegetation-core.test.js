import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeCellSeries,
  associateObservation,
  classifyForMode,
  compareRecentObservations,
  computeVegetationSummary,
  derivePositionQuality,
  duplicateKey,
  effectiveGridCellId,
  inspectionPriority,
  legendForMode,
  mergeImportedObservations,
  normalizeObservation,
  observationsForCell,
  parseVegetationImport,
  percentSumWarning,
  sortByTimestamp,
  validateObservationInput
} from "../../js/vegetation/vegetation-core.js";

const NOW = Date.parse("2026-07-18T12:00:00+09:00");

function makeObservation(overrides = {}) {
  return normalizeObservation({
    timestamp: "2026-07-18T10:30:00+09:00",
    latitude: 34.6545,
    longitude: 135.83,
    observationType: "weed",
    weedCoveragePercent: 18.2,
    cropCoveragePercent: 72.5,
    bareSoilPercent: 4.0,
    waterSurfacePercent: 5.3,
    confidence: 0.91,
    severity: "high",
    imageName: "IMG_0231.jpg",
    modelName: "weed-segmentation-v1",
    positionSource: "QZ1_SLAS",
    automaticGridCellId: "G-4",
    associationStatus: "automatic",
    ...overrides
  });
}

// A ~50m square boundary with two grid cells split east/west.
const BOUNDARY = [
  [34.65450, 135.83000],
  [34.65450, 135.83054],
  [34.65405, 135.83054],
  [34.65405, 135.83000]
];
const CELLS = [
  { id: "G-1", coordinates: [[34.65450, 135.83000], [34.65450, 135.83027], [34.65405, 135.83027], [34.65405, 135.83000]] },
  { id: "G-2", coordinates: [[34.65450, 135.83027], [34.65450, 135.83054], [34.65405, 135.83054], [34.65405, 135.83027]] }
];

test("observation input validation flags bad values but keeps percent-sum non-blocking", () => {
  const bad = validateObservationInput({
    timestamp: "not-a-date",
    latitude: 200,
    weedCoveragePercent: 150,
    confidence: 3,
    severity: "catastrophic"
  });
  assert.ok(bad.errors.some((error) => error.includes("timestamp")));
  assert.ok(bad.errors.some((error) => error.includes("緯度")));
  assert.ok(bad.errors.some((error) => error.includes("weedCoveragePercent")));
  assert.ok(bad.errors.some((error) => error.includes("AI信頼度")));
  assert.ok(bad.errors.some((error) => error.includes("深刻度")));

  const sumOff = validateObservationInput({
    timestamp: "2026-07-18T10:30:00+09:00",
    weedCoveragePercent: 10,
    cropCoveragePercent: 10,
    bareSoilPercent: 10,
    waterSurfacePercent: 10
  });
  assert.equal(sumOff.errors.length, 0);
  assert.equal(sumOff.warnings.length, 1);
  assert.ok(sumOff.warnings[0].includes("40.0%"));
});

test("percent sum within tolerance produces no warning and values are never modified", () => {
  const input = { weedCoveragePercent: 18.2, cropCoveragePercent: 72.5, bareSoilPercent: 4.0, waterSurfacePercent: 5.3 };
  assert.equal(percentSumWarning(input), null);
  const partial = { weedCoveragePercent: 18.2 };
  assert.equal(percentSumWarning(partial), null, "partial data cannot be judged");
  assert.equal(input.weedCoveragePercent, 18.2);
});

test("JSON import accepts valid rows and rejects malformed rows individually", () => {
  const payload = JSON.stringify({
    schemaVersion: 1,
    observations: [
      {
        timestamp: "2026-07-18T10:30:00+09:00",
        latitude: 34.0,
        longitude: 135.0,
        observationType: "weed",
        weedCoveragePercent: 18.2,
        confidence: 0.91,
        imageName: "IMG_0231.jpg",
        positionSource: "QZ1_SLAS"
      },
      { latitude: 34.0, longitude: 135.0, observationType: "weed" },
      { timestamp: "2026-07-18T10:31:00+09:00", latitude: "abc", longitude: 135.0, observationType: "weed" },
      { timestamp: "2026-07-18T10:32:00+09:00", latitude: 34.0, longitude: 135.0, observationType: "weed", weedCoveragePercent: 400 }
    ]
  });
  const result = parseVegetationImport(payload, "results.json");
  assert.equal(result.format, "json");
  assert.equal(result.records.length, 1);
  assert.equal(result.errors.length, 3);
  assert.equal(result.records[0].observationType, "weed");
  assert.equal(result.records[0].source, "camera_ai");
  assert.equal(result.records[0].slasActive, null, "SLAS status is not fabricated");
  assert.equal(result.records[0].positionQuality, "unknown");
});

test("future schemaVersion is rejected cleanly", () => {
  const result = parseVegetationImport(JSON.stringify({ schemaVersion: 99, observations: [] }), "results.json");
  assert.equal(result.records.length, 0);
  assert.ok(result.errors[0].includes("schemaVersion"));
});

test("CSV import maps headers, parses booleans and reports row errors", () => {
  const csv = [
    "timestamp,lat,lon,type,weed,crop,confidence,severity,image,slasActive,hdop",
    "2026-07-18T10:30:00+09:00,34.0,135.0,weed,18.2,72.5,0.91,high,IMG_1.jpg,true,0.9",
    "2026-07-18T10:31:00+09:00,,135.0,weed,10,80,0.8,low,IMG_2.jpg,false,1.1",
    "2026-07-18T10:32:00+09:00,34.1,135.1,weed,abc,80,0.8,low,IMG_3.jpg,true,1.0"
  ].join("\n");
  const result = parseVegetationImport(csv, "results.csv");
  assert.equal(result.format, "csv");
  assert.equal(result.records.length, 1);
  assert.equal(result.errors.length, 2);
  assert.equal(result.records[0].slasActive, true);
  assert.equal(result.records[0].hdop, 0.9);
  assert.equal(result.records[0].imageName, "IMG_1.jpg");
});

test("duplicate detection skips records with same timestamp/image/position/type", () => {
  const original = makeObservation();
  const duplicate = normalizeObservation({ ...original, id: "veg-different-id" });
  const fresh = makeObservation({ timestamp: "2026-07-19T10:30:00+09:00" });
  assert.equal(duplicateKey(original), duplicateKey(duplicate));
  const { added, skippedDuplicates } = mergeImportedObservations([original], [duplicate, fresh]);
  assert.equal(added.length, 1);
  assert.equal(skippedDuplicates, 1);
  assert.equal(added[0].timestamp, "2026-07-19T10:30:00+09:00");
});

test("association assigns interior points to one cell automatically", () => {
  const observation = makeObservation({ latitude: 34.65430, longitude: 135.83012, automaticGridCellId: null, associationStatus: "unassigned" });
  const association = associateObservation(observation, { fieldId: "field-01", boundary: BOUNDARY, cells: CELLS, thresholdM: 2 });
  assert.equal(association.automaticGridCellId, "G-1");
  assert.equal(association.associationStatus, "automatic");
  assert.equal(association.insideField, true);
});

test("association near a cell edge is ambiguous with candidates, not silently assigned", () => {
  // Point ~0.5m west of the G-1/G-2 split line.
  const observation = makeObservation({ latitude: 34.65430, longitude: 135.830265 });
  const association = associateObservation(observation, { fieldId: "field-01", boundary: BOUNDARY, cells: CELLS, thresholdM: 2 });
  assert.equal(association.associationStatus, "ambiguous");
  assert.ok(association.candidateGridCellIds.includes("G-1"));
  assert.ok(association.candidateGridCellIds.includes("G-2"));
});

test("association outside the field stays unassigned and preserves coordinates", () => {
  const observation = makeObservation({ latitude: 34.65550, longitude: 135.83200 });
  const association = associateObservation(observation, { fieldId: "field-01", boundary: BOUNDARY, cells: CELLS, thresholdM: 2 });
  assert.equal(association.associationStatus, "unassigned");
  assert.equal(association.automaticGridCellId, null);
  assert.equal(observation.latitude, 34.65550, "original latitude preserved");
});

test("position quality is unknown without metadata and green only with healthy SLAS + clean association", () => {
  const bare = makeObservation({ slasActive: undefined, correctionHealthy: undefined, hdop: undefined, estimatedUncertaintyM: undefined });
  assert.equal(derivePositionQuality(bare, { associationStatus: "automatic" }), "unknown");

  const healthy = makeObservation({ slasActive: true, correctionHealthy: true, hdop: 0.9 });
  assert.equal(derivePositionQuality(healthy, { associationStatus: "automatic" }), "green");
  assert.equal(derivePositionQuality(healthy, { associationStatus: "ambiguous" }), "yellow");

  const unhealthy = makeObservation({ slasActive: true, correctionHealthy: false });
  assert.equal(derivePositionQuality(unhealthy, { associationStatus: "automatic" }), "red");

  const provided = makeObservation({ positionQuality: "yellow" });
  assert.equal(derivePositionQuality(provided, { associationStatus: "automatic" }), "yellow", "imported value preserved");
});

test("cell series analysis reports percentage-point deltas and trend labels", () => {
  const earlier = makeObservation({ timestamp: "2026-07-04T10:00:00+09:00", weedCoveragePercent: 8.1, cropCoveragePercent: 80 });
  const later = makeObservation({ timestamp: "2026-07-18T10:30:00+09:00", weedCoveragePercent: 18.2, cropCoveragePercent: 72.5 });
  const analysis = analyzeCellSeries(sortByTimestamp([later, earlier]), undefined, NOW);
  assert.equal(analysis.count, 2);
  assert.ok(Math.abs(analysis.weedDeltaPp - 10.1) < 1e-9);
  assert.ok(Math.abs(analysis.cropDeltaPp + 7.5) < 1e-9);
  assert.equal(analysis.trend, "increasing");

  const single = analyzeCellSeries([earlier], undefined, NOW);
  assert.equal(single.trend, "insufficient_data");

  const stable = analyzeCellSeries(sortByTimestamp([
    makeObservation({ timestamp: "2026-07-04T10:00:00+09:00", weedCoveragePercent: 10 }),
    makeObservation({ timestamp: "2026-07-18T10:00:00+09:00", weedCoveragePercent: 11 })
  ]), undefined, NOW);
  assert.equal(stable.trend, "stable");
});

test("comparison warnings cover weed increase, stale interval and low confidence", () => {
  const earlier = makeObservation({ timestamp: "2026-06-20T10:00:00+09:00", weedCoveragePercent: 8.1, severity: "medium", confidence: 0.91 });
  const later = makeObservation({ timestamp: "2026-07-01T10:00:00+09:00", weedCoveragePercent: 18.2, severity: "high", confidence: 0.55 });
  const analysis = analyzeCellSeries(sortByTimestamp([earlier, later]), undefined, NOW);
  const warnings = compareRecentObservations(analysis);
  assert.ok(warnings.some((warning) => warning.includes("increased by 10.1pt")));
  assert.ok(warnings.some((warning) => warning.includes("Severity increased")));
  assert.ok(warnings.some((warning) => warning.includes("below the configured threshold")));
  assert.ok(warnings.some((warning) => warning.includes("No observation has been recorded for 17 days")));
  assert.ok(warnings.some((warning) => warning.includes("Manual inspection is recommended")));
  assert.ok(!warnings.some((warning) => /病害が確定|pest confirmed/i.test(warning)), "never claims confirmed diagnosis");
});

test("inspection priority is bounded 0-100 with explainable reasons", () => {
  const earlier = makeObservation({ timestamp: "2026-06-20T10:00:00+09:00", weedCoveragePercent: 10 });
  const later = makeObservation({
    timestamp: "2026-07-01T10:00:00+09:00",
    weedCoveragePercent: 35,
    severity: "high",
    confidence: 0.4,
    associationStatus: "ambiguous",
    positionQuality: "red"
  });
  const analysis = analyzeCellSeries(sortByTimestamp([earlier, later]), undefined, NOW);
  const priority = inspectionPriority(analysis);
  assert.ok(priority.score >= 90 && priority.score <= 100, `expected high score, got ${priority.score}`);
  assert.ok(priority.reasons.length >= 5);
  assert.ok(priority.reasons.some((reason) => reason.includes("30%")));

  const calm = inspectionPriority(analyzeCellSeries([
    makeObservation({ timestamp: new Date(NOW - 3600 * 1000).toISOString(), weedCoveragePercent: 1, severity: "low", confidence: 0.95, associationStatus: "confirmed", positionQuality: "green" })
  ], undefined, NOW));
  assert.ok(calm.score <= 10, `expected low score, got ${calm.score}`);

  const empty = inspectionPriority(analyzeCellSeries([], undefined, NOW));
  assert.equal(empty.score, 0);
});

test("map mode classification and legend share one style source with explicit no-data", () => {
  const observation = makeObservation({ weedCoveragePercent: 18.2 });
  const weed = classifyForMode("weed", observation, NOW);
  assert.equal(weed.noData, false);
  assert.equal(weed.label, "15–30%");

  const noValue = classifyForMode("weed", makeObservation({ weedCoveragePercent: undefined }), NOW);
  assert.equal(noValue.noData, true);

  const missing = classifyForMode("weed", null, NOW);
  assert.equal(missing.noData, true);

  const legend = legendForMode("weed");
  assert.equal(legend.length, 5);
  assert.ok(legend.at(-1).label.includes("No data"));
  assert.equal(legend[2].color, classifyForMode("weed", observation, NOW).color);
});

test("summary counts cells, review queue and averages; updates with data changes", () => {
  const cells = [{ id: "G-1" }, { id: "G-2" }, { id: "G-3" }];
  const observations = [
    makeObservation({ automaticGridCellId: "G-1", timestamp: "2026-07-04T10:00:00+09:00", weedCoveragePercent: 5, severity: "low" }),
    makeObservation({ automaticGridCellId: "G-1", timestamp: "2026-07-18T10:00:00+09:00", weedCoveragePercent: 20, severity: "high" }),
    makeObservation({ automaticGridCellId: null, confirmedGridCellId: null, associationStatus: "ambiguous", timestamp: "2026-07-17T10:00:00+09:00", weedCoveragePercent: 11 })
  ];
  const summary = computeVegetationSummary(observations, cells, undefined, NOW);
  assert.equal(summary.totalObservations, 3);
  assert.equal(summary.cellsWithObservations, 1);
  assert.equal(summary.cellsWithoutObservations, 2);
  assert.equal(summary.highSeverityCells, 1);
  assert.equal(summary.increasingWeedCells, 1);
  assert.equal(summary.reviewRequiredObservations, 1);
  assert.ok(Math.abs(summary.averageWeedCoveragePercent - 12) < 1e-9);
  assert.equal(summary.latestObservationTimestamp, "2026-07-18T10:00:00+09:00");
});

test("observationsForCell uses confirmed cell id over automatic", () => {
  const moved = makeObservation({ automaticGridCellId: "G-1", confirmedGridCellId: "G-2", associationStatus: "overridden" });
  assert.equal(effectiveGridCellId(moved), "G-2");
  assert.equal(observationsForCell([moved], "G-2").length, 1);
  assert.equal(observationsForCell([moved], "G-1").length, 0);
});

test("sorting supports newest-first and oldest-first", () => {
  const a = makeObservation({ timestamp: "2026-07-01T10:00:00+09:00" });
  const b = makeObservation({ timestamp: "2026-07-10T10:00:00+09:00" });
  assert.deepEqual(sortByTimestamp([b, a]).map((observation) => observation.timestamp), [a.timestamp, b.timestamp]);
  assert.deepEqual(sortByTimestamp([a, b], "desc").map((observation) => observation.timestamp), [b.timestamp, a.timestamp]);
});
