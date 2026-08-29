// The seam: one parsed QZ1 position, two independent consumers.
//
// index.html hands the SAME `point` object to the altitude experiment and to
// the field detector. This file checks that both get what they need from one
// parse, and — the point of the milestone — that neither depends on the
// other. If the altitude experiment concludes that GNSS height cannot resolve
// a water-level change, field association must still work.
//
// SYNTHETIC throughout: hand-written NMEA and invented paddy polygons. Nothing
// here says anything about real hardware.

import test from "node:test";
import assert from "node:assert/strict";

import { parseNmeaSession } from "../../js/gnss/nmea-parser.js";
import { observationsToSamples, serialPointToSample } from "../../js/qz1-water-level/experiment-samples.js";
import { summarizeAltitudes } from "../../js/qz1-water-level/displacement-statistics.js";
import { DETECTION_STATUS, detectFieldForPosition } from "../../js/qz1-water-level/field-detection.js";
import { SensorFieldController } from "../../js/qz1-water-level/sensor-field-controller.js";
import { ASSIGNMENT_STATES, FloatingSensorRegistry } from "../../js/qz1-water-level/sensor-registry.js";

// A ~110 m square around 34.700 N, 135.500 E, and its neighbour to the south.
const NORTH = {
  id: "paddy-003",
  name: "北の田",
  coordinates: [[34.700, 135.500], [34.700, 135.501], [34.701, 135.501], [34.701, 135.500]]
};
const SOUTH = {
  id: "paddy-007",
  name: "南の田",
  coordinates: [[34.698, 135.500], [34.698, 135.501], [34.699, 135.501], [34.699, 135.500]]
};

/** One GGA sentence with a correct checksum, at a given position/altitude. */
function gga({ latitude, longitude, altitudeM, hhmmss = "020000.00" }) {
  const body = `GPGGA,${hhmmss},${toNmeaLat(latitude)},N,${toNmeaLon(longitude)},E,1,09,0.9,${altitudeM.toFixed(3)},M,36.0,M,,`;
  let checksum = 0;
  for (const character of body) {
    checksum ^= character.charCodeAt(0);
  }
  return `$${body}*${checksum.toString(16).toUpperCase().padStart(2, "0")}`;
}

function toNmeaLat(degrees) {
  const whole = Math.floor(degrees);
  return `${String(whole).padStart(2, "0")}${((degrees - whole) * 60).toFixed(4).padStart(7, "0")}`;
}

function toNmeaLon(degrees) {
  const whole = Math.floor(degrees);
  return `${String(whole).padStart(3, "0")}${((degrees - whole) * 60).toFixed(4).padStart(7, "0")}`;
}

/** The live-pipeline point shape index.html's parseNmea() produces. */
function livePoint({ latitude, longitude, altitudeM }) {
  return { lat: latitude, lon: longitude, altitude: altitudeM, fixQuality: 1, satellites: 9, hdop: 0.9, timestamp: "020000.00" };
}

function controller(options = {}) {
  return new SensorFieldController({
    getFields: () => [NORTH, SOUTH],
    registry: new FloatingSensorRegistry({}),
    windowSize: 10,
    candidateThreshold: 0.8,
    movementThreshold: 3,
    ...options
  });
}

/** Feeds n fixes at one position through a headless controller. */
function feed(control, position, count, startMs = 1_700_000_000_000) {
  let snapshot = null;
  for (let index = 0; index < count; index += 1) {
    snapshot = control.ingestLiveFix(livePoint(position), startMs + index * 1000);
  }
  return snapshot;
}

// ---------------------------------------------------------------------------

test("a parsed QZ1 position reaches the field detector through the shared parser", () => {
  // The offline path: the project's existing NMEA parser, not a second one.
  const text = [
    gga({ latitude: 34.7003, longitude: 135.5003, altitudeM: 50.123 }),
    "$GNRMC,020000.00,A,3442.0180,N,13530.0180,E,0.0,0.0,150126,,,A*6A",
    ""
  ].join("\r\n");
  const parsed = parseNmeaSession(text, { captureDate: "2026-01-15" });
  assert.equal(parsed.observations.length, 1);

  const [observation] = parsed.observations;
  const detection = detectFieldForPosition({
    latitude: observation.lat, longitude: observation.lon, fields: [NORTH, SOUTH]
  });
  assert.equal(detection.status, DETECTION_STATUS.INSIDE);
  assert.equal(detection.fieldId, "paddy-003");
});

test("the same observation feeds altitude analysis without being re-parsed", () => {
  const text = [
    gga({ latitude: 34.7003, longitude: 135.5003, altitudeM: 50.123 }),
    "$GNGSA,A,3,01,02,03,04,05,06,07,08,,,,,1.8,0.9,1.5*2E",
    ""
  ].join("\r\n");
  const parsed = parseNmeaSession(text, { captureDate: "2026-01-15" });
  const [sample] = observationsToSamples(parsed.observations);

  // Altitude side.
  assert.equal(sample.altitudeM, 50.123);
  assert.equal(sample.altitudeMm, 50123);
  assert.equal(sample.vdop, 1.5);
  // Position side, off the same observation.
  assert.ok(Math.abs(sample.latitude - 34.7003) < 1e-6);
  assert.ok(Math.abs(sample.longitude - 135.5003) < 1e-6);
});

test("the live point shape feeds both consumers from one object", () => {
  const point = livePoint({ latitude: 34.7003, longitude: 135.5003, altitudeM: 50.5 });

  // Consumer 1: the altitude experiment.
  const sample = serialPointToSample(point, 1_700_000_000_000, "$GPGGA,...");
  assert.equal(sample.altitudeMm, 50500);

  // Consumer 2: field detection, same object, no second parse.
  const control = controller();
  control.useSensor("QZ1-FLOAT-001");
  const snapshot = control.ingestLiveFix(point, 1_700_000_000_000);
  assert.ok(Math.abs(snapshot.latitude - 34.7003) < 1e-9);
  assert.ok(Math.abs(snapshot.altitudeM - 50.5) < 1e-9);
});

test("field detection works with NO altitude at all", () => {
  // The independence requirement, stated as a test: horizontal association
  // must not be reachable only through the vertical experiment.
  const control = controller();
  control.useSensor("QZ1-FLOAT-001");
  control.registry.register({ sensorId: "QZ1-FLOAT-001" });

  let snapshot = null;
  for (let index = 0; index < 10; index += 1) {
    snapshot = control.ingestLiveFix(
      { lat: 34.7003, lon: 135.5003, altitude: null, fixQuality: 1, satellites: 9, hdop: 0.9 },
      1_700_000_000_000 + index * 1000
    );
  }
  assert.equal(snapshot.altitudeM, null, "no altitude was reported at all");
  assert.equal(snapshot.detectedFieldId, "paddy-003", "and the paddy was still identified");
  assert.equal(snapshot.fieldDetectionConfidence, 1);
  assert.equal(snapshot.assignmentStatus, ASSIGNMENT_STATES.CANDIDATE);
});

test("altitude statistics are unaffected by anything the sensor layer does", () => {
  // A guard against future coupling: the altitude pipeline's numbers must be
  // computable with no sensor, no field and no registry in the picture.
  const altitudes = [50000, 50002, 49998, 50001, 49999];
  const before = summarizeAltitudes(altitudes);

  const control = controller();
  control.useSensor("QZ1-FLOAT-001");
  feed(control, { latitude: 34.7003, longitude: 135.5003, altitudeM: 50.0 }, 10);

  const after = summarizeAltitudes(altitudes);
  assert.deepEqual(after, before);
});

// ---------------------------------------------------------------------------
// The installation workflow, end to end and headless
// ---------------------------------------------------------------------------

test("detect automatically, confirm once, lock afterwards", () => {
  const control = controller();
  control.useSensor("QZ1-FLOAT-001");

  // Nothing yet.
  assert.equal(control.snapshot().assignmentStatus, ASSIGNMENT_STATES.UNASSIGNED);

  // Detecting…
  feed(control, { latitude: 34.7003, longitude: 135.5003, altitudeM: 50 }, 5);
  assert.equal(control.snapshot().assignmentStatus, ASSIGNMENT_STATES.DETECTING);
  assert.equal(control.snapshot().detectedFieldId, null, "no claim before the window is full");

  // Candidate.
  feed(control, { latitude: 34.7003, longitude: 135.5003, altitudeM: 50 }, 5, 1_700_000_005_000);
  const candidate = control.snapshot();
  assert.equal(candidate.assignmentStatus, ASSIGNMENT_STATES.CANDIDATE);
  assert.equal(candidate.detectedFieldId, "paddy-003");
  assert.equal(candidate.assignedFieldId, null, "detected is not assigned");

  // Confirm — the one human step.
  control.registry.register({ sensorId: "QZ1-FLOAT-001" });
  control.registry.assign("QZ1-FLOAT-001", "paddy-003");
  const locked = control.snapshot();
  assert.equal(locked.assignedFieldId, "paddy-003");
  assert.equal(locked.assignmentStatus, ASSIGNMENT_STATES.LOCKED);
});

test("a float outside every registered field says so, and offers no assignment", () => {
  const control = controller();
  control.useSensor("QZ1-FLOAT-001");
  const snapshot = feed(control, { latitude: 34.7500, longitude: 135.5500, altitudeM: 50 }, 10);
  assert.equal(snapshot.assignmentStatus, ASSIGNMENT_STATES.OUTSIDE_KNOWN_FIELDS);
  assert.equal(snapshot.detectedFieldId, null);
  // NORTH is the nearer of the two. Proximity was not the question.
  assert.equal(snapshot.candidateFieldIds.length, 0);
});

test("boundary jitter does not flip the answer", () => {
  // A float parked just inside the north edge, with fixes scattering across
  // the boundary. Eight of ten land inside.
  const control = controller();
  control.useSensor("QZ1-FLOAT-001");
  const jitter = [
    34.70005, 34.70005, 34.69995, 34.70005, 34.70005,
    34.70005, 34.69995, 34.70005, 34.70005, 34.70005
  ];
  let snapshot = null;
  jitter.forEach((latitude, index) => {
    snapshot = control.ingestLiveFix(
      livePoint({ latitude, longitude: 135.5005, altitudeM: 50 }),
      1_700_000_000_000 + index * 1000
    );
  });
  assert.equal(snapshot.detectedFieldId, "paddy-003");
  assert.ok(Math.abs(snapshot.fieldDetectionConfidence - 0.8) < 1e-9,
    "the confidence reports the disagreement rather than hiding it");
});

test("a float in overlapping fields reports ambiguity with both ids", () => {
  const overlapping = {
    id: "paddy-009",
    name: "重なる田",
    coordinates: [[34.7005, 135.5005], [34.7005, 135.5015], [34.7015, 135.5015], [34.7015, 135.5005]]
  };
  const control = controller({ getFields: () => [NORTH, overlapping] });
  control.useSensor("QZ1-FLOAT-001");
  const snapshot = feed(control, { latitude: 34.7008, longitude: 135.5008, altitudeM: 50 }, 10);

  assert.equal(snapshot.assignmentStatus, ASSIGNMENT_STATES.AMBIGUOUS);
  assert.equal(snapshot.detectedFieldId, null, "no field is silently chosen");
  assert.deepEqual([...snapshot.candidateFieldIds].sort(), ["paddy-003", "paddy-009"]);
});

test("assigned to A but persistently detected in B warns, and changes nothing", () => {
  const control = controller();
  control.useSensor("QZ1-FLOAT-001");
  control.registry.register({ sensorId: "QZ1-FLOAT-001" });
  control.registry.assign("QZ1-FLOAT-001", "paddy-003");

  // Someone carried the float to the south paddy. The window must settle on
  // the new field (10 fixes) and then hold for the 3-verdict run, so the
  // warning arrives around the thirteenth fix -- about 13 s at 1 Hz. Four
  // windows are fed here so the assertion is not sitting on that boundary.
  let snapshot = null;
  for (let block = 0; block < 4; block += 1) {
    snapshot = feed(control, { latitude: 34.6985, longitude: 135.5005, altitudeM: 50 }, 10,
      1_700_000_000_000 + block * 10_000);
  }
  assert.equal(snapshot.assignmentStatus, ASSIGNMENT_STATES.MOVED_WARNING);
  assert.equal(snapshot.movement.mismatchFieldId, "paddy-007");
  assert.equal(snapshot.assignedFieldId, "paddy-003", "the assignment is NOT changed automatically");
  assert.equal(control.registry.get("QZ1-FLOAT-001").assignedFieldId, "paddy-003");
});

test("a brief excursion never reaches the warning threshold", () => {
  const control = controller();
  control.useSensor("QZ1-FLOAT-001");
  control.registry.register({ sensorId: "QZ1-FLOAT-001" });
  control.registry.assign("QZ1-FLOAT-001", "paddy-003");

  feed(control, { latitude: 34.7003, longitude: 135.5003, altitudeM: 50 }, 10);
  // One window's worth in the neighbour, then home again.
  feed(control, { latitude: 34.6985, longitude: 135.5005, altitudeM: 50 }, 10, 1_700_000_010_000);
  const snapshot = feed(control, { latitude: 34.7003, longitude: 135.5003, altitudeM: 50 }, 10, 1_700_000_020_000);

  assert.equal(snapshot.assignmentStatus, ASSIGNMENT_STATES.LOCKED);
  assert.equal(snapshot.movement.consecutiveMismatches, 0);
});

test("editing the registered fields discards votes cast against the old map", () => {
  let fields = [NORTH, SOUTH];
  const control = controller({ getFields: () => fields });
  control.useSensor("QZ1-FLOAT-001");
  feed(control, { latitude: 34.7003, longitude: 135.5003, altitudeM: 50 }, 10);
  assert.equal(control.snapshot().detectedFieldId, "paddy-003");

  // The farmer re-walks the boundary: same id and vertex count, different geometry.
  fields = [{
    ...NORTH,
    coordinates: [[34.7001, 135.5000], [34.7001, 135.5010], [34.7010, 135.5010], [34.7010, 135.5000]]
  }, SOUTH];
  const afterEdit = control.ingestLiveFix(livePoint({ latitude: 34.7003, longitude: 135.5003, altitudeM: 50 }), 1_700_000_020_000);
  assert.equal(afterEdit.detectedFieldId, null, "the window restarted against the new geometry");
  assert.equal(afterEdit.assignmentStatus, ASSIGNMENT_STATES.DETECTING);
});

test("a measurement built from live state carries the assigned field, not the detected one", () => {
  const control = controller();
  control.useSensor("QZ1-FLOAT-001");
  control.registry.register({ sensorId: "QZ1-FLOAT-001" });
  control.registry.assign("QZ1-FLOAT-001", "paddy-003");
  // Physically sitting in the SOUTH paddy while assigned to the north one.
  feed(control, { latitude: 34.6985, longitude: 135.5005, altitudeM: 50 }, 10);

  const record = control.buildMeasurement({ relativeHeightMm: 32, timestamp: "2026-08-29T01:00:00.000Z" });
  assert.equal(record.fieldId, "paddy-003", "the confirmed assignment, never the live detection");
  assert.equal(record.relativeHeightMm, 32);
  assert.ok(Math.abs(record.latitude - 34.6985) < 1e-9, "the real position is still recorded");
});

test("an unregistered sensor produces no measurement rather than an anonymous one", () => {
  const control = controller();
  control.useSensor("QZ1-FLOAT-001");
  feed(control, { latitude: 34.7003, longitude: 135.5003, altitudeM: 50 }, 10);
  assert.equal(control.buildMeasurement({ relativeHeightMm: 32 }), null);
});

test("the snapshot exposes every field the milestone asks for", () => {
  const control = controller();
  control.useSensor("QZ1-FLOAT-001");
  control.registry.register({ sensorId: "QZ1-FLOAT-001" });
  const snapshot = feed(control, { latitude: 34.7003, longitude: 135.5003, altitudeM: 50.5 }, 10);

  for (const key of [
    "sensorId", "latitude", "longitude", "detectedFieldId",
    "fieldDetectionConfidence", "assignedFieldId", "assignmentStatus"
  ]) {
    assert.ok(key in snapshot, `snapshot must expose ${key}`);
  }
  assert.equal(snapshot.sensorId, "QZ1-FLOAT-001");
  assert.equal(snapshot.altitudeM, 50.5, "altitude travels alongside, from the same fix");
});

test("a fix with no position is ignored without disturbing the window", () => {
  const control = controller();
  control.useSensor("QZ1-FLOAT-001");
  feed(control, { latitude: 34.7003, longitude: 135.5003, altitudeM: 50 }, 10);
  const before = control.snapshot();

  control.ingestLiveFix({ lat: null, lon: null, altitude: 50 }, 1_700_000_020_000);
  const after = control.snapshot();
  assert.equal(after.detectedFieldId, before.detectedFieldId);
  assert.equal(after.fieldDetectionConfidence, before.fieldDetectionConfidence);
  assert.equal(control.ingestLiveFix(null), null, "a null fix is simply not a fix");
});

test("with no fields registered the sensor is 'detecting', never 'outside'", () => {
  const control = controller({ getFields: () => [] });
  control.useSensor("QZ1-FLOAT-001");
  const snapshot = feed(control, { latitude: 34.7003, longitude: 135.5003, altitudeM: 50 }, 10);
  assert.equal(snapshot.assignmentStatus, ASSIGNMENT_STATES.DETECTING);
  assert.equal(snapshot.detectionStatus, DETECTION_STATUS.NO_FIELDS);
});

test("online reflects fix age, not whether anything was ever received", () => {
  const control = controller({ onlineTimeoutMs: 5000 });
  control.useSensor("QZ1-FLOAT-001");
  assert.equal(control.isOnline(1_700_000_000_000), false, "nothing received yet");
  control.ingestLiveFix(livePoint({ latitude: 34.7003, longitude: 135.5003, altitudeM: 50 }), 1_700_000_000_000);
  assert.equal(control.isOnline(1_700_000_002_000), true);
  assert.equal(control.isOnline(1_700_000_010_000), false, "a stale fix is not an online sensor");
});
