import test from "node:test";
import assert from "node:assert/strict";
import { FieldRegistry, validateBoundary } from "../../js/fields/field-registry.js";

const observations = [
  { id: "p1", fixValid: true, lat: 35.0, lon: 135.0 },
  { id: "p2", fixValid: true, lat: 35.0, lon: 135.0001 },
  { id: "p3", fixValid: true, lat: 35.0001, lon: 135.0001 },
  { id: "p4", fixValid: true, lat: 35.0001, lon: 135.0 }
];

test("a configurable point range becomes one persisted paddy field", () => {
  const registry = new FieldRegistry();
  const field = registry.createFromObservationRange({
    name: "北田",
    sessionId: "session-1",
    observations,
    startObservationId: "p1",
    endObservationId: "p4",
    direction: "forward"
  });
  assert.equal(field.name, "北田");
  assert.deepEqual(field.boundary.orderedObservationIds, ["p1", "p2", "p3", "p4"]);
  assert.equal(registry.getActive().id, field.id);

  const restored = new FieldRegistry();
  restored.hydrate(registry.serialize());
  assert.deepEqual(restored.getActive().boundary.coordinates, field.boundary.coordinates);
});

test("self-intersecting field boundaries are warned, not silently trusted", () => {
  const validation = validateBoundary([[35, 135], [35.0001, 135.0001], [35, 135.0001], [35.0001, 135]]);
  assert.equal(validation.valid, false);
  assert.ok(validation.warnings.some((warning) => warning.includes("自己交差")));
});
