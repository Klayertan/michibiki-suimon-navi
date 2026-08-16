// Stage-1 boundary trimming: pure logic (no DOM, no Leaflet).
//
// A walked QZ1/NMEA track rarely starts and stops exactly on the field
// boundary — the farmer walks up to the field, walks the perimeter, then
// walks away. Registering the *whole* recording therefore produced a polygon
// with a large closure gap and a confusing "close it anyway?" prompt.
//
// This module lets the farmer name two EXISTING measured points as the START
// and END of the boundary, and derives the candidate boundary from the
// ordered slice between them.
//
// Ordering rule (deliberate, and pinned by tests): the candidate boundary
// preserves the ORIGINAL measurement order. Given P0…P150 with START=P20 and
// END=P130 the boundary is P20 → P21 → … → P130, then closed P130 → P20.
// Nothing here sorts by latitude/longitude, takes a convex hull, or reorders
// spatially — the walk order *is* the boundary order.
//
// Coordinate order stays [lat, lon] to match field-annotation-core.js and
// every Leaflet call site in this app.

/** A polygon needs at least 3 vertices; fewer can never enclose an area. */
export const MIN_BOUNDARY_POINTS = 3;

export const NO_SELECTION_MESSAGE = "開始点と終了点を選んでください。";
export const TOO_SHORT_MESSAGE = `圃場を作るには測位点が${MIN_BOUNDARY_POINTS}点以上必要です。`;
export const REVERSED_SELECTION_NOTE = "終了点が開始点より前だったため、開始点と終了点を入れ替えました。";

/**
 * Coerces a user/UI-supplied index to a valid in-range integer, or null.
 *
 * The null/""/boolean rejection is load-bearing, not defensive noise: an
 * unpicked endpoint arrives here as null, and Number(null) is 0 — so without
 * it, "the farmer has not chosen an end point yet" would silently read as
 * "the farmer chose the very first fix".
 */
function toIndex(value, pointCount) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") {
    return null;
  }
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0 || index >= pointCount) {
    return null;
  }
  return index;
}

/**
 * Resolves a raw {startIndex, endIndex} pair against a track of `pointCount`
 * measured points.
 *
 * Reversed selection (END measured before START) is NOT an error and is NOT
 * silently guessed at either: the earlier index always becomes START and the
 * later one becomes END, and `reversed: true` is reported so the UI can
 * relabel the two markers and say so. There is deliberately no wrap-around
 * (…P130 → P150 → P0 → P20…): the data model has no notion of a cyclic
 * track, so inventing one here would fabricate boundary segments the farmer
 * never walked.
 *
 * Returns { valid, startIndex, endIndex, count, reversed, error }.
 */
export function normalizeBoundarySelection({ startIndex, endIndex, pointCount } = {}) {
  const total = Number.isInteger(pointCount) && pointCount > 0 ? pointCount : 0;
  const start = toIndex(startIndex, total);
  const end = toIndex(endIndex, total);

  if (start === null || end === null) {
    return {
      valid: false, startIndex: start, endIndex: end,
      count: 0, reversed: false, error: NO_SELECTION_MESSAGE
    };
  }

  const reversed = end < start;
  const from = reversed ? end : start;
  const to = reversed ? start : end;
  const count = to - from + 1;

  if (count < MIN_BOUNDARY_POINTS) {
    return {
      valid: false, startIndex: from, endIndex: to,
      count, reversed, error: TOO_SHORT_MESSAGE
    };
  }

  return { valid: true, startIndex: from, endIndex: to, count, reversed, error: null };
}

/** True when `index` falls inside an already-normalized selection's range. */
export function isIndexInSelection(index, selection) {
  if (!selection || !Number.isInteger(selection.startIndex) || !Number.isInteger(selection.endIndex)) {
    return false;
  }
  return index >= selection.startIndex && index <= selection.endIndex;
}

/** Measured points -> [lat, lon] pairs, in the order given. */
export function boundaryCoordinates(points) {
  return (points || []).map((point) => [Number(point.lat), Number(point.lon)]);
}

/**
 * The candidate field boundary for a START/END pair: the ordered slice of
 * `points` from START through END inclusive, plus its [lat, lon] ring.
 *
 * The ring is NOT closed here — the END → START segment is added by the
 * existing polygon builder (buildField / polygonAreaSquareMeters treat the
 * ring as implicitly closed), so this module never duplicates that step.
 *
 * Returns the normalizeBoundarySelection() result plus { points, coordinates }.
 */
export function selectBoundaryPoints(points, { startIndex, endIndex } = {}) {
  const list = Array.isArray(points) ? points : [];
  const selection = normalizeBoundarySelection({ startIndex, endIndex, pointCount: list.length });
  if (!selection.valid) {
    return { ...selection, points: [], coordinates: [] };
  }
  const selected = list.slice(selection.startIndex, selection.endIndex + 1);
  return { ...selection, points: selected, coordinates: boundaryCoordinates(selected) };
}

/** Human label for one measured point, 1-based so it matches the map popups. */
export function boundaryPointLabel(index) {
  return Number.isInteger(index) ? `測位点${index + 1}` : "未選択";
}

/** e.g. "126点（測位点20 〜 測位点145）" for the selection summary line. */
export function selectionSummaryLabel(selection) {
  if (!selection || !Number.isInteger(selection.startIndex) || !Number.isInteger(selection.endIndex)) {
    return "—";
  }
  const start = boundaryPointLabel(selection.startIndex);
  const end = boundaryPointLabel(selection.endIndex);
  return `${selection.count}点（${start} 〜 ${end}）`;
}
