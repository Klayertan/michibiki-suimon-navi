// Field & water-control-point annotation: pure logic (no DOM, no Leaflet).
// Converts an already-recorded walked path (QZ1 NMEA/serial or phone GPS
// points, already displayed elsewhere in the app) into a closed field
// polygon, and models water-control-point markers linked to a field by id.
//
// Reuses validateBoundary() from field-registry.js for the closure-gap
// distance and self-intersection check rather than duplicating geometry
// logic — this module only adds the auto-close/warn/manual-close decision
// and the field/water-control-point/export data shapes on top of it.
import { validateBoundary } from "./field-registry.js";

export const DEFAULT_AUTO_CLOSE_THRESHOLD_M = 5;

export const WATER_CONTROL_TYPE_LABELS = {
  inlet: "給水口",
  outlet: "排水口",
  gate: "水門",
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

// Single style source for both the map layer and the legend — colors are
// never hard-coded a second time in the controller or CSS.
export const FIELD_POLYGON_STYLE = { color: "#166534", fillColor: "#4ade80", fillOpacity: 0.12, weight: 3 };
export const WATER_CONTROL_STYLES = {
  inlet: { fillColor: "#0284c7" },
  outlet: { fillColor: "#0f766e" },
  gate: { fillColor: "#2563eb" },
  sensor: { fillColor: "#7c3aed" },
  photo: { fillColor: "#ca8a04" }
};

// ---------------------------------------------------------------------------
// Field defaults
// ---------------------------------------------------------------------------

/** Suggested (editable) name/id for the next field, based on how many exist now. */
export function nextFieldDefaults(existingFieldCount) {
  const n = existingFieldCount + 1;
  return { name: `圃場${n}`, id: `paddy-${String(n).padStart(3, "0")}` };
}

// ---------------------------------------------------------------------------
// Closure evaluation (walked path -> closed field polygon)
// ---------------------------------------------------------------------------

export const CLOSE_WARNING_MESSAGE = "始点と終点が離れています。圃場ポリゴンを閉じますか？";

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
// Field / water-control-point normalization
// ---------------------------------------------------------------------------

export function buildField({
  id, name, coordinates, memo = "",
  gapM = null, closedManually = false, sourcePointCount = null, nowIso = new Date().toISOString()
}) {
  return {
    id: String(id),
    type: "field",
    name: String(name || ""),
    coordinates: coordinates.map(([lat, lon]) => [Number(lat), Number(lon)]),
    areaM2: polygonAreaSquareMeters(coordinates),
    memo: String(memo ?? ""),
    closureGapM: Number.isFinite(gapM) ? gapM : null,
    closedManually: Boolean(closedManually),
    sourcePointCount: Number.isFinite(sourcePointCount) ? sourcePointCount : coordinates.length,
    createdAt: nowIso,
    updatedAt: nowIso
  };
}

export function buildWaterControlPoint({
  id, name = "", type, lat, lon, relatedFieldId = null, memo = "",
  positionSource = "unknown", nowIso = new Date().toISOString()
}) {
  return {
    id: String(id),
    type: isWaterControlType(type) ? type : "gate",
    name: String(name ?? ""),
    lat: Number(lat),
    lon: Number(lon),
    relatedFieldId: relatedFieldId || null,
    memo: String(memo ?? ""),
    positionSource,
    createdAt: nowIso,
    updatedAt: nowIso
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
// Export shapes
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
