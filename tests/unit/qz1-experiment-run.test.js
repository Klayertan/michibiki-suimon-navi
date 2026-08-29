import test from "node:test";
import assert from "node:assert/strict";
import { ExperimentRun, nextRunState } from "../../js/qz1-water-level/experiment-run.js";
import { normalizeExperimentConfig } from "../../js/qz1-water-level/experiment-config.js";

const T0 = Date.UTC(2026, 0, 15, 2, 0, 0);

function config(overrides = {}) {
  const { config: normalized } = normalizeExperimentConfig({
    experiment: "run-test",
    sensor: "QZ1",
    reference_heights_mm: [0, 10],
    include_descending: false,
    sampling_configuration: { dwell_seconds: 60, settle_seconds: 5 },
    tolerance_mm: 10,
    ...overrides
  });
  return normalized;
}

const fix = (timestampUtcMs, altitudeMm = 50000) => ({ timestampUtcMs, altitudeMm, fix: 1 });

test("the state machine only allows the transitions it declares", () => {
  assert.equal(nextRunState("idle", "start"), "awaiting-position");
  assert.equal(nextRunState("idle", "confirm"), null, "a dwell cannot start before the run does");
  assert.equal(nextRunState("awaiting-position", "confirm"), "dwelling");
  assert.equal(nextRunState("dwelling", "confirm"), null, "a dwell cannot be re-confirmed");
  assert.equal(nextRunState("complete", "confirm"), null);
});

test("a run starts by waiting for the operator, not by counting time", () => {
  const run = new ExperimentRun(config());
  const result = run.start(T0);
  assert.equal(result.ok, true);
  assert.equal(run.state, "awaiting-position");
  assert.equal(run.currentStep().referenceHeightMm, 0);
});

test("the dwell clock starts at the confirmation, not at the prompt", () => {
  const run = new ExperimentRun(config());
  run.start(T0);
  // The operator takes 45 seconds to move the rig.
  const confirmed = run.confirmPosition(T0 + 45000);
  assert.equal(confirmed.endsAtMs, T0 + 45000 + 60000, "the full dwell runs from the confirmation");
  run.tick(T0 + 45000 + 59000);
  assert.equal(run.state, "dwelling", "not a second early");
  run.tick(T0 + 45000 + 60000);
  assert.equal(run.state, "awaiting-position", "and not a second late");
});

test("samples that arrive before the confirmation belong to no reference height", () => {
  const run = new ExperimentRun(config());
  run.start(T0);
  const result = run.ingestSample(fix(T0 + 1000));
  assert.equal(result.accepted, false);
  assert.equal(run.samples.length, 0);
  assert.equal(run.transitionSamples.length, 1);
  assert.equal(run.transitionSamples[0].referenceHeightMm, null,
    "a transition sample is not credited to either neighbouring level");
});

test("transition samples are kept, never discarded", () => {
  const run = new ExperimentRun(config());
  run.start(T0);
  for (let index = 0; index < 30; index += 1) {
    run.ingestSample(fix(T0 + index * 1000));
  }
  assert.equal(run.transitionSamples.length, 30, "how long the operator took is part of the record");
  assert.equal(run.allSamples().length, 30);
});

test("samples during a dwell are labelled with that step", () => {
  const run = new ExperimentRun(config());
  run.start(T0);
  run.confirmPosition(T0);
  run.ingestSample(fix(T0 + 1000));
  assert.equal(run.samples[0].referenceHeightMm, 0);
  assert.equal(run.samples[0].stepIndex, 0);
  assert.equal(run.samples[0].direction, "ascending");
});

test("a completed dwell produces exactly one mark with the real times", () => {
  const run = new ExperimentRun(config());
  run.start(T0);
  run.confirmPosition(T0 + 10000);
  run.tick(T0 + 10000 + 60000);
  assert.equal(run.marks.length, 1);
  assert.equal(run.marks[0].startMs, T0 + 10000);
  assert.equal(run.marks[0].endMs, T0 + 10000 + 60000);
  assert.equal(run.marks[0].settleSeconds, 5);
  assert.equal(run.marks[0].referenceHeightMm, 0);
});

test("an early-ended dwell records its actual end, so the short sample count is visible", () => {
  const run = new ExperimentRun(config());
  run.start(T0);
  run.confirmPosition(T0);
  run.endStepEarly(T0 + 20000);
  assert.equal(run.marks[0].endMs, T0 + 20000, "20 s, not the planned 60 s");
  assert.equal(run.state, "awaiting-position");
});

test("the run completes after the last step and stops advancing", () => {
  const run = new ExperimentRun(config());
  run.start(T0);
  let clock = T0;
  for (let step = 0; step < 2; step += 1) {
    run.confirmPosition(clock);
    clock += 60000;
    run.tick(clock);
  }
  assert.equal(run.state, "complete");
  assert.equal(run.marks.length, 2);
  assert.equal(run.currentStep().referenceHeightMm, 10, "the last step stays addressable");
  const result = run.tick(clock + 60000);
  assert.equal(result.changed, false, "a completed run does not keep ticking");
});

test("aborting closes the dwell in progress and keeps its data", () => {
  const run = new ExperimentRun(config());
  run.start(T0);
  run.confirmPosition(T0);
  run.ingestSample(fix(T0 + 1000));
  run.abort(T0 + 30000);
  assert.equal(run.state, "aborted");
  assert.equal(run.marks.length, 1, "the partial dwell is recorded, not thrown away");
  assert.equal(run.marks[0].endMs, T0 + 30000);
  assert.equal(run.samples.length, 1, "and its samples survive");
});

test("progress reports current-step and total sample counts separately", () => {
  const run = new ExperimentRun(config());
  run.start(T0);
  run.confirmPosition(T0);
  run.ingestSample(fix(T0 + 1000));
  run.ingestSample(fix(T0 + 2000));
  run.tick(T0 + 60000);
  run.confirmPosition(T0 + 70000);
  run.ingestSample(fix(T0 + 71000));

  const progress = run.progress(T0 + 72000);
  assert.equal(progress.currentStepSampleCount, 1, "this dwell");
  assert.equal(progress.totalSampleCount, 3, "the whole run");
  assert.equal(progress.completedSteps, 1);
  assert.equal(progress.totalSteps, 2);
  assert.equal(progress.remainingMs, 58000);
});

test("a mid-run restart is refused, because starting over discards data", () => {
  const run = new ExperimentRun(config());
  run.start(T0);
  run.confirmPosition(T0);
  run.ingestSample(fix(T0 + 1000));
  run.tick(T0 + 60000);
  assert.equal(run.state, "awaiting-position");

  const result = run.start(T0 + 600000);
  assert.equal(result.ok, false, "the operator must abort first, deliberately");
  assert.equal(run.marks.length, 1, "and nothing already collected is lost by accident");
  assert.equal(run.samples.length, 1);
});

test("restarting after an abort clears the previous run rather than appending to it", () => {
  const run = new ExperimentRun(config());
  run.start(T0);
  run.confirmPosition(T0);
  run.ingestSample(fix(T0 + 1000));
  run.abort(T0 + 30000);
  assert.equal(run.marks.length, 1);

  const result = run.start(T0 + 600000);
  assert.equal(result.ok, true);
  assert.equal(run.marks.length, 0);
  assert.equal(run.samples.length, 0);
  assert.equal(run.currentStepIndex, 0);
});

test("the descending leg keeps its own visit index so hysteresis stays measurable", () => {
  const run = new ExperimentRun(config({ include_descending: true }));
  run.start(T0);
  let clock = T0;
  const heights = [];
  const visits = [];
  while (run.state !== "complete") {
    heights.push(run.currentStep().referenceHeightMm);
    visits.push(run.currentStep().visitIndex);
    run.confirmPosition(clock);
    clock += 60000;
    run.tick(clock);
  }
  assert.deepEqual(heights, [0, 10, 0]);
  assert.deepEqual(visits, [0, 0, 1]);
  assert.deepEqual(run.marks.map((mark) => mark.direction), ["ascending", "ascending", "descending"]);
});
