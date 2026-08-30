// The floating sensor as a thing with a name, and the rules about which paddy
// it belongs to.
//
// SENSOR IDENTITY IS NOT FIELD IDENTITY
// -------------------------------------
// A float knows one thing about itself: that it is `QZ1-FLOAT-001`. It does
// not know, and must never be told, that it is in FIELD-003. Those are two
// separate facts joined by a third — the GNSS position — and keeping them
// separate is what makes the device replaceable, movable and auditable:
//
//   sensorId          burned in, stable for the life of the hardware
//   detectedFieldId   recomputed from position every second, never stored
//   assignedFieldId   written once, by a person, and only by a person
//
// DETECTED IS NOT ASSIGNED
// ------------------------
// `detectedFieldId` is an observation. `assignedFieldId` is a decision. This
// module will never turn the first into the second on its own. When they
// disagree the answer is a WARNING, not a reassignment: a float that drifts
// under a levee into next door's paddy, a boundary the farmer walked slightly
// wrong, and a float someone genuinely carried to another field all look
// identical from here, and only one of them should move the assignment.
// `assign()` is the sole writer of `assignedFieldId`, and nothing in this file
// calls it.
//
// PERSISTENCE
// -----------
// Its own storage key, alongside the app's other per-domain keys
// (`suimonNaviFieldAnnotationsV2`, `suimonNaviTargetWaterLevelV1`, …), read
// and written through the injected `Storage`-shaped object so it is
// account-scoped like the rest — see js/cloud/user-scope.js. This is a device
// registry, not a second field database: it stores field IDs and never field
// geometry, and it is the field store that remains the only place a boundary
// lives.

import {
  DEFAULT_DEVICE_MODEL,
  normalizeDeviceModel,
  normalizeSensorSettings
} from "./sensor-settings.js";

// The key is unchanged at V1 on purpose. The record GREW (displayName,
// deviceModel, settings, calibration) but nothing was renamed or removed, so
// a V1 record read by this build normalizes into a V2 record with defaults
// filled in, and a V2 record read by an older build still finds every field
// it knew about. Bumping the key would strand every sensor a farmer has
// already registered; bumping only the version number inside it records the
// change without breaking the read.
export const SENSOR_STORAGE_KEY = "suimonNaviFloatingSensorsV1";
export const SENSOR_SCHEMA_VERSION = 2;

/** The only device type this milestone knows about. */
export const SENSOR_TYPE_FLOATING_WATER_LEVEL = "qz1-floating-water-level";

/**
 * Assignment states. Explicit, because the alternative — an `isAssigned`
 * beside an `isAmbiguous` beside a `hasMoved` — makes states like "assigned
 * AND ambiguous AND detecting" representable, and then someone has to decide
 * at each render which flag wins.
 */
export const ASSIGNMENT_STATES = {
  /** No assignment, and not enough evidence yet to suggest one. */
  UNASSIGNED: "unassigned",
  /** No assignment; positions arriving, window still filling. */
  DETECTING: "detecting",
  /** No assignment; one field has cleared the confidence threshold. */
  CANDIDATE: "candidate",
  /** Assigned and confirmed. Only an explicit action leaves this state. */
  LOCKED: "locked",
  /** No assignment; confidently contained by no registered field. */
  OUTSIDE_KNOWN_FIELDS: "outside-known-fields",
  /** No assignment; confidently contained by more than one field. */
  AMBIGUOUS: "ambiguous",
  /** Assigned, but sustained evidence places it somewhere else. */
  MOVED_WARNING: "moved-warning"
};

/** Consecutive confident, mismatching window verdicts before a warning. */
export const DEFAULT_MOVEMENT_THRESHOLD = 3;

const SENSOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * `QZ1-FLOAT-001`, `QZ1-FLOAT-002`, …
 *
 * Derived from a counter, never from a position: a sensor that is picked up
 * and moved must keep its name, and two floats sitting a metre apart must not
 * be able to collide into one identity.
 */
export function makeSensorId(index) {
  const n = Number.isInteger(index) && index > 0 ? index : 1;
  return `QZ1-FLOAT-${String(n).padStart(3, "0")}`;
}

/** The next id not already taken. */
export function nextAvailableSensorId(existingIds = []) {
  const taken = new Set((existingIds || []).map((id) => String(id)));
  let n = 1;
  while (taken.has(makeSensorId(n))) {
    n += 1;
  }
  return makeSensorId(n);
}

/** Trimmed and validated, or null. Never invents an id from something else. */
export function normalizeSensorId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  return SENSOR_ID_PATTERN.test(id) ? id : null;
}

/**
 * A new sensor record.
 *
 * `assignedFieldId` starts null and `assignmentStatus` starts UNASSIGNED: a
 * device that has just been named has told us nothing about where it is.
 */
export function buildSensor({
  sensorId,
  type = SENSOR_TYPE_FLOATING_WATER_LEVEL,
  label = "",
  displayName = "",
  deviceModel = DEFAULT_DEVICE_MODEL,
  settings = null,
  nowIso = new Date().toISOString()
} = {}) {
  const id = normalizeSensorId(sensorId);
  if (!id) {
    return null;
  }
  return {
    sensorId: id,
    type: String(type || SENSOR_TYPE_FLOATING_WATER_LEVEL),
    // `label` predates `displayName` and is kept so nothing that already reads
    // it breaks. `displayName` is the one the UI shows and the farmer edits;
    // renaming it must never touch `sensorId`, which is the hardware.
    label: String(label ?? ""),
    displayName: String(displayName ?? ""),
    deviceModel: normalizeDeviceModel(deviceModel),
    assignedFieldId: null,
    assignmentStatus: ASSIGNMENT_STATES.UNASSIGNED,
    settings: normalizeSensorSettings(settings),
    /** Set only by an explicit calibration action. See calibration.js. */
    calibration: null,
    lastPosition: null,
    lastSeenAt: null,
    assignmentHistory: [],
    createdAt: nowIso,
    updatedAt: nowIso
  };
}

/**
 * What the UI calls this sensor.
 *
 * Falls back to the stable id rather than to an empty string: a card with a
 * blank heading is worse than one headed `QZ1-FLOAT-001`, and the id is
 * always present.
 */
export function sensorDisplayName(sensor) {
  const name = typeof sensor?.displayName === "string" ? sensor.displayName.trim() : "";
  if (name) {
    return name;
  }
  const legacy = typeof sensor?.label === "string" ? sensor.label.trim() : "";
  return legacy || String(sensor?.sensorId ?? "");
}

/**
 * One entry in the sensor's own audit trail.
 *
 * Append-only. The history is what lets someone a season later answer "which
 * paddy did this float report from in August?" without trusting the current
 * assignment, which by then may have changed twice.
 */
export function buildAssignmentEvent({ action, fieldId = null, at = new Date().toISOString(), note = "" }) {
  return {
    at: String(at),
    action: String(action),
    fieldId: fieldId === null || fieldId === undefined ? null : String(fieldId),
    note: String(note ?? "")
  };
}

/**
 * A measurement, stamped with the field the sensor is assigned to RIGHT NOW.
 *
 * The stamp is copied in at build time and never recomputed. If the float is
 * later moved to FIELD-005, records already written keep saying FIELD-003,
 * because that is where the water they measured actually was. Rewriting them
 * would silently relabel a season of readings.
 *
 * An unassigned sensor produces `fieldId: null` rather than a guess from
 * `detectedFieldId`: detection is not assignment, and a measurement filed
 * against a field nobody confirmed is worse than one filed against none.
 */
export function buildSensorMeasurement({
  sensor,
  relativeHeightMm = null,
  altitudeM = null,
  latitude = null,
  longitude = null,
  timestamp = new Date().toISOString()
} = {}) {
  if (!sensor?.sensorId) {
    return null;
  }
  return {
    timestamp: String(timestamp),
    sensorId: String(sensor.sensorId),
    fieldId: sensor.assignedFieldId === null || sensor.assignedFieldId === undefined
      ? null
      : String(sensor.assignedFieldId),
    // Recorded so a later reader can tell a measurement taken under a
    // confirmed assignment from one taken while the sensor was flagged as
    // possibly moved. Both are real readings; they do not carry equal weight.
    assignmentStatusAtMeasurement: String(sensor.assignmentStatus ?? ASSIGNMENT_STATES.UNASSIGNED),
    relativeHeightMm: Number.isFinite(relativeHeightMm) ? relativeHeightMm : null,
    altitudeM: Number.isFinite(altitudeM) ? altitudeM : null,
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null
  };
}

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

/**
 * Sustained evidence that a locked sensor is somewhere other than where it was
 * assigned.
 *
 * Counts CONSECUTIVE confident window verdicts that name a different field.
 * Any verdict that agrees with the assignment, or that is not confident,
 * resets the count to zero — so a float bobbing across a boundary produces a
 * count that never climbs, while one that has genuinely been carried away
 * produces one that does.
 *
 * HOW LONG THAT ACTUALLY TAKES. The window has to become confident about the
 * other field first, which at the defaults costs ten valid fixes; each fix
 * after that yields another confident verdict, so the run of three completes
 * three fixes later. Roughly THIRTEEN valid fixes in total — about thirteen
 * seconds at 1 Hz. The heavy lifting is done by the window's own threshold;
 * this counter's job is to insist the window stays settled rather than
 * flickering through a confident state on its way somewhere else.
 */
export class MovementWatch {
  constructor({ threshold = DEFAULT_MOVEMENT_THRESHOLD } = {}) {
    if (!Number.isInteger(threshold) || threshold < 1) {
      throw new Error("movement threshold must be an integer >= 1");
    }
    this.threshold = threshold;
    this.consecutiveMismatches = 0;
    this.mismatchFieldId = null;
  }

  /**
   * @param assignedFieldId the sensor's confirmed field, or null
   * @param windowSummary   the current FieldDetectionWindow verdict
   * @returns {{ warned: boolean, consecutiveMismatches: number, mismatchFieldId: string|null }}
   */
  update(assignedFieldId, windowSummary) {
    const detected = windowSummary?.detectedFieldId ?? null;
    const isConfidentMismatch = Boolean(assignedFieldId)
      && windowSummary?.decided === true
      && detected !== null
      && String(detected) !== String(assignedFieldId);

    if (!isConfidentMismatch) {
      this.consecutiveMismatches = 0;
      this.mismatchFieldId = null;
      return this.summary();
    }
    // A run has to be about the SAME other field. Alternating between two
    // neighbours is a boundary artefact, not a relocation.
    if (this.mismatchFieldId !== null && this.mismatchFieldId !== String(detected)) {
      this.consecutiveMismatches = 1;
      this.mismatchFieldId = String(detected);
      return this.summary();
    }
    this.mismatchFieldId = String(detected);
    this.consecutiveMismatches += 1;
    return this.summary();
  }

  summary() {
    return {
      warned: this.consecutiveMismatches >= this.threshold,
      consecutiveMismatches: this.consecutiveMismatches,
      mismatchFieldId: this.mismatchFieldId,
      threshold: this.threshold
    };
  }

  reset() {
    this.consecutiveMismatches = 0;
    this.mismatchFieldId = null;
    return this.summary();
  }
}

/**
 * The sensor's assignment status, derived from its assignment plus the current
 * evidence. Pure — it returns a status, it does not write one.
 *
 * The ordering matters: an ASSIGNED sensor is only ever LOCKED or
 * MOVED_WARNING. It is never dragged back to CANDIDATE or AMBIGUOUS by the
 * detection window, because those are states about choosing a field, and this
 * one has already been chosen. That is what "a single noisy sample must not
 * change locked" means in practice — and it holds for a thousand noisy samples
 * too.
 */
export function deriveAssignmentStatus({ sensor, windowSummary, movementSummary }) {
  const assignedFieldId = sensor?.assignedFieldId ?? null;

  if (assignedFieldId) {
    return movementSummary?.warned
      ? ASSIGNMENT_STATES.MOVED_WARNING
      : ASSIGNMENT_STATES.LOCKED;
  }

  if (!windowSummary || windowSummary.totalSampleCount === 0) {
    return ASSIGNMENT_STATES.UNASSIGNED;
  }
  if (!windowSummary.decided) {
    return ASSIGNMENT_STATES.DETECTING;
  }
  switch (windowSummary.status) {
    case "candidate":
      return ASSIGNMENT_STATES.CANDIDATE;
    case "outside-known-fields":
      return ASSIGNMENT_STATES.OUTSIDE_KNOWN_FIELDS;
    case "ambiguous":
      return ASSIGNMENT_STATES.AMBIGUOUS;
    default:
      return ASSIGNMENT_STATES.DETECTING;
  }
}

/** True when the UI may offer "assign this sensor to the detected field". */
export function canAssignFromDetection({ sensor, windowSummary }) {
  return !sensor?.assignedFieldId
    && windowSummary?.decided === true
    && Boolean(windowSummary.detectedFieldId);
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * The set of known floating sensors, persisted.
 *
 * An EventTarget like GnssStore/FieldRegistry, so a view can subscribe to
 * `change` rather than being called back through a constructor option.
 */
export class FloatingSensorRegistry extends EventTarget {
  constructor({ storage = null, storageKey = SENSOR_STORAGE_KEY } = {}) {
    super();
    this.storage = storage;
    this.storageKey = storageKey;
    /** sensorId -> sensor record */
    this.sensors = new Map();
  }

  /** Reads persisted sensors. Never throws: corrupt storage starts empty. */
  hydrate() {
    if (!this.storage) {
      return this;
    }
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        for (const record of normalizeSensorList(parsed?.sensors)) {
          this.sensors.set(record.sensorId, record);
        }
      }
    } catch {
      this.sensors.clear();
    }
    this.emitChange();
    return this;
  }

  persist() {
    if (!this.storage) {
      return;
    }
    try {
      this.storage.setItem(this.storageKey, JSON.stringify({
        schemaVersion: SENSOR_SCHEMA_VERSION,
        sensors: [...this.sensors.values()]
      }));
    } catch {
      // Quota exceeded / private-browsing denial: keep working in memory.
    }
  }

  list() {
    return [...this.sensors.values()];
  }

  get(sensorId) {
    const id = normalizeSensorId(sensorId);
    return id ? this.sensors.get(id) ?? null : null;
  }

  /** Every sensor whose CONFIRMED assignment is this field. */
  listForField(fieldId) {
    if (!fieldId) {
      return [];
    }
    return this.list().filter((sensor) => String(sensor.assignedFieldId) === String(fieldId));
  }

  /** Registers a sensor, or returns the existing one — never a duplicate. */
  register({ sensorId, type, label, displayName, deviceModel, settings, nowIso = new Date().toISOString() } = {}) {
    const id = normalizeSensorId(sensorId);
    if (!id) {
      return { sensor: null, error: `センサIDが不正です: ${JSON.stringify(sensorId)} / invalid sensor id` };
    }
    const existing = this.sensors.get(id);
    if (existing) {
      // Never a duplicate, and never a silent overwrite of a device that is
      // already registered and possibly already assigned and calibrated.
      return { sensor: existing, error: null, alreadyRegistered: true };
    }
    const sensor = buildSensor({ sensorId: id, type, label, displayName, deviceModel, settings, nowIso });
    this.sensors.set(id, sensor);
    this.persist();
    this.emitChange();
    return { sensor, error: null, alreadyRegistered: false };
  }

  /**
   * Records where a sensor last reported from, and its derived status.
   *
   * This is the ONLY place a live position touches the registry, and it
   * deliberately cannot change `assignedFieldId`. `detectedFieldId` is written
   * to `lastDetection` for display; it is not promoted to an assignment here
   * or anywhere else automatic.
   */
  recordPosition(sensorId, { latitude, longitude, altitudeM = null, at = new Date().toISOString() } = {}) {
    const sensor = this.get(sensorId);
    if (!sensor) {
      return null;
    }
    sensor.lastPosition = {
      latitude: Number.isFinite(latitude) ? latitude : null,
      longitude: Number.isFinite(longitude) ? longitude : null,
      altitudeM: Number.isFinite(altitudeM) ? altitudeM : null
    };
    sensor.lastSeenAt = String(at);
    sensor.updatedAt = String(at);
    return sensor;
  }

  /** Stores the derived status/detection for display and persistence. */
  updateStatus(sensorId, { assignmentStatus, detectedFieldId = null, confidence = null, candidateFieldIds = [] } = {}) {
    const sensor = this.get(sensorId);
    if (!sensor) {
      return null;
    }
    sensor.assignmentStatus = String(assignmentStatus ?? sensor.assignmentStatus);
    sensor.lastDetection = {
      detectedFieldId: detectedFieldId === null || detectedFieldId === undefined ? null : String(detectedFieldId),
      confidence: Number.isFinite(confidence) ? confidence : null,
      candidateFieldIds: (candidateFieldIds || []).map(String)
    };
    return sensor;
  }

  /**
   * Confirms an assignment. The only writer of `assignedFieldId`.
   *
   * Called from an explicit user action and from nothing else — no detection
   * result, no confidence threshold and no movement warning reaches this
   * method on its own.
   */
  assign(sensorId, fieldId, { at = new Date().toISOString(), note = "" } = {}) {
    const sensor = this.get(sensorId);
    if (!sensor) {
      return { sensor: null, error: "センサが登録されていません / sensor is not registered" };
    }
    const id = fieldId === null || fieldId === undefined ? "" : String(fieldId).trim();
    if (!id) {
      return { sensor: null, error: "圃場IDが指定されていません / no field id given" };
    }
    if (sensor.assignedFieldId !== null) {
      // Reassignment is legal but is two events, not one: the record has to
      // show that the sensor LEFT the old field, or the history reads as if
      // it had been in the new one all along.
      sensor.assignmentHistory.push(buildAssignmentEvent({
        action: "removed", fieldId: sensor.assignedFieldId, at, note
      }));
    }
    sensor.assignedFieldId = id;
    sensor.assignmentStatus = ASSIGNMENT_STATES.LOCKED;
    sensor.assignmentHistory.push(buildAssignmentEvent({ action: "assigned", fieldId: id, at, note }));
    sensor.updatedAt = String(at);
    this.persist();
    this.emitChange();
    return { sensor, error: null };
  }

  /** Removes the assignment, returning the sensor to detection. */
  unassign(sensorId, { at = new Date().toISOString(), note = "" } = {}) {
    const sensor = this.get(sensorId);
    if (!sensor || sensor.assignedFieldId === null) {
      return { sensor: sensor ?? null, error: null, changed: false };
    }
    sensor.assignmentHistory.push(buildAssignmentEvent({
      action: "removed", fieldId: sensor.assignedFieldId, at, note
    }));
    sensor.assignedFieldId = null;
    sensor.assignmentStatus = ASSIGNMENT_STATES.UNASSIGNED;
    sensor.updatedAt = String(at);
    this.persist();
    this.emitChange();
    return { sensor, error: null, changed: true };
  }

  /**
   * Renames a sensor for display. The stable id is untouched.
   *
   * This is the whole reason `displayName` exists separately: a farmer wants
   * to call it 「田圃1 水位センサー」, and that must not become the identity
   * that measurements, assignments and history are filed under.
   */
  rename(sensorId, displayName, { at = new Date().toISOString() } = {}) {
    const sensor = this.get(sensorId);
    if (!sensor) {
      return { sensor: null, error: "センサが登録されていません / sensor is not registered" };
    }
    sensor.displayName = String(displayName ?? "").trim();
    sensor.updatedAt = String(at);
    this.persist();
    this.emitChange();
    return { sensor, error: null };
  }

  /** Changes which hardware model this record describes. */
  setDeviceModel(sensorId, deviceModel, { at = new Date().toISOString() } = {}) {
    const sensor = this.get(sensorId);
    if (!sensor) {
      return { sensor: null, error: "センサが登録されていません / sensor is not registered" };
    }
    sensor.deviceModel = normalizeDeviceModel(deviceModel);
    sensor.updatedAt = String(at);
    this.persist();
    this.emitChange();
    return { sensor, error: null };
  }

  /**
   * Replaces the settings block with an already-validated one.
   *
   * Validation belongs to `validateSettingsPatch()` in sensor-settings.js —
   * this method normalizes defensively but does not judge, so there is one
   * place that decides whether a farmer's input was acceptable.
   */
  updateSettings(sensorId, settings, { at = new Date().toISOString() } = {}) {
    const sensor = this.get(sensorId);
    if (!sensor) {
      return { sensor: null, error: "センサが登録されていません / sensor is not registered" };
    }
    sensor.settings = normalizeSensorSettings(settings);
    sensor.updatedAt = String(at);
    this.persist();
    this.emitChange();
    return { sensor, error: null };
  }

  /**
   * Stores (or clears) the calibration record.
   *
   * Storing one does NOT by itself make a depth displayable: calibration.js
   * still decides, every time, whether this particular record licenses a
   * particular claim. This method only persists what the farmer took.
   */
  setCalibration(sensorId, calibration, { at = new Date().toISOString() } = {}) {
    const sensor = this.get(sensorId);
    if (!sensor) {
      return { sensor: null, error: "センサが登録されていません / sensor is not registered" };
    }
    sensor.calibration = calibration ?? null;
    sensor.updatedAt = String(at);
    this.persist();
    this.emitChange();
    return { sensor, error: null };
  }

  /**
   * The sensor a field is paired with, or null.
   *
   * The REVERSE of the canonical relationship. `sensor.assignedFieldId` is the
   * single source of truth; there is deliberately no `field.sensorId` to fall
   * out of step with it. `primaryWaterSensor()` picks the first assignment
   * when several exist rather than inventing a competing "primary" flag —
   * the data model already allows many, and destroying that would be a
   * regression, not a simplification.
   */
  primaryWaterSensor(fieldId) {
    return this.listForField(fieldId)[0] ?? null;
  }

  remove(sensorId) {
    const id = normalizeSensorId(sensorId);
    if (!id || !this.sensors.has(id)) {
      return false;
    }
    this.sensors.delete(id);
    this.persist();
    this.emitChange();
    return true;
  }

  emitChange() {
    this.dispatchEvent(new Event("change"));
  }
}

/**
 * Repairs whatever came out of storage into valid sensor records.
 *
 * A record with an unreadable id is dropped rather than repaired: an id is the
 * one field that cannot be reconstructed, and inventing one would create a
 * second identity for hardware that already has one.
 */
export function normalizeSensorList(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    const sensorId = normalizeSensorId(entry?.sensorId);
    if (!sensorId || seen.has(sensorId)) {
      continue;
    }
    seen.add(sensorId);
    const assignedFieldId = typeof entry?.assignedFieldId === "string" && entry.assignedFieldId.trim()
      ? entry.assignedFieldId.trim()
      : null;
    // Status is derived state. Recompute it from the durable assignment rather
    // than trusting a stale/corrupt transient status from storage.
    const status = assignedFieldId ? ASSIGNMENT_STATES.LOCKED : ASSIGNMENT_STATES.UNASSIGNED;
    out.push({
      sensorId,
      type: typeof entry?.type === "string" && entry.type ? entry.type : SENSOR_TYPE_FLOATING_WATER_LEVEL,
      label: typeof entry?.label === "string" ? entry.label : "",
      // V1 -> V2. A V1 record has no displayName; it inherits its `label` if
      // it had one, and otherwise stays empty so sensorDisplayName() falls
      // back to the id. Nothing is invented and nothing is dropped.
      displayName: typeof entry?.displayName === "string"
        ? entry.displayName
        : (typeof entry?.label === "string" ? entry.label : ""),
      deviceModel: normalizeDeviceModel(entry?.deviceModel),
      // Missing settings become the documented defaults rather than
      // undefined, so every consumer can read settings.quality.maxHdop
      // without a guard.
      settings: normalizeSensorSettings(entry?.settings),
      // Calibration is carried through UNVALIDATED and UNCHANGED. Repairing
      // it here would be the one repair that could manufacture a licence to
      // display a water depth; calibration.js re-checks it on every use, so
      // a corrupt record fails there, visibly, rather than being silently
      // "fixed" into something usable.
      calibration: entry?.calibration && typeof entry.calibration === "object"
        ? entry.calibration
        : null,
      assignedFieldId,
      assignmentStatus: status,
      lastPosition: normalizePosition(entry?.lastPosition),
      lastSeenAt: typeof entry?.lastSeenAt === "string" ? entry.lastSeenAt : null,
      lastDetection: entry?.lastDetection && typeof entry.lastDetection === "object"
        ? {
          detectedFieldId: typeof entry.lastDetection.detectedFieldId === "string" ? entry.lastDetection.detectedFieldId : null,
          confidence: Number.isFinite(entry.lastDetection.confidence) ? entry.lastDetection.confidence : null,
          candidateFieldIds: Array.isArray(entry.lastDetection.candidateFieldIds)
            ? entry.lastDetection.candidateFieldIds.map(String)
            : []
        }
        : null,
      assignmentHistory: Array.isArray(entry?.assignmentHistory)
        ? entry.assignmentHistory
          .filter((event) => event && typeof event.at === "string" && typeof event.action === "string")
          .map((event) => buildAssignmentEvent(event))
        : [],
      createdAt: typeof entry?.createdAt === "string" ? entry.createdAt : new Date(0).toISOString(),
      updatedAt: typeof entry?.updatedAt === "string" ? entry.updatedAt : new Date(0).toISOString()
    });
  }
  return out;
}

function normalizePosition(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const latitude = numberOrNull(raw.latitude);
  const longitude = numberOrNull(raw.longitude);
  if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) {
    return null;
  }
  return {
    latitude,
    longitude,
    altitudeM: numberOrNull(raw.altitudeM)
  };
}

function numberOrNull(value) {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) {
    return null;
  }
  if (typeof value !== "number" && typeof value !== "string") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isValidLatitude(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= -90 && value <= 90;
}

function isValidLongitude(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= -180 && value <= 180;
}
