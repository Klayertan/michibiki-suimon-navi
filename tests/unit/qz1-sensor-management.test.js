// Sensor management: identity, settings, pairing, migration and the rules
// governing what the UI may claim.
//
// SYNTHETIC throughout. Invented paddies, invented device ids, no hardware.

import test from "node:test";
import assert from "node:assert/strict";
import {
  ASSIGNMENT_STATES,
  FloatingSensorRegistry,
  SENSOR_SCHEMA_VERSION,
  SENSOR_STORAGE_KEY,
  buildSensor,
  buildSensorMeasurement,
  normalizeSensorList,
  sensorDisplayName
} from "../../js/qz1-water-level/sensor-registry.js";
import {
  CALIBRATION_STATES,
  DEFAULT_DEVICE_MODEL,
  DEFAULT_QUALITY_SETTINGS,
  DEVICE_MODELS,
  MEASUREMENT_QUALITY,
  calibrationState,
  defaultSensorSettings,
  describeSettings,
  deviceModelFor,
  judgeMeasurementQuality,
  normalizeDeviceModel,
  normalizeSensorSettings,
  validateSettingsPatch
} from "../../js/qz1-water-level/sensor-settings.js";
import {
  CONNECTION_STATES,
  buildFieldSensorModel,
  buildSensorListModel,
  buildSensorModel,
  connectionStateFor,
  fieldsWithoutSensor
} from "../../js/qz1-water-level/sensor-view-model.js";
import { detectCapabilities } from "../../js/qz1-water-level/platform-capabilities.js";

const NORTH = { id: "paddy-001", name: "田圃1", coordinates: [[34.700, 135.500], [34.700, 135.501], [34.701, 135.501], [34.701, 135.500]] };
const SOUTH = { id: "paddy-005", name: "田圃5", coordinates: [[34.698, 135.500], [34.698, 135.501], [34.699, 135.501], [34.699, 135.500]] };

function fakeStorage(seed = null) {
  const map = new Map();
  if (seed) map.set(SENSOR_STORAGE_KEY, JSON.stringify(seed));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    _raw: () => map.get(SENSOR_STORAGE_KEY)
  };
}

function registryWith(sensors = []) {
  const registry = new FloatingSensorRegistry({ storage: fakeStorage() });
  for (const spec of sensors) registry.register(spec);
  return registry;
}

const chromium = detectCapabilities({
  navigatorRef: { serial: {}, bluetooth: {}, userAgent: "Chrome" },
  windowRef: { isSecureContext: true, FileReader: function FileReader() {} },
  cloudConfigured: true
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

test("a sensor gets a stable id and an editable display name", () => {
  const registry = registryWith([{ sensorId: "QZ1-FLOAT-001", deviceModel: "QZ1LE" }]);
  registry.rename("QZ1-FLOAT-001", "田圃1 水位センサー");

  const sensor = registry.get("QZ1-FLOAT-001");
  assert.equal(sensor.sensorId, "QZ1-FLOAT-001", "the id is the hardware and does not move");
  assert.equal(sensorDisplayName(sensor), "田圃1 水位センサー");
  assert.equal(sensor.deviceModel, "QZ1LE");
});

test("renaming and reassigning never change the sensor id", () => {
  const registry = registryWith([{ sensorId: "QZ1-FLOAT-001" }]);
  registry.rename("QZ1-FLOAT-001", "別の名前");
  registry.assign("QZ1-FLOAT-001", "paddy-001");
  registry.assign("QZ1-FLOAT-001", "paddy-005");
  assert.equal(registry.get("QZ1-FLOAT-001").sensorId, "QZ1-FLOAT-001");
  assert.equal(registry.list().length, 1, "and never produce a second record");
});

test("the display name falls back to the id, never to a blank heading", () => {
  assert.equal(sensorDisplayName(buildSensor({ sensorId: "QZ1-FLOAT-001" })), "QZ1-FLOAT-001");
  assert.equal(sensorDisplayName({ sensorId: "X", displayName: "   " }), "X");
  assert.equal(sensorDisplayName({ sensorId: "X", label: "旧ラベル" }), "旧ラベル", "a V1 label still shows");
});

test("a duplicate id is refused rather than overwriting a configured device", () => {
  const registry = registryWith([{ sensorId: "QZ1-FLOAT-001" }]);
  registry.assign("QZ1-FLOAT-001", "paddy-001");
  const second = registry.register({ sensorId: "QZ1-FLOAT-001", displayName: "別物" });
  assert.equal(second.alreadyRegistered, true);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.get("QZ1-FLOAT-001").assignedFieldId, "paddy-001", "the existing assignment survives");
});

test("multiple sensors are independent records", () => {
  const registry = registryWith([
    { sensorId: "QZ1-FLOAT-001", deviceModel: "QZ1" },
    { sensorId: "QZ1-FLOAT-002", deviceModel: "QZ1LE" }
  ]);
  registry.assign("QZ1-FLOAT-001", "paddy-001");
  registry.assign("QZ1-FLOAT-002", "paddy-005");
  assert.equal(registry.list().length, 2);
  assert.equal(registry.get("QZ1-FLOAT-001").assignedFieldId, "paddy-001");
  assert.equal(registry.get("QZ1-FLOAT-002").assignedFieldId, "paddy-005");
});

// ---------------------------------------------------------------------------
// Device model
// ---------------------------------------------------------------------------

test("device models are data, and an unknown one degrades to the default", () => {
  assert.equal(normalizeDeviceModel("QZ1LE"), "QZ1LE");
  assert.equal(normalizeDeviceModel("SOMETHING-ELSE"), DEFAULT_DEVICE_MODEL);
  assert.equal(normalizeDeviceModel(null), DEFAULT_DEVICE_MODEL);
  assert.equal(deviceModelFor("nope").id, DEFAULT_DEVICE_MODEL, "never throws on an unknown model");
});

test("a device's transports are hardware facts, separate from browser support", () => {
  // QZ1 has no GATT profile here; QZ1LE does. Neither statement says anything
  // about whether the current browser can reach it.
  assert.ok(!DEVICE_MODELS.QZ1.transports.includes("bluetooth"));
  assert.ok(DEVICE_MODELS.QZ1LE.transports.includes("bluetooth"));
  assert.ok(DEVICE_MODELS.QZ1.transports.includes("file-import"), "every model can import a log");
});

// ---------------------------------------------------------------------------
// Field pairing — one canonical relationship
// ---------------------------------------------------------------------------

test("the reverse lookup is derived, so the two views cannot disagree", () => {
  const registry = registryWith([{ sensorId: "QZ1-FLOAT-001" }, { sensorId: "QZ1-FLOAT-002" }]);
  registry.assign("QZ1-FLOAT-001", "paddy-001");

  // Sensor side.
  assert.equal(registry.get("QZ1-FLOAT-001").assignedFieldId, "paddy-001");
  // Field side — computed, not stored.
  assert.equal(registry.primaryWaterSensor("paddy-001").sensorId, "QZ1-FLOAT-001");
  assert.equal(registry.primaryWaterSensor("paddy-005"), null);
  assert.deepEqual(registry.listForField("paddy-001").map((s) => s.sensorId), ["QZ1-FLOAT-001"]);
});

test("unassigning clears both directions at once, because there is only one", () => {
  const registry = registryWith([{ sensorId: "QZ1-FLOAT-001" }]);
  registry.assign("QZ1-FLOAT-001", "paddy-001");
  registry.unassign("QZ1-FLOAT-001");
  assert.equal(registry.get("QZ1-FLOAT-001").assignedFieldId, null);
  assert.equal(registry.primaryWaterSensor("paddy-001"), null);
});

test("fields already carrying a sensor are excluded from the assign picker", () => {
  const registry = registryWith([{ sensorId: "QZ1-FLOAT-001" }]);
  registry.assign("QZ1-FLOAT-001", "paddy-001");
  const free = fieldsWithoutSensor([NORTH, SOUTH], registry.list());
  assert.deepEqual(free.map((field) => field.id), ["paddy-005"]);
});

test("reassignment records the departure, and history is never rewritten", () => {
  const registry = registryWith([{ sensorId: "QZ1-FLOAT-001" }]);
  registry.assign("QZ1-FLOAT-001", "paddy-001", { at: "2026-08-29T00:00:00.000Z" });
  registry.assign("QZ1-FLOAT-001", "paddy-005", { at: "2026-09-12T00:00:00.000Z" });

  const history = registry.get("QZ1-FLOAT-001").assignmentHistory;
  assert.deepEqual(history.map((event) => `${event.action}:${event.fieldId}`),
    ["assigned:paddy-001", "removed:paddy-001", "assigned:paddy-005"]);
});

test("a measurement keeps the field it was taken under, after the sensor moves", () => {
  const registry = registryWith([{ sensorId: "QZ1-FLOAT-001" }]);
  registry.assign("QZ1-FLOAT-001", "paddy-001");
  const august = buildSensorMeasurement({
    sensor: registry.get("QZ1-FLOAT-001"), relativeHeightMm: 32, timestamp: "2026-08-29T01:00:00.000Z"
  });

  registry.assign("QZ1-FLOAT-001", "paddy-005");
  const september = buildSensorMeasurement({
    sensor: registry.get("QZ1-FLOAT-001"), relativeHeightMm: 11, timestamp: "2026-09-12T01:00:00.000Z"
  });

  assert.equal(august.fieldId, "paddy-001", "the August water was in paddy-001 and still is");
  assert.equal(september.fieldId, "paddy-005");
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

test("settings round-trip through storage", () => {
  const storage = fakeStorage();
  const first = new FloatingSensorRegistry({ storage });
  first.register({ sensorId: "QZ1-FLOAT-001" });
  const { settings } = validateSettingsPatch(defaultSensorSettings(), {
    quality: { minSatellites: 7, maxHdop: 2.5, filterProfile: "standard-quality-gate" },
    display: { showAbsoluteDepth: false }
  });
  first.updateSettings("QZ1-FLOAT-001", settings);

  const reloaded = new FloatingSensorRegistry({ storage }).hydrate().get("QZ1-FLOAT-001");
  assert.equal(reloaded.settings.quality.minSatellites, 7);
  assert.equal(reloaded.settings.quality.maxHdop, 2.5);
  assert.equal(reloaded.settings.quality.filterProfile, "standard-quality-gate");
  assert.equal(reloaded.settings.display.showAbsoluteDepth, false);
});

test("an invalid settings patch is rejected wholesale, not partially applied", () => {
  // A form the farmer typed must not half-save.
  const { settings, errors } = validateSettingsPatch(defaultSensorSettings(), {
    quality: { minSatellites: -3, maxHdop: 2 }
  });
  assert.equal(settings, null);
  assert.ok(errors.some((error) => error.includes("最小衛星数")));
});

test("every invalid field is reported, not just the first", () => {
  const { errors } = validateSettingsPatch(defaultSensorSettings(), {
    quality: { minSatellites: -1, maxHdop: 0, filterProfile: "made-up" },
    display: { showAbsoluteDepth: "yes" }
  });
  assert.equal(errors.length, 4);
});

test("corrupt stored settings are repaired field by field, keeping the rest", () => {
  // Repairing storage silently is right; the farmer cannot act on it and the
  // sensor must keep its identity, assignment and calibration.
  const normalized = normalizeSensorSettings({
    acquisition: { transportPreference: "carrier-pigeon", onlineTimeoutMs: -5 },
    quality: { minSatellites: "many", maxHdop: null, filterProfile: "unknown" },
    display: { showAbsoluteDepth: "maybe" }
  });
  const defaults = defaultSensorSettings();
  assert.deepEqual(normalized, defaults, "each bad field falls back independently");
});

test("a null/empty stored minSatellites falls back to the default, not to 0", () => {
  // Number(null) and Number("") are both 0, and 0 IS a legitimate
  // minSatellites value ("no minimum") -- so unlike maxHdop/onlineTimeoutMs,
  // whose own `> 0` check rejects a coerced 0 on its own, a corrupted or
  // missing minSatellites needs an explicit guard, or it silently becomes
  // "no minimum" instead of the documented default of 4.
  for (const corrupt of [null, ""]) {
    const normalized = normalizeSensorSettings({ quality: { minSatellites: corrupt } });
    assert.equal(normalized.quality.minSatellites, DEFAULT_QUALITY_SETTINGS.minSatellites,
      `${JSON.stringify(corrupt)} must fall back to the default, not become 0`);
  }
  // A key that is genuinely absent must behave the same way.
  assert.equal(normalizeSensorSettings({ quality: {} }).quality.minSatellites, DEFAULT_QUALITY_SETTINGS.minSatellites);
  // A real, explicit 0 is still a legitimate value once someone means it.
  assert.equal(normalizeSensorSettings({ quality: { minSatellites: 0 } }).quality.minSatellites, 0);
});

test("a null/empty minSatellites PATCH is rejected, matching its sibling fields", () => {
  // Before the fix, an empty form field silently saved as "no minimum"
  // instead of the same error onlineTimeoutMs/maxHdop already gave.
  for (const corrupt of [null, ""]) {
    const { settings, errors } = validateSettingsPatch(defaultSensorSettings(), {
      quality: { minSatellites: corrupt }
    });
    assert.equal(settings, null, `${JSON.stringify(corrupt)} must be rejected, not coerced to 0`);
    assert.ok(errors.some((error) => error.includes("最小衛星数")));
  }
  // An explicit 0 is still accepted -- this is about missing input, not
  // about forbidding the value zero.
  const explicit = validateSettingsPatch(defaultSensorSettings(), { quality: { minSatellites: 0 } });
  assert.equal(explicit.settings.quality.minSatellites, 0);
});

test("describeSettings reports what is actually in force", () => {
  const described = describeSettings(defaultSensorSettings());
  assert.equal(described.filterProfile, "none");
  assert.equal(described.filterStageCount, 0, "the honest default applies no filter");
  assert.equal(described.onlineTimeoutSeconds, 15);
});

// ---------------------------------------------------------------------------
// Quality gate
// ---------------------------------------------------------------------------

test("a DOP the receiver never sent does not fail the gate", () => {
  // QZ1's GGA carries no VDOP. Rejecting on a missing one would discard every
  // fix from a healthy device.
  const judgement = judgeMeasurementQuality(
    { latitude: 34.7, longitude: 135.5, fixQuality: 1, satellites: 9, hdop: 0.9, vdop: null, pdop: null },
    defaultSensorSettings()
  );
  assert.equal(judgement.quality, MEASUREMENT_QUALITY.VALID);
});

test("a fix below the configured bar is rejected, with the reason", () => {
  const judgement = judgeMeasurementQuality(
    { latitude: 34.7, longitude: 135.5, fixQuality: 1, satellites: 2, hdop: 9 },
    defaultSensorSettings()
  );
  assert.equal(judgement.quality, MEASUREMENT_QUALITY.REJECTED);
  assert.equal(judgement.reasons.length, 2, "both failures are named, not just the first");
});

test("no position at all is rejected before anything else is considered", () => {
  const judgement = judgeMeasurementQuality({ latitude: null, longitude: null }, defaultSensorSettings());
  assert.equal(judgement.quality, MEASUREMENT_QUALITY.REJECTED);
  assert.ok(judgement.reasons[0].includes("測位"));
});

// ---------------------------------------------------------------------------
// Calibration state
// ---------------------------------------------------------------------------

test("calibration states are distinguished, not collapsed into a boolean", () => {
  assert.equal(calibrationState(null), CALIBRATION_STATES.UNCALIBRATED);
  assert.equal(calibrationState({ calibratedAt: 1000 }), CALIBRATION_STATES.INVALID,
    "a calibration with no validating experiment cannot license a depth");
  assert.equal(calibrationState({ calibratedAt: 1000, validation: {} }, { nowMs: 2000 }),
    CALIBRATION_STATES.CALIBRATED);
  assert.equal(
    calibrationState({ calibratedAt: 1000, validation: {} }, { nowMs: 100000, maxAgeMs: 5000 }),
    CALIBRATION_STATES.EXPIRED);
});

// ---------------------------------------------------------------------------
// View model — what the UI is allowed to say
// ---------------------------------------------------------------------------

test("an uncalibrated sensor shows no absolute depth, and says why", () => {
  // The rule this whole project turns on.
  const registry = registryWith([{ sensorId: "QZ1-FLOAT-001" }]);
  registry.assign("QZ1-FLOAT-001", "paddy-001");
  const model = buildSensorModel({
    sensor: registry.get("QZ1-FLOAT-001"),
    fields: [NORTH],
    liveState: { sensorId: "QZ1-FLOAT-001", latitude: 34.7003, longitude: 135.5003, altitudeM: 50.1, fixQuality: 1, satellites: 9, hdop: 0.9, lastSeenAtMs: 1000 },
    capabilities: chromium,
    relativeDisplacementMm: 32,
    nowMs: 2000
  });
  assert.equal(model.depthMm, null);
  assert.ok(model.depthBlockedReason.length > 0);
  // The relative figure is still shown — labelled as what it is.
  assert.equal(model.relativeDisplacementMm, 32);
  assert.equal(model.altitudeM, 50.1);
});

test("the three quantities are separate fields, so they cannot be confused", () => {
  const model = buildSensorModel({
    sensor: buildSensor({ sensorId: "QZ1-FLOAT-001" }),
    liveState: { sensorId: "QZ1-FLOAT-001", latitude: 34.7, longitude: 135.5, altitudeM: 42.347, fixQuality: 1, satellites: 9, hdop: 0.9, lastSeenAtMs: 1000 },
    capabilities: chromium,
    relativeDisplacementMm: 32,
    nowMs: 2000
  });
  assert.equal(model.altitudeM, 42.347, "GNSS altitude");
  assert.equal(model.relativeDisplacementMm, 32, "relative displacement");
  assert.equal(model.depthMm, null, "calibrated depth — absent");
});

test("switching depth display off blocks it even where calibration would allow it", () => {
  const sensor = buildSensor({ sensorId: "QZ1-FLOAT-001" });
  sensor.settings.display.showAbsoluteDepth = false;
  const model = buildSensorModel({
    sensor,
    liveState: { sensorId: "QZ1-FLOAT-001", latitude: 34.7, longitude: 135.5, altitudeM: 50, fixQuality: 1, satellites: 9, hdop: 0.9, lastSeenAtMs: 1000 },
    capabilities: chromium,
    nowMs: 2000
  });
  assert.equal(model.depthMm, null);
  assert.ok(model.depthBlockedReason.includes("設定"));
});

test("connection state distinguishes never-seen, stale and unsupported", () => {
  assert.equal(connectionStateFor({ lastSeenAtMs: 1000, nowMs: 2000, onlineTimeoutMs: 15000 }),
    CONNECTION_STATES.ONLINE);
  assert.equal(connectionStateFor({ lastSeenAtMs: 1000, nowMs: 25000, onlineTimeoutMs: 15000 }),
    CONNECTION_STATES.STALE);
  assert.equal(connectionStateFor({ lastSeenAtMs: 1000, nowMs: 500000, onlineTimeoutMs: 15000 }),
    CONNECTION_STATES.OFFLINE);
  assert.equal(connectionStateFor({ lastSeenAtMs: null, nowMs: 1000, onlineTimeoutMs: 15000 }),
    CONNECTION_STATES.OFFLINE, "never seen, but a direct route exists");
  assert.equal(
    connectionStateFor({ lastSeenAtMs: null, nowMs: 1000, onlineTimeoutMs: 15000, directTransportAvailable: false }),
    CONNECTION_STATES.UNSUPPORTED_DIRECT,
    "on iOS this is a platform fact, not a broken sensor");
});

test("a sensor with no live state still renders from its stored record", () => {
  // What makes a multi-sensor list possible when only one is connected.
  const registry = registryWith([{ sensorId: "QZ1-FLOAT-002" }]);
  registry.assign("QZ1-FLOAT-002", "paddy-005");
  const models = buildSensorListModel({
    sensors: registry.list(), fields: [NORTH, SOUTH], liveStateFor: () => null, capabilities: chromium, nowMs: 1000
  });
  assert.equal(models.length, 1);
  assert.equal(models[0].assignedFieldId, "paddy-005");
  assert.equal(models[0].assignedFieldName, "田圃5");
  assert.equal(models[0].connection, CONNECTION_STATES.OFFLINE);
});

test("an assignment pointing at a deleted field is shown, not silently blanked", () => {
  const registry = registryWith([{ sensorId: "QZ1-FLOAT-001" }]);
  registry.assign("QZ1-FLOAT-001", "paddy-999");
  const model = buildSensorModel({ sensor: registry.get("QZ1-FLOAT-001"), fields: [NORTH], capabilities: chromium });
  assert.equal(model.assignedFieldId, "paddy-999");
  assert.equal(model.assignedFieldMissing, true);
});

test("a suggestion is offered only while unassigned, and is never an assignment", () => {
  const unassigned = buildSensorModel({
    sensor: buildSensor({ sensorId: "QZ1-FLOAT-001" }),
    fields: [NORTH],
    liveState: { sensorId: "QZ1-FLOAT-001", detectedFieldId: "paddy-001", assignmentStatus: ASSIGNMENT_STATES.CANDIDATE, fieldDetectionConfidence: 0.9 },
    capabilities: chromium
  });
  assert.equal(unassigned.suggestedFieldId, "paddy-001");
  assert.equal(unassigned.assignedFieldId, null, "detected is not assigned");

  const registry = registryWith([{ sensorId: "QZ1-FLOAT-002" }]);
  registry.assign("QZ1-FLOAT-002", "paddy-001");
  const assigned = buildSensorModel({
    sensor: registry.get("QZ1-FLOAT-002"),
    fields: [NORTH, SOUTH],
    liveState: { sensorId: "QZ1-FLOAT-002", detectedFieldId: "paddy-005", assignmentStatus: ASSIGNMENT_STATES.MOVED_WARNING },
    capabilities: chromium
  });
  assert.equal(assigned.suggestedFieldId, null, "an assigned sensor is never re-suggested");
  assert.equal(assigned.movedWarning, true);
  assert.equal(assigned.assignedFieldId, "paddy-001", "and the assignment is unchanged");
});

test("detection consistency is carried as a fraction and never renamed to probability", () => {
  const model = buildSensorModel({
    sensor: buildSensor({ sensorId: "QZ1-FLOAT-001" }),
    liveState: { sensorId: "QZ1-FLOAT-001", fieldDetectionConfidence: 0.9 },
    capabilities: chromium
  });
  assert.equal(model.detectionConsistency, 0.9);
  assert.ok(!("fieldDetectionProbability" in model));
});

test("the field-side model lists the paired sensors for that field only", () => {
  const registry = registryWith([{ sensorId: "QZ1-FLOAT-001" }, { sensorId: "QZ1-FLOAT-002" }]);
  registry.assign("QZ1-FLOAT-001", "paddy-001");
  registry.assign("QZ1-FLOAT-002", "paddy-005");

  const north = buildFieldSensorModel({ field: NORTH, sensors: registry.list(), capabilities: chromium });
  assert.equal(north.hasSensor, true);
  assert.deepEqual(north.sensors.map((s) => s.sensorId), ["QZ1-FLOAT-001"]);

  const empty = buildFieldSensorModel({ field: { id: "paddy-777", name: "空き" }, sensors: registry.list() });
  assert.equal(empty.hasSensor, false);
});

// ---------------------------------------------------------------------------
// Migration — V1 records must keep working
// ---------------------------------------------------------------------------

test("a V1 record loads with defaults, losing nothing", () => {
  // The exact shape the previous milestone persisted.
  const v1 = [{
    sensorId: "QZ1-FLOAT-001",
    type: "qz1-floating-water-level",
    label: "旧ラベル",
    assignedFieldId: "paddy-001",
    assignmentStatus: "locked",
    lastPosition: { latitude: 34.7, longitude: 135.5, altitudeM: 50 },
    lastSeenAt: "2026-08-29T01:00:00.000Z",
    assignmentHistory: [{ at: "2026-08-29T00:00:00.000Z", action: "assigned", fieldId: "paddy-001", note: "" }],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-29T01:00:00.000Z"
  }];
  const [migrated] = normalizeSensorList(v1);

  // Preserved.
  assert.equal(migrated.sensorId, "QZ1-FLOAT-001");
  assert.equal(migrated.assignedFieldId, "paddy-001");
  assert.equal(migrated.assignmentHistory.length, 1, "history survives");
  assert.equal(migrated.lastPosition.latitude, 34.7);
  assert.equal(migrated.createdAt, "2026-08-01T00:00:00.000Z");
  // Added, with defaults.
  assert.equal(migrated.displayName, "旧ラベル", "a V1 label becomes the display name");
  assert.equal(migrated.deviceModel, DEFAULT_DEVICE_MODEL);
  assert.deepEqual(migrated.settings, defaultSensorSettings());
  assert.equal(migrated.calibration, null);
});

test("a V1 record with no label keeps an empty display name and falls back to the id", () => {
  const [migrated] = normalizeSensorList([{ sensorId: "QZ1-FLOAT-002", assignedFieldId: null }]);
  assert.equal(migrated.displayName, "");
  assert.equal(sensorDisplayName(migrated), "QZ1-FLOAT-002");
});

test("a V1 record survives a full hydrate/persist round trip", () => {
  const storage = fakeStorage({
    schemaVersion: 1,
    sensors: [{ sensorId: "QZ1-FLOAT-001", label: "旧", assignedFieldId: "paddy-001", assignmentHistory: [] }]
  });
  const registry = new FloatingSensorRegistry({ storage }).hydrate();
  assert.equal(registry.get("QZ1-FLOAT-001").assignedFieldId, "paddy-001");

  registry.rename("QZ1-FLOAT-001", "新しい名前");
  const written = JSON.parse(storage._raw());
  assert.equal(written.schemaVersion, SENSOR_SCHEMA_VERSION);
  assert.equal(written.sensors[0].displayName, "新しい名前");
  assert.equal(written.sensors[0].assignedFieldId, "paddy-001", "the assignment is not lost on upgrade");
});

test("a corrupt calibration is carried through untouched rather than repaired into a licence", () => {
  // Repairing this is the one repair that could manufacture permission to show
  // a water depth. calibration.js re-checks it on every use instead.
  const [migrated] = normalizeSensorList([
    { sensorId: "QZ1-FLOAT-001", calibration: { baselineAltitudeMm: "nonsense" } }
  ]);
  assert.deepEqual(migrated.calibration, { baselineAltitudeMm: "nonsense" });
  assert.equal(calibrationState(migrated.calibration), CALIBRATION_STATES.INVALID);

  const model = buildSensorModel({
    sensor: migrated,
    liveState: { sensorId: "QZ1-FLOAT-001", latitude: 34.7, longitude: 135.5, altitudeM: 50, fixQuality: 1, satellites: 9, hdop: 0.9, lastSeenAtMs: 1 },
    capabilities: chromium,
    nowMs: 2
  });
  assert.equal(model.depthMm, null, "and no depth is derivable from it");
});

test("an unreadable record is dropped rather than given a new identity", () => {
  const normalized = normalizeSensorList([
    { sensorId: "QZ1-FLOAT-001" },
    { sensorId: "" },
    null,
    { notASensor: true }
  ]);
  assert.equal(normalized.length, 1);
});
