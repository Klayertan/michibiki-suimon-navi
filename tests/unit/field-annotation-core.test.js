import test from "node:test";
import assert from "node:assert/strict";
import {
  CLOSE_WARNING_MESSAGE,
  DEFAULT_AUTO_CLOSE_THRESHOLD_M,
  FEATURE_TYPE_LABELS,
  MEASUREMENT_TYPE_LABELS,
  OBSERVATION_TYPE_LABELS,
  SCHEMA_VERSION,
  SEVERITY_LABELS,
  UPLOAD_CLOSE_WARNING_MESSAGE,
  WATER_CONTROL_EXPORT_TYPES,
  buildBoundaryTrack,
  buildField,
  buildFieldObservation,
  buildMetadata,
  buildSurveySession,
  buildWaterControlPoint,
  distanceMeters,
  emptyPersistedStore,
  evaluateClosure,
  isObservationType,
  isWaterControlType,
  makeSurveySessionId,
  nextBoundaryTrackId,
  nextFieldDefaults,
  nextObservationName,
  normalizeObservationType,
  normalizePersistedStore,
  normalizeSeverity,
  normalizeWaterControlType,
  polygonAreaSquareMeters,
  summarizeFixQuality,
  waterControlInternalType
} from "../../js/fields/field-annotation-core.js";

// A ~40m x 45m square near the demo field used elsewhere in this app.
const SQUARE = [
  [34.65480, 135.82982],
  [34.65480, 135.83027],
  [34.65444, 135.83027],
  [34.65444, 135.82982]
];

test("nextFieldDefaults sequences 圃場N / paddy-00N based on existing count", () => {
  assert.deepEqual(nextFieldDefaults(0), { name: "圃場1", id: "paddy-001" });
  assert.deepEqual(nextFieldDefaults(1), { name: "圃場2", id: "paddy-002" });
  assert.deepEqual(nextFieldDefaults(11), { name: "圃場12", id: "paddy-012" });
});

test("nextBoundaryTrackId and makeSurveySessionId produce stable, distinguishable ids", () => {
  assert.equal(nextBoundaryTrackId("paddy-001", 0), "paddy-001-track-001");
  assert.equal(nextBoundaryTrackId("paddy-001", 1), "paddy-001-track-002");
  const id = makeSurveySessionId(Date.parse("2026-07-19T19:38:52+09:00"));
  assert.match(id, /^survey-/);
});

test("evaluateClosure auto-closes a tight loop and requires confirmation for a large gap", () => {
  const tight = [...SQUARE, [34.654799, 135.829825]];
  const tightResult = evaluateClosure(tight, DEFAULT_AUTO_CLOSE_THRESHOLD_M);
  assert.equal(tightResult.canClose, true);
  assert.equal(tightResult.autoClose, true);
  assert.ok(tightResult.gapM < DEFAULT_AUTO_CLOSE_THRESHOLD_M);

  const farResult = evaluateClosure(SQUARE, DEFAULT_AUTO_CLOSE_THRESHOLD_M);
  assert.equal(farResult.canClose, true);
  assert.equal(farResult.autoClose, false);
  assert.ok(farResult.gapM > DEFAULT_AUTO_CLOSE_THRESHOLD_M);
});

test("an open L-shaped track (only 2-3 points, large gap) is never rejected by evaluateClosure itself", () => {
  // Simulates the user's real incomplete L-shaped walk: evaluateClosure just
  // reports the facts (canClose/autoClose/gapM) — deciding to save it as a
  // boundary track instead of a polygon is the controller's job, not a
  // rejection here.
  const lShape = [
    [34.65480, 135.82982],
    [34.65480, 135.83027],
    [34.65444, 135.83027]
  ];
  const result = evaluateClosure(lShape, DEFAULT_AUTO_CLOSE_THRESHOLD_M);
  assert.equal(result.canClose, true);
  assert.equal(result.autoClose, false);
});

test("evaluateClosure flags self-intersecting paths as a non-fatal warning", () => {
  const bowtie = [
    [34.6548, 135.8298],
    [34.6544, 135.8302],
    [34.6548, 135.8302],
    [34.6544, 135.8298]
  ];
  const result = evaluateClosure(bowtie);
  assert.equal(result.selfIntersects, true);
  assert.ok(result.warnings.some((warning) => warning.includes("自己交差")));
});

test("both the standalone and upload-triggered confirmation messages are stable and distinct", () => {
  assert.equal(CLOSE_WARNING_MESSAGE, "始点と終点が離れています。圃場ポリゴンを閉じますか？");
  assert.equal(UPLOAD_CLOSE_WARNING_MESSAGE, "始点と終点が離れています。このログを圃場ポリゴンとして閉じますか？");
});

test("buildField nests memo/source/timestamps under properties, matching the requested schema", () => {
  const field = buildField({
    id: "paddy-001",
    name: "圃場1",
    coordinates: SQUARE,
    memo: "テスト圃場",
    gapM: 12.3,
    closedManually: true,
    sourceSessionId: "survey-20260719-193852",
    sourceFileName: "walk.txt",
    fixQualitySummary: { total: 5 },
    nowIso: "2026-07-19T10:00:00+09:00"
  });
  assert.equal(field.type, "field");
  assert.equal(field.geometryType, "Polygon");
  assert.equal(field.id, "paddy-001");
  assert.equal(field.name, "圃場1");
  assert.equal(field.sourceSessionId, "survey-20260719-193852");
  assert.equal(field.coordinates.length, 4);
  assert.ok(field.properties.areaM2 > 0);
  assert.equal(field.properties.closureGapM, 12.3);
  assert.equal(field.properties.closedManually, true);
  assert.equal(field.properties.memo, "テスト圃場");
  assert.equal(field.properties.sourceFileName, "walk.txt");
  assert.equal(field.properties.sourceType, "QZ1_NMEA");
  assert.deepEqual(field.properties.fixQualitySummary, { total: 5 });
});

test("buildBoundaryTrack accepts an open (unclosed) path without complaint", () => {
  const lShape = [
    [34.65480, 135.82982],
    [34.65480, 135.83027],
    [34.65444, 135.83027]
  ];
  const track = buildBoundaryTrack({
    id: "paddy-001-track-001",
    name: "圃場1 下見測定",
    fieldId: "paddy-001",
    coordinates: lShape,
    memo: "2026/07/19 QZ1徒歩測量。圃場境界の一部を測定。次回、全周測量予定。",
    sourceSessionId: "survey-20260719-193852",
    sourceFileName: "Serial Bluetooth Terminal 20260719-193852.txt",
    nowIso: "2026-07-19T19:38:52+09:00"
  });
  assert.equal(track.type, "field_boundary_track");
  assert.equal(track.geometryType, "LineString");
  assert.equal(track.fieldId, "paddy-001");
  assert.equal(track.coordinates.length, 3);
  assert.equal(track.properties.sourceFileName, "Serial Bluetooth Terminal 20260719-193852.txt");
  assert.match(track.properties.memo, /下見測定|一部を測定/);
});

test("buildWaterControlPoint exports descriptive type strings and accepts either form on re-import", () => {
  const point = buildWaterControlPoint({
    id: "gate-001",
    name: "圃場1 水門1",
    type: "gate",
    lat: 34.6548,
    lon: 135.8300,
    relatedFieldId: "paddy-001",
    sourceType: "manual_map_click",
    nowIso: "2026-07-19T10:00:00+09:00"
  });
  assert.equal(point.type, "water_gate");
  assert.equal(point.relatedFieldId, "paddy-001");
  assert.equal(point.geometryType, "Point");
  assert.deepEqual(point.coordinates, [34.6548, 135.83]);
  assert.equal(waterControlInternalType(point), "gate");

  // Re-importing a record that already carries the long-form type string
  // must round-trip to the same internal key, not fall back to a default.
  const reimported = buildWaterControlPoint({ id: "gate-002", type: "water_outlet", lat: 34, lon: 135 });
  assert.equal(reimported.type, "water_outlet");
  assert.equal(waterControlInternalType(reimported), "outlet");

  const unknownType = buildWaterControlPoint({ id: "gate-003", type: "bogus", lat: 34, lon: 135 });
  assert.equal(unknownType.type, "water_gate", "unknown types fall back to gate, never invented");
});

test("normalizeWaterControlType and isWaterControlType cover exactly the five requested categories", () => {
  assert.deepEqual(Object.keys(FEATURE_TYPE_LABELS), ["field", "gate", "inlet", "outlet", "sensor", "photo"]);
  assert.equal(FEATURE_TYPE_LABELS.gate, "水門");
  assert.equal(FEATURE_TYPE_LABELS.inlet, "給水口");
  assert.equal(FEATURE_TYPE_LABELS.outlet, "排水口");
  assert.equal(FEATURE_TYPE_LABELS.sensor, "水位センサ");
  assert.equal(FEATURE_TYPE_LABELS.photo, "撮影地点");
  assert.equal(isWaterControlType("field"), false);
  assert.equal(isWaterControlType("gate"), true);
  assert.equal(normalizeWaterControlType("water_level_sensor"), "sensor");
  assert.equal(WATER_CONTROL_EXPORT_TYPES.sensor, "water_level_sensor");
});

test("buildSurveySession preserves raw points and a valid measurementType, defaulting safely otherwise", () => {
  const points = [{ lat: 34, lon: 135, fixQuality: 1 }];
  const session = buildSurveySession({
    id: "survey-20260719-193852",
    name: "圃場1 測量",
    fieldId: "paddy-001",
    sourceFileName: "walk.txt",
    rawPoints: points,
    measurementType: "boundary_track",
    nowIso: "2026-07-19T19:38:52+09:00"
  });
  assert.equal(session.measurementType, "boundary_track");
  assert.equal(session.rawPoints.length, 1);
  assert.notEqual(session.rawPoints, points, "rawPoints is copied, not aliased");

  const invalidType = buildSurveySession({ id: "survey-x", name: "x", rawPoints: [], measurementType: "not-real" });
  assert.equal(invalidType.measurementType, "field_polygon", "invalid measurementType falls back, never invented");
  assert.deepEqual(Object.keys(MEASUREMENT_TYPE_LABELS), ["field_polygon", "boundary_track", "water_points"]);
});

test("polygonAreaSquareMeters returns a plausible area for a known square and 0 for degenerate input", () => {
  const area = polygonAreaSquareMeters(SQUARE);
  assert.ok(area > 1000 && area < 3000, `expected a few thousand m², got ${area}`);
  assert.equal(polygonAreaSquareMeters([[34, 135], [34, 135.001]]), 0);
});

test("distanceMeters matches the closure-gap distance used internally", () => {
  const gap = distanceMeters(SQUARE[0], SQUARE[3]);
  assert.ok(gap > 0);
  const result = evaluateClosure([...SQUARE, SQUARE[0]]);
  assert.ok(Math.abs(result.gapM - 0) < 1e-6);
});

test("summarizeFixQuality groups by fix quality and counts augmented fixes without fabricating data", () => {
  const points = [
    { fixQuality: 1, augmented: false },
    { fixQuality: 2, augmented: true },
    { fixQuality: 2, augmented: true },
    { lat: 34, lon: 135 }
  ];
  const summary = summarizeFixQuality(points);
  assert.equal(summary.total, 4);
  assert.equal(summary.byFixQuality["1"], 1);
  assert.equal(summary.byFixQuality["2"], 2);
  assert.equal(summary.byFixQuality.unknown, 1);
  assert.equal(summary.augmentedCount, 2);
});

test("buildMetadata carries the source label through without inventing a filename", () => {
  const withSource = buildMetadata({ sourceFileName: "walk-log.nmea", points: [{ fixQuality: 1 }], nowIso: "2026-07-19T10:00:00+09:00" });
  assert.equal(withSource.sourceFileName, "walk-log.nmea");
  assert.equal(withSource.date, "2026-07-19T10:00:00+09:00");
  assert.equal(withSource.fixQualitySummary.total, 1);

  const withoutSource = buildMetadata({ points: [] });
  assert.equal(withoutSource.sourceFileName, null);
});

test("persisted-store normalization degrades safely instead of crashing on bad input", () => {
  assert.deepEqual(normalizePersistedStore(null), emptyPersistedStore());
  assert.deepEqual(normalizePersistedStore(undefined), emptyPersistedStore());
  assert.deepEqual(normalizePersistedStore("not an object"), emptyPersistedStore());
  assert.deepEqual(normalizePersistedStore({ fields: "not an array" }).fields, []);

  const valid = {
    fields: [{ id: "paddy-001" }], boundaryTracks: [], waterControlPoints: [],
    surveySessions: [], fieldObservations: []
  };
  const normalized = normalizePersistedStore(valid);
  assert.equal(normalized.fields.length, 1);
  assert.equal(normalized.schemaVersion, SCHEMA_VERSION);
});

test("normalizePersistedStore defaults fieldObservations to [] for older/malformed data (schema migration)", () => {
  const legacyV2 = { fields: [], boundaryTracks: [], waterControlPoints: [], surveySessions: [] };
  assert.deepEqual(normalizePersistedStore(legacyV2).fieldObservations, []);
  assert.deepEqual(normalizePersistedStore({ fieldObservations: "not an array" }).fieldObservations, []);
});

test("buildFieldObservation matches the requested schema (id/fieldId/type/label/name/geometryType/coordinates/properties)", () => {
  const obs = buildFieldObservation({
    id: "obs-001",
    fieldId: "paddy-001",
    type: "weed",
    name: "圃場1 雑草地点1",
    severity: "medium",
    memo: "畦道側に雑草が多い",
    lat: 34.6438,
    lon: 135.7620,
    sourceType: "manual_map_click",
    nowIso: "2026-07-20T10:00:00+09:00"
  });
  assert.equal(obs.id, "obs-001");
  assert.equal(obs.fieldId, "paddy-001");
  assert.equal(obs.type, "weed");
  assert.equal(obs.label, "雑草");
  assert.equal(obs.name, "圃場1 雑草地点1");
  assert.equal(obs.geometryType, "Point");
  assert.deepEqual(obs.coordinates, [34.6438, 135.762]);
  assert.equal(obs.properties.severity, "medium");
  assert.equal(obs.properties.memo, "畦道側に雑草が多い");
  assert.equal(obs.properties.sourceType, "manual_map_click");
  assert.equal(obs.properties.createdAt, "2026-07-20T10:00:00+09:00");
  assert.equal(obs.properties.updatedAt, "2026-07-20T10:00:00+09:00");
});

test("all nine observation types and four severities are exactly the requested Japanese labels", () => {
  assert.deepEqual(Object.keys(OBSERVATION_TYPE_LABELS), [
    "weed", "insect", "disease", "water_shortage", "excess_water",
    "lodging", "soil_problem", "gate_problem", "note"
  ]);
  assert.equal(OBSERVATION_TYPE_LABELS.weed, "雑草");
  assert.equal(OBSERVATION_TYPE_LABELS.insect, "害虫");
  assert.equal(OBSERVATION_TYPE_LABELS.disease, "病気");
  assert.equal(OBSERVATION_TYPE_LABELS.water_shortage, "水不足");
  assert.equal(OBSERVATION_TYPE_LABELS.excess_water, "水が多すぎる");
  assert.equal(OBSERVATION_TYPE_LABELS.lodging, "倒伏");
  assert.equal(OBSERVATION_TYPE_LABELS.soil_problem, "土壌・泥の問題");
  assert.equal(OBSERVATION_TYPE_LABELS.gate_problem, "水門異常");
  assert.equal(OBSERVATION_TYPE_LABELS.note, "その他メモ");
  assert.deepEqual(SEVERITY_LABELS, { low: "低", medium: "中", high: "高", urgent: "緊急" });
});

test("normalizeObservationType/normalizeSeverity fall back safely instead of inventing values", () => {
  assert.equal(isObservationType("weed"), true);
  assert.equal(isObservationType("bogus"), false);
  assert.equal(normalizeObservationType("bogus"), "note");
  assert.equal(normalizeObservationType("disease"), "disease");
  assert.equal(normalizeSeverity("urgent"), "urgent");
  assert.equal(normalizeSeverity("bogus"), "medium");
  assert.equal(normalizeSeverity(undefined), "medium");

  const fallback = buildFieldObservation({ id: "obs-x", type: "bogus", severity: "bogus", lat: 34, lon: 135 });
  assert.equal(fallback.type, "note");
  assert.equal(fallback.label, "その他メモ");
  assert.equal(fallback.properties.severity, "medium");
});

test("nextObservationName sequences per field+type, matching the requested '圃場1 雑草地点1' shape", () => {
  assert.equal(nextObservationName("圃場1", "weed", 0), "圃場1 雑草地点1");
  assert.equal(nextObservationName("圃場1", "weed", 1), "圃場1 雑草地点2");
  assert.equal(nextObservationName("圃場1", "insect", 0), "圃場1 害虫地点1");
});
