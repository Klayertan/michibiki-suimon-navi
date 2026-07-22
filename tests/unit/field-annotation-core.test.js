import test from "node:test";
import assert from "node:assert/strict";
import {
  CLOSE_WARNING_MESSAGE,
  DEFAULT_AUTO_CLOSE_THRESHOLD_M,
  FEATURE_TYPE_LABELS,
  MAX_RAW_NMEA_STORAGE_BYTES,
  MEASUREMENT_TYPE_LABELS,
  NEEDS_EXPORT_DATA_MESSAGE,
  NEEDS_FIELD_MESSAGE,
  OBSERVATION_SOURCE_LABELS,
  OBSERVATION_TYPE_LABELS,
  OUTSIDE_FIELD_WARNING_MESSAGE,
  RAW_NMEA_SIZE_WARNING,
  SCHEMA_VERSION,
  SEVERITY_LABELS,
  UPLOAD_CLOSE_WARNING_MESSAGE,
  WATER_CONTROL_EXPORT_TYPES,
  WORKFLOW_STEPS,
  buildBoundaryTrack,
  buildField,
  buildFieldObservation,
  buildMetadata,
  buildSurveySession,
  buildWaterControlPoint,
  computeWorkflowStatus,
  countNmeaLines,
  decideRawNmeaStorage,
  distanceMeters,
  emptyPersistedStore,
  evaluateClosure,
  isObservationType,
  isPointInsideBoundary,
  isWaterControlType,
  makeSurveySessionId,
  nextBoundaryTrackId,
  nextFieldDefaults,
  nextObservationName,
  nextWaterControlName,
  normalizeObservationType,
  normalizePersistedStore,
  normalizeSeverity,
  normalizeWaterControlType,
  observationSourceLabel,
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
  assert.equal(session.rawNmeaText, null, "no rawNmeaText was ever provided for this session");
  assert.equal(session.rawNmeaStored, false);
  assert.equal(session.rawNmeaStorageReason, null, "not a size_limit refusal, simply never provided");
  assert.equal(session.rawNmeaLineCount, 0);
  assert.equal(session.uploadedAt, null);

  const invalidType = buildSurveySession({ id: "survey-x", name: "x", rawPoints: [], measurementType: "not-real" });
  assert.equal(invalidType.measurementType, "field_polygon", "invalid measurementType falls back, never invented");
  assert.deepEqual(Object.keys(MEASUREMENT_TYPE_LABELS), ["field_polygon", "boundary_track", "water_points"]);
});

test("decideRawNmeaStorage keeps small NMEA text and drops text over the byte cap, but always reports the line count", () => {
  const small = "$GNGGA,1\n$GNGGA,2\n$GNGGA,3\n";
  const smallResult = decideRawNmeaStorage(small, 1000);
  assert.equal(smallResult.stored, true);
  assert.equal(smallResult.text, small);
  assert.equal(smallResult.lineCount, 3);
  assert.equal(smallResult.reason, null);

  const large = "$GNGGA,1\n".repeat(200);
  const largeResult = decideRawNmeaStorage(large, 100);
  assert.equal(largeResult.stored, false);
  assert.equal(largeResult.text, null, "oversized text is dropped, not truncated silently");
  assert.equal(largeResult.lineCount, 200, "line count is still reported even when the text itself is dropped");
  assert.equal(largeResult.reason, "size_limit");

  const missing = decideRawNmeaStorage(null, 1000);
  assert.equal(missing.stored, false);
  assert.equal(missing.lineCount, 0);
  assert.equal(missing.reason, null, "no text at all is not a size_limit refusal");

  assert.equal(MAX_RAW_NMEA_STORAGE_BYTES, 2_000_000);
  assert.equal(RAW_NMEA_SIZE_WARNING, "NMEAログが大きいため、元ファイル全文は保存せず、解析済みデータのみ保存しました。");
});

test("countNmeaLines counts non-empty lines across \\n, \\r\\n and \\r line endings", () => {
  assert.equal(countNmeaLines(""), 0);
  assert.equal(countNmeaLines(null), 0);
  assert.equal(countNmeaLines("a\nb\nc"), 3);
  assert.equal(countNmeaLines("a\r\nb\r\nc\r\n"), 3);
  assert.equal(countNmeaLines("a\n\nb"), 2, "blank lines are not counted");
});

test("buildSurveySession stores small rawNmeaText and refuses+warns on oversized text, preserving uploadedAt only when text was given", () => {
  const smallText = "$GNGGA,120000.00,3439.2880,N,13549.7892,E,1,8,1.1,45.0,M,30.0,M,,*7A\n";
  const stored = buildSurveySession({
    id: "survey-small", name: "圃場1 測量", fieldId: "paddy-001", sourceFileName: "walk.txt",
    rawPoints: [{ lat: 34, lon: 135 }], measurementType: "field_polygon",
    rawNmeaText: smallText, uploadedAt: "2026-07-20T10:00:00+09:00", nowIso: "2026-07-20T10:00:00+09:00"
  });
  assert.equal(stored.rawNmeaText, smallText);
  assert.equal(stored.rawNmeaStored, true);
  assert.equal(stored.rawNmeaStorageReason, null);
  assert.equal(stored.rawNmeaLineCount, 1);
  assert.equal(stored.uploadedAt, "2026-07-20T10:00:00+09:00");

  const oversizedText = "$GNGGA,test line padding for size*00\n".repeat(60_000); // well over MAX_RAW_NMEA_STORAGE_BYTES
  const refused = buildSurveySession({
    id: "survey-large", name: "圃場2 測量", fieldId: "paddy-002", sourceFileName: "big.txt",
    rawPoints: [], measurementType: "field_polygon",
    rawNmeaText: oversizedText, uploadedAt: "2026-07-20T10:05:00+09:00"
  });
  assert.equal(refused.rawNmeaText, null);
  assert.equal(refused.rawNmeaStored, false);
  assert.equal(refused.rawNmeaStorageReason, "size_limit");
  assert.equal(refused.rawNmeaLineCount, 60_000);
  assert.equal(refused.uploadedAt, "2026-07-20T10:05:00+09:00", "uploadedAt is preserved even when the text itself is refused");
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

test("observationSourceLabel always reads as manual, never drone/AI/automatic, even for an unknown sourceType", () => {
  assert.equal(observationSourceLabel("manual_map_click"), "手動配置（地図クリック）");
  assert.equal(observationSourceLabel("qz1_current_position"), "手動配置（QZ1現在地）");
  assert.equal(observationSourceLabel("phone_gps"), "手動配置（スマホGPS）");
  assert.equal(observationSourceLabel("bogus"), "手動配置");
  assert.equal(observationSourceLabel(undefined), "手動配置");
  Object.values(OBSERVATION_SOURCE_LABELS).forEach((label) => {
    assert.match(label, /^手動配置/);
  });
});

test("isPointInsideBoundary correctly classifies points inside/outside a closed square, and never blocks an open/degenerate boundary", () => {
  assert.equal(isPointInsideBoundary([34.65460, 135.83000], SQUARE), true);
  assert.equal(isPointInsideBoundary([34.70000, 135.90000], SQUARE), false);
  assert.equal(OUTSIDE_FIELD_WARNING_MESSAGE, "選択した地点は圃場の範囲外です。このまま記録しますか？");
  // A boundary-track-only registration (no closed polygon) must never block
  // placement — "preferably" inside the field, not a hard gate.
  assert.equal(isPointInsideBoundary([0, 0], []), true);
  assert.equal(isPointInsideBoundary([0, 0], [[34.6548, 135.8298], [34.6544, 135.8303]]), true);
});

test("nextObservationName sequences per field+type, matching the requested '圃場1 雑草地点1' shape", () => {
  assert.equal(nextObservationName("圃場1", "weed", 0), "圃場1 雑草地点1");
  assert.equal(nextObservationName("圃場1", "weed", 1), "圃場1 雑草地点2");
  assert.equal(nextObservationName("圃場1", "insect", 0), "圃場1 害虫地点1");
});

test("nextWaterControlName sequences per field+type, matching the requested '圃場1 水門1' shape (no '地点' word)", () => {
  assert.equal(nextWaterControlName("圃場1", "gate", 0), "圃場1 水門1");
  assert.equal(nextWaterControlName("圃場1", "gate", 1), "圃場1 水門2");
  assert.equal(nextWaterControlName("圃場1", "inlet", 0), "圃場1 給水口1");
  assert.equal(nextWaterControlName("圃場1", "outlet", 0), "圃場1 排水口1");
});

test("computeWorkflowStatus reports 0/5 with step 1 as the next task on a fully empty state", () => {
  const status = computeWorkflowStatus();
  assert.equal(status.completedCount, 0);
  assert.equal(status.totalSteps, 5);
  assert.equal(status.isComplete, false);
  assert.equal(status.nextStepId, 1);
  assert.equal(status.progressLabel, "進捗: 0 / 5 完了");
  assert.equal(status.nextTaskLine, "次の作業: NMEAログをアップロードしてください。");
  assert.deepEqual(status.steps.map((step) => step.done), [false, false, false, false, false]);
  assert.equal(status.steps.length, WORKFLOW_STEPS.length);
});

test("computeWorkflowStatus marks steps 1-2 done from survey/field data and points to step 3 next", () => {
  const status = computeWorkflowStatus({ surveySessionCount: 1, fieldCount: 1 });
  assert.equal(status.completedCount, 2);
  assert.deepEqual(status.steps.map((step) => step.done), [true, true, false, false, false]);
  assert.equal(status.nextStepId, 3);
  assert.equal(status.nextTaskLine, "次の作業: 水門・給水口・排水口を登録してください。");
});

test("computeWorkflowStatus treats measurementCount and boundaryTrackCount as alternate satisfiers for steps 1-2", () => {
  const viaMeasurements = computeWorkflowStatus({ measurementCount: 3 });
  assert.equal(viaMeasurements.steps[0].done, true, "step 1 can be satisfied by parsed points alone, without a saved session");

  const viaTrack = computeWorkflowStatus({ boundaryTrackCount: 1 });
  assert.equal(viaTrack.steps[1].done, true, "step 2 can be satisfied by a boundary track alone, without a field polygon");
});

test("computeWorkflowStatus advances the next task through steps 3, 4 and 5 in order", () => {
  const afterWater = computeWorkflowStatus({ surveySessionCount: 1, fieldCount: 1, waterControlPointCount: 1 });
  assert.equal(afterWater.completedCount, 3);
  assert.equal(afterWater.nextStepId, 4);
  assert.equal(afterWater.nextTaskLine, "次の作業: 雑草・害虫・病気などの観察メモを記録してください。");

  const afterObservation = computeWorkflowStatus({
    surveySessionCount: 1, fieldCount: 1, waterControlPointCount: 1, fieldObservationCount: 1
  });
  assert.equal(afterObservation.completedCount, 4);
  assert.equal(afterObservation.nextStepId, 5);
  assert.equal(afterObservation.nextTaskLine, "次の作業: 測量JSONを書き出してください。");
});

test("computeWorkflowStatus reports 5/5 complete only once lastExportedAt is set, with no next task", () => {
  const status = computeWorkflowStatus({
    surveySessionCount: 1, fieldCount: 1, waterControlPointCount: 1, fieldObservationCount: 1,
    lastExportedAt: "2026-07-20T10:00:00+09:00"
  });
  assert.equal(status.completedCount, 5);
  assert.equal(status.isComplete, true);
  assert.equal(status.nextStepId, null);
  assert.equal(status.progressLabel, "進捗: 5 / 5 完了");
  assert.equal(status.nextTaskLine, "現地調査ワークフローは完了しています。");
});

test("WORKFLOW_STEPS carries the exact Japanese titles/descriptions/action labels, and the disabled-state messages are exact", () => {
  assert.deepEqual(WORKFLOW_STEPS.map((step) => step.title), [
    "NMEAログをアップロード", "圃場として登録", "水門・給水口・排水口を登録", "雑草・害虫・病気などを記録", "JSONを書き出し"
  ]);
  assert.deepEqual(WORKFLOW_STEPS.map((step) => step.description), [
    "QZ1/NMEAログを読み込み、測位点を確認します。",
    "測位点を圃場ポリゴンまたは境界トラックとして登録します。",
    "水門・給水口・排水口・水位センサ位置を地図上に登録します。",
    "地図をクリックして、雑草・害虫・病気・水不足などの観察位置と内容を手動で登録します。ドローンを使用しないデモにも対応しています。",
    "圃場・測量ログ・水管理ポイント・観察メモをJSONとして保存します。"
  ]);
  assert.deepEqual(WORKFLOW_STEPS.map((step) => step.actionLabel), [
    "NMEAをアップロード", "登録済み圃場を確認", "水管理ポイントを追加", "地図上に観察メモを追加", "測量JSONを書き出し"
  ]);
  assert.equal(NEEDS_FIELD_MESSAGE, "先に圃場を登録してください。");
  assert.equal(NEEDS_EXPORT_DATA_MESSAGE, "書き出す圃場データがありません。");
});

test("emptyPersistedStore and normalizePersistedStore carry workflowState.lastExportedAt, falling back to metadata.workflowLastExportedAt on import", () => {
  assert.equal(emptyPersistedStore().workflowState.lastExportedAt, null);

  const fromLocalStorageShape = normalizePersistedStore({ workflowState: { lastExportedAt: "2026-07-20T01:00:00.000Z" } });
  assert.equal(fromLocalStorageShape.workflowState.lastExportedAt, "2026-07-20T01:00:00.000Z");

  // An exported project JSON has no top-level workflowState — the info lives in metadata instead.
  const fromExportShape = normalizePersistedStore({ metadata: { workflowLastExportedAt: "2026-07-20T02:00:00.000Z" } });
  assert.equal(fromExportShape.workflowState.lastExportedAt, "2026-07-20T02:00:00.000Z");

  const fromNothing = normalizePersistedStore({ fields: [] });
  assert.equal(fromNothing.workflowState.lastExportedAt, null);
});
