// QZ1 field-recording: pure logic (no DOM, no IndexedDB, no Leaflet).
// Mirrors the vegetation-core.js / assurance-engine.js split in this repo:
// state machines, classification and formatting live here so they can be
// unit tested with node:test; recording-controller.js owns the DOM/IndexedDB
// wiring and recording-store.js owns persistence.

// ---------------------------------------------------------------------------
// Connection state machine
// ---------------------------------------------------------------------------
// Connection state (is the serial link open?) and recording state (is a
// session actively capturing?) are intentionally independent — connecting to
// QZ1 must never implicitly start a permanent recording session.

export const CONNECTION_STATES = [
  "unsupported", "disconnected", "requesting", "opening",
  "connected", "stalled", "disconnecting", "error"
];

export const CONNECTION_STATE_LABELS = {
  unsupported: "非対応",
  disconnected: "未接続",
  requesting: "選択中",
  opening: "接続中…",
  connected: "接続中",
  stalled: "受信なし",
  disconnecting: "切断中",
  error: "エラー"
};

// ---------------------------------------------------------------------------
// Recording state machine
// ---------------------------------------------------------------------------

export const RECORDING_STATES = ["idle", "recording", "paused", "stopped", "recovery_available"];

const RECORDING_TRANSITIONS = {
  idle: { start: "recording" },
  recovery_available: { resume: "recording", finish: "stopped", delete: "idle" },
  recording: { pause: "paused", stop: "stopped" },
  paused: { resume: "recording", stop: "stopped" },
  stopped: { start: "recording" }
};

/** Returns the next state for (current, action), or null if the transition is invalid. */
export function nextRecordingState(current, action) {
  return RECORDING_TRANSITIONS[current]?.[action] ?? null;
}

export function canTransitionRecording(current, action) {
  return nextRecordingState(current, action) !== null;
}

// ---------------------------------------------------------------------------
// NMEA checksum verification (diagnostics only — the existing shared parser
// in index.html does not verify checksums, so this adds a genuinely new
// signal rather than duplicating parsing logic).
// ---------------------------------------------------------------------------

/**
 * Returns true/false for a line shaped like "$...*HH", or null when the line
 * has no checksum suffix at all (not a checksummed NMEA sentence).
 */
export function verifyNmeaChecksum(line) {
  const match = /^\$([^*]*)\*([0-9A-Fa-f]{2})/.exec(String(line ?? ""));
  if (!match) {
    return null;
  }
  const [, body, hex] = match;
  let checksum = 0;
  for (let i = 0; i < body.length; i += 1) {
    checksum ^= body.charCodeAt(i);
  }
  return checksum === Number.parseInt(hex, 16);
}

// ---------------------------------------------------------------------------
// Four-tier stall diagnostics
// ---------------------------------------------------------------------------
// The four signals are tracked separately so the UI never collapses them
// into one generic "stalled" warning: a device that streams bytes but no
// complete sentence, a receiver with sentences but no fix yet, and a session
// whose last known fix is simply old are all distinct, actionable states.

export const DEFAULT_DIAGNOSTIC_THRESHOLDS_MS = {
  byteStallMs: 8000,
  lineStallMs: 8000,
  staleFixMs: 30000
};

export const DIAGNOSTIC_MESSAGES = {
  "not-connected": "Serial not connected. / シリアル未接続です。",
  "no-data": "No data received yet. / まだデータを受信していません。",
  byte: "Serial stream stalled. / シリアル通信が停止しています。",
  line: "Receiving data but no complete NMEA sentence. / データは届いていますが、完全なNMEA文がありません。",
  "no-fix": "No valid fix yet. / まだ有効な測位がありません。",
  "stale-fix": "Latest valid fix is stale. / 最新の有効な測位が古くなっています。",
  ok: ""
};

/**
 * times: { lastByteMs, lastLineMs, lastChecksumMs, lastFixMs } — any of
 * these may be null/undefined when that event has never occurred.
 *
 * everConnected distinguishes "never successfully connected yet" (and,
 * transitively, "connected but zero bytes received yet") from a genuine
 * stall: the byte/line/fix tiers below only ever fire once a signal has
 * actually been observed at least once and then goes quiet past its
 * threshold. Before that, the state is neutral, not alarming.
 */
export function classifySerialDiagnostics(times, nowMs, thresholds = DEFAULT_DIAGNOSTIC_THRESHOLDS_MS, { everConnected = true } = {}) {
  const byteAgeMs = ageMs(times.lastByteMs, nowMs);
  const lineAgeMs = ageMs(times.lastLineMs, nowMs);
  const checksumAgeMs = ageMs(times.lastChecksumMs, nowMs);
  const fixAgeMs = ageMs(times.lastFixMs, nowMs);
  const ages = { byteAgeMs, lineAgeMs, checksumAgeMs, fixAgeMs };

  if (!everConnected) {
    return { tier: "not-connected", message: DIAGNOSTIC_MESSAGES["not-connected"], ...ages };
  }
  if (byteAgeMs === null) {
    return { tier: "no-data", message: DIAGNOSTIC_MESSAGES["no-data"], ...ages };
  }
  if (byteAgeMs >= thresholds.byteStallMs) {
    return { tier: "byte", message: DIAGNOSTIC_MESSAGES.byte, ...ages };
  }
  if (lineAgeMs === null || lineAgeMs >= thresholds.lineStallMs) {
    return { tier: "line", message: DIAGNOSTIC_MESSAGES.line, ...ages };
  }
  if (fixAgeMs === null) {
    return { tier: "no-fix", message: DIAGNOSTIC_MESSAGES["no-fix"], ...ages };
  }
  if (fixAgeMs >= thresholds.staleFixMs) {
    return { tier: "stale-fix", message: DIAGNOSTIC_MESSAGES["stale-fix"], ...ages };
  }
  return { tier: "ok", message: DIAGNOSTIC_MESSAGES.ok, ...ages };
}

function ageMs(timestamp, nowMs) {
  return Number.isFinite(timestamp) ? Math.max(0, nowMs - timestamp) : null;
}

// ---------------------------------------------------------------------------
// Marked observations
// ---------------------------------------------------------------------------

export const OBSERVATION_TYPES = {
  water_level: "水位 / Water level",
  weed: "雑草 / Weed",
  crop_stress_candidate: "生育ストレス候補 / Crop stress candidate",
  suspected_pest_damage: "害虫被害の疑い / Suspected pest damage",
  suspected_disease: "病害の疑い / Suspected disease",
  inlet_outlet_issue: "取水・排水口の異常 / Inlet/outlet issue",
  levee_damage: "畦の損傷 / Levee damage",
  other: "その他 / Other"
};

export const DEFAULT_FIX_STALE_MS = 10000;

// Image attachments are resized/re-encoded before ever touching IndexedDB —
// these are the configurable defaults; recording-controller.js accepts
// overrides via constructor options.
export const DEFAULT_IMAGE_MAX_DIMENSION_PX = 1920;
export const DEFAULT_IMAGE_QUALITY = 0.8;
export const DEFAULT_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/** Whether the latest fix is too old to attach to a new observation. */
export function isFixStale(fix, nowMs, staleMs = DEFAULT_FIX_STALE_MS) {
  if (!fix || !Number.isFinite(fix.receivedAtMs)) {
    return true;
  }
  return nowMs - fix.receivedAtMs > staleMs;
}

/**
 * Checks whether "現在地を記録" may proceed. Returns { ok, reason }.
 * Never fabricates a position — refuses instead of using a stale/missing fix.
 */
export function validateObservationCreation(fix, nowMs, staleMs = DEFAULT_FIX_STALE_MS) {
  if (!fix) {
    return { ok: false, reason: "有効な測位がまだありません。/ No valid fix received yet." };
  }
  if (isFixStale(fix, nowMs, staleMs)) {
    return { ok: false, reason: `最新の測位が古すぎます（${Math.round((nowMs - fix.receivedAtMs) / 1000)}秒前）。/ Latest fix is stale.` };
  }
  if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lon)) {
    return { ok: false, reason: "測位に緯度・経度がありません。/ Fix has no coordinates." };
  }
  return { ok: true, reason: "" };
}

/**
 * Builds a marked-observation record from the latest fix. Caller must have
 * already validated with validateObservationCreation. SLAS/augmentation
 * status is only included when the fix genuinely carries it (fixQuality
 * 2/4/5 from the receiver) — never fabricated for a plain single fix.
 */
export function buildMarkedObservation({
  id, sessionId, fix, fieldId = null, gridCellId = null,
  observationType = "other", note = "", waterLevel = null,
  imageRef = null, imageName = null, positionSource = "qz1_serial", nowIso
}) {
  return {
    id,
    sessionId,
    timestamp: nowIso,
    latitude: fix.lat,
    longitude: fix.lon,
    altitude: Number.isFinite(fix.altitude) ? fix.altitude : null,
    fixQuality: Number.isFinite(fix.fixQuality) ? fix.fixQuality : null,
    satelliteCount: Number.isFinite(fix.satellites) ? fix.satellites : null,
    hdop: Number.isFinite(fix.hdop) ? fix.hdop : null,
    fixAugmented: fix.augmented === true,
    rawSourceSentence: fix.rawLine || "",
    fieldId,
    gridCellId,
    observationType: OBSERVATION_TYPES[observationType] ? observationType : "other",
    note: String(note ?? ""),
    waterLevel: Number.isFinite(Number(waterLevel)) ? Number(waterLevel) : null,
    imageRef: imageRef || null,
    imageName: imageName || null,
    positionSource,
    createdAt: nowIso,
    updatedAt: nowIso
  };
}

// ---------------------------------------------------------------------------
// CSV export helpers
// ---------------------------------------------------------------------------

function csvEscape(value) {
  const str = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function toCsv(header, rows) {
  return [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n");
}

export function structuredFixesToCsv(fixes) {
  const header = ["receivedAt", "timestamp", "lat", "lon", "altitude", "fixQuality", "satellites", "hdop", "rawLine"];
  const rows = fixes.map((fix) => header.map((key) => fix[key] ?? ""));
  return toCsv(header, rows);
}

export function markedObservationsToCsv(observations) {
  const header = [
    "id", "timestamp", "latitude", "longitude", "altitude", "fixQuality", "satelliteCount", "hdop",
    "observationType", "note", "waterLevel", "imageRef", "imageName", "positionSource", "fieldId", "gridCellId"
  ];
  const rows = observations.map((observation) => header.map((key) => observation[key] ?? ""));
  return toCsv(header, rows);
}

// ---------------------------------------------------------------------------
// IDs and filenames
// ---------------------------------------------------------------------------

let sessionIdSeq = 0;
export function makeSessionId() {
  sessionIdSeq += 1;
  return `rec-${Date.now().toString(36)}-${sessionIdSeq.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

let observationIdSeq = 0;
export function makeObservationId() {
  observationIdSeq += 1;
  return `obs-${Date.now().toString(36)}-${observationIdSeq.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function recordingFilename(sessionId, kind, ext, nowMs = Date.now()) {
  const stamp = new Date(nowMs).toISOString().slice(0, 16).replace(/[:T]/g, "-");
  return `qz1-recording-${sessionId}-${kind}-${stamp}.${ext}`;
}

// ---------------------------------------------------------------------------
// Storage usage formatting
// ---------------------------------------------------------------------------

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "—";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}
