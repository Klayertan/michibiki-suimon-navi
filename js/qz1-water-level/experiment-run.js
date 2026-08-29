// The live run: a small state machine that walks the operator through the
// plan, stamps each dwell with the reference height it was held at, and
// collects the samples that arrived during it.
//
// DOM-free and clock-free on purpose (every method takes `nowMs`), so the
// whole procedure can be unit tested end to end without a receiver, a
// browser, or a five-minute wait. `experiment-controller.js` owns the DOM and
// the timers and does nothing this file does not.
//
// WHY THE OPERATOR CONFIRMS EACH POSITION
// ---------------------------------------
// The run does not advance on a timer alone. Between one dwell and the next
// the receiver has to be physically moved, and how long that takes is not
// predictable — a rig can jam, a float can snag, a phone call happens. So
// each step is: (1) the tool says "move to +30 mm", (2) the operator moves it
// and presses 確認, (3) only then does the dwell clock start. Samples that
// arrive between (1) and (2) belong to no reference height and are recorded
// as such rather than being credited to either neighbour.
//
// The alternative — a fixed cadence that assumes the move happened on
// schedule — would silently mislabel the transition samples, which is exactly
// the kind of error that makes a small step look resolvable when it is not.

import { buildExperimentPlan } from "./experiment-config.js";

export const RUN_STATES = ["idle", "awaiting-position", "dwelling", "complete", "aborted"];

const TRANSITIONS = {
  idle: { start: "awaiting-position" },
  "awaiting-position": { confirm: "dwelling", abort: "aborted" },
  dwelling: { finishStep: "awaiting-position", finishRun: "complete", abort: "aborted" },
  complete: { start: "awaiting-position" },
  aborted: { start: "awaiting-position" }
};

/** Next state for (current, action), or null when the action is not allowed. */
export function nextRunState(current, action) {
  return TRANSITIONS[current]?.[action] ?? null;
}

export class ExperimentRun {
  constructor(config) {
    this.config = config;
    this.plan = buildExperimentPlan(config);
    this.state = "idle";
    this.currentStepIndex = 0;
    this.currentStepStartMs = null;
    this.marks = [];
    this.samples = [];
    // Samples that arrived while nothing was being held at a known height.
    // Kept, never discarded: how long the operator spent between levels is
    // part of the experimental record.
    this.transitionSamples = [];
    this.startedAtMs = null;
    this.finishedAtMs = null;
  }

  /** Begins (or restarts) the run. Clears any previous data. */
  start(nowMs) {
    if (!nextRunState(this.state, "start")) {
      return { ok: false, reason: `この状態からは開始できません (${this.state}) / cannot start` };
    }
    this.state = "awaiting-position";
    this.currentStepIndex = 0;
    this.currentStepStartMs = null;
    this.marks = [];
    this.samples = [];
    this.transitionSamples = [];
    this.startedAtMs = nowMs;
    this.finishedAtMs = null;
    return { ok: true, step: this.currentStep() };
  }

  /** The operator has placed the receiver at the current step's height. */
  confirmPosition(nowMs) {
    if (!nextRunState(this.state, "confirm")) {
      return { ok: false, reason: `位置確認できる状態ではありません (${this.state}) / cannot confirm here` };
    }
    this.state = "dwelling";
    this.currentStepStartMs = nowMs;
    return { ok: true, step: this.currentStep(), endsAtMs: nowMs + this.currentStep().dwellSeconds * 1000 };
  }

  /**
   * Feeds one sample in.
   *
   * During a dwell the sample is labelled with the step. Otherwise it goes to
   * `transitionSamples` untouched — with no reference height, because it has
   * none.
   */
  ingestSample(sample) {
    if (this.state !== "dwelling") {
      this.transitionSamples.push({ ...sample, referenceHeightMm: null, stepIndex: null });
      return { accepted: false, reason: this.state };
    }
    const step = this.currentStep();
    this.samples.push({
      ...sample,
      referenceHeightMm: step.referenceHeightMm,
      stepIndex: step.stepIndex,
      visitIndex: step.visitIndex,
      direction: step.direction
    });
    return { accepted: true, step };
  }

  /**
   * Advances the clock. Closes the current dwell once its duration has
   * elapsed; returns `{ changed, state, step }`.
   *
   * Never closes a dwell early and never extends one: the dwell is exactly
   * `dwellSeconds` of wall clock from the confirmation, so every level in the
   * run gets the same exposure and levels stay comparable.
   */
  tick(nowMs) {
    if (this.state !== "dwelling") {
      return { changed: false, state: this.state, step: this.currentStep() };
    }
    const step = this.currentStep();
    const endsAtMs = this.currentStepStartMs + step.dwellSeconds * 1000;
    if (nowMs < endsAtMs) {
      return { changed: false, state: this.state, step, remainingMs: endsAtMs - nowMs };
    }
    return this.closeStep(endsAtMs);
  }

  /**
   * Ends the current dwell now, before its time is up.
   *
   * Available because field conditions are field conditions, but the mark
   * records the actual end time, so a short dwell shows up as a smaller `n`
   * in the analysis rather than being invisible.
   */
  endStepEarly(nowMs) {
    if (this.state !== "dwelling") {
      return { changed: false, state: this.state, step: this.currentStep() };
    }
    return this.closeStep(nowMs);
  }

  closeStep(endMs) {
    const step = this.currentStep();
    this.marks.push({
      stepIndex: step.stepIndex,
      referenceHeightMm: step.referenceHeightMm,
      visitIndex: step.visitIndex,
      direction: step.direction,
      startMs: this.currentStepStartMs,
      endMs,
      settleSeconds: step.settleSeconds,
      note: ""
    });
    this.currentStepStartMs = null;

    if (this.currentStepIndex + 1 >= this.plan.length) {
      this.state = "complete";
      this.finishedAtMs = endMs;
      return { changed: true, state: this.state, step: null };
    }
    this.currentStepIndex += 1;
    this.state = "awaiting-position";
    return { changed: true, state: this.state, step: this.currentStep() };
  }

  abort(nowMs) {
    if (!nextRunState(this.state, "abort")) {
      return { ok: false, reason: `中止できる状態ではありません (${this.state}) / cannot abort` };
    }
    // A dwell that was in progress is still closed and kept: partial data
    // from an aborted run is data, and deleting it would be the one
    // irreversible thing this module could do.
    if (this.state === "dwelling") {
      this.closeStep(nowMs);
    }
    this.state = "aborted";
    this.finishedAtMs = nowMs;
    return { ok: true };
  }

  currentStep() {
    return this.plan[this.currentStepIndex] ?? null;
  }

  /** Everything the UI needs to render, in one object. */
  progress(nowMs) {
    const step = this.currentStep();
    const completed = this.marks.length;
    const dwellEndsAtMs = this.state === "dwelling" && step
      ? this.currentStepStartMs + step.dwellSeconds * 1000
      : null;
    return {
      state: this.state,
      stepIndex: this.currentStepIndex,
      totalSteps: this.plan.length,
      completedSteps: completed,
      step,
      dwellEndsAtMs,
      remainingMs: dwellEndsAtMs === null ? null : Math.max(0, dwellEndsAtMs - nowMs),
      elapsedMs: this.currentStepStartMs === null ? null : nowMs - this.currentStepStartMs,
      // Samples collected for the CURRENT step only — a live "is this dwell
      // producing data at all?" readout, distinct from the run total.
      currentStepSampleCount: step === null
        ? 0
        : this.samples.filter((sample) => sample.stepIndex === step.stepIndex).length,
      totalSampleCount: this.samples.length,
      transitionSampleCount: this.transitionSamples.length
    };
  }

  /** All samples, labelled ones and transition ones, in arrival order. */
  allSamples() {
    return [...this.samples, ...this.transitionSamples]
      .sort((a, b) => (a.timestampUtcMs ?? 0) - (b.timestampUtcMs ?? 0));
  }
}
