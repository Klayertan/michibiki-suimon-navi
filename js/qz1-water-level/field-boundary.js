// Reading a boundary out of whichever field record the caller happens to hold.
//
// This repository has two field record shapes, both in active use, and this
// milestone adds no third one:
//
//   Stage-1 / annotation — js/fields/field-annotation-core.js `buildField()`,
//   persisted under `suimonNaviFieldAnnotationsV2`, rendered by
//   field-annotation-controller.js, and the shape the farmer's registered
//   paddies actually live in:
//
//       { id: "paddy-003", name: "田圃3", type: "field",
//         geometryType: "Polygon", coordinates: [[lat, lon], ...], properties: {…} }
//
//   Assurance registry — js/fields/field-registry.js, used by the 測量チェック
//   workspace, which nests the same array one level down:
//
//       { id, name, boundary: { coordinates: [[lat, lon], ...], … } }
//
// Both store `[latitude, longitude]`, matching Leaflet. Neither is GeoJSON
// order. Everything downstream of this function may assume [lat, lon].
//
// Kept in its own tiny module so field-detection.js can stay purely about
// geometry, and so a future third shape (or a migration to one shape) has
// exactly one place to be taught about.

/**
 * The boundary vertex list, or `[]` when this record carries none.
 *
 * Returns `[]` rather than null so callers can iterate unconditionally; the
 * "is this actually a polygon" judgement belongs to
 * `isUsablePolygon()` in field-detection.js, which has to reject two-vertex
 * tracks and NaN vertices too.
 */
export function fieldBoundaryCoordinates(field) {
  if (!field || typeof field !== "object") {
    return [];
  }
  if (Array.isArray(field.coordinates)) {
    return field.coordinates;
  }
  if (Array.isArray(field.boundary?.coordinates)) {
    return field.boundary.coordinates;
  }
  return [];
}

/** Display name for a field record, falling back to its id. */
export function fieldDisplayName(field) {
  const name = typeof field?.name === "string" ? field.name.trim() : "";
  return name || String(field?.id ?? "");
}

/** Looks a field up by id across either shape. */
export function findFieldById(fields, fieldId) {
  if (!fieldId) {
    return null;
  }
  return (Array.isArray(fields) ? fields : []).find((field) => String(field?.id) === String(fieldId)) || null;
}
