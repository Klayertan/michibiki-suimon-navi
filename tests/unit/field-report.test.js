import test from "node:test";
import assert from "node:assert/strict";
import {
  buildField, buildBoundaryTrack, buildSurveySession, buildWaterControlPoint, buildFieldObservation
} from "../../js/fields/field-annotation-core.js";
import {
  buildFieldReport, buildReportHtml, buildReportMarkdown, listReportableFields, rawNmeaStatusLabel, REPORT_STATUS_LABELS
} from "../../js/reports/field-report.js";

const CLOSED_SQUARE = [[35, 135], [35, 135.0004], [35.0004, 135.0004], [35.0004, 135]];

function polygonPoints(count, { augmentedFraction = 0.6 } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    lat: 35 + (index % 4) * 0.0001,
    lon: 135 + Math.floor(index / 4) * 0.0001,
    fixQuality: index < Math.round(count * augmentedFraction) ? 2 : 1,
    satellites: 9,
    hdop: 0.9,
    augmented: index < Math.round(count * augmentedFraction)
  }));
}

function polygonField({ id = "paddy-001", closedManually = false } = {}) {
  return buildField({
    id, name: "圃場1", coordinates: CLOSED_SQUARE, sourceSessionId: "session-1",
    sourceFileName: "walk.txt", closedManually, fixQualitySummary: null,
    nowIso: "2026-07-20T01:00:00.000Z"
  });
}

function survey({ id = "session-1", fieldId = "paddy-001", pointCount = 6, rawNmeaStored = true } = {}) {
  return buildSurveySession({
    id, name: "圃場1 測量", fieldId, sourceFileName: "walk.txt",
    rawPoints: polygonPoints(pointCount), measurementType: "field_polygon",
    rawNmeaText: rawNmeaStored ? "$GNGGA,dummy\n".repeat(5) : null,
    uploadedAt: "2026-07-20T01:00:00.000Z"
  });
}

test("listReportableFields includes registered polygon fields and boundary-track-only fieldIds, deduped, with the 下見測定 suffix stripped", () => {
  const fields = [polygonField({ id: "paddy-001" })];
  const boundaryTracks = [
    buildBoundaryTrack({ id: "track-1", name: "圃場1 下見測定", fieldId: "paddy-001", coordinates: CLOSED_SQUARE }),
    buildBoundaryTrack({ id: "track-2", name: "圃場2 下見測定", fieldId: "paddy-002", coordinates: CLOSED_SQUARE })
  ];
  const entries = listReportableFields({ fields, boundaryTracks });
  assert.deepEqual(entries.map((entry) => entry.fieldId), ["paddy-001", "paddy-002"]);
  assert.equal(entries[0].fieldName, "圃場1", "paddy-001 has a real fields[] entry, so its name comes from there");
  assert.equal(entries[1].fieldName, "圃場2", "paddy-002 only has a boundary track — the suffix is stripped to recover the plain field name");
  assert.equal(entries[1].kind, "boundary_track");
});

test("buildFieldReport for a registered polygon field includes basicInfo, surveyLog and a non-blank QZ1-only reliability fallback", () => {
  const report = buildFieldReport({
    fieldId: "paddy-001",
    fields: [polygonField()],
    boundaryTracks: [],
    surveySessions: [survey({ pointCount: 8, rawNmeaStored: true })],
    waterControlPoints: [],
    fieldObservations: [],
    generatedAt: "2026-07-20T02:00:00.000Z"
  });

  assert.equal(report.fieldId, "paddy-001");
  assert.equal(report.fieldName, "圃場1");
  assert.equal(report.basicInfo.dataKind, "実測");
  assert.equal(report.basicInfo.measurementTypeLabel, "圃場ポリゴン");
  assert.equal(report.basicInfo.createdAt, "2026-07-20T01:00:00.000Z");

  assert.equal(report.surveyLog.found, true);
  assert.equal(report.surveyLog.sourceFileName, "walk.txt");
  assert.equal(report.surveyLog.rawNmeaStored, true);
  assert.equal(report.surveyLog.totalPoints, 8);
  assert.equal(report.surveyLog.gpsOnlyCount + report.surveyLog.dgpsCount, 8);

  // Never blank when rawPoints exist — a real classification and reasons are always produced.
  assert.ok(Object.values(REPORT_STATUS_LABELS).includes(report.reliabilityCheck.label));
  assert.equal(report.reliabilityCheck.source, "qz1_only_fallback");
  assert.ok(report.reliabilityCheck.reasons.length > 0);
  assert.equal(report.summary.overallLabel, report.reliabilityCheck.label);
});

test("buildFieldReport identifies a Polygon vs a boundary-track-only field, and reports the exact 境界トラック note", () => {
  const polygonReport = buildFieldReport({
    fieldId: "paddy-001", fields: [polygonField()], boundaryTracks: [], surveySessions: [survey()],
    waterControlPoints: [], fieldObservations: []
  });
  assert.equal(polygonReport.geometry.geometryType, "Polygon");
  assert.equal(polygonReport.geometry.isBoundaryTrackOnly, false);
  assert.ok(Number.isFinite(polygonReport.geometry.areaM2));

  const trackOnlyReport = buildFieldReport({
    fieldId: "paddy-002", fields: [],
    boundaryTracks: [buildBoundaryTrack({ id: "track-1", name: "圃場2 下見測定", fieldId: "paddy-002", coordinates: CLOSED_SQUARE, sourceSessionId: "session-2" })],
    surveySessions: [survey({ id: "session-2", fieldId: "paddy-002" })],
    waterControlPoints: [], fieldObservations: []
  });
  assert.equal(trackOnlyReport.geometry.geometryType, "LineString");
  assert.equal(trackOnlyReport.geometry.isBoundaryTrackOnly, true);
  assert.equal(trackOnlyReport.geometry.areaM2, null);
  assert.equal(trackOnlyReport.basicInfo.dataKind, "境界トラック");
  assert.ok(trackOnlyReport.summary.keyReasons.includes("境界トラックであり、圃場面積は未確定です。"));
});

test("buildFieldReport flags a force-closed polygon with the exact 仮のポリゴン wording", () => {
  const report = buildFieldReport({
    fieldId: "paddy-001", fields: [polygonField({ closedManually: true })], boundaryTracks: [],
    surveySessions: [survey()], waterControlPoints: [], fieldObservations: []
  });
  assert.equal(report.basicInfo.dataKind, "仮登録");
  assert.equal(report.geometry.isForceClosed, true);
  assert.ok(report.summary.keyReasons.includes("始点と終点を接続した仮のポリゴンです。"));
});

test("buildFieldReport shows the exact 関連する測量ログが見つかりません message when no survey session exists", () => {
  const report = buildFieldReport({
    fieldId: "paddy-001", fields: [polygonField()], boundaryTracks: [], surveySessions: [],
    waterControlPoints: [], fieldObservations: []
  });
  assert.equal(report.surveyLog.found, false);
  assert.equal(report.surveyLog.message, "関連する測量ログが見つかりません。");
  assert.equal(report.reliabilityCheck.source, "none");
  assert.equal(report.reliabilityCheck.reasons[0], "測量チェックはまだ実行されていません。");
});

test("buildFieldReport lists linked water-control points and field observations, and ignores records for other fields", () => {
  const waterControlPoints = [
    buildWaterControlPoint({ id: "wcp-1", name: "水門1", type: "gate", lat: 35, lon: 135, relatedFieldId: "paddy-001" }),
    buildWaterControlPoint({ id: "wcp-2", name: "他圃場の水門", type: "gate", lat: 35, lon: 135, relatedFieldId: "paddy-999" })
  ];
  const fieldObservations = [
    buildFieldObservation({ id: "obs-1", fieldId: "paddy-001", type: "weed", name: "雑草1", severity: "high", lat: 35, lon: 135 }),
    buildFieldObservation({ id: "obs-2", fieldId: "paddy-001", type: "insect", name: "害虫1", severity: "urgent", lat: 35, lon: 135 }),
    buildFieldObservation({ id: "obs-3", fieldId: "paddy-999", type: "weed", name: "他圃場の観察", severity: "low", lat: 35, lon: 135 })
  ];
  const report = buildFieldReport({
    fieldId: "paddy-001", fields: [polygonField()], boundaryTracks: [], surveySessions: [survey()],
    waterControlPoints, fieldObservations
  });

  assert.equal(report.waterControlPoints.length, 1);
  assert.equal(report.waterControlPoints[0].typeLabel, "水門");
  assert.equal(report.observations.length, 2);
  assert.equal(report.observationSummary.total, 2);
  assert.equal(report.observationSummary.byType.weed, 1);
  assert.equal(report.observationSummary.byType.insect, 1);
  assert.equal(report.observationSummary.bySeverity.urgent, 1);
});

test("buildFieldReport recommendations: missing water points and observations", () => {
  const report = buildFieldReport({
    fieldId: "paddy-001", fields: [polygonField()], boundaryTracks: [], surveySessions: [survey({ augmentedFraction: 0.6 })],
    waterControlPoints: [], fieldObservations: []
  });
  assert.ok(report.recommendations.includes("給水口・排水口・水門を登録してください。"));
  assert.ok(report.recommendations.includes("雑草・害虫・病気・水不足などの現地観察メモを記録してください。"));
});

test("buildFieldReport recommendations: zero DGPS fix triggers the exact re-measure-in-the-open wording", () => {
  const noDgpsSurvey = buildSurveySession({
    id: "session-1", name: "圃場1 測量", fieldId: "paddy-001", sourceFileName: "walk.txt",
    rawPoints: polygonPoints(6, { augmentedFraction: 0 }), measurementType: "field_polygon"
  });
  const report = buildFieldReport({
    fieldId: "paddy-001", fields: [polygonField()], boundaryTracks: [], surveySessions: [noDgpsSurvey],
    waterControlPoints: [buildWaterControlPoint({ id: "wcp-1", type: "gate", lat: 35, lon: 135, relatedFieldId: "paddy-001" })],
    fieldObservations: [buildFieldObservation({ id: "obs-1", fieldId: "paddy-001", type: "weed", lat: 35, lon: 135 })]
  });
  assert.equal(report.surveyLog.dgpsCount, 0);
  assert.ok(report.recommendations.includes("補強測位が得られていないため、測量結果は要確認です。開けた場所で再測量してください。"));
});

test("buildFieldReport recommendations: an open boundary track triggers the exact walk-the-loop wording", () => {
  const openTrack = buildBoundaryTrack({
    id: "track-1", name: "圃場2 下見測定", fieldId: "paddy-002",
    coordinates: [[35, 135], [35, 135.001], [35.0005, 135.0015]], // start/end ~70m apart
    sourceSessionId: "session-2"
  });
  const report = buildFieldReport({
    fieldId: "paddy-002", fields: [], boundaryTracks: [openTrack],
    surveySessions: [survey({ id: "session-2", fieldId: "paddy-002" })],
    waterControlPoints: [buildWaterControlPoint({ id: "wcp-1", type: "gate", lat: 35, lon: 135, relatedFieldId: "paddy-002" })],
    fieldObservations: [buildFieldObservation({ id: "obs-1", fieldId: "paddy-002", type: "weed", lat: 35, lon: 135 })]
  });
  assert.equal(report.geometry.closed, false);
  assert.ok(report.recommendations.includes("圃場の外周を一周し、開始点付近まで戻って記録してください。"));
});

test("buildFieldReport recommendations fall back to the exact all-good message when nothing else triggers", () => {
  const report = buildFieldReport({
    fieldId: "paddy-001", fields: [polygonField()], boundaryTracks: [], surveySessions: [survey({ augmentedFraction: 0.6 })],
    waterControlPoints: [buildWaterControlPoint({ id: "wcp-1", type: "gate", lat: 35, lon: 135, relatedFieldId: "paddy-001" })],
    fieldObservations: [buildFieldObservation({ id: "obs-1", fieldId: "paddy-001", type: "weed", lat: 35, lon: 135 })]
  });
  assert.deepEqual(report.recommendations, ["この圃場データは基本的な現地調査として利用できます。"]);
});

test("rawNmeaStatusLabel mirrors the three field-annotation states", () => {
  assert.equal(rawNmeaStatusLabel({ found: false }), "—");
  assert.equal(rawNmeaStatusLabel({ found: true, rawNmeaStored: true }), "保存済み");
  assert.equal(rawNmeaStatusLabel({ found: true, rawNmeaStored: false, rawNmeaStorageReason: "size_limit" }), "未保存（サイズ超過）");
  assert.equal(rawNmeaStatusLabel({ found: true, rawNmeaStored: false, rawNmeaStorageReason: null }), "—");
});

test("buildReportHtml and buildReportMarkdown escape/embed user-provided memo text and include all required sections", () => {
  const report = buildFieldReport({
    fieldId: "paddy-001", fields: [polygonField()], boundaryTracks: [], surveySessions: [survey()],
    waterControlPoints: [buildWaterControlPoint({ id: "wcp-1", name: "水門A", type: "gate", lat: 35, lon: 135, relatedFieldId: "paddy-001", memo: "<script>alert(1)</script>" })],
    fieldObservations: [buildFieldObservation({ id: "obs-1", fieldId: "paddy-001", type: "weed", name: "雑草1", lat: 35, lon: 135, memo: "A & B" })]
  });

  const html = buildReportHtml(report);
  assert.ok(html.includes("<title>圃場レポート: 圃場1</title>"));
  assert.ok(html.includes("基本情報") && html.includes("QZ1測量ログ") && html.includes("測量チェック結果"));
  assert.ok(html.includes("水管理ポイント") && html.includes("現地観察メモ") && html.includes("次にやること"));
  assert.ok(!html.includes("<script>alert(1)</script>"), "raw memo HTML must be escaped, not embedded verbatim");
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("A &amp; B"));
  assert.ok(!html.includes("unpkg.com") && !html.includes("cdn."), "exported HTML must not reference an external CDN");

  const markdown = buildReportMarkdown(report);
  assert.ok(markdown.startsWith("# 圃場レポート: 圃場1"));
  assert.ok(markdown.includes("## 基本情報") && markdown.includes("## 次にやること"));
});
