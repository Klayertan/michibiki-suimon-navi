// Field & water-control-point annotation: pure logic (no DOM, no Leaflet).
// Converts an NMEA/phone-GPS walked path into a closed field polygon or an
// (optionally unclosed) boundary track, and models water-control-point
// markers linked to a field by id, plus the survey-session record that
// preserves the raw uploaded points. Records use a GeoJSON-Feature-like
// shape (id/name/type/geometryType/coordinates + a nested `properties` bag
// for memo/source/timestamps) to match how this project expects to consume
// the exported JSON downstream.
//
// Coordinate order: this app is Leaflet-first everywhere else (map layers,
// existing paddy boundary, existing v1 export), so `coordinates` here stays
// [lat, lon] (a single pair for Point, an ordered ring/line of pairs for
// Polygon/LineString) rather than GeoJSON's [lng, lat] — flipping order
// would require rewriting every render call site for no functional benefit.
// `geometryType` is included for shape/documentation purposes.
//
// Reuses validateBoundary() from field-registry.js for the closure-gap
// distance and self-intersection check rather than duplicating geometry
// logic — this module only adds the auto-close/warn/force-close/save-as-
// track decision and the record/export shapes on top of it.
import { validateBoundary } from "./field-registry.js";

export const SCHEMA_VERSION = 3;
export const DEFAULT_AUTO_CLOSE_THRESHOLD_M = 5;
export const LOCAL_STORAGE_KEY = "suimonNaviFieldAnnotationsV2";

// Above this size, the original NMEA file text is dropped from the survey
// session (parsed points/metadata are always kept regardless) to avoid
// blowing the localStorage quota with a single large log.
export const MAX_RAW_NMEA_STORAGE_BYTES = 2_000_000;
export const RAW_NMEA_SIZE_WARNING = "NMEAログが大きいため、元ファイル全文は保存せず、解析済みデータのみ保存しました。";

export const WATER_CONTROL_TYPE_LABELS = {
  gate: "水門",
  inlet: "給水口",
  outlet: "排水口",
  sensor: "水位センサ",
  photo: "撮影地点"
};

export const FEATURE_TYPE_LABELS = {
  field: "圃場",
  ...WATER_CONTROL_TYPE_LABELS
};

export function isWaterControlType(type) {
  return Object.prototype.hasOwnProperty.call(WATER_CONTROL_TYPE_LABELS, type);
}

// The internal short keys above (gate/inlet/outlet/sensor/photo) drive the
// UI and style lookups; the exported/imported JSON uses the more
// descriptive strings below so downstream consumers get self-explanatory
// type values. Both directions are supported on import for round-tripping.
export const WATER_CONTROL_EXPORT_TYPES = {
  gate: "water_gate",
  inlet: "water_inlet",
  outlet: "water_outlet",
  sensor: "water_level_sensor",
  photo: "photo_point"
};
const WATER_CONTROL_IMPORT_ALIASES = Object.fromEntries(
  Object.entries(WATER_CONTROL_EXPORT_TYPES).map(([internal, external]) => [external, internal])
);

/** Accepts either the internal short key or the exported long-form type string. */
export function normalizeWaterControlType(type) {
  if (isWaterControlType(type)) {
    return type;
  }
  return WATER_CONTROL_IMPORT_ALIASES[type] || "gate";
}

// Single style source for both the map layer and the legend — colors are
// never hard-coded a second time in the controller or CSS.
export const FIELD_POLYGON_STYLE = { color: "#166534", fillColor: "#4ade80", fillOpacity: 0.12, weight: 3 };
export const BOUNDARY_TRACK_STYLE = { color: "#b45309", weight: 3, dashArray: "6 5" };
export const WATER_CONTROL_STYLES = {
  gate: { fillColor: "#2563eb" },
  inlet: { fillColor: "#0284c7" },
  outlet: { fillColor: "#0f766e" },
  sensor: { fillColor: "#7c3aed" },
  photo: { fillColor: "#ca8a04" }
};

// The three registration choices offered right after an NMEA upload.
export const MEASUREMENT_TYPE_LABELS = {
  field_polygon: "圃場ポリゴンとして登録",
  boundary_track: "境界トラックとして登録",
  water_points: "水門・給水口・排水口ポイントとして登録"
};

// ---------------------------------------------------------------------------
// Manual field observations (現地観察メモ) — weed/pest/disease/water/etc.
// point markers a farmer drops while walking the field, linked to a
// registered field by id.
// ---------------------------------------------------------------------------

export const OBSERVATION_TYPE_LABELS = {
  weed: "雑草",
  insect: "害虫",
  disease: "病気",
  water_shortage: "水不足",
  excess_water: "水が多すぎる",
  lodging: "倒伏",
  soil_problem: "土壌・泥の問題",
  gate_problem: "水門異常",
  note: "その他メモ"
};

export const SEVERITY_LABELS = { low: "低", medium: "中", high: "高", urgent: "緊急" };

export const OBSERVATION_STYLES = {
  weed: { fillColor: "#65a30d" },
  insect: { fillColor: "#dc2626" },
  disease: { fillColor: "#b91c1c" },
  water_shortage: { fillColor: "#f59e0b" },
  excess_water: { fillColor: "#0284c7" },
  lodging: { fillColor: "#92400e" },
  soil_problem: { fillColor: "#78350f" },
  gate_problem: { fillColor: "#7c3aed" },
  note: { fillColor: "#64748b" }
};

// Larger radius communicates higher urgency at a glance on the map.
export const SEVERITY_MARKER_RADIUS = { low: 6, medium: 8, high: 10, urgent: 12 };

export function isObservationType(type) {
  return Object.prototype.hasOwnProperty.call(OBSERVATION_TYPE_LABELS, type);
}

/** Unknown/missing types fall back to "note" rather than being invented or dropped. */
export function normalizeObservationType(type) {
  return isObservationType(type) ? type : "note";
}

/** Unknown/missing severities fall back to "medium". */
export function normalizeSeverity(severity) {
  return Object.prototype.hasOwnProperty.call(SEVERITY_LABELS, severity) ? severity : "medium";
}

export function buildFieldObservation({
  id, fieldId = null, type, name = "", severity = "medium", memo = "",
  lat, lon, sourceType = "manual_map_click", nowIso = new Date().toISOString()
}) {
  const internalType = normalizeObservationType(type);
  return {
    id: String(id),
    fieldId: fieldId || null,
    type: internalType,
    label: OBSERVATION_TYPE_LABELS[internalType],
    name: String(name ?? ""),
    geometryType: "Point",
    coordinates: [Number(lat), Number(lon)],
    properties: {
      severity: normalizeSeverity(severity),
      memo: String(memo ?? ""),
      sourceType,
      createdAt: nowIso,
      updatedAt: nowIso
    }
  };
}

/** Suggested (editable) title for the next observation of a given type on a given field. */
export function nextObservationName(fieldName, type, existingCountForFieldAndType) {
  const label = OBSERVATION_TYPE_LABELS[normalizeObservationType(type)];
  return `${fieldName || ""} ${label}地点${existingCountForFieldAndType + 1}`.trim();
}

// ---------------------------------------------------------------------------
// Field / track defaults
// ---------------------------------------------------------------------------

/** Suggested (editable) name/id for the next field, based on how many exist now. */
export function nextFieldDefaults(existingFieldCount) {
  const n = existingFieldCount + 1;
  return { name: `圃場${n}`, id: `paddy-${String(n).padStart(3, "0")}` };
}

export function nextBoundaryTrackId(fieldId, existingTrackCountForField) {
  return `${fieldId}-track-${String(existingTrackCountForField + 1).padStart(3, "0")}`;
}

export function makeSurveySessionId(nowMs = Date.now()) {
  const stamp = new Date(nowMs).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `survey-${stamp}`;
}

// ---------------------------------------------------------------------------
// Closure evaluation (walked path -> closed field polygon / boundary track)
// ---------------------------------------------------------------------------

export const CLOSE_WARNING_MESSAGE = "始点と終点が離れています。圃場ポリゴンを閉じますか？";
export const UPLOAD_CLOSE_WARNING_MESSAGE = "始点と終点が離れています。このログを圃場ポリゴンとして閉じますか？";

/**
 * Evaluates whether an ordered vertex list can auto-close into a field
 * polygon, or needs the user to confirm closing despite a large gap.
 * Returns { autoClose, gapM, selfIntersects, warnings, canClose }.
 */
export function evaluateClosure(coordinates, thresholdM = DEFAULT_AUTO_CLOSE_THRESHOLD_M) {
  if (!Array.isArray(coordinates) || coordinates.length < 3) {
    return {
      canClose: false,
      autoClose: false,
      gapM: null,
      selfIntersects: false,
      warnings: ["圃場ポリゴンには3点以上が必要です。"]
    };
  }
  const validation = validateBoundary(coordinates);
  const gapM = validation.closureGapM;
  const autoClose = Number.isFinite(gapM) && gapM <= thresholdM;
  const selfIntersects = validation.warnings.some((warning) => warning.includes("自己交差"));
  const warnings = selfIntersects ? ["境界線が自己交差しています。点の範囲・順序を確認してください。"] : [];
  return { canClose: true, autoClose, gapM, selfIntersects, warnings };
}

// ---------------------------------------------------------------------------
// Record builders (GeoJSON-Feature-like: id/name/type/geometryType/
// coordinates + a `properties` bag for memo/source/timestamps)
// ---------------------------------------------------------------------------

export function buildField({
  id, name, coordinates, memo = "",
  gapM = null, closedManually = false, sourcePointCount = null,
  sourceSessionId = null, sourceType = "QZ1_NMEA", sourceFileName = null,
  fixQualitySummary = null, nowIso = new Date().toISOString()
}) {
  return {
    id: String(id),
    name: String(name || ""),
    type: "field",
    geometryType: "Polygon",
    coordinates: coordinates.map(([lat, lon]) => [Number(lat), Number(lon)]),
    sourceSessionId: sourceSessionId || null,
    properties: {
      memo: String(memo ?? ""),
      sourceType,
      sourceFileName: sourceFileName || null,
      createdAt: nowIso,
      updatedAt: nowIso,
      areaM2: polygonAreaSquareMeters(coordinates),
      closureGapM: Number.isFinite(gapM) ? gapM : null,
      closedManually: Boolean(closedManually),
      sourcePointCount: Number.isFinite(sourcePointCount) ? sourcePointCount : coordinates.length,
      fixQualitySummary: fixQualitySummary || null
    }
  };
}

export function buildBoundaryTrack({
  id, name, fieldId, coordinates, memo = "",
  sourceSessionId = null, sourceType = "QZ1_NMEA", sourceFileName = null,
  fixQualitySummary = null, nowIso = new Date().toISOString()
}) {
  return {
    id: String(id),
    name: String(name || ""),
    type: "field_boundary_track",
    fieldId: fieldId || null,
    geometryType: "LineString",
    coordinates: coordinates.map(([lat, lon]) => [Number(lat), Number(lon)]),
    sourceSessionId: sourceSessionId || null,
    properties: {
      memo: String(memo ?? ""),
      sourceType,
      sourceFileName: sourceFileName || null,
      createdAt: nowIso,
      updatedAt: nowIso,
      sourcePointCount: coordinates.length,
      fixQualitySummary: fixQualitySummary || null
    }
  };
}

export function buildWaterControlPoint({
  id, name = "", type, lat, lon, relatedFieldId = null, memo = "",
  sourceType = "manual_map_click", nowIso = new Date().toISOString()
}) {
  const internalType = normalizeWaterControlType(type);
  return {
    id: String(id),
    name: String(name ?? ""),
    type: WATER_CONTROL_EXPORT_TYPES[internalType],
    relatedFieldId: relatedFieldId || null,
    geometryType: "Point",
    coordinates: [Number(lat), Number(lon)],
    properties: {
      memo: String(memo ?? ""),
      sourceType,
      createdAt: nowIso,
      updatedAt: nowIso
    }
  };
}

/** The short internal key (gate/inlet/outlet/sensor/photo) for a built water-control-point record. */
export function waterControlInternalType(point) {
  return normalizeWaterControlType(point?.type);
}

/** Number of non-empty lines in a raw NMEA text, counted the same way the file was split for parsing. */
export function countNmeaLines(text) {
  if (!text) {
    return 0;
  }
  return text.split(/\r\n|\r|\n/).filter((line) => line.length > 0).length;
}

/**
 * Decides whether a raw NMEA text is small enough to persist alongside the
 * survey session. Always reports the line count (cheap, useful even when
 * the text itself is dropped); only refuses storage — never parsing or
 * registration — when the text exceeds maxBytes.
 */
export function decideRawNmeaStorage(rawText, maxBytes = MAX_RAW_NMEA_STORAGE_BYTES) {
  if (!rawText) {
    return { stored: false, text: null, lineCount: 0, reason: null };
  }
  const lineCount = countNmeaLines(rawText);
  const byteLength = new TextEncoder().encode(rawText).length;
  if (byteLength > maxBytes) {
    return { stored: false, text: null, lineCount, reason: "size_limit" };
  }
  return { stored: true, text: rawText, lineCount, reason: null };
}

export function buildSurveySession({
  id, name, fieldId = null, sourceFileName = null, rawPoints = [],
  measurementType, rawNmeaText = null, uploadedAt = null, nowIso = new Date().toISOString()
}) {
  const rawNmea = decideRawNmeaStorage(rawNmeaText);
  return {
    id: String(id),
    name: String(name || ""),
    fieldId: fieldId || null,
    sourceFileName: sourceFileName || null,
    rawPoints: rawPoints.slice(),
    rawNmeaText: rawNmea.text,
    rawNmeaLineCount: rawNmea.lineCount,
    rawNmeaStored: rawNmea.stored,
    rawNmeaStorageReason: rawNmea.reason,
    createdAt: nowIso,
    uploadedAt: uploadedAt || null,
    measurementType: MEASUREMENT_TYPE_LABELS[measurementType] ? measurementType : "field_polygon"
  };
}

// ---------------------------------------------------------------------------
// Geometry helpers (local planar approximation, consistent with the rest of
// this app's non-Turf fallback path)
// ---------------------------------------------------------------------------

export function polygonAreaSquareMeters(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 3) {
    return 0;
  }
  if (typeof globalThis.turf !== "undefined") {
    try {
      const ring = coordinates.map(([lat, lon]) => [lon, lat]);
      ring.push(ring[0]);
      return globalThis.turf.area(globalThis.turf.polygon([ring]));
    } catch {}
  }
  const origin = coordinates[0];
  const metersPerDegreeLat = 111320;
  const metersPerDegreeLon = 111320 * Math.cos(origin[0] * Math.PI / 180);
  const points = coordinates.map(([lat, lon]) => ({
    x: (lon - origin[1]) * metersPerDegreeLon,
    y: (lat - origin[0]) * metersPerDegreeLat
  }));
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum / 2);
}

export function distanceMeters(a, b) {
  const lat = (a[0] + b[0]) / 2 * Math.PI / 180;
  const dx = (b[1] - a[1]) * 111320 * Math.cos(lat);
  const dy = (b[0] - a[0]) * 111320;
  return Math.hypot(dx, dy);
}

// ---------------------------------------------------------------------------
// Fix-quality summary (used by both the upload dialog preview and the
// registered-field/log panel)
// ---------------------------------------------------------------------------

/**
 * Groups raw measurement points by fixQuality (NMEA-style points only carry
 * fixQuality; phone-GPS points do not, and are counted under "unknown").
 */
export function summarizeFixQuality(points) {
  const byFixQuality = {};
  let augmentedCount = 0;
  (points || []).forEach((point) => {
    const key = Number.isFinite(point.fixQuality) ? String(point.fixQuality) : "unknown";
    byFixQuality[key] = (byFixQuality[key] || 0) + 1;
    if (point.augmented === true || point.fixQuality === 2 || point.fixQuality === 4 || point.fixQuality === 5) {
      augmentedCount += 1;
    }
  });
  return { total: (points || []).length, byFixQuality, augmentedCount };
}

export function buildMetadata({ sourceFileName = null, points = [], nowIso = new Date().toISOString() } = {}) {
  return {
    date: nowIso,
    sourceFileName: sourceFileName || null,
    fixQualitySummary: summarizeFixQuality(points)
  };
}

// ---------------------------------------------------------------------------
// Persistence shape (pure — the actual localStorage read/write happens in
// the controller; this module only validates/normalizes what comes back)
// ---------------------------------------------------------------------------

export function emptyPersistedStore() {
  return {
    schemaVersion: SCHEMA_VERSION, fields: [], boundaryTracks: [], waterControlPoints: [],
    surveySessions: [], fieldObservations: []
  };
}

/**
 * Normalizes whatever was read from localStorage (or an imported project
 * file) into the five persisted arrays. Never throws — malformed or
 * missing data degrades to empty arrays so a corrupted/older value (or an
 * older schema without fieldObservations) can't crash the app.
 */
export function normalizePersistedStore(raw) {
  if (!raw || typeof raw !== "object") {
    return emptyPersistedStore();
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    fields: Array.isArray(raw.fields) ? raw.fields : [],
    boundaryTracks: Array.isArray(raw.boundaryTracks) ? raw.boundaryTracks : [],
    waterControlPoints: Array.isArray(raw.waterControlPoints) ? raw.waterControlPoints : [],
    surveySessions: Array.isArray(raw.surveySessions) ? raw.surveySessions : [],
    fieldObservations: Array.isArray(raw.fieldObservations) ? raw.fieldObservations : []
  };
}
