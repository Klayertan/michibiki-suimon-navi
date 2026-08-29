import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CANDIDATE_THRESHOLD,
  DEFAULT_WINDOW_SIZE,
  FieldDetectionWindow,
  OUTCOME_KEYS,
  WINDOW_STATUS,
  isFieldOutcome,
  outcomeKey
} from "../../js/qz1-water-level/detection-window.js";
import { DETECTION_STATUS } from "../../js/qz1-water-level/field-detection.js";

const inside = (fieldId) => ({ status: DETECTION_STATUS.INSIDE, fieldId, fieldIds: [fieldId] });
const outside = () => ({ status: DETECTION_STATUS.OUTSIDE, fieldId: null, fieldIds: [] });
const ambiguous = (ids) => ({ status: DETECTION_STATUS.AMBIGUOUS, fieldId: null, fieldIds: ids });
const invalid = () => ({ status: DETECTION_STATUS.INVALID_POSITION, fieldId: null, fieldIds: [] });
const noFields = () => ({ status: DETECTION_STATUS.NO_FIELDS, fieldId: null, fieldIds: [] });

function feed(window, results) {
  let summary = window.summarize();
  for (const result of results) {
    summary = window.push(result);
  }
  return summary;
}

test("the documented defaults are 10 samples at 0.8", () => {
  assert.equal(DEFAULT_WINDOW_SIZE, 10);
  assert.equal(DEFAULT_CANDIDATE_THRESHOLD, 0.8);
  const window = new FieldDetectionWindow();
  assert.equal(window.windowSize, 10);
  assert.equal(window.candidateThreshold, 0.8);
});

test("a single sample never produces a candidate, however unanimous", () => {
  // The whole point of the window: one fix is not evidence about a stationary
  // float, and a fresh float must not announce a paddy one second after
  // switch-on.
  const window = new FieldDetectionWindow();
  const summary = window.push(inside("paddy-003"));
  assert.equal(summary.status, WINDOW_STATUS.DETECTING);
  assert.equal(summary.detectedFieldId, null);
  assert.equal(summary.confidence, 1, "the fraction is still reported, so the UI can show progress");
  assert.equal(summary.filled, false);
});

test("a stable field becomes a candidate at full confidence", () => {
  const window = new FieldDetectionWindow();
  const summary = feed(window, Array.from({ length: 10 }, () => inside("paddy-003")));
  assert.equal(summary.status, WINDOW_STATUS.CANDIDATE);
  assert.equal(summary.detectedFieldId, "paddy-003");
  assert.equal(summary.confidence, 1);
  assert.equal(summary.decided, true);
});

test("the brief's worked example: nine of ten agree -> 0.9 confidence, still a candidate", () => {
  const window = new FieldDetectionWindow();
  const summary = feed(window, [
    inside("paddy-003"), inside("paddy-003"), inside("paddy-003"), inside("paddy-003"),
    inside("paddy-003"), inside("paddy-003"), inside("paddy-003"), inside("paddy-003"),
    outside(),
    inside("paddy-003")
  ]);
  assert.equal(summary.status, WINDOW_STATUS.CANDIDATE);
  assert.equal(summary.detectedFieldId, "paddy-003");
  assert.ok(Math.abs(summary.confidence - 0.9) < 1e-9);
});

test("below the threshold nothing is claimed", () => {
  const window = new FieldDetectionWindow();
  // 7/10 = 0.7 < 0.8.
  const summary = feed(window, [
    ...Array.from({ length: 7 }, () => inside("paddy-003")),
    outside(), outside(), outside()
  ]);
  assert.equal(summary.status, WINDOW_STATUS.DETECTING);
  assert.equal(summary.detectedFieldId, null);
  assert.ok(Math.abs(summary.confidence - 0.7) < 1e-9, "confidence is still reported honestly");
});

test("a stable outside is a confident conclusion, not permanent indecision", () => {
  const window = new FieldDetectionWindow();
  const summary = feed(window, Array.from({ length: 10 }, () => outside()));
  assert.equal(summary.status, WINDOW_STATUS.OUTSIDE);
  assert.equal(summary.detectedFieldId, null, "'outside' is an outcome, never handed out as a field id");
  assert.equal(summary.confidence, 1);
  assert.equal(summary.decided, true);
});

test("a stable ambiguous stays ambiguous rather than collapsing to one field", () => {
  const window = new FieldDetectionWindow();
  const summary = feed(window, Array.from({ length: 10 }, () => ambiguous(["paddy-003", "paddy-009"])));
  assert.equal(summary.status, WINDOW_STATUS.AMBIGUOUS);
  assert.equal(summary.detectedFieldId, null);
});

test("alternating between two fields decides nothing", () => {
  // A float on a shared levee. Neither neighbour reaches 0.8.
  const window = new FieldDetectionWindow();
  const summary = feed(window, Array.from({ length: 10 }, (unused, index) =>
    inside(index % 2 === 0 ? "paddy-003" : "paddy-007")));
  assert.equal(summary.status, WINDOW_STATUS.DETECTING);
  assert.equal(summary.detectedFieldId, null);
  assert.ok(summary.confidence <= 0.5);
});

test("invalid positions are counted but never vote", () => {
  // A receiver that loses its fix must not vote against the paddy the float
  // is sitting in the middle of.
  const window = new FieldDetectionWindow();
  const summary = feed(window, [
    ...Array.from({ length: 10 }, () => inside("paddy-003")),
    invalid(), invalid(), invalid()
  ]);
  assert.equal(summary.status, WINDOW_STATUS.CANDIDATE);
  assert.equal(summary.detectedFieldId, "paddy-003");
  assert.equal(summary.confidence, 1, "the dropped fixes did not dilute the vote");
  assert.equal(summary.rejectedSampleCount, 3);
  assert.equal(summary.totalSampleCount, 13);
  assert.equal(summary.sampleCount, 10);
});

test("'no fields registered' never votes as 'outside'", () => {
  const window = new FieldDetectionWindow();
  const summary = feed(window, Array.from({ length: 10 }, () => noFields()));
  assert.equal(summary.status, WINDOW_STATUS.DETECTING);
  assert.equal(summary.sampleCount, 0);
  assert.equal(summary.rejectedSampleCount, 10);
});

test("the window slides: old samples fall out", () => {
  const window = new FieldDetectionWindow({ windowSize: 5, candidateThreshold: 0.8 });
  feed(window, Array.from({ length: 5 }, () => inside("paddy-003")));
  const summary = feed(window, Array.from({ length: 5 }, () => inside("paddy-007")));
  assert.equal(summary.detectedFieldId, "paddy-007", "the float moved and the window followed");
  assert.equal(summary.sampleCount, 5);
  assert.deepEqual(Object.keys(summary.counts), ["paddy-007"]);
});

test("window size and threshold are configurable, not baked in", () => {
  const strict = new FieldDetectionWindow({ windowSize: 20, candidateThreshold: 1 });
  const nineteen = feed(strict, [
    ...Array.from({ length: 19 }, () => inside("paddy-003")),
    outside()
  ]);
  assert.equal(nineteen.status, WINDOW_STATUS.DETECTING, "19/20 does not clear a threshold of 1.0");

  const loose = new FieldDetectionWindow({ windowSize: 4, candidateThreshold: 0.5 });
  const half = feed(loose, [inside("paddy-003"), inside("paddy-003"), outside(), outside()]);
  assert.equal(half.status, WINDOW_STATUS.CANDIDATE, "2/4 clears a threshold of 0.5");
});

test("minSamples lets a verdict come early, but defaults to a full window", () => {
  const early = new FieldDetectionWindow({ windowSize: 10, candidateThreshold: 0.8, minSamples: 3 });
  const summary = feed(early, Array.from({ length: 3 }, () => inside("paddy-003")));
  assert.equal(summary.status, WINDOW_STATUS.CANDIDATE);

  const normal = new FieldDetectionWindow({ windowSize: 10, candidateThreshold: 0.8 });
  assert.equal(normal.minSamples, 10);
  assert.equal(feed(normal, Array.from({ length: 3 }, () => inside("paddy-003"))).status,
    WINDOW_STATUS.DETECTING);
});

test("invalid construction is refused rather than silently corrected", () => {
  assert.throws(() => new FieldDetectionWindow({ windowSize: 0 }));
  assert.throws(() => new FieldDetectionWindow({ windowSize: 2.5 }));
  assert.throws(() => new FieldDetectionWindow({ candidateThreshold: 0 }));
  assert.throws(() => new FieldDetectionWindow({ candidateThreshold: 1.5 }));
});

test("reset clears the votes but keeps the lifetime counters", () => {
  const window = new FieldDetectionWindow({ windowSize: 5 });
  feed(window, Array.from({ length: 5 }, () => inside("paddy-003")));
  const summary = window.reset();
  assert.equal(summary.sampleCount, 0);
  assert.equal(summary.status, WINDOW_STATUS.DETECTING);
  assert.equal(summary.totalSampleCount, 5, "how many fixes have been seen is still true");
});

test("a field literally named 'outside' cannot impersonate the outside outcome", () => {
  const window = new FieldDetectionWindow({ windowSize: 4, candidateThreshold: 0.75 });
  const summary = feed(window, Array.from({ length: 4 }, () => inside("outside")));
  assert.equal(summary.status, WINDOW_STATUS.CANDIDATE);
  assert.equal(summary.detectedFieldId, "outside", "it is a field id and stays one");
  assert.notEqual(outcomeKey(inside("outside")), OUTCOME_KEYS.OUTSIDE);
});

test("outcomeKey maps every detection status, and isFieldOutcome separates ids from outcomes", () => {
  assert.equal(outcomeKey(inside("paddy-003")), "paddy-003");
  assert.equal(outcomeKey(outside()), OUTCOME_KEYS.OUTSIDE);
  assert.equal(outcomeKey(ambiguous([])), OUTCOME_KEYS.AMBIGUOUS);
  assert.equal(outcomeKey(invalid()), null);
  assert.equal(outcomeKey(noFields()), null);
  assert.equal(outcomeKey(null), null);
  assert.equal(outcomeKey({ status: DETECTION_STATUS.INSIDE, fieldId: null }), null,
    "an 'inside' with no field id carries no vote");

  assert.equal(isFieldOutcome("paddy-003"), true);
  assert.equal(isFieldOutcome(OUTCOME_KEYS.OUTSIDE), false);
  assert.equal(isFieldOutcome(OUTCOME_KEYS.AMBIGUOUS), false);
});
