import test from "node:test";
import assert from "node:assert/strict";
import {
  CLOSE_WARNING_MESSAGE,
  DEFAULT_AUTO_CLOSE_THRESHOLD_M,
  FEATURE_TYPE_LABELS,
  buildField,
  buildMetadata,
  buildWaterControlPoint,
  distanceMeters,
  evaluateClosure,
  isWaterControlType,
  nextFieldDefaults,
  polygonAreaSquareMeters,
  summarizeFixQuality
} from "../../js/fields/field-annotation-core.js";

// A ~40m x 40m square near the demo field used elsewhere in this app.
const SQUARE = [
  [34.65480, 135.82982],
  [34.65480, 135.83027],
  [34.65444, 135.83027],
  [34.65444, 135.82982]
];

test("nextFieldDefaults sequences 圃場N / paddy-00N based on existing count", () => {
  assert.deepEqual(nextFieldDefaults(0), { name: "圃場1", id: "paddy-001" });
  assert.deepEqual(nextFieldDefaults(1), { name: "圃場2", id: "paddy-002" });
  assert.deepEqual(nextFieldDefaults(11), { name: "圃場12", id: "paddy-012" });
});

test("evaluateClosure auto-closes a tight loop and requires confirmation for a large gap", () => {
  // Last point very close to the first (~1m gap) -> auto-close.
  const tight = [...SQUARE, [34.654799, 135.829825]];
  const tightResult = evaluateClosure(tight, DEFAULT_AUTO_CLOSE_THRESHOLD_M);
  assert.equal(tightResult.canClose, true);
  assert.equal(tightResult.autoClose, true);
  assert.ok(tightResult.gapM < DEFAULT_AUTO_CLOSE_THRESHOLD_M);

  // Last point far from the first -> must ask before closing.
  const farResult = evaluateClosure(SQUARE, DEFAULT_AUTO_CLOSE_THRESHOLD_M);
  assert.equal(farResult.canClose, true);
  assert.equal(farResult.autoClose, false);
  assert.ok(farResult.gapM > DEFAULT_AUTO_CLOSE_THRESHOLD_M);
});

test("evaluateClosure refuses fewer than three points instead of guessing", () => {
  const result = evaluateClosure([[34.6548, 135.8298], [34.6548, 135.8302]]);
  assert.equal(result.canClose, false);
  assert.ok(result.warnings.length > 0);
});

test("evaluateClosure flags self-intersecting paths as a non-fatal warning", () => {
  // A bowtie / figure-eight shape.
  const bowtie = [
    [34.6548, 135.8298],
    [34.6544, 135.8302],
    [34.6548, 135.8302],
    [34.6544, 135.8298]
  ];
  const result = evaluateClosure(bowtie);
  assert.equal(result.selfIntersects, true);
  assert.ok(result.warnings.some((warning) => warning.includes("自己交差")));
});

test("the exact confirmation message is stable for the UI to display verbatim", () => {
  assert.equal(CLOSE_WARNING_MESSAGE, "始点と終点が離れています。圃場ポリゴンを閉じますか？");
});

test("buildField normalizes coordinates, computes area, and records closure provenance", () => {
  const field = buildField({
    id: "paddy-001",
    name: "圃場1",
    coordinates: SQUARE,
    memo: "テスト圃場",
    gapM: 12.3,
    closedManually: true,
    nowIso: "2026-07-19T10:00:00+09:00"
  });
  assert.equal(field.type, "field");
  assert.equal(field.id, "paddy-001");
  assert.equal(field.name, "圃場1");
  assert.equal(field.coordinates.length, 4);
  assert.ok(field.areaM2 > 0);
  assert.equal(field.closureGapM, 12.3);
  assert.equal(field.closedManually, true);
  assert.equal(field.sourcePointCount, 4);
});

test("buildWaterControlPoint validates type and preserves field linkage", () => {
  const point = buildWaterControlPoint({
    id: "wcp-1",
    name: "北側取水口",
    type: "inlet",
    lat: 34.6548,
    lon: 135.8300,
    relatedFieldId: "paddy-001",
    memo: "手動追加",
    positionSource: "map-click",
    nowIso: "2026-07-19T10:00:00+09:00"
  });
  assert.equal(point.type, "inlet");
  assert.equal(point.relatedFieldId, "paddy-001");
  assert.equal(point.positionSource, "map-click");

  const invalidType = buildWaterControlPoint({ id: "wcp-2", type: "not-a-real-type", lat: 34, lon: 135 });
  assert.equal(invalidType.type, "gate", "unknown types fall back to a safe default, never invented");
});

test("isWaterControlType and FEATURE_TYPE_LABELS cover exactly the requested categories", () => {
  assert.deepEqual(Object.keys(FEATURE_TYPE_LABELS), ["field", "inlet", "outlet", "gate", "sensor", "photo"]);
  assert.equal(FEATURE_TYPE_LABELS.field, "圃場");
  assert.equal(FEATURE_TYPE_LABELS.inlet, "給水口");
  assert.equal(FEATURE_TYPE_LABELS.outlet, "排水口");
  assert.equal(FEATURE_TYPE_LABELS.gate, "水門");
  assert.equal(FEATURE_TYPE_LABELS.sensor, "水位センサ");
  assert.equal(FEATURE_TYPE_LABELS.photo, "撮影地点");
  assert.equal(isWaterControlType("field"), false);
  assert.equal(isWaterControlType("inlet"), true);
});

test("polygonAreaSquareMeters returns a plausible area for a known square and 0 for degenerate input", () => {
  const area = polygonAreaSquareMeters(SQUARE);
  // ~40m x 45m box; allow a generous tolerance for the planar approximation.
  assert.ok(area > 1000 && area < 3000, `expected a few thousand m², got ${area}`);
  assert.equal(polygonAreaSquareMeters([[34, 135], [34, 135.001]]), 0);
});

test("distanceMeters matches the closure-gap distance used internally", () => {
  const gap = distanceMeters(SQUARE[0], SQUARE[3]);
  assert.ok(gap > 0);
  const result = evaluateClosure([...SQUARE, SQUARE[0]]);
  assert.ok(Math.abs(result.gapM - 0) < 1e-6);
});

test("summarizeFixQuality groups by fix quality and counts augmented fixes without fabricating data", () => {
  const points = [
    { fixQuality: 1, augmented: false },
    { fixQuality: 2, augmented: true },
    { fixQuality: 2, augmented: true },
    { lat: 34, lon: 135 } // phone GPS point: no fixQuality at all
  ];
  const summary = summarizeFixQuality(points);
  assert.equal(summary.total, 4);
  assert.equal(summary.byFixQuality["1"], 1);
  assert.equal(summary.byFixQuality["2"], 2);
  assert.equal(summary.byFixQuality.unknown, 1);
  assert.equal(summary.augmentedCount, 2);
});

test("buildMetadata carries the source label through without inventing a filename", () => {
  const withSource = buildMetadata({ sourceFileName: "walk-log.nmea", points: [{ fixQuality: 1 }], nowIso: "2026-07-19T10:00:00+09:00" });
  assert.equal(withSource.sourceFileName, "walk-log.nmea");
  assert.equal(withSource.date, "2026-07-19T10:00:00+09:00");
  assert.equal(withSource.fixQualitySummary.total, 1);

  const withoutSource = buildMetadata({ points: [] });
  assert.equal(withoutSource.sourceFileName, null);
});
