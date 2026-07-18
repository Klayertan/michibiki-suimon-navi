// Vegetation Intelligence core logic.
// Pure data / validation / analytics functions with no DOM or Leaflet
// dependencies so they can run in node:test and in the browser controller.
//
// Design notes:
// - The camera / AI detects vegetation conditions; QZ1 / SLAS only provides
//   the position used to associate an observation with a field & grid cell.
// - Nothing here claims confirmed pest or disease detection. Observation
//   types use "suspected" wording and manual confirmation states.
// - Positioning quality is never fabricated: when SLAS metadata is absent
//   the quality stays "unknown".

export const VEGETATION_SCHEMA_VERSION = 1;

export const OBSERVATION_TYPES = {
  weed: { label: "雑草 / weed", short: "weed" },
  crop_stress: { label: "生育ストレス候補 / crop stress candidate", short: "crop stress" },
  pest_damage_suspected: { label: "害虫被害の疑い / suspected pest damage", short: "pest?" },
  disease_suspected: { label: "病害の疑い / suspected disease", short: "disease?" },
  lodging: { label: "倒伏 / lodging", short: "lodging" },
  unknown: { label: "不明 / unknown", short: "unknown" }
};

export const SEVERITY_LEVELS = ["low", "medium", "high", "unknown"];
export const SEVERITY_LABELS = {
  low: "低 / low",
  medium: "中 / medium",
  high: "高 / high",
  unknown: "不明 / unknown"
};
const SEVERITY_RANK = { low: 1, medium: 2, high: 3 };

export const POSITION_QUALITIES = ["green", "yellow", "red", "unknown"];
export const POSITION_QUALITY_LABELS = {
  green: "緑（SLAS有効・関連付け確実）",
  yellow: "黄（境界付近・関連付け不確実・品質低下）",
  red: "赤（位置不正・矛盾・自動判断不可）",
  unknown: "不明（品質メタデータなし）"
};

export const ASSOCIATION_STATUSES = ["automatic", "ambiguous", "confirmed", "overridden", "unassigned"];
export const ASSOCIATION_LABELS = {
  automatic: "自動",
  ambiguous: "要確認（曖昧）",
  confirmed: "確認済み",
  overridden: "手動変更",
  unassigned: "未割当"
};

export const DEFAULT_VEGETATION_SETTINGS = {
  schemaVersion: VEGETATION_SCHEMA_VERSION,
  mapMode: "weed",
  confidenceThreshold: 0.7,
  staleDays: 14,
  trendTolerancePp: 2,
  weedIncreaseAlertPp: 5,
  percentSumTolerancePp: 5
};

// Single source of truth for vegetation overlay colors so map, legend and
// tables never hard-code colors separately. Palette follows the assurance
// green / yellow / orange / red language already used in the app.
const RAMP_COLORS = {
  good: "#2f855a",
  fair: "#eab308",
  warn: "#f97316",
  bad: "#dc2626",
  none: "#9ca3af"
};

export const NO_DATA_STYLE = {
  color: "#6b7280",
  fillColor: RAMP_COLORS.none,
  fillOpacity: 0.08,
  weight: 1,
  dashArray: "3 4",
  label: "データなし / No data"
};

export const VEGETATION_MAP_MODES = {
  weed: {
    label: "雑草被覆率 / Weed coverage",
    buckets: [
      { max: 5, color: RAMP_COLORS.good, label: "0–5%" },
      { max: 15, color: RAMP_COLORS.fair, label: "5–15%" },
      { max: 30, color: RAMP_COLORS.warn, label: "15–30%" },
      { max: Infinity, color: RAMP_COLORS.bad, label: "30%以上" }
    ]
  },
  crop: {
    label: "稲被覆率 / Crop coverage",
    buckets: [
      { max: 40, color: RAMP_COLORS.bad, label: "40%未満" },
      { max: 60, color: RAMP_COLORS.warn, label: "40–60%" },
      { max: 80, color: RAMP_COLORS.fair, label: "60–80%" },
      { max: Infinity, color: RAMP_COLORS.good, label: "80%以上" }
    ]
  },
  severity: {
    label: "深刻度 / Severity",
    categories: [
      { value: "low", color: RAMP_COLORS.good, label: SEVERITY_LABELS.low },
      { value: "medium", color: RAMP_COLORS.warn, label: SEVERITY_LABELS.medium },
      { value: "high", color: RAMP_COLORS.bad, label: SEVERITY_LABELS.high },
      { value: "unknown", color: RAMP_COLORS.none, label: SEVERITY_LABELS.unknown }
    ]
  },
  age: {
    label: "観測経過日数 / Observation age",
    buckets: [
      { max: 3, color: RAMP_COLORS.good, label: "3日以内" },
      { max: 7, color: RAMP_COLORS.fair, label: "4–7日" },
      { max: 14, color: RAMP_COLORS.warn, label: "8–14日" },
      { max: Infinity, color: RAMP_COLORS.bad, label: "15日以上" }
    ]
  },
  confidence: {
    label: "AI信頼度 / AI confidence",
    buckets: [
      { max: 0.5, color: RAMP_COLORS.bad, label: "0.5未満" },
      { max: 0.7, color: RAMP_COLORS.warn, label: "0.5–0.7" },
      { max: 0.9, color: RAMP_COLORS.fair, label: "0.7–0.9" },
      { max: Infinity, color: RAMP_COLORS.good, label: "0.9以上" }
    ]
  }
};

const PERCENT_FIELDS = ["weedCoveragePercent", "cropCoveragePercent", "bareSoilPercent", "waterSurfacePercent"];

let idCounter = 0;
export function makeVegetationId() {
  idCounter += 1;
  return `veg-${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// ---------------------------------------------------------------------------
// Observation normalization & validation
// ---------------------------------------------------------------------------

export function normalizeObservation(input = {}) {
  const now = new Date().toISOString();
  return {
    id: typeof input.id === "string" && input.id ? input.id : makeVegetationId(),
    schemaVersion: VEGETATION_SCHEMA_VERSION,
    fieldId: stringOrNull(input.fieldId),
    gridCellId: stringOrNull(input.gridCellId),
    timestamp: String(input.timestamp ?? ""),
    source: stringOr(input.source, "manual"),
    positionSource: stringOr(input.positionSource, "unknown"),
    latitude: finiteOrNull(input.latitude),
    longitude: finiteOrNull(input.longitude),
    observationType: OBSERVATION_TYPES[input.observationType] ? input.observationType : "unknown",
    weedCoveragePercent: finiteOrNull(input.weedCoveragePercent),
    cropCoveragePercent: finiteOrNull(input.cropCoveragePercent),
    bareSoilPercent: finiteOrNull(input.bareSoilPercent),
    waterSurfacePercent: finiteOrNull(input.waterSurfacePercent),
    confidence: finiteOrNull(input.confidence),
    severity: SEVERITY_LEVELS.includes(input.severity) ? input.severity : "unknown",
    imageName: String(input.imageName ?? "").trim(),
    modelName: String(input.modelName ?? "").trim(),
    notes: String(input.notes ?? ""),
    // QZ1 / SLAS positioning quality metadata. null = not provided (unknown);
    // never invented for imported data.
    slasActive: booleanOrNull(input.slasActive),
    correctionHealthy: booleanOrNull(input.correctionHealthy),
    satelliteCount: finiteOrNull(input.satelliteCount),
    hdop: finiteOrNull(input.hdop),
    estimatedUncertaintyM: finiteOrNull(input.estimatedUncertaintyM),
    positionQuality: POSITION_QUALITIES.includes(input.positionQuality) ? input.positionQuality : "unknown",
    // On re-normalization keep the original flag so a quality we derived is
    // not mistaken for an imported (authoritative) one.
    positionQualityProvided: typeof input.positionQualityProvided === "boolean"
      ? input.positionQualityProvided
      : POSITION_QUALITIES.includes(input.positionQuality),
    // Association (automatic vs confirmed values are both preserved).
    automaticFieldId: stringOrNull(input.automaticFieldId),
    automaticGridCellId: stringOrNull(input.automaticGridCellId),
    confirmedFieldId: stringOrNull(input.confirmedFieldId),
    confirmedGridCellId: stringOrNull(input.confirmedGridCellId),
    candidateGridCellIds: Array.isArray(input.candidateGridCellIds) ? input.candidateGridCellIds.map(String) : [],
    associationStatus: ASSOCIATION_STATUSES.includes(input.associationStatus) ? input.associationStatus : "unassigned",
    distanceToBoundaryM: finiteOrNull(input.distanceToBoundaryM),
    createdAt: String(input.createdAt ?? now),
    updatedAt: String(input.updatedAt ?? now)
  };
}

export function effectiveGridCellId(observation) {
  return observation.confirmedGridCellId || observation.automaticGridCellId || null;
}

export function effectiveFieldId(observation) {
  return observation.confirmedFieldId || observation.automaticFieldId || observation.fieldId || null;
}

export function requiresReview(observation) {
  return observation.associationStatus === "ambiguous" || observation.associationStatus === "unassigned";
}

/**
 * Validate raw form/import values. Returns { errors, warnings }.
 * errors block saving; warnings (e.g. percent sum) never do.
 */
export function validateObservationInput(input, settings = DEFAULT_VEGETATION_SETTINGS) {
  const errors = [];
  const warnings = [];

  if (!input.timestamp || !Number.isFinite(parseTimestampMs(input.timestamp))) {
    errors.push("観測日時が不正です（timestamp required）。");
  }
  if (input.latitude !== null && input.latitude !== undefined && input.latitude !== "") {
    const lat = Number(input.latitude);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      errors.push("緯度は -90〜90 の数値が必要です。");
    }
  }
  if (input.longitude !== null && input.longitude !== undefined && input.longitude !== "") {
    const lon = Number(input.longitude);
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      errors.push("経度は -180〜180 の数値が必要です。");
    }
  }
  if (input.observationType && !OBSERVATION_TYPES[input.observationType]) {
    errors.push(`観測タイプが不明です: ${input.observationType}`);
  }

  PERCENT_FIELDS.forEach((field) => {
    const value = input[field];
    if (value === null || value === undefined || value === "") {
      return;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) {
      errors.push(`${field} は 0〜100 の数値が必要です。`);
    }
  });

  if (input.confidence !== null && input.confidence !== undefined && input.confidence !== "") {
    const confidence = Number(input.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      errors.push("AI信頼度は 0〜1 の数値が必要です。");
    }
  }
  if (input.severity && !SEVERITY_LEVELS.includes(input.severity)) {
    errors.push(`深刻度が不明です: ${input.severity}`);
  }

  const sumWarning = percentSumWarning(input, settings);
  if (sumWarning) {
    warnings.push(sumWarning);
  }
  return { errors, warnings };
}

/**
 * Non-blocking check: the four coverage percentages should normally add up
 * to ~100%. Entered values are never modified.
 */
export function percentSumWarning(input, settings = DEFAULT_VEGETATION_SETTINGS) {
  const values = PERCENT_FIELDS
    .map((field) => Number(input[field]))
    .filter((value) => Number.isFinite(value));
  if (values.length < PERCENT_FIELDS.length) {
    return null;
  }
  const sum = values.reduce((total, value) => total + value, 0);
  const tolerance = settings.percentSumTolerancePp ?? 5;
  if (Math.abs(sum - 100) > tolerance) {
    return `被覆率の合計が ${sum.toFixed(1)}% です（通常は100%±${tolerance}pt）。値はそのまま保存されます。`;
  }
  return null;
}

export function parseTimestampMs(timestamp) {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : NaN;
}

/** Local ISO string with timezone offset, e.g. 2026-07-18T10:30:00+09:00 */
export function toLocalIso(date) {
  const pad = (value, digits = 2) => String(Math.trunc(Math.abs(value))).padStart(digits, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${sign}${pad(offsetMinutes / 60)}:${pad(offsetMinutes % 60)}`;
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

export function duplicateKey(observation) {
  const lat = Number.isFinite(observation.latitude) ? observation.latitude.toFixed(6) : "";
  const lon = Number.isFinite(observation.longitude) ? observation.longitude.toFixed(6) : "";
  return [observation.timestamp, observation.imageName || "", lat, lon, observation.observationType].join("|");
}

// ---------------------------------------------------------------------------
// Import parsing (JSON / CSV)
// ---------------------------------------------------------------------------

const IMPORT_REQUIRED_FIELDS = ["timestamp", "latitude", "longitude", "observationType"];

const CSV_HEADER_ALIASES = {
  timestamp: "timestamp",
  time: "timestamp",
  datetime: "timestamp",
  latitude: "latitude",
  lat: "latitude",
  longitude: "longitude",
  lon: "longitude",
  lng: "longitude",
  observationtype: "observationType",
  type: "observationType",
  weedcoveragepercent: "weedCoveragePercent",
  weed: "weedCoveragePercent",
  cropcoveragepercent: "cropCoveragePercent",
  crop: "cropCoveragePercent",
  baresoilpercent: "bareSoilPercent",
  baresoil: "bareSoilPercent",
  watersurfacepercent: "waterSurfacePercent",
  watersurface: "waterSurfacePercent",
  confidence: "confidence",
  severity: "severity",
  imagename: "imageName",
  image: "imageName",
  modelname: "modelName",
  model: "modelName",
  notes: "notes",
  note: "notes",
  positionsource: "positionSource",
  source: "source",
  slasactive: "slasActive",
  correctionhealthy: "correctionHealthy",
  satellitecount: "satelliteCount",
  satellites: "satelliteCount",
  hdop: "hdop",
  estimateduncertaintym: "estimatedUncertaintyM",
  positionquality: "positionQuality"
};

/**
 * Parse an AI analysis result file (JSON or CSV) into observation records.
 * Malformed rows are rejected individually with per-row error messages;
 * one bad row never aborts the whole import.
 * Returns { records, errors, format }.
 */
export function parseVegetationImport(text, filename = "") {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    return { records: [], errors: ["ファイルが空です。"], format: "unknown" };
  }
  const looksJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  const looksCsv = /\.csv$/i.test(filename);
  if (looksJson && !looksCsv) {
    return parseImportJson(trimmed);
  }
  return parseImportCsv(trimmed);
}

function parseImportJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { records: [], errors: [`JSONを解析できません: ${error.message}`], format: "json" };
  }
  const rows = Array.isArray(data) ? data : data.observations;
  if (!Array.isArray(rows)) {
    return { records: [], errors: ["observations 配列が見つかりません。"], format: "json" };
  }
  if (!Array.isArray(data) && data.schemaVersion !== undefined && Number(data.schemaVersion) > VEGETATION_SCHEMA_VERSION) {
    return {
      records: [],
      errors: [`未対応の schemaVersion です: ${data.schemaVersion}（対応: ${VEGETATION_SCHEMA_VERSION} 以下）`],
      format: "json"
    };
  }
  return validateImportRows(rows, "json");
}

function parseImportCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length < 2) {
    return { records: [], errors: ["CSVにヘッダー行とデータ行が必要です。"], format: "csv" };
  }
  const headers = splitCsvLine(lines[0]).map((header) => CSV_HEADER_ALIASES[header.trim().toLowerCase().replace(/[\s_-]/g, "")] || null);
  if (!headers.some((header) => header !== null)) {
    return { records: [], errors: ["認識できるCSVヘッダーがありません。"], format: "csv" };
  }
  const rows = lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row = {};
    headers.forEach((field, index) => {
      if (field && cells[index] !== undefined && cells[index] !== "") {
        row[field] = cells[index];
      }
    });
    return row;
  });
  return validateImportRows(rows, "csv");
}

function splitCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function validateImportRows(rows, format) {
  const records = [];
  const errors = [];
  rows.forEach((row, index) => {
    const rowLabel = `${format === "csv" ? "行" : "observation"} ${index + 1}`;
    if (!row || typeof row !== "object") {
      errors.push(`${rowLabel}: レコードがオブジェクトではありません。`);
      return;
    }
    const missing = IMPORT_REQUIRED_FIELDS.filter((field) => row[field] === undefined || row[field] === null || row[field] === "");
    if (missing.length > 0) {
      errors.push(`${rowLabel}: 必須フィールドがありません（${missing.join(", ")}）。`);
      return;
    }
    const candidate = {
      ...row,
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      weedCoveragePercent: numberOrUndefined(row.weedCoveragePercent),
      cropCoveragePercent: numberOrUndefined(row.cropCoveragePercent),
      bareSoilPercent: numberOrUndefined(row.bareSoilPercent),
      waterSurfacePercent: numberOrUndefined(row.waterSurfacePercent),
      confidence: numberOrUndefined(row.confidence),
      satelliteCount: numberOrUndefined(row.satelliteCount),
      hdop: numberOrUndefined(row.hdop),
      estimatedUncertaintyM: numberOrUndefined(row.estimatedUncertaintyM),
      slasActive: parseBoolean(row.slasActive),
      correctionHealthy: parseBoolean(row.correctionHealthy)
    };
    if (!Number.isFinite(candidate.latitude) || !Number.isFinite(candidate.longitude)) {
      errors.push(`${rowLabel}: 緯度・経度が数値ではありません。`);
      return;
    }
    const validation = validateObservationInput(candidate);
    if (validation.errors.length > 0) {
      errors.push(`${rowLabel}: ${validation.errors.join(" ")}`);
      return;
    }
    records.push(normalizeObservation({
      ...candidate,
      source: candidate.source || "camera_ai",
      positionSource: candidate.positionSource || "unknown"
    }));
  });
  return { records, errors, format };
}

/**
 * Merge imported records into an existing observation list.
 * Returns { added, skippedDuplicates } without mutating inputs.
 */
export function mergeImportedObservations(existing, incoming) {
  const seen = new Set(existing.map(duplicateKey));
  const added = [];
  let skippedDuplicates = 0;
  incoming.forEach((record) => {
    const key = duplicateKey(record);
    if (seen.has(key)) {
      skippedDuplicates += 1;
      return;
    }
    seen.add(key);
    added.push(record);
  });
  return { added, skippedDuplicates };
}

// ---------------------------------------------------------------------------
// Geometry (local planar approximation, consistent with the rest of the app)
// ---------------------------------------------------------------------------

export function createLocalProjection(points) {
  const origin = points[0] || [34.6545, 135.8302];
  const metersPerDegreeLat = 111320;
  const metersPerDegreeLon = 111320 * Math.cos(origin[0] * Math.PI / 180);
  return {
    toXY: ([lat, lon]) => ({
      x: (lon - origin[1]) * metersPerDegreeLon,
      y: (lat - origin[0]) * metersPerDegreeLat
    })
  };
}

export function pointInPolygonXY(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    const intersects = ((a.y > point.y) !== (b.y > point.y))
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

export function distanceToPolygonMeters(point, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 2) {
    return Infinity;
  }
  let shortest = Infinity;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    shortest = Math.min(shortest, distancePointToSegment(point, a, b));
  }
  return shortest;
}

function distancePointToSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return Math.hypot(point.x - a.x, point.y - a.y);
  }
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

// ---------------------------------------------------------------------------
// Association with field boundary and grid cells
// ---------------------------------------------------------------------------

/**
 * Compute the automatic association for one observation.
 * geometry = { fieldId, boundary: [[lat,lon],...], cells: [{id, coordinates}], thresholdM }
 * Returns association fields only; never mutates the observation and never
 * silently assigns a near-boundary observation with full confidence.
 */
export function associateObservation(observation, geometry) {
  const { boundary = [], cells = [], thresholdM = 2, fieldId = null } = geometry || {};
  const lat = observation.latitude;
  const lon = observation.longitude;

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return {
      automaticFieldId: null,
      automaticGridCellId: null,
      candidateGridCellIds: [],
      associationStatus: "unassigned",
      distanceToBoundaryM: null,
      insideField: false
    };
  }
  if (boundary.length < 3) {
    return {
      automaticFieldId: null,
      automaticGridCellId: null,
      candidateGridCellIds: [],
      associationStatus: "unassigned",
      distanceToBoundaryM: null,
      insideField: false
    };
  }

  const projection = createLocalProjection(boundary);
  const pointXY = projection.toXY([lat, lon]);
  const boundaryXY = boundary.map(projection.toXY);
  const insideField = pointInPolygonXY(pointXY, boundaryXY);
  const distanceToBoundaryM = distanceToPolygonMeters(pointXY, boundaryXY);
  const nearBoundary = distanceToBoundaryM <= thresholdM;

  const containing = [];
  const nearCells = [];
  cells.forEach((cell) => {
    const cellXY = cell.coordinates.map(projection.toXY);
    if (pointInPolygonXY(pointXY, cellXY)) {
      containing.push(cell.id);
      return;
    }
    if (distanceToPolygonMeters(pointXY, cellXY) <= thresholdM) {
      nearCells.push(cell.id);
    }
  });

  if (!insideField && !nearBoundary) {
    return {
      automaticFieldId: null,
      automaticGridCellId: null,
      candidateGridCellIds: containing.concat(nearCells),
      associationStatus: "unassigned",
      distanceToBoundaryM: round2(distanceToBoundaryM),
      insideField
    };
  }

  const primary = containing[0] || null;
  const candidates = [...new Set(containing.concat(nearCells))];
  const ambiguous = nearBoundary || candidates.length > 1 || (insideField && !primary && cells.length > 0);
  return {
    automaticFieldId: fieldId,
    automaticGridCellId: primary,
    candidateGridCellIds: candidates,
    associationStatus: ambiguous ? "ambiguous" : (primary || cells.length === 0 ? "automatic" : "ambiguous"),
    distanceToBoundaryM: round2(distanceToBoundaryM),
    insideField
  };
}

/**
 * Derive positionQuality without fabricating SLAS status.
 * - Imported explicit positionQuality is preserved.
 * - green requires slasActive && correctionHealthy metadata AND a clean
 *   single-cell association.
 * - yellow: near boundary / ambiguous association / degraded metrics.
 * - red: invalid position, conflicting association, or clearly poor metrics.
 * - unknown: metadata unavailable and no geometric problem detected.
 */
export function derivePositionQuality(observation, association) {
  if (observation.positionQualityProvided) {
    return observation.positionQuality;
  }
  if (!Number.isFinite(observation.latitude) || !Number.isFinite(observation.longitude)) {
    return "red";
  }
  if (observation.correctionHealthy === false) {
    return "red";
  }
  if (Number.isFinite(observation.hdop) && observation.hdop > 5) {
    return "red";
  }
  if (Number.isFinite(observation.estimatedUncertaintyM) && observation.estimatedUncertaintyM > 5) {
    return "red";
  }
  if (association?.associationStatus === "unassigned" && association?.insideField === false && Number.isFinite(association?.distanceToBoundaryM)) {
    return "red";
  }

  const degraded = observation.slasActive === false
    || (Number.isFinite(observation.hdop) && observation.hdop > 2)
    || (Number.isFinite(observation.estimatedUncertaintyM) && observation.estimatedUncertaintyM > 2);
  const ambiguous = association?.associationStatus === "ambiguous";
  if (degraded || ambiguous) {
    return "yellow";
  }

  if (observation.slasActive === true && observation.correctionHealthy === true
    && (association?.associationStatus === "automatic" || association?.associationStatus === "confirmed")) {
    return "green";
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Time series, trend & comparison
// ---------------------------------------------------------------------------

export function sortByTimestamp(observations, direction = "asc") {
  const sorted = [...observations].sort((a, b) => {
    const timeA = parseTimestampMs(a.timestamp);
    const timeB = parseTimestampMs(b.timestamp);
    if (Number.isFinite(timeA) && Number.isFinite(timeB) && timeA !== timeB) {
      return timeA - timeB;
    }
    return String(a.timestamp).localeCompare(String(b.timestamp));
  });
  return direction === "desc" ? sorted.reverse() : sorted;
}

export function observationsForCell(observations, cellId) {
  if (!cellId) {
    return [];
  }
  return sortByTimestamp(observations.filter((observation) => effectiveGridCellId(observation) === cellId));
}

/**
 * Latest / previous analytics for one grid cell.
 * Differences between percentages are expressed in percentage points (pp),
 * never as percent growth.
 */
export function analyzeCellSeries(series, settings = DEFAULT_VEGETATION_SETTINGS, nowMs = Date.now()) {
  const count = series.length;
  const latest = count > 0 ? series[count - 1] : null;
  const previous = count > 1 ? series[count - 2] : null;
  const tolerance = settings.trendTolerancePp ?? 2;

  let weedDeltaPp = null;
  let cropDeltaPp = null;
  if (latest && previous) {
    if (Number.isFinite(latest.weedCoveragePercent) && Number.isFinite(previous.weedCoveragePercent)) {
      weedDeltaPp = latest.weedCoveragePercent - previous.weedCoveragePercent;
    }
    if (Number.isFinite(latest.cropCoveragePercent) && Number.isFinite(previous.cropCoveragePercent)) {
      cropDeltaPp = latest.cropCoveragePercent - previous.cropCoveragePercent;
    }
  }

  let trend = "insufficient_data";
  if (Number.isFinite(weedDeltaPp)) {
    if (weedDeltaPp > tolerance) {
      trend = "increasing";
    } else if (weedDeltaPp < -tolerance) {
      trend = "decreasing";
    } else {
      trend = "stable";
    }
  }

  const latestMs = latest ? parseTimestampMs(latest.timestamp) : NaN;
  const daysSinceLast = Number.isFinite(latestMs) ? (nowMs - latestMs) / 86400000 : null;
  const intervalMs = latest && previous ? parseTimestampMs(latest.timestamp) - parseTimestampMs(previous.timestamp) : NaN;

  return {
    count,
    latest,
    previous,
    weedDeltaPp,
    cropDeltaPp,
    trend,
    daysSinceLast,
    intervalDays: Number.isFinite(intervalMs) ? intervalMs / 86400000 : null
  };
}

export const TREND_LABELS = {
  increasing: "増加 / Increasing",
  decreasing: "減少 / Decreasing",
  stable: "横ばい / Stable",
  insufficient_data: "データ不足 / Insufficient data"
};

/**
 * Comparison warnings between the two most recent observations of a cell.
 * Never auto-diagnoses a pest or disease type — only flags candidates and
 * recommends manual inspection.
 */
export function compareRecentObservations(analysis, settings = DEFAULT_VEGETATION_SETTINGS) {
  const warnings = [];
  const { latest, previous, weedDeltaPp, cropDeltaPp, daysSinceLast } = analysis;
  if (!latest) {
    return warnings;
  }
  const tolerance = settings.trendTolerancePp ?? 2;
  let recommendInspection = false;

  if (Number.isFinite(weedDeltaPp) && weedDeltaPp > tolerance) {
    warnings.push(`雑草被覆率が ${formatPp(weedDeltaPp)} 増加しました。/ Weed coverage increased by ${formatPp(weedDeltaPp)}.`);
    if (weedDeltaPp >= (settings.weedIncreaseAlertPp ?? 5)) {
      recommendInspection = true;
    }
  } else if (Number.isFinite(weedDeltaPp) && weedDeltaPp < -tolerance) {
    warnings.push(`雑草被覆率が ${formatPp(Math.abs(weedDeltaPp))} 減少しました。/ Weed coverage decreased by ${formatPp(Math.abs(weedDeltaPp))}.`);
  }
  if (Number.isFinite(cropDeltaPp) && cropDeltaPp < -tolerance) {
    warnings.push(`稲被覆率が ${formatPp(Math.abs(cropDeltaPp))} 低下しました。/ Crop coverage decreased by ${formatPp(Math.abs(cropDeltaPp))}.`);
    recommendInspection = true;
  }
  if (latest && previous && SEVERITY_RANK[latest.severity] > (SEVERITY_RANK[previous.severity] || 0)) {
    warnings.push(`深刻度が ${previous.severity} から ${latest.severity} に上がりました。/ Severity increased.`);
    recommendInspection = true;
  }
  if (latest && previous && Number.isFinite(latest.confidence) && Number.isFinite(previous.confidence)
    && previous.confidence - latest.confidence >= 0.15) {
    warnings.push(`AI信頼度が ${previous.confidence.toFixed(2)} から ${latest.confidence.toFixed(2)} に低下しました。/ Reduced confidence.`);
  }
  if (Number.isFinite(latest?.confidence) && latest.confidence < (settings.confidenceThreshold ?? 0.7)) {
    warnings.push(`AI信頼度がしきい値 ${Number(settings.confidenceThreshold ?? 0.7).toFixed(2)} を下回っています。/ AI confidence is below the configured threshold.`);
    recommendInspection = true;
  }
  if (Number.isFinite(daysSinceLast) && daysSinceLast >= (settings.staleDays ?? 14)) {
    warnings.push(`${Math.floor(daysSinceLast)}日間観測がありません。/ No observation has been recorded for ${Math.floor(daysSinceLast)} days.`);
    recommendInspection = true;
  }
  if (latest && requiresReview(latest)) {
    warnings.push("位置の関連付けが未確定です。/ Position association requires review.");
    recommendInspection = true;
  }
  if (recommendInspection) {
    warnings.push("現地での手動確認を推奨します。/ Manual inspection is recommended.");
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Inspection priority score (transparent, rule-based; no machine learning)
// ---------------------------------------------------------------------------

/**
 * Weighted rule-based score, clamped to 0–100. Weights (max 100 total):
 *   weed coverage          0–25  (>=30% → 25, >=20% → 20, >=10% → 12, >=5% → 6)
 *   weed increase (pp)     0–20  (>=10 → 20, >=5 → 14, > trend tolerance → 8)
 *   severity               0–15  (high 15, medium 8, unknown 4, low 2)
 *   low AI confidence      0–10  (below threshold 10, unknown 5)
 *   days since inspection  0–15  (>=21 → 15, >=14 → 12, >=7 → 6)
 *   association review     0–10  (ambiguous/unassigned 10, overridden 2)
 *   position quality       0–5   (red 5, yellow 3, unknown 1)
 */
export function inspectionPriority(analysis, settings = DEFAULT_VEGETATION_SETTINGS) {
  const reasons = [];
  let score = 0;
  const latest = analysis.latest;
  if (!latest) {
    return { score: 0, reasons: ["観測がありません。/ No observations."] };
  }

  const weed = latest.weedCoveragePercent;
  if (Number.isFinite(weed)) {
    if (weed >= 30) {
      score += 25;
      reasons.push(`雑草被覆率が30%以上（${weed.toFixed(1)}%）/ Weed coverage above 30%`);
    } else if (weed >= 20) {
      score += 20;
      reasons.push(`雑草被覆率が20%以上（${weed.toFixed(1)}%）/ Weed coverage above 20%`);
    } else if (weed >= 10) {
      score += 12;
      reasons.push(`雑草被覆率が10%以上（${weed.toFixed(1)}%）/ Weed coverage above 10%`);
    } else if (weed >= 5) {
      score += 6;
      reasons.push(`雑草被覆率が5%以上（${weed.toFixed(1)}%）/ Weed coverage above 5%`);
    }
  }

  const delta = analysis.weedDeltaPp;
  if (Number.isFinite(delta)) {
    if (delta >= 10) {
      score += 20;
      reasons.push(`雑草被覆率が ${formatPp(delta)} 急増 / Weed coverage increased by ${formatPp(delta)}`);
    } else if (delta >= 5) {
      score += 14;
      reasons.push(`雑草被覆率が ${formatPp(delta)} 増加 / Weed coverage increased by ${formatPp(delta)}`);
    } else if (delta > (settings.trendTolerancePp ?? 2)) {
      score += 8;
      reasons.push(`雑草被覆率が ${formatPp(delta)} 増加傾向 / Weed coverage increasing`);
    }
  }

  if (latest.severity === "high") {
    score += 15;
    reasons.push("深刻度: 高 / High severity");
  } else if (latest.severity === "medium") {
    score += 8;
    reasons.push("深刻度: 中 / Medium severity");
  } else if (latest.severity === "unknown") {
    score += 4;
    reasons.push("深刻度: 不明 / Severity unknown");
  } else {
    score += 2;
  }

  const threshold = settings.confidenceThreshold ?? 0.7;
  if (Number.isFinite(latest.confidence)) {
    if (latest.confidence < threshold) {
      score += 10;
      reasons.push(`AI信頼度がしきい値未満（${latest.confidence.toFixed(2)} < ${threshold.toFixed(2)}）/ Low AI confidence`);
    }
  } else {
    score += 5;
    reasons.push("AI信頼度が不明 / Confidence unknown");
  }

  const days = analysis.daysSinceLast;
  if (Number.isFinite(days)) {
    if (days >= 21) {
      score += 15;
      reasons.push(`最終観測から${Math.floor(days)}日経過 / Last inspection ${Math.floor(days)} days ago`);
    } else if (days >= (settings.staleDays ?? 14)) {
      score += 12;
      reasons.push(`最終観測から${Math.floor(days)}日経過 / Last inspection ${Math.floor(days)} days ago`);
    } else if (days >= 7) {
      score += 6;
      reasons.push(`最終観測から${Math.floor(days)}日経過 / Last inspection ${Math.floor(days)} days ago`);
    }
  }

  if (requiresReview(latest)) {
    score += 10;
    reasons.push("位置の関連付けが曖昧・未割当 / Position association is ambiguous");
  } else if (latest.associationStatus === "overridden") {
    score += 2;
    reasons.push("関連付けが手動変更されています / Association manually overridden");
  }

  if (latest.positionQuality === "red") {
    score += 5;
    reasons.push("測位品質: 赤 / Position quality red");
  } else if (latest.positionQuality === "yellow") {
    score += 3;
    reasons.push("測位品質: 黄 / Position quality yellow");
  } else if (latest.positionQuality === "unknown") {
    score += 1;
  }

  return { score: Math.max(0, Math.min(100, Math.round(score))), reasons };
}

// ---------------------------------------------------------------------------
// Map-mode classification & legend (central style helper)
// ---------------------------------------------------------------------------

/**
 * Classify the latest observation of a cell for a vegetation map mode.
 * Returns { color, label, value } or the shared no-data style when the value
 * needed by the mode is unavailable.
 */
export function classifyForMode(mode, observation, nowMs = Date.now()) {
  const definition = VEGETATION_MAP_MODES[mode];
  if (!definition || !observation) {
    return { color: NO_DATA_STYLE.fillColor, label: NO_DATA_STYLE.label, value: null, noData: true };
  }
  if (mode === "severity") {
    const entry = definition.categories.find((category) => category.value === observation.severity)
      || definition.categories.at(-1);
    return { color: entry.color, label: entry.label, value: observation.severity, noData: false };
  }
  let value = null;
  if (mode === "weed") {
    value = observation.weedCoveragePercent;
  } else if (mode === "crop") {
    value = observation.cropCoveragePercent;
  } else if (mode === "confidence") {
    value = observation.confidence;
  } else if (mode === "age") {
    const ms = parseTimestampMs(observation.timestamp);
    value = Number.isFinite(ms) ? (nowMs - ms) / 86400000 : null;
  }
  if (!Number.isFinite(value)) {
    return { color: NO_DATA_STYLE.fillColor, label: NO_DATA_STYLE.label, value: null, noData: true };
  }
  const bucket = definition.buckets.find((candidate) => value <= candidate.max) || definition.buckets.at(-1);
  return { color: bucket.color, label: bucket.label, value, noData: false };
}

export function legendForMode(mode) {
  const definition = VEGETATION_MAP_MODES[mode];
  if (!definition) {
    return [];
  }
  const entries = definition.categories
    ? definition.categories.map((category) => ({ color: category.color, label: category.label }))
    : definition.buckets.map((bucket) => ({ color: bucket.color, label: bucket.label }));
  return entries.concat([{ color: NO_DATA_STYLE.fillColor, label: NO_DATA_STYLE.label }]);
}

// ---------------------------------------------------------------------------
// Summary dashboard
// ---------------------------------------------------------------------------

export function computeVegetationSummary(observations, cells, settings = DEFAULT_VEGETATION_SETTINGS, nowMs = Date.now()) {
  const cellIds = new Set(cells.map((cell) => cell.id));
  const byCell = new Map();
  observations.forEach((observation) => {
    const cellId = effectiveGridCellId(observation);
    if (!cellId) {
      return;
    }
    if (!byCell.has(cellId)) {
      byCell.set(cellId, []);
    }
    byCell.get(cellId).push(observation);
  });

  let highSeverityCells = 0;
  let increasingWeedCells = 0;
  const observedCellIds = new Set();
  byCell.forEach((cellObservations, cellId) => {
    if (cellIds.size > 0 && !cellIds.has(cellId)) {
      return;
    }
    observedCellIds.add(cellId);
    const analysis = analyzeCellSeries(sortByTimestamp(cellObservations), settings, nowMs);
    if (analysis.latest?.severity === "high") {
      highSeverityCells += 1;
    }
    if (analysis.trend === "increasing") {
      increasingWeedCells += 1;
    }
  });

  const weedValues = observations
    .map((observation) => observation.weedCoveragePercent)
    .filter((value) => Number.isFinite(value));
  const timestamps = observations
    .map((observation) => ({ raw: observation.timestamp, ms: parseTimestampMs(observation.timestamp) }))
    .filter((entry) => Number.isFinite(entry.ms))
    .sort((a, b) => a.ms - b.ms);

  return {
    totalObservations: observations.length,
    cellsWithObservations: observedCellIds.size,
    cellsWithoutObservations: Math.max(0, cellIds.size - observedCellIds.size),
    highSeverityCells,
    increasingWeedCells,
    reviewRequiredObservations: observations.filter(requiresReview).length,
    averageWeedCoveragePercent: weedValues.length > 0
      ? weedValues.reduce((total, value) => total + value, 0) / weedValues.length
      : null,
    latestObservationTimestamp: timestamps.at(-1)?.raw || null
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function formatPp(value) {
  return `${Math.abs(value) >= 10 ? value.toFixed(1) : value.toFixed(1)}pt`;
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function numberOrUndefined(value) {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  return Number(value);
}

function booleanOrNull(value) {
  if (value === true || value === false) {
    return value;
  }
  return null;
}

function parseBoolean(value) {
  if (value === true || value === false) {
    return value;
  }
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "true" || lower === "1" || lower === "yes") {
      return true;
    }
    if (lower === "false" || lower === "0" || lower === "no") {
      return false;
    }
  }
  return null;
}

function stringOrNull(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

function stringOr(value, fallback) {
  return typeof value === "string" && value !== "" ? value : fallback;
}

function round2(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : value;
}
