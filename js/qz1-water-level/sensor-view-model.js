// Everything the sensor UI displays, computed as data.
//
// WHY THIS IS A SEPARATE MODULE
// -----------------------------
// The decisions this file makes are the ones most worth testing and least
// worth clicking through a browser to check: may this sensor show an absolute
// water depth, is it online, does its detected field disagree with its
// assigned field, is this reading good enough to act on. Putting them in the
// controller would make them reachable only through the DOM.
//
// The controller below it becomes plumbing: take a model, write it into
// elements. Same split as recording-core.js / recording-controller.js.
//
// THE RULE THIS FILE ENFORCES
// --------------------------
// GNSS altitude, relative displacement and calibrated water depth are three
// different quantities and are never collapsed into one. `depthMm` is null
// unless calibration.js licenses it, and `depthBlockedReason` says why not.
// A caller cannot accidentally render a displacement as a depth, because the
// model hands it two separately named fields and a reason string.

import {
  ASSIGNMENT_STATES,
  sensorDisplayName
} from "./sensor-registry.js";
import {
  CALIBRATION_STATES,
  MEASUREMENT_QUALITY,
  calibrationState,
  deviceModelFor,
  judgeMeasurementQuality,
  normalizeSensorSettings
} from "./sensor-settings.js";
import { canDeriveWaterDepth, deriveWaterDepth } from "./calibration.js";
import { fieldDisplayName, findFieldById } from "./field-boundary.js";
import { resolveTransport } from "./sensor-transport.js";

/** Connection state. Distinct from assignment and from calibration. */
export const CONNECTION_STATES = {
  ONLINE: "online",
  /** Nothing has ever been received from this sensor. */
  OFFLINE: "offline",
  /** Something was received, but not recently enough to trust as current. */
  STALE: "stale",
  /** This platform offers no way to reach the device directly. */
  UNSUPPORTED_DIRECT: "unsupported-direct-connection"
};

export const CONNECTION_LABELS = {
  [CONNECTION_STATES.ONLINE]: { ja: "接続中", en: "online" },
  [CONNECTION_STATES.OFFLINE]: { ja: "オフライン", en: "offline" },
  [CONNECTION_STATES.STALE]: { ja: "受信が古い", en: "stale" },
  [CONNECTION_STATES.UNSUPPORTED_DIRECT]: { ja: "直接接続に非対応", en: "direct connection unsupported" }
};

export const ASSIGNMENT_LABELS = {
  [ASSIGNMENT_STATES.UNASSIGNED]: { ja: "未割り当て", en: "unassigned" },
  [ASSIGNMENT_STATES.DETECTING]: { ja: "検出中", en: "detecting" },
  [ASSIGNMENT_STATES.CANDIDATE]: { ja: "候補あり（未確定）", en: "candidate" },
  [ASSIGNMENT_STATES.LOCKED]: { ja: "確定", en: "locked" },
  [ASSIGNMENT_STATES.OUTSIDE_KNOWN_FIELDS]: { ja: "登録圃場の外", en: "outside known fields" },
  [ASSIGNMENT_STATES.AMBIGUOUS]: { ja: "圃場が重複", en: "ambiguous" },
  [ASSIGNMENT_STATES.MOVED_WARNING]: { ja: "移動の可能性", en: "possible movement" }
};

export const CALIBRATION_LABELS = {
  [CALIBRATION_STATES.UNCALIBRATED]: { ja: "未較正", en: "uncalibrated" },
  [CALIBRATION_STATES.CALIBRATED]: { ja: "較正済み", en: "calibrated" },
  [CALIBRATION_STATES.EXPIRED]: { ja: "較正期限切れ", en: "expired" },
  [CALIBRATION_STATES.INVALID]: { ja: "較正が無効", en: "invalid" }
};

/**
 * Connection state from the age of the last reading.
 *
 * `UNSUPPORTED_DIRECT` is reported only when nothing has EVER arrived AND no
 * direct route exists. A sensor whose readings come from imported files is
 * not "unsupported" — it is working exactly as designed on that platform, and
 * labelling it as broken would be the lie this whole capability layer exists
 * to avoid.
 */
export function connectionStateFor({ lastSeenAtMs, nowMs = Date.now(), onlineTimeoutMs, directTransportAvailable = true }) {
  if (!Number.isFinite(lastSeenAtMs)) {
    return directTransportAvailable ? CONNECTION_STATES.OFFLINE : CONNECTION_STATES.UNSUPPORTED_DIRECT;
  }
  const age = nowMs - lastSeenAtMs;
  if (age <= onlineTimeoutMs) {
    return CONNECTION_STATES.ONLINE;
  }
  // Three windows of silence is a judgement call, made explicit: "stale"
  // means "was working, has gone quiet", while "offline" after a long gap
  // stops implying the link is about to come back.
  return age <= onlineTimeoutMs * 3 ? CONNECTION_STATES.STALE : CONNECTION_STATES.OFFLINE;
}

/**
 * The complete model for one sensor card / settings panel / data view.
 *
 * @param liveState the SensorFieldController snapshot for this sensor, or
 *        null when it is not the one currently receiving fixes. A sensor with
 *        no live state still renders — from its persisted record — which is
 *        what makes a multi-sensor list possible when only one is connected.
 */
export function buildSensorModel({
  sensor,
  fields = [],
  liveState = null,
  capabilities = null,
  relativeDisplacementMm = null,
  nowMs = Date.now()
} = {}) {
  if (!sensor) {
    return null;
  }
  const settings = normalizeSensorSettings(sensor.settings);
  const device = deviceModelFor(sensor.deviceModel);

  // Which routes this DEVICE supports, intersected with what this BROWSER
  // can do. Neither alone is the answer.
  const transport = capabilities
    ? resolveTransport(settings.acquisition.transportPreference, capabilities)
    : { resolved: null, fellBack: false, requested: settings.acquisition.transportPreference, usable: [] };
  const deviceUsable = transport.usable.filter((kind) => device.transports.includes(kind));
  const directAvailable = deviceUsable.some((kind) => kind === "serial" || kind === "bluetooth");

  const lastSeenAtMs = liveState?.lastSeenAtMs ?? parseIsoOrNull(sensor.lastSeenAt);
  const connection = connectionStateFor({
    lastSeenAtMs,
    nowMs,
    onlineTimeoutMs: settings.acquisition.onlineTimeoutMs,
    directTransportAvailable: directAvailable
  });

  const assignedFieldId = sensor.assignedFieldId ?? null;
  const assignedField = findFieldById(fields, assignedFieldId);
  const detectedFieldId = liveState?.detectedFieldId ?? sensor.lastDetection?.detectedFieldId ?? null;
  const detectedField = findFieldById(fields, detectedFieldId);
  const assignmentStatus = liveState?.assignmentStatus
    ?? sensor.assignmentStatus
    ?? ASSIGNMENT_STATES.UNASSIGNED;

  // Reported as CONSISTENCY, never as probability. It is the fraction of the
  // recent window that agreed; systematic GNSS bias or a mis-walked boundary
  // can make it 100% and still wrong. See detection-window.js.
  const detectionConsistency = liveState?.fieldDetectionConfidence
    ?? sensor.lastDetection?.confidence
    ?? null;

  const measurement = liveStateToMeasurement(liveState);
  const qualityJudgement = measurement
    ? judgeMeasurementQuality(measurement, settings)
    : { quality: MEASUREMENT_QUALITY.INSUFFICIENT, reasons: ["測定がありません / no measurement"] };

  const calibration = sensor.calibration ?? null;
  const calState = calibrationState(calibration, { nowMs });
  const depth = describeDepth({
    calibration,
    settings,
    altitudeM: liveState?.altitudeM ?? null,
    quality: qualityJudgement.quality,
    nowMs
  });

  return {
    sensorId: sensor.sensorId,
    displayName: sensorDisplayName(sensor),
    deviceModel: device.id,
    deviceLabel: device.labelJa,

    connection,
    connectionLabelJa: CONNECTION_LABELS[connection].ja,
    lastSeenAtMs,

    assignedFieldId,
    assignedFieldName: assignedField ? fieldDisplayName(assignedField) : null,
    // True when a record points at a field that no longer exists — a real
    // state after a farmer deletes a paddy, and one the UI must show rather
    // than rendering a blank.
    assignedFieldMissing: Boolean(assignedFieldId) && !assignedField,
    detectedFieldId,
    detectedFieldName: detectedField ? fieldDisplayName(detectedField) : null,
    detectionConsistency,
    assignmentStatus,
    assignmentLabelJa: ASSIGNMENT_LABELS[assignmentStatus]?.ja ?? assignmentStatus,
    movedWarning: assignmentStatus === ASSIGNMENT_STATES.MOVED_WARNING,
    /** A suggestion the farmer may accept. Never applied automatically. */
    suggestedFieldId: !assignedFieldId && assignmentStatus === ASSIGNMENT_STATES.CANDIDATE
      ? detectedFieldId
      : null,

    // The three quantities, kept apart.
    altitudeM: liveState?.altitudeM ?? null,
    relativeDisplacementMm: Number.isFinite(relativeDisplacementMm) ? relativeDisplacementMm : null,
    depthMm: depth.depthMm,
    depthUncertaintyMm: depth.uncertaintyMm,
    depthBlockedReason: depth.blockedReason,

    latitude: liveState?.latitude ?? sensor.lastPosition?.latitude ?? null,
    longitude: liveState?.longitude ?? sensor.lastPosition?.longitude ?? null,

    calibrationState: calState,
    calibrationLabelJa: CALIBRATION_LABELS[calState].ja,
    calibratedAtMs: Number.isFinite(calibration?.calibratedAt) ? calibration.calibratedAt : null,

    measurementQuality: qualityJudgement.quality,
    measurementQualityReasons: qualityJudgement.reasons,

    settings,
    transport: {
      requested: transport.requested,
      resolved: deviceUsable.includes(transport.resolved) ? transport.resolved : (deviceUsable[0] ?? null),
      fellBack: transport.fellBack,
      usable: deviceUsable,
      directAvailable
    }
  };
}

/**
 * Whether an absolute water depth may be shown, and the number if so.
 *
 * Three independent gates, all of which must pass. Any one of them failing
 * yields a null depth and a reason — never a number with a caveat next to it,
 * because a number on screen is what a farmer acts on regardless of the
 * caveat.
 */
function describeDepth({ calibration, settings, altitudeM, quality, nowMs }) {
  if (!settings.display.showAbsoluteDepth) {
    return { depthMm: null, uncertaintyMm: null, blockedReason: "水深表示が設定でオフになっています / depth display is switched off" };
  }
  if (quality !== MEASUREMENT_QUALITY.VALID) {
    return { depthMm: null, uncertaintyMm: null, blockedReason: "測定品質が基準を満たしていません / measurement quality gate not met" };
  }
  if (!Number.isFinite(altitudeM)) {
    return { depthMm: null, uncertaintyMm: null, blockedReason: "GNSS標高がありません / no GNSS altitude" };
  }
  const gate = canDeriveWaterDepth(calibration, { nowMs });
  if (!gate.allowed) {
    return { depthMm: null, uncertaintyMm: null, blockedReason: gate.reason };
  }
  const derived = deriveWaterDepth(calibration, altitudeM * 1000, { nowMs });
  if (!derived.allowed) {
    return { depthMm: null, uncertaintyMm: null, blockedReason: derived.reason };
  }
  return {
    depthMm: derived.measurement.valueMm,
    uncertaintyMm: derived.uncertaintyMm,
    blockedReason: null
  };
}

/** The live snapshot re-expressed as a measurement for the quality gate. */
function liveStateToMeasurement(liveState) {
  if (!liveState || !Number.isFinite(liveState.latitude) || !Number.isFinite(liveState.longitude)) {
    return null;
  }
  return {
    latitude: liveState.latitude,
    longitude: liveState.longitude,
    altitudeM: liveState.altitudeM ?? null,
    fixQuality: liveState.fixQuality ?? null,
    satellites: liveState.satellites ?? null,
    hdop: liveState.hdop ?? null,
    vdop: null,
    pdop: null
  };
}

/**
 * The models for every registered sensor, newest-registered last.
 *
 * `liveStateFor` is a lookup rather than a single snapshot because only one
 * sensor is typically connected: the others still render from their records.
 */
export function buildSensorListModel({
  sensors = [], fields = [], liveStateFor = () => null,
  capabilities = null, relativeDisplacementMm = null, nowMs = Date.now()
} = {}) {
  return sensors
    .map((sensor) => buildSensorModel({
      sensor,
      fields,
      liveState: liveStateFor(sensor.sensorId),
      capabilities,
      // The displacement belongs to whichever sensor is actually streaming.
      relativeDisplacementMm: liveStateFor(sensor.sensorId) ? relativeDisplacementMm : null,
      nowMs
    }))
    .filter(Boolean);
}

/**
 * The field-side view of the pairing.
 *
 * Derived from the sensor registry every time rather than stored on the field:
 * one canonical relationship (`sensor.assignedFieldId`) and a computed
 * reverse lookup cannot disagree with each other, whereas two stored copies
 * eventually will.
 */
export function buildFieldSensorModel({ field, sensors = [], liveStateFor = () => null, capabilities = null, nowMs = Date.now() } = {}) {
  if (!field) {
    return null;
  }
  const paired = sensors.filter((sensor) => String(sensor.assignedFieldId) === String(field.id));
  return {
    fieldId: String(field.id),
    fieldName: fieldDisplayName(field),
    hasSensor: paired.length > 0,
    sensors: paired.map((sensor) => buildSensorModel({
      sensor, fields: [field], liveState: liveStateFor(sensor.sensorId), capabilities, nowMs
    })).filter(Boolean)
  };
}

/** Fields with no sensor assigned — the candidates an "assign" picker offers. */
export function fieldsWithoutSensor(fields = [], sensors = []) {
  const taken = new Set(sensors.map((sensor) => String(sensor.assignedFieldId)).filter((id) => id !== "null"));
  return fields.filter((field) => !taken.has(String(field.id)));
}

function parseIsoOrNull(value) {
  if (typeof value !== "string" || !value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
