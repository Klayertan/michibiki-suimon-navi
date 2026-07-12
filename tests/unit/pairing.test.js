import test from "node:test";
import assert from "node:assert/strict";
import { pairObservations, summarizeContinuity } from "../../js/assurance/pairing.js";

function point(id, time, options = {}) {
  return { id, sequence: Number(id.replace(/\D/g, "")) || 0, timestampUtcMs: time, lat: 35 + time / 1e10, lon: 135, fixValid: options.fixValid ?? true, ...options };
}

test("monotonic nearest pairing handles rates, duplicates, and out-of-order input", () => {
  const qz1 = [point("q2", 2000), point("q1", 1000), point("q3", 3000)];
  const reference = [point("r3", 3050), point("r1-low", 1050, { hdop: null }), point("r1", 1050, { hdop: 0.8 }), point("r2", 2050)];
  const result = pairObservations(qz1, reference, { toleranceMs: 100 });
  assert.equal(result.pairs.length, 3);
  assert.deepEqual(result.pairs.map((pair) => pair.reference.id), ["r1", "r2", "r3"]);
  assert.ok(result.pairs.every((pair) => pair.timeDeltaMs === 50));
});

test("clock offsets and tolerance control pairing", () => {
  const result = pairObservations([point("q1", 1000)], [point("r1", 1500)], { toleranceMs: 100, referenceOffsetMs: -500 });
  assert.equal(result.pairs.length, 1);
  assert.equal(result.pairs[0].timeDeltaMs, 0);
});

test("continuity retains no-fix epochs while reporting valid-fix ratio", () => {
  const result = summarizeContinuity([point("p1", 0), point("p2", 1000, { fixValid: false, lat: null, lon: null }), point("p3", 2000)], 1);
  assert.equal(result.observed, 3);
  assert.equal(result.validFixes, 2);
  assert.equal(result.ratio, 1);
  assert.equal(result.validFixRatio, 2 / 3);
  assert.equal(result.dropoutCount, 0);
});

test("large sessions pair without quadratic matching", () => {
  const count = 20_000;
  const qz1 = Array.from({ length: count }, (_, index) => point(`q${index}`, index * 1000));
  const reference = Array.from({ length: count }, (_, index) => point(`r${index}`, index * 1000 + 40));
  const result = pairObservations(qz1, reference, { toleranceMs: 100 });
  assert.equal(result.pairs.length, count);
  assert.equal(result.unmatchedQz1.length, 0);
  assert.equal(result.unmatchedReference.length, 0);
});
