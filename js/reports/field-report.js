// 圃場レポート: pure logic (no DOM). Assembles a single farmer/hackathon-
// readable report for one registered field from the same persisted records
// field-annotation-controller.js already owns (fields / boundaryTracks /
// surveySessions / waterControlPoints / fieldObservations) — this module
// never stores its own copy of that data, it only reads and summarizes it.
//
// A field is reportable even when it only exists as a boundary track (no
// closed polygon yet) — this was the very first real registration shape
// this project used (an open L-shaped walk saved as "境界トラックとして登録"),
// so the report must never assume a `fields[]` entry exists.
import {
  MEASUREMENT_TYPE_LABELS, OBSERVATION_TYPE_LABELS, SEVERITY_LABELS, WATER_CONTROL_TYPE_LABELS,
  normalizeObservationType, normalizeSeverity, observationSourceLabel, waterControlInternalType
} from "../fields/field-annotation-core.js";
import { calculateQz1OnlyCheck, RESULT_STATUS_LABELS } from "../assurance/assurance-engine.js";

export const REPORT_STATUS_LABELS = {
  usable: "使用可能",
  needs_check: "要確認",
  remeasure_recommended: "再測量推奨",
  insufficient_evidence: "証拠不足"
};

// Maps the shared assurance vocabulary (green/yellow/red/grey/simulated)
// onto the report's own status keys — kept as a separate small vocabulary
// per the spec rather than reusing color words, since a report is read by
// people (teachers, judges) who never saw the 測量チェック legend.
const STATUS_FROM_CLASSIFICATION = {
  green: "usable", yellow: "needs_check", red: "remeasure_recommended", grey: "insufficient_evidence", simulated: "insufficient_evidence"
};

const COMPACT_MEASUREMENT_TYPE_LABELS = {
  field_polygon: "圃場ポリゴン",
  boundary_track: "境界トラック",
  water_points: "水門・給水口・排水口ポイント"
};

const NO_SURVEY_LOG_MESSAGE = "関連する測量ログが見つかりません。";
const NO_RELIABILITY_MESSAGE = "測量チェックはまだ実行されていません。";
const NO_WATER_POINTS_MESSAGE = "水管理ポイントはまだ登録されていません。";
const NO_OBSERVATIONS_MESSAGE = "現地観察メモはまだ登録されていません。";
const CLOSURE_GAP_THRESHOLD_M = 10; // matches field-registry.js's validateBoundary()

/**
 * Every fieldId the report panel can generate a report for — the union of
 * registered polygon fields and boundary-track-only fieldIds, deduped and
 * sorted with polygons first (they carry a real name; see
 * resolveFieldIdentity for why track-only names need extra care).
 */
export function listReportableFields({ fields = [], boundaryTracks = [] } = {}) {
  const seen = new Set();
  const entries = [];
  fields.forEach((field) => {
    if (seen.has(field.id)) return;
    seen.add(field.id);
    entries.push({ fieldId: field.id, fieldName: field.name, kind: "field" });
  });
  boundaryTracks.forEach((track) => {
    if (!track.fieldId || seen.has(track.fieldId)) return;
    seen.add(track.fieldId);
    entries.push({ fieldId: track.fieldId, fieldName: deriveTrackOnlyFieldName(track), kind: "boundary_track" });
  });
  return entries;
}

/**
 * boundaryTracks don't store a plain "圃場名" — only a derived name like
 * "圃場1 下見測定" (see field-annotation-controller.js's registerBoundaryTrack,
 * which always appends this exact suffix). Stripping it back off is the only
 * way to recover the field's display name when no polygon was ever
 * registered under the same fieldId.
 */
function deriveTrackOnlyFieldName(track) {
  const suffix = " 下見測定";
  if (track.name?.endsWith(suffix)) return track.name.slice(0, -suffix.length);
  return track.name || track.fieldId;
}

function resolveFieldIdentity(fieldId, fields, boundaryTracks) {
  const field = fields.find((candidate) => candidate.id === fieldId) || null;
  const track = boundaryTracks.find((candidate) => candidate.fieldId === fieldId) || null;
  const fieldName = field?.name || (track ? deriveTrackOnlyFieldName(track) : fieldId);
  return { field, track, fieldName };
}

/** The one survey session a field's basic info/QZ1 log section is built from — prefers the polygon's session, then the track's, then any session naming this field. */
function resolvePrimarySurveySession(fieldId, field, track, surveySessions) {
  const bySourceId = field?.sourceSessionId || track?.sourceSessionId;
  if (bySourceId) {
    const bySource = surveySessions.find((session) => session.id === bySourceId);
    if (bySource) return bySource;
  }
  return surveySessions.find((session) => session.fieldId === fieldId) || null;
}

/** Adapts field-annotation rawPoints (already fix-valid-only by construction) into the observation shape calculateQz1OnlyCheck expects. */
function toQz1Observations(rawPoints) {
  return (rawPoints || []).map((point, index) => ({
    id: `pt-${index}`,
    sequence: index,
    lat: Number(point.lat),
    lon: Number(point.lon),
    fixQuality: Number(point.fixQuality),
    fixValid: Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lon)),
    satellites: Number.isFinite(Number(point.satellites)) ? Number(point.satellites) : null,
    hdop: Number.isFinite(Number(point.hdop)) ? Number(point.hdop) : null,
    augmentation: { status: point.augmented ? "active" : "inactive", service: null, evidence: [] },
    qzss: { visibleCount: null, satellites: [], usedInFix: null }
  }));
}

function distanceMeters(a, b) {
  const meanLat = (a[0] + b[0]) / 2 * Math.PI / 180;
  const dx = (b[1] - a[1]) * 111320 * Math.cos(meanLat);
  const dy = (b[0] - a[0]) * 111320;
  return Math.hypot(dx, dy);
}

function perimeterMeters(coordinates, closedLoop) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return 0;
  let total = 0;
  for (let index = 1; index < coordinates.length; index += 1) total += distanceMeters(coordinates[index - 1], coordinates[index]);
  if (closedLoop) total += distanceMeters(coordinates[coordinates.length - 1], coordinates[0]);
  return total;
}

function buildBasicInfo({ field, track, fieldId, fieldName, primarySession }) {
  const measurementType = primarySession?.measurementType || (field ? "field_polygon" : track ? "boundary_track" : null);
  const dataKind = field
    ? (field.properties.closedManually ? "仮登録" : "実測")
    : (track ? "境界トラック" : "不明");
  const properties = field?.properties || track?.properties || {};
  return {
    fieldName,
    fieldId,
    createdAt: properties.createdAt || null,
    updatedAt: properties.updatedAt || null,
    measurementType,
    measurementTypeLabel: measurementType ? COMPACT_MEASUREMENT_TYPE_LABELS[measurementType] || MEASUREMENT_TYPE_LABELS[measurementType] : null,
    dataKind
  };
}

function buildSurveyLog(primarySession) {
  if (!primarySession) {
    return { found: false, message: NO_SURVEY_LOG_MESSAGE };
  }
  const points = primarySession.rawPoints || [];
  const validCount = points.length; // rawPoints are fix-valid-only by construction (see parseNmea in index.html)
  const gpsOnlyCount = points.filter((point) => Number(point.fixQuality) === 1).length;
  const dgpsCount = points.filter((point) => point.augmented).length;
  const qzssUsedCount = 0; // the simple QZ1測量 parser never records QZSS-in-fix evidence
  return {
    found: true,
    sourceFileName: primarySession.sourceFileName || null,
    rawNmeaStored: primarySession.rawNmeaStored,
    rawNmeaStorageReason: primarySession.rawNmeaStorageReason,
    rawNmeaLineCount: primarySession.rawNmeaLineCount || 0,
    totalPoints: points.length,
    validCount,
    gpsOnlyCount,
    dgpsCount,
    qzssUsedCount,
    uploadedAt: primarySession.uploadedAt || null,
    // Exposed so consumers (e.g. 判断デモ's QZ1/DGNSS 測位品質 card) can derive
    // HDOP/satellite-count quality stats and show this field's own points on
    // the map, without re-deriving them from a separate global point store.
    rawPoints: points.slice()
  };
}

function buildGeometry({ field, track }) {
  if (field) {
    const coordinates = field.coordinates || [];
    return {
      geometryType: "Polygon",
      areaM2: field.properties.areaM2 ?? null,
      boundaryLengthM: perimeterMeters(coordinates, true),
      closed: true,
      closureGapM: field.properties.closureGapM ?? null,
      isForceClosed: Boolean(field.properties.closedManually),
      isBoundaryTrackOnly: false
    };
  }
  if (track) {
    const coordinates = track.coordinates || [];
    const closureGapM = coordinates.length >= 2 ? distanceMeters(coordinates[0], coordinates[coordinates.length - 1]) : null;
    return {
      geometryType: "LineString",
      areaM2: null,
      boundaryLengthM: perimeterMeters(coordinates, false),
      closed: closureGapM !== null && closureGapM <= CLOSURE_GAP_THRESHOLD_M,
      closureGapM,
      isForceClosed: false,
      isBoundaryTrackOnly: true
    };
  }
  return { geometryType: null, areaM2: null, boundaryLengthM: null, closed: null, closureGapM: null, isForceClosed: false, isBoundaryTrackOnly: false };
}

function buildReliabilityCheck({ primarySession, geometry, assuranceResult }) {
  if (assuranceResult) {
    const classification = assuranceResult.classification;
    const status = STATUS_FROM_CLASSIFICATION[classification] || "insufficient_evidence";
    return {
      source: "provided_assurance_result", status, label: REPORT_STATUS_LABELS[status],
      reasons: assuranceResult.reasons || [], recommendations: assuranceResult.recommendations || []
    };
  }
  if (!primarySession?.rawPoints?.length) {
    return { source: "none", status: "insufficient_evidence", label: REPORT_STATUS_LABELS.insufficient_evidence, reasons: [NO_RELIABILITY_MESSAGE], recommendations: [] };
  }
  const boundary = geometry.isBoundaryTrackOnly ? [] : []; // closure is already reported separately in geometry; avoid double-computing here
  const check = calculateQz1OnlyCheck({
    qz1Observations: toQz1Observations(primarySession.rawPoints),
    boundary,
    rawNmeaStored: Boolean(primarySession.rawNmeaStored)
  });
  const status = STATUS_FROM_CLASSIFICATION[check.classification] || "insufficient_evidence";
  return { source: "qz1_only_fallback", status, label: REPORT_STATUS_LABELS[status], reasons: check.reasons, recommendations: [] };
}

function buildWaterControlPointList(fieldId, waterControlPoints) {
  return (waterControlPoints || [])
    .filter((point) => point.relatedFieldId === fieldId)
    .map((point) => ({
      id: point.id,
      name: point.name,
      type: waterControlInternalType(point),
      typeLabel: WATER_CONTROL_TYPE_LABELS[waterControlInternalType(point)] || point.type,
      coordinates: point.coordinates,
      createdAt: point.properties?.createdAt || null,
      memo: point.properties?.memo || ""
    }));
}

function buildObservationList(fieldId, fieldObservations) {
  return (fieldObservations || [])
    .filter((observation) => observation.fieldId === fieldId)
    .map((observation) => {
      const type = normalizeObservationType(observation.type);
      const severity = normalizeSeverity(observation.properties?.severity);
      return {
        id: observation.id,
        name: observation.name,
        type,
        typeLabel: OBSERVATION_TYPE_LABELS[type],
        severity,
        severityLabel: SEVERITY_LABELS[severity],
        // Always a farmer-entered-data label ("手動配置…") — never drone/AI/
        // automatic-detection, since this app has no such observation source.
        sourceLabel: observationSourceLabel(observation.properties?.sourceType),
        coordinates: observation.coordinates,
        memo: observation.properties?.memo || "",
        createdAt: observation.properties?.createdAt || null
      };
    });
}

function summarizeObservations(observations) {
  const byType = {};
  const bySeverity = { low: 0, medium: 0, high: 0, urgent: 0 };
  observations.forEach((observation) => {
    byType[observation.type] = (byType[observation.type] || 0) + 1;
    bySeverity[observation.severity] += 1;
  });
  return { total: observations.length, byType, bySeverity };
}

function buildRecommendations({ waterControlPoints, observations, reliabilityCheck, surveyLog, geometry }) {
  const recommendations = [];
  if (waterControlPoints.length === 0) recommendations.push("給水口・排水口・水門を登録してください。");
  if (observations.length === 0) recommendations.push("雑草・害虫・病気・水不足などの現地観察メモを記録してください。");
  if (reliabilityCheck.status === "remeasure_recommended") recommendations.push("圃場の外周をもう一度QZ1で測量してください。");
  if (surveyLog.found && surveyLog.validCount > 0 && surveyLog.dgpsCount === 0) {
    recommendations.push("補強測位が得られていないため、測量結果は要確認です。開けた場所で再測量してください。");
  }
  if (geometry.closed === false) recommendations.push("圃場の外周を一周し、開始点付近まで戻って記録してください。");
  if (recommendations.length === 0) recommendations.push("この圃場データは基本的な現地調査として利用できます。");
  return recommendations;
}

/**
 * Builds one complete, farmer/hackathon-readable report for a single field
 * from the live persisted records — never fabricates data, and never
 * leaves the reliability section blank when QZ1 rawPoints exist (falls
 * back to calculateQz1OnlyCheck when no assuranceResult is supplied).
 */
export function buildFieldReport({
  fieldId, fields = [], boundaryTracks = [], surveySessions = [],
  waterControlPoints = [], fieldObservations = [], assuranceResult = null,
  generatedAt = new Date().toISOString()
}) {
  const { field, track, fieldName } = resolveFieldIdentity(fieldId, fields, boundaryTracks);
  const primarySession = resolvePrimarySurveySession(fieldId, field, track, surveySessions);
  const basicInfo = buildBasicInfo({ field, track, fieldId, fieldName, primarySession });
  const surveyLog = buildSurveyLog(primarySession);
  const geometry = buildGeometry({ field, track });
  const reliabilityCheck = buildReliabilityCheck({ primarySession, geometry, assuranceResult });
  const waterControlPointList = buildWaterControlPointList(fieldId, waterControlPoints);
  const observationList = buildObservationList(fieldId, fieldObservations);
  const observationSummary = summarizeObservations(observationList);
  const recommendations = buildRecommendations({
    waterControlPoints: waterControlPointList, observations: observationList, reliabilityCheck, surveyLog, geometry
  });

  const keyReasons = [...reliabilityCheck.reasons];
  if (geometry.isBoundaryTrackOnly) keyReasons.push("境界トラックであり、圃場面積は未確定です。");
  if (geometry.isForceClosed) keyReasons.push("始点と終点を接続した仮のポリゴンです。");

  return {
    reportId: `report-${fieldId}-${generatedAt.replace(/[^0-9]/g, "").slice(0, 14)}`,
    generatedAt,
    fieldId,
    fieldName,
    summary: {
      overallStatus: reliabilityCheck.status,
      overallLabel: reliabilityCheck.label,
      keyReasons,
      nextActions: recommendations
    },
    basicInfo,
    surveyLog,
    geometry,
    reliabilityCheck,
    waterControlPoints: waterControlPointList,
    observations: observationList,
    observationSummary,
    recommendations
  };
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  }[char]));
}

function formatDateTime(iso) {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString("ja-JP") : iso;
}

function formatNumber(value, unit = "") {
  return Number.isFinite(value) ? `${value.toFixed(unit ? 1 : 0)}${unit}` : "—";
}

function htmlList(items) {
  if (!items.length) return "";
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

/** Mirrors field-annotation-controller.js's rawNmeaStatusLabel(): 保存済み / 未保存（サイズ超過） / — (never captured at all). */
export function rawNmeaStatusLabel(surveyLog) {
  if (!surveyLog?.found) return "—";
  if (surveyLog.rawNmeaStored) return "保存済み";
  return surveyLog.rawNmeaStorageReason === "size_limit" ? "未保存（サイズ超過）" : "—";
}

/**
 * A single self-contained, printable HTML document for one field report —
 * no external stylesheets/scripts/CDN, safe to save standalone or open in
 * a new window for window.print().
 */
export function buildReportHtml(report) {
  const geometryNote = report.geometry.isBoundaryTrackOnly
    ? "<p class=\"note\">このデータは境界トラックです。圃場全体の面積は確定していません。</p>"
    : report.geometry.isForceClosed
      ? "<p class=\"note\">この圃場は始点と終点を接続して仮のポリゴンとして保存されています。再測量を推奨します。</p>"
      : "";

  const waterRows = report.waterControlPoints.length
    ? report.waterControlPoints.map((point) => `<tr>
        <td>${escapeHtml(point.typeLabel)}</td><td>${escapeHtml(point.name)}</td>
        <td>${point.coordinates.map((value) => value.toFixed(6)).join(", ")}</td>
        <td>${escapeHtml(formatDateTime(point.createdAt))}</td><td>${escapeHtml(point.memo)}</td>
      </tr>`).join("")
    : `<tr><td colspan="5">${NO_WATER_POINTS_MESSAGE}</td></tr>`;

  const observationRows = report.observations.length
    ? report.observations.map((observation) => `<tr>
        <td>${escapeHtml(observation.typeLabel)}</td><td>${escapeHtml(observation.name)}</td>
        <td>${escapeHtml(observation.severityLabel)}</td>
        <td>${escapeHtml(observation.sourceLabel)}</td>
        <td>${observation.coordinates.map((value) => value.toFixed(6)).join(", ")}</td>
        <td>${escapeHtml(observation.memo)}</td><td>${escapeHtml(formatDateTime(observation.createdAt))}</td>
      </tr>`).join("")
    : `<tr><td colspan="7">${NO_OBSERVATIONS_MESSAGE}</td></tr>`;

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>圃場レポート: ${escapeHtml(report.fieldName)}</title>
<style>
  body { font-family: -apple-system, "Hiragino Sans", "Yu Gothic", sans-serif; color: #1d2528; max-width: 860px; margin: 24px auto; padding: 0 16px; line-height: 1.6; }
  h1 { font-size: 1.5rem; margin-bottom: 4px; }
  h2 { font-size: 1.1rem; border-bottom: 2px solid #166534; padding-bottom: 4px; margin-top: 28px; }
  .status-badge { display: inline-block; font-size: 1.2rem; font-weight: 800; padding: 6px 14px; border-radius: 8px; background: #f0fdf4; border: 2px solid #166534; color: #166534; }
  .meta { color: #647174; font-size: 0.85rem; }
  .note { background: #fff7ed; border-left: 3px solid #fb923c; padding: 8px 10px; color: #9a3412; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; }
  dt { color: #647174; }
  dd { margin: 0; }
  table { border-collapse: collapse; width: 100%; margin-top: 8px; }
  th, td { border: 1px solid #d9dfdc; padding: 6px 8px; font-size: 0.85rem; text-align: left; }
  th { background: #f6f7f4; }
  ul { margin: 6px 0; padding-left: 1.3em; }
  @media print { body { margin: 0; max-width: none; } }
</style>
</head>
<body>
  <h1>圃場レポート: ${escapeHtml(report.fieldName)}</h1>
  <p class="meta">生成日時: ${escapeHtml(formatDateTime(report.generatedAt))} / 圃場ID: ${escapeHtml(report.fieldId)}</p>
  <p class="status-badge">総合判定: ${escapeHtml(report.summary.overallLabel)}</p>
  ${htmlList(report.summary.keyReasons)}

  <h2>基本情報</h2>
  <dl>
    <dt>圃場名</dt><dd>${escapeHtml(report.basicInfo.fieldName)}</dd>
    <dt>圃場ID</dt><dd>${escapeHtml(report.basicInfo.fieldId)}</dd>
    <dt>作成日時</dt><dd>${escapeHtml(formatDateTime(report.basicInfo.createdAt))}</dd>
    <dt>最終更新日時</dt><dd>${escapeHtml(formatDateTime(report.basicInfo.updatedAt))}</dd>
    <dt>測量タイプ</dt><dd>${escapeHtml(report.basicInfo.measurementTypeLabel || "—")}</dd>
    <dt>データ種別</dt><dd>${escapeHtml(report.basicInfo.dataKind)}</dd>
  </dl>

  <h2>QZ1測量ログ</h2>
  ${report.surveyLog.found ? `<dl>
    <dt>元NMEAファイル名</dt><dd>${escapeHtml(report.surveyLog.sourceFileName || "—")}</dd>
    <dt>元NMEA保存状態</dt><dd>${escapeHtml(rawNmeaStatusLabel(report.surveyLog))}</dd>
    <dt>NMEA行数</dt><dd>${escapeHtml(formatNumber(report.surveyLog.rawNmeaLineCount))}</dd>
    <dt>有効測位点</dt><dd>${escapeHtml(formatNumber(report.surveyLog.validCount))}</dd>
    <dt>GPS単独</dt><dd>${escapeHtml(formatNumber(report.surveyLog.gpsOnlyCount))}</dd>
    <dt>DGPS/補強あり</dt><dd>${escapeHtml(formatNumber(report.surveyLog.dgpsCount))}</dd>
    <dt>QZSS使用</dt><dd>${escapeHtml(formatNumber(report.surveyLog.qzssUsedCount))}</dd>
  </dl>` : `<p>${NO_SURVEY_LOG_MESSAGE}</p>`}

  <h2>測量チェック結果</h2>
  <p>総合判定: ${escapeHtml(report.reliabilityCheck.label)}</p>
  ${htmlList(report.reliabilityCheck.reasons)}

  <h2>圃場形状・面積</h2>
  <dl>
    <dt>形状タイプ</dt><dd>${escapeHtml(report.geometry.geometryType || "—")}</dd>
    <dt>圃場面積</dt><dd>${Number.isFinite(report.geometry.areaM2) ? `${formatNumber(report.geometry.areaM2)} m²` : "—"}</dd>
    <dt>境界長</dt><dd>${Number.isFinite(report.geometry.boundaryLengthM) ? `${formatNumber(report.geometry.boundaryLengthM)} m` : "—"}</dd>
    <dt>閉合状態</dt><dd>${report.geometry.closed === null ? "—" : report.geometry.closed ? "閉じている" : "開いている"}</dd>
    <dt>始点と終点の距離</dt><dd>${Number.isFinite(report.geometry.closureGapM) ? `${formatNumber(report.geometry.closureGapM, "")} m` : "—"}</dd>
  </dl>
  ${geometryNote}

  <h2>水管理ポイント</h2>
  <table><thead><tr><th>種類</th><th>名前</th><th>座標</th><th>作成日時</th><th>メモ</th></tr></thead><tbody>${waterRows}</tbody></table>

  <h2>現地観察メモ</h2>
  <p>観察メモ合計: ${report.observationSummary.total}件</p>
  <table><thead><tr><th>種類</th><th>タイトル</th><th>重要度</th><th>登録方法</th><th>座標</th><th>メモ</th><th>作成日時</th></tr></thead><tbody>${observationRows}</tbody></table>

  <h2>次にやること</h2>
  ${htmlList(report.recommendations)}
</body>
</html>`;
}

/** Plain-text Markdown for the "Markdownをコピー" button. */
export function buildReportMarkdown(report) {
  const lines = [
    `# 圃場レポート: ${report.fieldName}`,
    "",
    `生成日時: ${formatDateTime(report.generatedAt)} / 圃場ID: ${report.fieldId}`,
    "",
    `**総合判定: ${report.summary.overallLabel}**`,
    "",
    "## 主な理由",
    ...report.summary.keyReasons.map((reason) => `- ${reason}`),
    "",
    "## 基本情報",
    `- 圃場名: ${report.basicInfo.fieldName}`,
    `- 圃場ID: ${report.basicInfo.fieldId}`,
    `- 作成日時: ${formatDateTime(report.basicInfo.createdAt)}`,
    `- 最終更新日時: ${formatDateTime(report.basicInfo.updatedAt)}`,
    `- 測量タイプ: ${report.basicInfo.measurementTypeLabel || "—"}`,
    `- データ種別: ${report.basicInfo.dataKind}`,
    "",
    "## QZ1測量ログ",
    ...(report.surveyLog.found ? [
      `- 元NMEAファイル名: ${report.surveyLog.sourceFileName || "—"}`,
      `- 元NMEA保存状態: ${rawNmeaStatusLabel(report.surveyLog)}`,
      `- NMEA行数: ${report.surveyLog.rawNmeaLineCount}`,
      `- 有効測位点: ${report.surveyLog.validCount}`,
      `- GPS単独: ${report.surveyLog.gpsOnlyCount}`,
      `- DGPS/補強あり: ${report.surveyLog.dgpsCount}`,
      `- QZSS使用: ${report.surveyLog.qzssUsedCount}`
    ] : [NO_SURVEY_LOG_MESSAGE]),
    "",
    "## 測量チェック結果",
    `- 総合判定: ${report.reliabilityCheck.label}`,
    ...report.reliabilityCheck.reasons.map((reason) => `- ${reason}`),
    "",
    "## 圃場形状・面積",
    `- 形状タイプ: ${report.geometry.geometryType || "—"}`,
    `- 圃場面積: ${Number.isFinite(report.geometry.areaM2) ? `${report.geometry.areaM2.toFixed(1)} m²` : "—"}`,
    `- 境界長: ${Number.isFinite(report.geometry.boundaryLengthM) ? `${report.geometry.boundaryLengthM.toFixed(1)} m` : "—"}`,
    `- 閉合状態: ${report.geometry.closed === null ? "—" : report.geometry.closed ? "閉じている" : "開いている"}`,
    "",
    "## 水管理ポイント",
    ...(report.waterControlPoints.length
      ? report.waterControlPoints.map((point) => `- ${point.typeLabel} ${point.name}（${formatDateTime(point.createdAt)}）${point.memo ? `: ${point.memo}` : ""}`)
      : [NO_WATER_POINTS_MESSAGE]),
    "",
    "## 現地観察メモ",
    `観察メモ合計: ${report.observationSummary.total}件`,
    ...(report.observations.length
      ? report.observations.map((observation) => `- [${observation.severityLabel}] ${observation.typeLabel} ${observation.name}（${observation.sourceLabel}）${observation.memo ? `: ${observation.memo}` : ""}`)
      : [NO_OBSERVATIONS_MESSAGE]),
    "",
    "## 次にやること",
    ...report.recommendations.map((action) => `- ${action}`)
  ];
  return lines.join("\n");
}

export {
  NO_SURVEY_LOG_MESSAGE, NO_RELIABILITY_MESSAGE, NO_WATER_POINTS_MESSAGE, NO_OBSERVATIONS_MESSAGE, RESULT_STATUS_LABELS
};
