import test from "node:test";
import assert from "node:assert/strict";
import {
  DETECTION_STATUS,
  containsViaRayCasting,
  containsViaTurf,
  detectFieldForPosition,
  isPositionInsideBoundary,
  isUsablePolygon,
  isValidLatitude,
  isValidLongitude,
  toGeoJsonRing
} from "../../js/qz1-water-level/field-detection.js";
import { fieldBoundaryCoordinates, fieldDisplayName, findFieldById } from "../../js/qz1-water-level/field-boundary.js";

// SYNTHETIC geometry. Two ~110 m squares in the Kansai paddy belt, plus one
// that overlaps the first. Coordinates are [lat, lon] — the order this app
// stores boundaries in. Nothing here was measured anywhere.
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
// Deliberately overlaps NORTH: two farmers' surveys of a shared levee, or one
// boundary walked twice slightly differently. Real, and must not be resolved
// by array order.
const OVERLAP = {
  id: "paddy-009",
  name: "重なる田",
  coordinates: [[34.7005, 135.5005], [34.7005, 135.5015], [34.7015, 135.5015], [34.7015, 135.5005]]
};

const INSIDE_NORTH = { latitude: 34.7003, longitude: 135.5003 };
const INSIDE_BOTH = { latitude: 34.7008, longitude: 135.5008 };
const OUTSIDE_ALL = { latitude: 34.7500, longitude: 135.5500 };

test("a position clearly inside one field detects that field", () => {
  const result = detectFieldForPosition({ ...INSIDE_NORTH, fields: [NORTH, SOUTH] });
  assert.equal(result.status, DETECTION_STATUS.INSIDE);
  assert.equal(result.fieldId, "paddy-003");
  assert.deepEqual(result.fieldIds, ["paddy-003"]);
  assert.equal(result.candidates[0].name, "北の田");
  assert.equal(result.checkedFieldCount, 2);
});

test("a position outside every field detects none, and does NOT pick the nearest", () => {
  const result = detectFieldForPosition({ ...OUTSIDE_ALL, fields: [NORTH, SOUTH] });
  assert.equal(result.status, DETECTION_STATUS.OUTSIDE);
  assert.equal(result.fieldId, null);
  assert.deepEqual(result.fieldIds, []);
  // NORTH is nearer than SOUTH from OUTSIDE_ALL. Containment was the question.
  assert.deepEqual(result.candidates, []);
});

test("overlapping fields are ambiguous, never resolved by array order", () => {
  const forwards = detectFieldForPosition({ ...INSIDE_BOTH, fields: [NORTH, OVERLAP] });
  const backwards = detectFieldForPosition({ ...INSIDE_BOTH, fields: [OVERLAP, NORTH] });

  assert.equal(forwards.status, DETECTION_STATUS.AMBIGUOUS);
  assert.equal(backwards.status, DETECTION_STATUS.AMBIGUOUS);
  assert.equal(forwards.fieldId, null, "no field is chosen");
  assert.equal(backwards.fieldId, null);
  // Both candidates are exposed so the UI and a debugger can see which two.
  assert.deepEqual([...forwards.fieldIds].sort(), ["paddy-003", "paddy-009"]);
  assert.deepEqual([...forwards.fieldIds].sort(), [...backwards.fieldIds].sort(),
    "the answer must not depend on the order the fields were registered in");
});

test("coordinate order: a [lat, lon] boundary is NOT read as [lon, lat]", () => {
  // The classic GeoJSON bug. If the axes were swapped, the polygon would sit
  // near lat 135 (impossible) and every query would read "outside" — a
  // failure that looks like "detection just doesn't work" rather than a bug.
  const inside = detectFieldForPosition({ ...INSIDE_NORTH, fields: [NORTH] });
  assert.equal(inside.status, DETECTION_STATUS.INSIDE);

  // The same numbers with the axes swapped must NOT be found inside.
  const swapped = detectFieldForPosition({
    latitude: INSIDE_NORTH.longitude, longitude: INSIDE_NORTH.latitude, fields: [NORTH]
  });
  assert.notEqual(swapped.status, DETECTION_STATUS.INSIDE);
});

test("toGeoJsonRing flips to [lon, lat] and closes the ring", () => {
  const ring = toGeoJsonRing(NORTH.coordinates);
  assert.deepEqual(ring[0], [135.500, 34.700], "GeoJSON is [longitude, latitude]");
  assert.equal(ring.length, NORTH.coordinates.length + 1, "the ring is closed");
  assert.deepEqual(ring[0], ring[ring.length - 1]);
});

test("toGeoJsonRing does not double-close an already-closed ring", () => {
  const closed = [...NORTH.coordinates, NORTH.coordinates[0]];
  assert.equal(toGeoJsonRing(closed).length, closed.length);
});

test("invalid coordinates are refused rather than guessed at", () => {
  for (const position of [
    { latitude: NaN, longitude: 135.5 },
    { latitude: 34.7, longitude: NaN },
    { latitude: null, longitude: 135.5 },
    { latitude: 34.7, longitude: undefined },
    { latitude: "34.7", longitude: "135.5" },
    { latitude: 91, longitude: 135.5 },
    { latitude: 34.7, longitude: 181 },
    { latitude: Infinity, longitude: 135.5 }
  ]) {
    const result = detectFieldForPosition({ ...position, fields: [NORTH] });
    assert.equal(result.status, DETECTION_STATUS.INVALID_POSITION,
      `${JSON.stringify(position)} must be refused`);
    assert.equal(result.fieldId, null);
  }
});

test("a numeric string is not a coordinate: 0 would be the Gulf of Guinea", () => {
  // Number("") === 0 and Number(null) === 0, both of which are a valid-looking
  // latitude. Strict typing here is what stops a missing fix becoming a
  // confident position at 0,0.
  assert.equal(isValidLatitude("34.7"), false);
  assert.equal(isValidLatitude(null), false);
  assert.equal(isValidLatitude(""), false);
  assert.equal(isValidLongitude(null), false);
  assert.equal(isValidLatitude(0), true, "0 typed as a number is a real latitude");
});

test("a malformed polygon is skipped and named, never treated as empty or as containing everything", () => {
  const broken = { id: "paddy-broken", name: "壊れた田", coordinates: [[34.7, 135.5], [34.7, 135.501]] };
  const nanVertex = { id: "paddy-nan", name: "NaN", coordinates: [[34.7, 135.5], [NaN, 135.501], [34.701, 135.5]] };

  const result = detectFieldForPosition({ ...INSIDE_NORTH, fields: [NORTH, broken, nanVertex] });
  assert.equal(result.status, DETECTION_STATUS.INSIDE);
  assert.equal(result.fieldId, "paddy-003");
  assert.equal(result.checkedFieldCount, 1, "only the usable polygon was tested");
  assert.deepEqual([...result.invalidFieldIds].sort(), ["paddy-broken", "paddy-nan"],
    "a boundary that cannot be tested is reported, not silently dropped");
});

test("no usable polygon at all is NO_FIELDS, which is not the same as OUTSIDE", () => {
  // "Nothing to compare against" and "compared against everything and matched
  // nothing" are different facts; conflating them would let an app with zero
  // registered fields confidently report the sensor as outside them all.
  const noFields = detectFieldForPosition({ ...INSIDE_NORTH, fields: [] });
  assert.equal(noFields.status, DETECTION_STATUS.NO_FIELDS);

  const onlyBroken = detectFieldForPosition({
    ...INSIDE_NORTH, fields: [{ id: "x", coordinates: [[34.7, 135.5]] }]
  });
  assert.equal(onlyBroken.status, DETECTION_STATUS.NO_FIELDS);
  assert.deepEqual(onlyBroken.invalidFieldIds, ["x"]);
});

test("detection is strict about degenerate boundaries, unlike the permissive annotation helper", () => {
  // field-annotation-core's isPointInsideBoundary() returns TRUE for a
  // <3-point boundary on purpose (it is a "warn if clearly outside" check).
  // Reusing that here would report a sensor as inside a two-point track.
  assert.equal(isPositionInsideBoundary(34.7003, 135.5003, [[34.7, 135.5], [34.7, 135.501]]), false);
  assert.equal(isUsablePolygon([[34.7, 135.5], [34.7, 135.501]]), false);
  assert.equal(isUsablePolygon(NORTH.coordinates), true);
  assert.equal(isUsablePolygon(null), false);
});

test("both field record shapes in this repo are read, and no third is invented", () => {
  // Stage-1 / annotation shape (top-level coordinates).
  assert.equal(fieldBoundaryCoordinates(NORTH).length, 4);
  // Assurance registry shape (nested under boundary).
  const registryShape = { id: "field-x", name: "登録", boundary: { coordinates: NORTH.coordinates } };
  assert.equal(fieldBoundaryCoordinates(registryShape).length, 4);
  assert.deepEqual(fieldBoundaryCoordinates({}), []);
  assert.deepEqual(fieldBoundaryCoordinates(null), []);

  const detected = detectFieldForPosition({ ...INSIDE_NORTH, fields: [registryShape] });
  assert.equal(detected.status, DETECTION_STATUS.INSIDE);
  assert.equal(detected.fieldId, "field-x");
});

test("a field name falls back to its id, and lookup works across shapes", () => {
  assert.equal(fieldDisplayName(NORTH), "北の田");
  assert.equal(fieldDisplayName({ id: "paddy-001", name: "   " }), "paddy-001");
  assert.equal(findFieldById([NORTH, SOUTH], "paddy-007").id, "paddy-007");
  assert.equal(findFieldById([NORTH], "nope"), null);
  assert.equal(findFieldById([NORTH], null), null);
});

test("a point on the boundary is decided consistently, not randomly", () => {
  // Ray casting puts an exact-vertex-latitude point on one definite side. The
  // value matters less than that it is stable: the same query must not
  // alternate between inside and outside on repeated calls.
  const onEdge = { latitude: 34.700, longitude: 135.5005 };
  const first = detectFieldForPosition({ ...onEdge, fields: [NORTH] }).status;
  for (let i = 0; i < 10; i += 1) {
    assert.equal(detectFieldForPosition({ ...onEdge, fields: [NORTH] }).status, first);
  }
});

test("Turf is preferred when present, and its answer matches the built-in test", () => {
  // Turf is CDN-loaded in the browser and simply absent in Node, so the
  // fallback is the normal path here. This checks the seam itself: absent
  // Turf yields null (fall through), and a stub Turf is actually consulted.
  assert.equal(containsViaTurf(34.7003, 135.5003, NORTH.coordinates), null, "no turf in Node");

  const calls = [];
  globalThis.turf = {
    point: (position) => ({ kind: "point", position }),
    polygon: (rings) => ({ kind: "polygon", rings }),
    booleanPointInPolygon: (point, polygon) => {
      calls.push({ point, polygon });
      // Re-implement via the built-in test on the flipped coordinates so the
      // assertion below is about the seam, not about Turf's own correctness.
      const ring = polygon.rings[0].map(([lon, lat]) => [lat, lon]);
      return containsViaRayCasting(point.position[1], point.position[0], ring);
    }
  };
  try {
    assert.equal(containsViaTurf(34.7003, 135.5003, NORTH.coordinates), true);
    assert.equal(containsViaTurf(34.7500, 135.5500, NORTH.coordinates), false);
    assert.equal(calls.length, 2, "Turf was actually consulted");
    assert.deepEqual(calls[0].point.position, [135.5003, 34.7003], "Turf is given [lon, lat]");

    const viaTurf = detectFieldForPosition({ ...INSIDE_NORTH, fields: [NORTH, SOUTH] });
    assert.equal(viaTurf.engine, "turf");
    assert.equal(viaTurf.fieldId, "paddy-003");
  } finally {
    delete globalThis.turf;
  }
  assert.equal(detectFieldForPosition({ ...INSIDE_NORTH, fields: [NORTH] }).engine, "ray-casting");
});

test("a Turf that throws falls back instead of reporting 'outside'", () => {
  globalThis.turf = {
    point: () => { throw new Error("bad ring"); },
    polygon: () => ({}),
    booleanPointInPolygon: () => true
  };
  try {
    assert.equal(containsViaTurf(34.7003, 135.5003, NORTH.coordinates), null);
    const result = detectFieldForPosition({ ...INSIDE_NORTH, fields: [NORTH] });
    assert.equal(result.status, DETECTION_STATUS.INSIDE, "the built-in test still answers correctly");
    assert.equal(result.engine, "ray-casting");
  } finally {
    delete globalThis.turf;
  }
});
