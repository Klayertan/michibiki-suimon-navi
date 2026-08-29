import test from "node:test";
import assert from "node:assert/strict";
import {
  ASSIGNMENT_STATES,
  DEFAULT_MOVEMENT_THRESHOLD,
  FloatingSensorRegistry,
  MovementWatch,
  SENSOR_STORAGE_KEY,
  SENSOR_TYPE_FLOATING_WATER_LEVEL,
  buildSensor,
  buildSensorMeasurement,
  canAssignFromDetection,
  deriveAssignmentStatus,
  makeSensorId,
  nextAvailableSensorId,
  normalizeSensorId,
  normalizeSensorList
} from "../../js/qz1-water-level/sensor-registry.js";
import { FieldDetectionWindow, WINDOW_STATUS } from "../../js/qz1-water-level/detection-window.js";
import { DETECTION_STATUS } from "../../js/qz1-water-level/field-detection.js";

/** A Map-backed Storage stand-in, the same shape user-scope.js tests against. */
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    _map: map
  };
}

const inside = (fieldId) => ({ status: DETECTION_STATUS.INSIDE, fieldId, fieldIds: [fieldId] });
const outside = () => ({ status: DETECTION_STATUS.OUTSIDE, fieldId: null, fieldIds: [] });
const ambiguous = (ids) => ({ status: DETECTION_STATUS.AMBIGUOUS, fieldId: null, fieldIds: ids });

/** A window summary that has settled on `fieldId` (or on nothing). */
function settledOn(fieldId, { decided = true } = {}) {
  const window = new FieldDetectionWindow({ windowSize: 10, candidateThreshold: 0.8 });
  const results = fieldId === null
    ? Array.from({ length: 10 }, () => outside())
    : Array.from({ length: decided ? 10 : 5 }, () => inside(fieldId));
  let summary;
  for (const result of results) {
    summary = window.push(result);
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

test("sensor ids look like QZ1-FLOAT-001 and are allocated from a counter", () => {
  assert.equal(makeSensorId(1), "QZ1-FLOAT-001");
  assert.equal(makeSensorId(42), "QZ1-FLOAT-042");
  assert.equal(nextAvailableSensorId([]), "QZ1-FLOAT-001");
  assert.equal(nextAvailableSensorId(["QZ1-FLOAT-001"]), "QZ1-FLOAT-002");
  assert.equal(nextAvailableSensorId(["QZ1-FLOAT-001", "QZ1-FLOAT-002"]), "QZ1-FLOAT-003");
  assert.equal(nextAvailableSensorId(["QZ1-FLOAT-002"]), "QZ1-FLOAT-001");
});

test("an id is never derived from a position", () => {
  // Two floats a metre apart must not collapse into one identity, and one
  // float that is carried elsewhere must not become a different device.
  const a = buildSensor({ sensorId: "QZ1-FLOAT-001" });
  assert.equal(a.sensorId, "QZ1-FLOAT-001");
  assert.equal(a.lastPosition, null, "a newly named device has reported nothing");
  assert.equal(a.assignedFieldId, null);
  assert.equal(a.assignmentStatus, ASSIGNMENT_STATES.UNASSIGNED);
  assert.equal(a.type, SENSOR_TYPE_FLOATING_WATER_LEVEL);
});

test("an unusable sensor id is refused, never repaired into something else", () => {
  for (const bad of ["", "   ", null, undefined, 42, "has space", "-leading", "a".repeat(65), {}]) {
    assert.equal(normalizeSensorId(bad), null, `${JSON.stringify(bad)} must not normalize`);
    assert.equal(buildSensor({ sensorId: bad }), null);
  }
  assert.equal(normalizeSensorId("  QZ1-FLOAT-001  "), "QZ1-FLOAT-001", "surrounding space is trimmed");
  assert.equal(normalizeSensorId("qz1_float.1"), "qz1_float.1");
});

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

test("unassigned -> detecting -> candidate as evidence accumulates", () => {
  const sensor = buildSensor({ sensorId: "QZ1-FLOAT-001" });
  const movement = new MovementWatch().summary();

  const noSamples = new FieldDetectionWindow().summarize();
  assert.equal(deriveAssignmentStatus({ sensor, windowSummary: noSamples, movementSummary: movement }),
    ASSIGNMENT_STATES.UNASSIGNED);

  assert.equal(
    deriveAssignmentStatus({ sensor, windowSummary: settledOn("paddy-003", { decided: false }), movementSummary: movement }),
    ASSIGNMENT_STATES.DETECTING);

  assert.equal(
    deriveAssignmentStatus({ sensor, windowSummary: settledOn("paddy-003"), movementSummary: movement }),
    ASSIGNMENT_STATES.CANDIDATE);
});

test("a confident outside and a confident ambiguous are their own states", () => {
  const sensor = buildSensor({ sensorId: "QZ1-FLOAT-001" });
  const movement = new MovementWatch().summary();

  assert.equal(deriveAssignmentStatus({ sensor, windowSummary: settledOn(null), movementSummary: movement }),
    ASSIGNMENT_STATES.OUTSIDE_KNOWN_FIELDS);

  const window = new FieldDetectionWindow();
  let summary;
  for (let i = 0; i < 10; i += 1) {
    summary = window.push(ambiguous(["paddy-003", "paddy-009"]));
  }
  assert.equal(summary.status, WINDOW_STATUS.AMBIGUOUS);
  assert.equal(deriveAssignmentStatus({ sensor, windowSummary: summary, movementSummary: movement }),
    ASSIGNMENT_STATES.AMBIGUOUS);
});

test("candidate -> locked happens only through an explicit assign()", () => {
  const registry = new FloatingSensorRegistry({ storage: fakeStorage() });
  registry.register({ sensorId: "QZ1-FLOAT-001" });

  const summary = settledOn("paddy-003");
  assert.equal(canAssignFromDetection({ sensor: registry.get("QZ1-FLOAT-001"), windowSummary: summary }), true);
  // Nothing has changed yet: a confident detection is an offer, not an act.
  assert.equal(registry.get("QZ1-FLOAT-001").assignedFieldId, null);

  registry.assign("QZ1-FLOAT-001", "paddy-003");
  const sensor = registry.get("QZ1-FLOAT-001");
  assert.equal(sensor.assignedFieldId, "paddy-003");
  assert.equal(sensor.assignmentStatus, ASSIGNMENT_STATES.LOCKED);
});

test("an assigned sensor is offered no further assignment from detection", () => {
  const sensor = { ...buildSensor({ sensorId: "QZ1-FLOAT-001" }), assignedFieldId: "paddy-003" };
  assert.equal(canAssignFromDetection({ sensor, windowSummary: settledOn("paddy-007") }), false);
});

test("locked survives GNSS noise: a thousand disagreeing samples do not move it", () => {
  const registry = new FloatingSensorRegistry({ storage: fakeStorage() });
  registry.register({ sensorId: "QZ1-FLOAT-001" });
  registry.assign("QZ1-FLOAT-001", "paddy-003");

  const window = new FieldDetectionWindow();
  const movement = new MovementWatch();
  let status = null;
  for (let i = 0; i < 1000; i += 1) {
    // Jitter across the levee: mostly the assigned field, occasionally next
    // door, never sustained.
    const summary = window.push(i % 7 === 0 ? inside("paddy-007") : inside("paddy-003"));
    const movementSummary = movement.update("paddy-003", summary);
    status = deriveAssignmentStatus({ sensor: registry.get("QZ1-FLOAT-001"), windowSummary: summary, movementSummary });
  }
  assert.equal(status, ASSIGNMENT_STATES.LOCKED);
  assert.equal(registry.get("QZ1-FLOAT-001").assignedFieldId, "paddy-003", "and the assignment itself never moved");
});

test("a locked sensor is never dragged back to candidate or ambiguous by detection", () => {
  const sensor = { ...buildSensor({ sensorId: "QZ1-FLOAT-001" }), assignedFieldId: "paddy-003" };
  const quiet = new MovementWatch().summary();
  for (const summary of [settledOn("paddy-007"), settledOn(null), settledOn("paddy-003", { decided: false })]) {
    assert.equal(deriveAssignmentStatus({ sensor, windowSummary: summary, movementSummary: quiet }),
      ASSIGNMENT_STATES.LOCKED, "choosing a field is over; only movement can change the display now");
  }
});

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

test("one mismatching window does not warn; a sustained run does", () => {
  const watch = new MovementWatch({ threshold: 3 });
  assert.equal(watch.update("paddy-003", settledOn("paddy-007")).warned, false);
  assert.equal(watch.update("paddy-003", settledOn("paddy-007")).warned, false);
  const third = watch.update("paddy-003", settledOn("paddy-007"));
  assert.equal(third.warned, true);
  assert.equal(third.consecutiveMismatches, 3);
  assert.equal(third.mismatchFieldId, "paddy-007");
  assert.equal(DEFAULT_MOVEMENT_THRESHOLD, 3);
});

test("any agreeing or unconfident window resets the run to zero", () => {
  const watch = new MovementWatch({ threshold: 3 });
  watch.update("paddy-003", settledOn("paddy-007"));
  watch.update("paddy-003", settledOn("paddy-007"));
  assert.equal(watch.update("paddy-003", settledOn("paddy-003")).consecutiveMismatches, 0,
    "back where it belongs: the run is broken");

  watch.update("paddy-003", settledOn("paddy-007"));
  watch.update("paddy-003", settledOn("paddy-007"));
  assert.equal(watch.update("paddy-003", settledOn("paddy-007", { decided: false })).consecutiveMismatches, 0,
    "an unconfident window is not evidence of anything");
});

test("alternating neighbours never accumulate a run: that is a boundary, not a move", () => {
  const watch = new MovementWatch({ threshold: 3 });
  let summary;
  for (let i = 0; i < 20; i += 1) {
    summary = watch.update("paddy-003", settledOn(i % 2 === 0 ? "paddy-007" : "paddy-009"));
  }
  assert.equal(summary.warned, false);
  assert.ok(summary.consecutiveMismatches < 3, "a run has to be about the same other field");
});

test("an unassigned sensor never produces a movement warning", () => {
  const watch = new MovementWatch({ threshold: 1 });
  assert.equal(watch.update(null, settledOn("paddy-007")).warned, false);
});

test("a movement warning changes the STATUS and nothing else", () => {
  const registry = new FloatingSensorRegistry({ storage: fakeStorage() });
  registry.register({ sensorId: "QZ1-FLOAT-001" });
  registry.assign("QZ1-FLOAT-001", "paddy-003");

  const watch = new MovementWatch({ threshold: 3 });
  let movementSummary;
  for (let i = 0; i < 5; i += 1) {
    movementSummary = watch.update("paddy-003", settledOn("paddy-007"));
  }
  const status = deriveAssignmentStatus({
    sensor: registry.get("QZ1-FLOAT-001"), windowSummary: settledOn("paddy-007"), movementSummary
  });
  assert.equal(status, ASSIGNMENT_STATES.MOVED_WARNING);
  // The whole point: a warning is a prompt for a person, not an action.
  assert.equal(registry.get("QZ1-FLOAT-001").assignedFieldId, "paddy-003",
    "assignedFieldId must NOT be rewritten by a warning");
  assert.equal(registry.get("QZ1-FLOAT-001").assignmentHistory.length, 1, "and no history event was added");
});

test("movement threshold is configurable", () => {
  const strict = new MovementWatch({ threshold: 10 });
  for (let i = 0; i < 9; i += 1) {
    assert.equal(strict.update("paddy-003", settledOn("paddy-007")).warned, false);
  }
  assert.equal(strict.update("paddy-003", settledOn("paddy-007")).warned, true);
  assert.throws(() => new MovementWatch({ threshold: 0 }));
});

// ---------------------------------------------------------------------------
// Reassignment and history
// ---------------------------------------------------------------------------

test("explicit reassignment records leaving the old field and joining the new one", () => {
  const registry = new FloatingSensorRegistry({ storage: fakeStorage() });
  registry.register({ sensorId: "QZ1-FLOAT-001" });
  registry.assign("QZ1-FLOAT-001", "paddy-003", { at: "2026-08-29T00:00:00.000Z" });
  registry.unassign("QZ1-FLOAT-001", { at: "2026-09-10T00:00:00.000Z" });
  registry.assign("QZ1-FLOAT-001", "paddy-005", { at: "2026-09-12T00:00:00.000Z" });

  const history = registry.get("QZ1-FLOAT-001").assignmentHistory;
  assert.deepEqual(history.map((event) => [event.at.slice(0, 10), event.action, event.fieldId]), [
    ["2026-08-29", "assigned", "paddy-003"],
    ["2026-09-10", "removed", "paddy-003"],
    ["2026-09-12", "assigned", "paddy-005"]
  ]);
  assert.equal(registry.get("QZ1-FLOAT-001").assignedFieldId, "paddy-005");
});

test("assigning straight over an existing assignment still records the departure", () => {
  // Otherwise the history reads as if the float had been in the new paddy all
  // along, and the record of where the August water actually was is lost.
  const registry = new FloatingSensorRegistry({ storage: fakeStorage() });
  registry.register({ sensorId: "QZ1-FLOAT-001" });
  registry.assign("QZ1-FLOAT-001", "paddy-003");
  registry.assign("QZ1-FLOAT-001", "paddy-005");

  const actions = registry.get("QZ1-FLOAT-001").assignmentHistory.map((event) => `${event.action}:${event.fieldId}`);
  assert.deepEqual(actions, ["assigned:paddy-003", "removed:paddy-003", "assigned:paddy-005"]);
});

test("assign() refuses without a sensor or without a field", () => {
  const registry = new FloatingSensorRegistry({ storage: fakeStorage() });
  assert.ok(registry.assign("QZ1-FLOAT-404", "paddy-003").error);
  registry.register({ sensorId: "QZ1-FLOAT-001" });
  assert.ok(registry.assign("QZ1-FLOAT-001", "").error);
  assert.ok(registry.assign("QZ1-FLOAT-001", null).error);
  assert.equal(registry.get("QZ1-FLOAT-001").assignedFieldId, null);
});

// ---------------------------------------------------------------------------
// Measurement stamping
// ---------------------------------------------------------------------------

test("a measurement is stamped with the field assigned at the time it was taken", () => {
  const registry = new FloatingSensorRegistry({ storage: fakeStorage() });
  registry.register({ sensorId: "QZ1-FLOAT-001" });
  registry.assign("QZ1-FLOAT-001", "paddy-003");

  const record = buildSensorMeasurement({
    sensor: registry.get("QZ1-FLOAT-001"),
    relativeHeightMm: 32,
    timestamp: "2026-08-29T01:00:00.000Z"
  });
  assert.equal(record.sensorId, "QZ1-FLOAT-001");
  assert.equal(record.fieldId, "paddy-003");
  assert.equal(record.relativeHeightMm, 32);
  assert.equal(record.assignmentStatusAtMeasurement, ASSIGNMENT_STATES.LOCKED);
});

test("moving the sensor does NOT rewrite measurements already taken", () => {
  const registry = new FloatingSensorRegistry({ storage: fakeStorage() });
  registry.register({ sensorId: "QZ1-FLOAT-001" });
  registry.assign("QZ1-FLOAT-001", "paddy-003");

  const august = buildSensorMeasurement({
    sensor: registry.get("QZ1-FLOAT-001"), relativeHeightMm: 32, timestamp: "2026-08-29T01:00:00.000Z"
  });
  registry.assign("QZ1-FLOAT-001", "paddy-005");
  const september = buildSensorMeasurement({
    sensor: registry.get("QZ1-FLOAT-001"), relativeHeightMm: 11, timestamp: "2026-09-12T01:00:00.000Z"
  });

  assert.equal(august.fieldId, "paddy-003", "the August water was in paddy-003 and still is");
  assert.equal(september.fieldId, "paddy-005");
});

test("an unassigned sensor stamps null, not the detected field", () => {
  // Detection is not assignment. A reading filed against a field nobody
  // confirmed is worse than one filed against none.
  const record = buildSensorMeasurement({
    sensor: buildSensor({ sensorId: "QZ1-FLOAT-001" }), relativeHeightMm: 5
  });
  assert.equal(record.fieldId, null);
  assert.equal(buildSensorMeasurement({ sensor: null }), null);
});

test("a non-finite height is null, never a fabricated zero", () => {
  const record = buildSensorMeasurement({
    sensor: buildSensor({ sensorId: "QZ1-FLOAT-001" }), relativeHeightMm: null, altitudeM: undefined
  });
  assert.equal(record.relativeHeightMm, null);
  assert.equal(record.altitudeM, null);
});

// ---------------------------------------------------------------------------
// Registry and persistence
// ---------------------------------------------------------------------------

test("registering twice returns the same record rather than a duplicate", () => {
  const registry = new FloatingSensorRegistry({ storage: fakeStorage() });
  const first = registry.register({ sensorId: "QZ1-FLOAT-001" });
  const second = registry.register({ sensorId: "QZ1-FLOAT-001" });
  assert.equal(second.alreadyRegistered, true);
  assert.equal(registry.list().length, 1);
  assert.equal(first.sensor.sensorId, second.sensor.sensorId);
});

test("identity and assignment survive a reload; live position does not have to", () => {
  const storage = fakeStorage();
  const first = new FloatingSensorRegistry({ storage });
  first.register({ sensorId: "QZ1-FLOAT-001" });
  first.assign("QZ1-FLOAT-001", "paddy-003");

  const reloaded = new FloatingSensorRegistry({ storage }).hydrate();
  const sensor = reloaded.get("QZ1-FLOAT-001");
  assert.equal(sensor.assignedFieldId, "paddy-003");
  assert.equal(sensor.assignmentStatus, ASSIGNMENT_STATES.LOCKED);
  assert.equal(sensor.assignmentHistory.length, 1);
  assert.ok(storage.getItem(SENSOR_STORAGE_KEY));
});

test("corrupt storage starts empty instead of crashing the card", () => {
  const storage = fakeStorage();
  storage.setItem(SENSOR_STORAGE_KEY, "{ not json");
  const registry = new FloatingSensorRegistry({ storage }).hydrate();
  assert.deepEqual(registry.list(), []);
});

test("a record with an unreadable id is dropped, not given a new identity", () => {
  const normalized = normalizeSensorList([
    { sensorId: "QZ1-FLOAT-001", assignedFieldId: "paddy-003" },
    { sensorId: "", assignedFieldId: "paddy-004" },
    { sensorId: "QZ1-FLOAT-001", assignedFieldId: "paddy-009" },
    null
  ]);
  assert.equal(normalized.length, 1, "duplicates and unreadable ids are dropped");
  assert.equal(normalized[0].assignedFieldId, "paddy-003", "the first record wins");
});

test("an unreadable status is recomputed from the assignment, which is the fact", () => {
  const [assigned, unassigned] = normalizeSensorList([
    { sensorId: "QZ1-FLOAT-001", assignedFieldId: "paddy-003", assignmentStatus: "nonsense" },
    { sensorId: "QZ1-FLOAT-002", assignedFieldId: null, assignmentStatus: ASSIGNMENT_STATES.LOCKED }
  ]);
  assert.equal(assigned.assignmentStatus, ASSIGNMENT_STATES.LOCKED);
  assert.equal(unassigned.assignmentStatus, ASSIGNMENT_STATES.UNASSIGNED);
});

test("an unreadable persisted position is dropped rather than turned into 0,0", () => {
  const [sensor] = normalizeSensorList([{
    sensorId: "QZ1-FLOAT-001",
    lastPosition: { latitude: null, longitude: null, altitudeM: null }
  }]);
  assert.equal(sensor.lastPosition, null);
});

test("listForField returns only CONFIRMED assignments", () => {
  const registry = new FloatingSensorRegistry({ storage: fakeStorage() });
  registry.register({ sensorId: "QZ1-FLOAT-001" });
  registry.register({ sensorId: "QZ1-FLOAT-002" });
  registry.assign("QZ1-FLOAT-001", "paddy-003");
  // 002 is merely detected in paddy-003; that is not membership.
  registry.updateStatus("QZ1-FLOAT-002", {
    assignmentStatus: ASSIGNMENT_STATES.CANDIDATE, detectedFieldId: "paddy-003", confidence: 1
  });

  assert.deepEqual(registry.listForField("paddy-003").map((s) => s.sensorId), ["QZ1-FLOAT-001"]);
  assert.deepEqual(registry.listForField(null), []);
});

test("recordPosition never touches the assignment", () => {
  const registry = new FloatingSensorRegistry({ storage: fakeStorage() });
  registry.register({ sensorId: "QZ1-FLOAT-001" });
  registry.assign("QZ1-FLOAT-001", "paddy-003");
  registry.recordPosition("QZ1-FLOAT-001", { latitude: 34.9, longitude: 135.9, altitudeM: 42.3 });

  const sensor = registry.get("QZ1-FLOAT-001");
  assert.equal(sensor.assignedFieldId, "paddy-003", "a position on the far side of the county changes nothing");
  assert.equal(sensor.lastPosition.latitude, 34.9);
  assert.equal(sensor.lastPosition.altitudeM, 42.3);
});

test("a registry with no storage still works entirely in memory", () => {
  const registry = new FloatingSensorRegistry({});
  registry.hydrate();
  registry.register({ sensorId: "QZ1-FLOAT-001" });
  registry.assign("QZ1-FLOAT-001", "paddy-003");
  assert.equal(registry.get("QZ1-FLOAT-001").assignedFieldId, "paddy-003");
});

test("the registry emits change so views can subscribe rather than poll", () => {
  const registry = new FloatingSensorRegistry({ storage: fakeStorage() });
  let changes = 0;
  registry.addEventListener("change", () => { changes += 1; });
  registry.register({ sensorId: "QZ1-FLOAT-001" });
  registry.assign("QZ1-FLOAT-001", "paddy-003");
  registry.unassign("QZ1-FLOAT-001");
  assert.equal(changes, 3);
});
