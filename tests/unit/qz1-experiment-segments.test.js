import test from "node:test";
import assert from "node:assert/strict";
import {
  assignSamplesToSegments,
  groupSegmentsByHeight,
  marksFromPlan,
  normalizeMark,
  normalizeMarks
} from "../../js/qz1-water-level/experiment-segments.js";
import { buildExperimentPlan, normalizeExperimentConfig } from "../../js/qz1-water-level/experiment-config.js";

const T0 = Date.UTC(2026, 0, 15, 2, 0, 0);

/** SYNTHETIC samples at 1 Hz from `startMs`. */
function series(startMs, count, altitudeMm) {
  return Array.from({ length: count }, (unused, index) => ({
    timestampUtcMs: startMs + index * 1000,
    altitudeMm
  }));
}

test("a well-formed mark normalizes", () => {
  const { mark, error } = normalizeMark({ referenceHeightMm: 30, startMs: T0, endMs: T0 + 1000 });
  assert.equal(error, null);
  assert.equal(mark.referenceHeightMm, 30);
  assert.equal(mark.endMs, T0 + 1000);
});

test("a mark with no reference height or no start is refused, not guessed", () => {
  assert.equal(normalizeMark({ startMs: T0 }).mark, null);
  assert.equal(normalizeMark({ referenceHeightMm: 30 }).mark, null);
  assert.equal(normalizeMark({ referenceHeightMm: null, startMs: T0 }).mark, null,
    "null must not become 0 mm");
});

test("a mark that ends before it starts is refused", () => {
  assert.equal(normalizeMark({ referenceHeightMm: 0, startMs: T0, endMs: T0 - 1 }).mark, null);
});

test("an open-ended final mark is allowed", () => {
  const { mark } = normalizeMark({ referenceHeightMm: 0, startMs: T0, endMs: null });
  assert.equal(mark.endMs, null);
});

test("invalid optional numeric mark fields are refused, while explicit null means absent", () => {
  const open = normalizeMark({ referenceHeightMm: 10, startMs: T0, endMs: null, settleSeconds: null });
  assert.equal(open.error, null);
  assert.equal(open.mark.settleSeconds, null);
  assert.equal(normalizeMark({ referenceHeightMm: 10, startMs: T0, endMs: "not-a-time" }).mark, null);
  assert.equal(normalizeMark({ referenceHeightMm: 10, startMs: T0, settleSeconds: "unknown" }).mark, null);
  assert.equal(normalizeMark({ referenceHeightMm: 10, startMs: T0, settleSeconds: -1 }).mark, null);
});

test("overlapping marks are reported", () => {
  const { errors } = normalizeMarks([
    { referenceHeightMm: 0, startMs: T0, endMs: T0 + 10000 },
    { referenceHeightMm: 10, startMs: T0 + 5000, endMs: T0 + 20000 }
  ]);
  assert.ok(errors.some((error) => error.includes("重なって")));
});

test("marks are sorted by start time regardless of input order", () => {
  const { marks } = normalizeMarks([
    { referenceHeightMm: 10, startMs: T0 + 10000, endMs: T0 + 20000 },
    { referenceHeightMm: 0, startMs: T0, endMs: T0 + 9000 }
  ]);
  assert.deepEqual(marks.map((mark) => mark.referenceHeightMm), [0, 10]);
});

test("the settle window is discarded from the front of each dwell, and kept separately", () => {
  const samples = series(T0, 60, 100);
  const { marks } = normalizeMarks([{ referenceHeightMm: 0, startMs: T0, endMs: T0 + 60000, settleSeconds: 15 }]);
  const { segments } = assignSamplesToSegments(samples, marks);
  assert.equal(segments[0].settling.length, 15, "the first 15 seconds are settling");
  assert.equal(segments[0].accepted.length, 45);
  // Nothing is destroyed: a re-analysis with a different settle window is
  // possible from the same data.
  assert.equal(segments[0].settling.length + segments[0].accepted.length, 60);
});

test("samples between marks belong to no level and are kept as unassigned", () => {
  const samples = [...series(T0, 10, 100), ...series(T0 + 20000, 10, 200)];
  const { marks } = normalizeMarks([
    { referenceHeightMm: 0, startMs: T0, endMs: T0 + 10000, settleSeconds: 0 },
    { referenceHeightMm: 10, startMs: T0 + 20000, endMs: T0 + 30000, settleSeconds: 0 }
  ]);
  const { segments, unassigned } = assignSamplesToSegments([...samples, ...series(T0 + 12000, 5, 150)], marks);
  assert.equal(segments[0].accepted.length, 10);
  assert.equal(segments[1].accepted.length, 10);
  assert.equal(unassigned.length, 5, "repositioning samples are neither credited nor deleted");
});

test("a sample with no timestamp is never attached to the nearest mark", () => {
  const { marks } = normalizeMarks([{ referenceHeightMm: 0, startMs: T0, endMs: T0 + 10000, settleSeconds: 0 }]);
  const { segments, undatable } = assignSamplesToSegments(
    [{ timestampUtcMs: null, altitudeMm: 100 }, { timestampUtcMs: T0, altitudeMm: 200 }],
    marks
  );
  assert.equal(undatable.length, 1);
  assert.equal(segments[0].accepted.length, 1);
});

test("mark boundaries are half-open, so no sample lands in two levels", () => {
  const { marks } = normalizeMarks([
    { referenceHeightMm: 0, startMs: T0, endMs: T0 + 5000, settleSeconds: 0 },
    { referenceHeightMm: 10, startMs: T0 + 5000, endMs: T0 + 10000, settleSeconds: 0 }
  ]);
  const { segments } = assignSamplesToSegments(series(T0, 10, 100), marks);
  assert.equal(segments[0].accepted.length, 5);
  assert.equal(segments[1].accepted.length, 5);
  const boundary = segments[1].accepted[0];
  assert.equal(boundary.timestampUtcMs, T0 + 5000, "the boundary sample belongs to the later mark only");
});

test("the ascending and descending visits to one height pool but stay separable", () => {
  const { marks } = normalizeMarks([
    { referenceHeightMm: 0, startMs: T0, endMs: T0 + 5000, visitIndex: 0, direction: "ascending", settleSeconds: 0 },
    { referenceHeightMm: 10, startMs: T0 + 5000, endMs: T0 + 10000, visitIndex: 0, direction: "ascending", settleSeconds: 0 },
    { referenceHeightMm: 0, startMs: T0 + 10000, endMs: T0 + 15000, visitIndex: 1, direction: "descending", settleSeconds: 0 }
  ]);
  const { segments } = assignSamplesToSegments(series(T0, 15, 100), marks);
  const grouped = groupSegmentsByHeight(segments);
  const zero = grouped.find((group) => group.referenceHeightMm === 0);
  assert.equal(zero.accepted.length, 10, "pooled across both visits");
  assert.equal(zero.visits.length, 2, "and still available per visit, so drift stays measurable");
  assert.deepEqual(zero.visits.map((visit) => visit.direction), ["ascending", "descending"]);
});

test("marksFromPlan lays consecutive dwells end to end", () => {
  const { config } = normalizeExperimentConfig({
    experiment: "x", sensor: "QZ1", reference_heights_mm: [0, 10],
    sampling_configuration: { dwell_seconds: 60, settle_seconds: 5 }, tolerance_mm: 10
  });
  const marks = marksFromPlan(buildExperimentPlan(config), T0);
  assert.equal(marks.length, 3);
  assert.equal(marks[0].startMs, T0);
  assert.equal(marks[0].endMs, T0 + 60000);
  assert.equal(marks[1].startMs, T0 + 60000, "no gap is invented between steps");
  assert.equal(marks[2].endMs, T0 + 180000);
  assert.equal(marks[0].settleSeconds, 5);
});
