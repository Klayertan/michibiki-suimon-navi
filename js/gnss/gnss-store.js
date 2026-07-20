export class GnssStore extends EventTarget {
  constructor() {
    super();
    this.receivers = new Map();
    this.sessions = new Map();
    this.observations = new Map();
    this.registerReceiver({ id: "qz1", displayName: "QZ1", role: "qz1", capabilities: { qzssL1S: true, qzssGsv: true, explicitSlasStatus: false, dcrOutput: null } });
    this.registerReceiver({ id: "reference", displayName: "比較用GPS受信機", role: "reference", capabilities: { qzssL1S: null, qzssGsv: null, explicitSlasStatus: false, dcrOutput: null } });
    this.registerReceiver({ id: "legacy-unknown", displayName: "旧形式・受信機不明", role: "unknown", capabilities: {} });
  }

  registerReceiver(receiver) {
    const normalized = {
      id: receiver.id || makeId("receiver"),
      displayName: receiver.displayName || receiver.model || "受信機",
      manufacturer: receiver.manufacturer || "",
      model: receiver.model || "",
      firmware: receiver.firmware || "",
      role: receiver.role || "unknown",
      capabilities: { ...(receiver.capabilities || {}) },
      capabilityEvidence: receiver.capabilityEvidence || []
    };
    this.receivers.set(normalized.id, normalized);
    return normalized;
  }

  addParsedSession(parsed) {
    this.sessions.set(parsed.session.id, { ...parsed.session });
    this.observations.set(parsed.session.id, parsed.observations.map((observation) => ({ ...observation })));
    this.emitChange();
    return parsed.session;
  }

  addLegacyPoints(records, options = {}) {
    const sessionId = options.sessionId || makeId("legacy-session");
    const observations = records.map((record, index) => ({
      id: `${sessionId}:obs-${index}`,
      sessionId,
      receiverId: options.receiverId || "legacy-unknown",
      sequence: index,
      sourceLine: null,
      timestampUtcMs: parseLegacyTimestamp(record.timestamp),
      timeOfDay: String(record.timestamp || ""),
      timeOfDayMs: null,
      loggerTimestamp: null,
      lat: Number(record.lat),
      lon: Number(record.lon),
      altitudeMsl: finiteOrNull(record.altitude),
      fixQuality: finiteOrNull(record.fixQuality),
      fixValid: Number.isFinite(Number(record.lat)) && Number.isFinite(Number(record.lon)),
      satellites: finiteOrNull(record.satelliteCount ?? record.satellites),
      hdop: finiteOrNull(record.hdop),
      pdop: null,
      vdop: null,
      rmcMode: null,
      augmentation: { service: null, status: "unknown", evidence: [] },
      qzss: { visibleCount: null, satellites: [], usedInFix: null },
      checksumValid: null,
      rawRefs: [],
      feature: record.feature || "unknown",
      note: record.note || "",
      photoRef: record.photoRef || ""
    })).filter((observation) => Number.isFinite(observation.lat) && Number.isFinite(observation.lon));
    return this.addParsedSession({
      session: {
        id: sessionId,
        receiverId: options.receiverId || "legacy-unknown",
        captureGroupId: options.captureGroupId || "capture-default",
        sourceType: "legacy-json",
        sourceName: options.sourceName || "旧形式の測量JSON",
        simulated: false,
        expectedRateHz: 1,
        captureDate: null,
        manualClockOffsetMs: 0,
        parserSummary: { observationCount: observations.length, validFixCount: observations.length, noFixCount: 0, sentenceCounts: {} },
        warnings: ["旧形式のため受信機・生NMEA・完全な時刻の証拠がありません。"]
      },
      observations
    });
  }

  removeSession(sessionId) {
    this.sessions.delete(sessionId);
    this.observations.delete(sessionId);
    this.emitChange();
  }

  getReceiver(id) {
    return this.receivers.get(id) || null;
  }

  getSession(id) {
    return this.sessions.get(id) || null;
  }

  getSessionsByRole(role) {
    return [...this.sessions.values()].filter((session) => this.getReceiver(session.receiverId)?.role === role);
  }

  getObservations(sessionId, options = {}) {
    const values = this.observations.get(sessionId) || [];
    return options.validOnly ? values.filter((observation) => observation.fixValid) : values;
  }

  clear() {
    this.sessions.clear();
    this.observations.clear();
    this.emitChange();
  }

  serialize() {
    return {
      receivers: [...this.receivers.values()],
      sessions: [...this.sessions.values()],
      observations: [...this.observations.values()].flat()
    };
  }

  hydrate(data) {
    this.receivers.clear();
    (data.receivers || []).forEach((receiver) => this.registerReceiver(receiver));
    if (!this.receivers.has("legacy-unknown")) this.registerReceiver({ id: "legacy-unknown", displayName: "旧形式・受信機不明", role: "unknown", capabilities: {} });
    this.sessions.clear();
    this.observations.clear();
    (data.sessions || []).forEach((session) => {
      this.sessions.set(session.id, { ...session });
      this.observations.set(session.id, []);
    });
    (data.observations || []).forEach((observation) => {
      if (!this.observations.has(observation.sessionId)) this.observations.set(observation.sessionId, []);
      this.observations.get(observation.sessionId).push({ ...observation });
    });
    this.emitChange();
  }

  emitChange() {
    this.dispatchEvent(new Event("change"));
  }
}

export function makeId(prefix) {
  const token = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${token}`;
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseLegacyTimestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
