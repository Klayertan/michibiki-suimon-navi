// Which registered paddy field contains a GNSS position?
//
// WHY THE SENSOR DOES NOT KNOW ITS OWN FIELD
// ------------------------------------------
// A float dropped into a paddy reports where it is, not what it is in. The
// field is worked out here, from the polygons the farmer already surveyed.
// That means the device needs no field-specific firmware, can be lifted from
// one paddy and dropped into another with nothing to reconfigure, and the
// mapping between device and field stays in one place — this app — where it
// can be reviewed, corrected and audited.
//
// This module is ONLY about containment. It is deliberately unable to answer
// "which field is nearest": containment and proximity are different questions,
// and a sensor sitting on a levee between two paddies must come back as
// "outside", not as "probably that one".
//
// NO SECOND FIELD DATABASE
// ------------------------
// Fields come in as whatever the caller already has. Two field record shapes
// exist in this repository and both are read here rather than converted into
// a third:
//
//   Stage-1 / annotation (js/fields/field-annotation-core.js buildField)
//       { id, name, coordinates: [[lat, lon], ...] }
//   Assurance registry   (js/fields/field-registry.js)
//       { id, name, boundary: { coordinates: [[lat, lon], ...] } }
//
// COORDINATE ORDER IS THE CLASSIC BUG HERE
// ----------------------------------------
// This project stores boundaries as [latitude, longitude] — the order Leaflet
// uses. GeoJSON, and therefore Turf, uses [longitude, latitude]. Around a
// Japanese paddy (lat ~34, lon ~135) a swapped pair is not a small error: it
// lands the point in the Mediterranean, so every field reads "outside" and the
// failure looks like "detection just doesn't work" rather than like a bug.
// `toGeoJsonRing()` is the single place the flip happens, and there is a unit
// test that would fail if it were removed.

import { fieldBoundaryCoordinates } from "./field-boundary.js";

/** Outcomes of a containment query. Exhaustive: callers switch on these. */
export const DETECTION_STATUS = {
  /** Exactly one registered field contains the position. */
  INSIDE: "inside",
  /** A valid position, checked against valid polygons, contained by none. */
  OUTSIDE: "outside",
  /** Two or more registered fields contain it. Never resolved silently. */
  AMBIGUOUS: "ambiguous",
  /** The position itself is unusable (missing/NaN/out of range). */
  INVALID_POSITION: "invalid-position",
  /** There is nothing to test against — no field has a usable polygon. */
  NO_FIELDS: "no-fields"
};

/**
 * Containment for one position against every field.
 *
 * @param latitude  degrees, -90..90
 * @param longitude degrees, -180..180
 * @param fields    array in either supported field shape
 *
 * @returns {{
 *   status: string,
 *   fieldId: string|null,      // set only for INSIDE
 *   fieldIds: string[],        // every containing field: 0, 1, or (AMBIGUOUS) 2+
 *   candidates: Array<{id: string, name: string}>,
 *   checkedFieldCount: number, // fields with a usable polygon
 *   invalidFieldIds: string[], // fields skipped for malformed geometry
 *   engine: "turf"|"ray-casting"|null
 * }}
 *
 * A malformed polygon is SKIPPED and named in `invalidFieldIds`, never treated
 * as empty and never treated as containing everything. Silently dropping it
 * would let a broken boundary read as a confident "outside".
 */
export function detectFieldForPosition({ latitude, longitude, fields = [] } = {}) {
  const empty = {
    fieldId: null, fieldIds: [], candidates: [],
    checkedFieldCount: 0, invalidFieldIds: [], engine: null
  };

  if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) {
    return { ...empty, status: DETECTION_STATUS.INVALID_POSITION };
  }

  const usable = [];
  const invalidFieldIds = [];
  for (const field of Array.isArray(fields) ? fields : []) {
    const coordinates = fieldBoundaryCoordinates(field);
    if (isUsablePolygon(coordinates)) {
      usable.push({ field, coordinates });
    } else if (field && field.id !== undefined && field.id !== null) {
      invalidFieldIds.push(String(field.id));
    }
  }

  if (usable.length === 0) {
    return { ...empty, status: DETECTION_STATUS.NO_FIELDS, invalidFieldIds };
  }

  let engine = null;
  const containing = [];
  for (const { field, coordinates } of usable) {
    const viaTurf = containsViaTurf(latitude, longitude, coordinates);
    const inside = viaTurf === null
      ? containsViaRayCasting(latitude, longitude, coordinates)
      : viaTurf;
    engine = viaTurf === null ? "ray-casting" : "turf";
    if (inside) {
      containing.push(field);
    }
  }

  const candidates = containing.map((field) => ({
    id: String(field.id),
    name: String(field.name ?? field.id ?? "")
  }));
  const fieldIds = candidates.map((candidate) => candidate.id);
  const base = {
    fieldIds, candidates, checkedFieldCount: usable.length, invalidFieldIds, engine
  };

  if (containing.length === 0) {
    return { ...base, status: DETECTION_STATUS.OUTSIDE, fieldId: null };
  }
  if (containing.length === 1) {
    return { ...base, status: DETECTION_STATUS.INSIDE, fieldId: fieldIds[0] };
  }
  // Overlapping polygons. Picking `containing[0]` would resolve this by array
  // order — i.e. by the order the farmer happened to register the fields in —
  // which is not a fact about where the sensor is.
  return { ...base, status: DETECTION_STATUS.AMBIGUOUS, fieldId: null };
}

/**
 * True when the position is inside this one boundary.
 *
 * Strict, unlike `isPointInsideBoundary()` in field-annotation-core.js, which
 * returns TRUE for a degenerate boundary on purpose: that one is a "warn the
 * farmer if they clicked clearly outside" heuristic and is permissive by
 * design. Reusing it here would report a sensor as being inside a field whose
 * boundary is an unclosed two-point track — a confident answer derived from a
 * shape that has no inside. The ray-casting arithmetic below is the same;
 * only the degenerate case differs.
 */
export function isPositionInsideBoundary(latitude, longitude, coordinates) {
  if (!isValidLatitude(latitude) || !isValidLongitude(longitude) || !isUsablePolygon(coordinates)) {
    return false;
  }
  const viaTurf = containsViaTurf(latitude, longitude, coordinates);
  return viaTurf === null ? containsViaRayCasting(latitude, longitude, coordinates) : viaTurf;
}

/**
 * A polygon this module is willing to test against: at least three vertices,
 * every one of them a finite, in-range [lat, lon] pair.
 */
export function isUsablePolygon(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 3) {
    return false;
  }
  return coordinates.every((vertex) =>
    Array.isArray(vertex)
    && vertex.length >= 2
    && isValidLatitude(vertex[0])
    && isValidLongitude(vertex[1]));
}

/**
 * `[[lat, lon], ...]` → a closed GeoJSON linear ring `[[lon, lat], ..., first]`.
 *
 * Two transformations, both mandatory and both easy to forget:
 *   1. the axis flip (see the header);
 *   2. closing the ring — GeoJSON requires the first and last positions to be
 *      identical, and this app's boundaries are stored open (the farmer walks
 *      a loop and stops near where they started). Turf rejects an unclosed
 *      ring outright, so without this the turf path would throw on every real
 *      field and silently fall back to ray casting forever.
 */
export function toGeoJsonRing(coordinates) {
  const ring = coordinates.map(([latitude, longitude]) => [Number(longitude), Number(latitude)]);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    ring.push([first[0], first[1]]);
  }
  return ring;
}

/**
 * Turf's containment test, or null when Turf cannot answer.
 *
 * Turf is loaded from a CDN with `defer` (index.html) and is simply absent in
 * Node, where these modules are unit tested. Returning null rather than
 * throwing lets the caller fall through to the built-in test, which is the
 * same arrangement `polygonAreaSquareMeters()` already uses for `turf.area`.
 */
export function containsViaTurf(latitude, longitude, coordinates) {
  const turf = globalThis.turf;
  if (!turf || typeof turf.booleanPointInPolygon !== "function" || typeof turf.polygon !== "function") {
    return null;
  }
  try {
    // turf.point takes [lon, lat]. So does the ring. Both flips happen here.
    return turf.booleanPointInPolygon(
      turf.point([Number(longitude), Number(latitude)]),
      turf.polygon([toGeoJsonRing(coordinates)])
    );
  } catch {
    // A ring Turf rejects (self-intersecting, wound wrongly) is not a reason
    // to report "outside" — fall back rather than answer from a thrown error.
    return null;
  }
}

/**
 * Ray casting on raw [lat, lon] pairs.
 *
 * No projection: at paddy scale (tens of metres) the error from treating
 * degrees as a plane is far below the GNSS noise this whole feature is
 * fighting, and the same simplification is already used by
 * `isPointInsideBoundary()` and `pointInPolygonXY()` elsewhere in this repo.
 */
export function containsViaRayCasting(latitude, longitude, coordinates) {
  let inside = false;
  for (let i = 0, j = coordinates.length - 1; i < coordinates.length; j = i, i += 1) {
    const [latI, lonI] = coordinates[i];
    const [latJ, lonJ] = coordinates[j];
    if (((latI > latitude) !== (latJ > latitude))
      && longitude < (lonJ - lonI) * (latitude - latI) / (latJ - latI) + lonI) {
      inside = !inside;
    }
  }
  return inside;
}

export function isValidLatitude(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= -90 && value <= 90;
}

export function isValidLongitude(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= -180 && value <= 180;
}
