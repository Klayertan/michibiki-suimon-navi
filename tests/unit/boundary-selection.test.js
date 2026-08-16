import test from "node:test";
import assert from "node:assert/strict";
import {
  MIN_BOUNDARY_POINTS,
  NO_SELECTION_MESSAGE,
  REVERSED_SELECTION_NOTE,
  TOO_SHORT_MESSAGE,
  boundaryCoordinates,
  boundaryPointLabel,
  isIndexInSelection,
  normalizeBoundarySelection,
  selectBoundaryPoints,
  selectionSummaryLabel
} from "../../js/fields/boundary-selection.js";
import { polygonAreaSquareMeters } from "../../js/fields/field-annotation-core.js";

/** A synthetic walk: 5 approach fixes, a 4-corner square loop, 5 return fixes. */
function walkedTrack() {
  const approach = Array.from({ length: 5 }, (_, i) => ({ lat: 34.6500 + i * 0.0001, lon: 135.8280 }));
  const loop = [
    { lat: 34.6540, lon: 135.8300 },
    { lat: 34.6540, lon: 135.8305 },
    { lat: 34.6536, lon: 135.8305 },
    { lat: 34.6536, lon: 135.8300 }
  ];
  const ret = Array.from({ length: 5 }, (_, i) => ({ lat: 34.6530 - i * 0.0001, lon: 135.8280 }));
  return [...approach, ...loop, ...ret]; // indexes 0-4, 5-8, 9-13
}

test("normalizeBoundarySelection keeps an in-order selection exactly as picked", () => {
  const selection = normalizeBoundarySelection({ startIndex: 5, endIndex: 8, pointCount: 14 });
  assert.equal(selection.valid, true);
  assert.equal(selection.startIndex, 5);
  assert.equal(selection.endIndex, 8);
  assert.equal(selection.count, 4);
  assert.equal(selection.reversed, false);
  assert.equal(selection.error, null);
});

test("a reversed selection swaps to measurement order and reports reversed:true", () => {
  const selection = normalizeBoundarySelection({ startIndex: 8, endIndex: 5, pointCount: 14 });
  assert.equal(selection.valid, true);
  // Documented, pinned behavior: the EARLIER measured point becomes START.
  assert.equal(selection.startIndex, 5);
  assert.equal(selection.endIndex, 8);
  assert.equal(selection.count, 4);
  assert.equal(selection.reversed, true);
  assert.ok(REVERSED_SELECTION_NOTE.includes("入れ替え"));
});

test("an unpicked or out-of-range endpoint is not a selection", () => {
  for (const input of [
    { startIndex: null, endIndex: 8, pointCount: 14 },
    { startIndex: 5, endIndex: undefined, pointCount: 14 },
    { startIndex: 5, endIndex: 14, pointCount: 14 },
    { startIndex: -1, endIndex: 8, pointCount: 14 },
    { startIndex: 1.5, endIndex: 8, pointCount: 14 },
    { startIndex: 0, endIndex: 1, pointCount: 0 }
  ]) {
    const selection = normalizeBoundarySelection(input);
    assert.equal(selection.valid, false, JSON.stringify(input));
    assert.equal(selection.error, NO_SELECTION_MESSAGE);
  }
});

test("a range shorter than a triangle is rejected, not silently padded", () => {
  const selection = normalizeBoundarySelection({ startIndex: 5, endIndex: 6, pointCount: 14 });
  assert.equal(selection.valid, false);
  assert.equal(selection.count, 2);
  assert.equal(selection.error, TOO_SHORT_MESSAGE);
  assert.equal(MIN_BOUNDARY_POINTS, 3);

  // Exactly MIN_BOUNDARY_POINTS is accepted.
  assert.equal(normalizeBoundarySelection({ startIndex: 5, endIndex: 7, pointCount: 14 }).valid, true);
});

test("selectBoundaryPoints returns only the selected range, in original measurement order", () => {
  const track = walkedTrack();
  const range = selectBoundaryPoints(track, { startIndex: 5, endIndex: 8 });

  assert.equal(range.valid, true);
  assert.equal(range.points.length, 4);
  assert.equal(range.count, 4);
  // The 5 approach fixes and 5 return fixes are excluded entirely.
  assert.deepEqual(range.points, track.slice(5, 9));
  assert.deepEqual(range.coordinates, [
    [34.6540, 135.8300],
    [34.6540, 135.8305],
    [34.6536, 135.8305],
    [34.6536, 135.8300]
  ]);
  // No spatial sort / convex hull: this is walk order, not lat/lon order.
  assert.deepEqual(
    range.coordinates.map(([lat]) => lat),
    [34.6540, 34.6540, 34.6536, 34.6536]
  );
});

test("the ring is left open — closing END -> START is the polygon builder's job", () => {
  const track = walkedTrack();
  const range = selectBoundaryPoints(track, { startIndex: 5, endIndex: 8 });
  assert.notDeepEqual(range.coordinates[0], range.coordinates[range.coordinates.length - 1]);

  // The existing area helper treats the ring as implicitly closed, so the
  // trimmed loop measures its real square area rather than the whole walk.
  const trimmedArea = polygonAreaSquareMeters(range.coordinates);
  const wholeTrackArea = polygonAreaSquareMeters(boundaryCoordinates(track));
  assert.ok(trimmedArea > 0);
  assert.notEqual(Math.round(trimmedArea), Math.round(wholeTrackArea));
  // ~44m x ~46m square.
  assert.ok(trimmedArea > 1500 && trimmedArea < 2600, `unexpected area ${trimmedArea}`);
});

test("a reversed pick selects the same range and the same coordinates", () => {
  const track = walkedTrack();
  const forward = selectBoundaryPoints(track, { startIndex: 5, endIndex: 8 });
  const reversed = selectBoundaryPoints(track, { startIndex: 8, endIndex: 5 });
  assert.deepEqual(reversed.coordinates, forward.coordinates);
  assert.equal(reversed.reversed, true);
  assert.equal(forward.reversed, false);
});

test("an invalid selection yields no points and no coordinates", () => {
  const track = walkedTrack();
  const range = selectBoundaryPoints(track, { startIndex: 5, endIndex: 6 });
  assert.equal(range.valid, false);
  assert.deepEqual(range.points, []);
  assert.deepEqual(range.coordinates, []);
});

test("isIndexInSelection covers the inclusive range only", () => {
  const selection = { startIndex: 5, endIndex: 8 };
  assert.equal(isIndexInSelection(4, selection), false);
  assert.equal(isIndexInSelection(5, selection), true);
  assert.equal(isIndexInSelection(8, selection), true);
  assert.equal(isIndexInSelection(9, selection), false);
  assert.equal(isIndexInSelection(5, null), false);
});

test("labels are 1-based so they match the map popups", () => {
  assert.equal(boundaryPointLabel(0), "測位点1");
  assert.equal(boundaryPointLabel(129), "測位点130");
  assert.equal(boundaryPointLabel(null), "未選択");
  assert.equal(
    selectionSummaryLabel({ startIndex: 19, endIndex: 129, count: 111 }),
    "111点（測位点20 〜 測位点130）"
  );
  assert.equal(selectionSummaryLabel(null), "—");
});

test("the documented P20 -> P130 example produces exactly 111 ordered points", () => {
  const track = Array.from({ length: 151 }, (_, i) => ({ lat: 34.65 + i * 0.00001, lon: 135.83 + i * 0.00001 }));
  const range = selectBoundaryPoints(track, { startIndex: 20, endIndex: 130 });
  assert.equal(range.count, 111);
  assert.equal(range.points.length, 111);
  assert.deepEqual(range.points[0], track[20]);
  assert.deepEqual(range.points[range.points.length - 1], track[130]);
});
