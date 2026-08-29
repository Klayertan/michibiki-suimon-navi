// Deciding which field a STATIONARY float is in, from a stream of positions
// that will not hold still.
//
// WHY A SINGLE SAMPLE IS NEVER ENOUGH
// -----------------------------------
// The float does not move. Its reported position does. This project's own
// recorded QZ1 log (data/samples/qz1-dorm-walk-20260706.txt) wanders by metres
// while the receiver sits on a desk, and a paddy levee is not metres wide. A
// float parked two metres from a boundary will therefore produce a stream that
// flips between FIELD-003, FIELD-003, OUTSIDE, FIELD-003 … and any code that
// believed the latest sample would flip its answer with it.
//
// So membership is decided by a majority over a rolling window of recent VALID
// positions, and reported with the fraction that agreed. A field only becomes
// a candidate when that fraction clears a threshold.
//
// THESE NUMBERS ARE ENGINEERING DEFAULTS, NOT MEASURED CONSTANTS
// --------------------------------------------------------------
// windowSize = 10 and candidateThreshold = 0.8 are starting points chosen to
// be unsurprising, not values any experiment has justified. At 1 Hz the window
// spans ten seconds, which is far shorter than GNSS error decorrelates — so a
// float sitting just outside a boundary can produce ten consecutive
// wrong-but-agreeing samples and reach 1.0 confidence on a false answer.
// Confidence here means "the recent stream agreed", NOT "this is correct".
// Both values are constructor arguments, and the boundary-jitter limitation is
// written down in docs/qz1-floating-water-level/ARCHITECTURE.md.
//
// The window holds detection OUTCOMES, not positions: "outside" and
// "ambiguous" are results that can win a vote just as a field id can. A float
// that is genuinely outside every registered field must be able to say so
// confidently, rather than being permanently undecided.

import { DETECTION_STATUS } from "./field-detection.js";

export const DEFAULT_WINDOW_SIZE = 10;
export const DEFAULT_CANDIDATE_THRESHOLD = 0.8;

/** What the window has concluded. Distinct from the sensor's assignment state. */
export const WINDOW_STATUS = {
  /** Not enough valid samples yet, or no outcome cleared the threshold. */
  DETECTING: "detecting",
  /** One field cleared the threshold. */
  CANDIDATE: "candidate",
  /** "Contained by nothing" cleared the threshold. */
  OUTSIDE: "outside-known-fields",
  /** "Contained by several" cleared the threshold. */
  AMBIGUOUS: "ambiguous"
};

/**
 * A fixed-length window over recent detection outcomes.
 *
 * @param windowSize          how many valid samples are remembered
 * @param candidateThreshold  fraction of the window that must agree (0..1]
 * @param minSamples          samples required before any verdict is offered.
 *        Defaults to a FULL window on purpose: computing the fraction over
 *        however many samples have arrived so far would make the very first
 *        sample unanimous, so a freshly-powered float would announce a
 *        confident candidate one second after switch-on — exactly the
 *        single-sample decision this class exists to prevent.
 */
export class FieldDetectionWindow {
  constructor({
    windowSize = DEFAULT_WINDOW_SIZE,
    candidateThreshold = DEFAULT_CANDIDATE_THRESHOLD,
    minSamples = null
  } = {}) {
    if (!Number.isInteger(windowSize) || windowSize < 1) {
      throw new Error("windowSize must be an integer >= 1");
    }
    if (!Number.isFinite(candidateThreshold) || candidateThreshold <= 0 || candidateThreshold > 1) {
      throw new Error("candidateThreshold must be in (0, 1]");
    }
    this.windowSize = windowSize;
    this.candidateThreshold = candidateThreshold;
    this.minSamples = Number.isInteger(minSamples) && minSamples > 0
      ? Math.min(minSamples, windowSize)
      : windowSize;
    /** Outcome keys, oldest first. A field id, "outside", or "ambiguous". */
    this.outcomes = [];
    /** Detection results that never entered the vote, for the UI's counters. */
    this.rejectedSampleCount = 0;
    this.totalSampleCount = 0;
  }

  /**
   * Feeds one detection result in.
   *
   * Results that carry no information about membership — an unusable position,
   * or a moment when no field has a usable polygon — are counted but NOT
   * pushed into the window. Letting them in would let a receiver that
   * temporarily lost its fix vote against a field it is sitting in the middle
   * of, and would make "no fields registered yet" look like "outside".
   */
  push(detection) {
    this.totalSampleCount += 1;
    const key = outcomeKey(detection);
    if (key === null) {
      this.rejectedSampleCount += 1;
      return this.summarize();
    }
    this.outcomes.push(key);
    while (this.outcomes.length > this.windowSize) {
      this.outcomes.shift();
    }
    return this.summarize();
  }

  /**
   * The current verdict.
   *
   * `confidence` is the winning outcome's share of the samples actually in the
   * window — reported even while DETECTING, so the UI can show a rising
   * number rather than a blank.
   */
  summarize() {
    const counts = new Map();
    for (const key of this.outcomes) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    let leader = null;
    let leaderCount = 0;
    for (const [key, count] of counts) {
      // Strictly greater: a tie leaves the earlier-seen leader in place, and
      // a tie can never clear a threshold above 0.5 anyway.
      if (count > leaderCount) {
        leader = key;
        leaderCount = count;
      }
    }

    const sampleCount = this.outcomes.length;
    const confidence = sampleCount === 0 ? 0 : leaderCount / sampleCount;
    const filled = sampleCount >= this.minSamples;
    const decided = filled && leader !== null && confidence >= this.candidateThreshold;

    return {
      status: decided ? statusForOutcome(leader) : WINDOW_STATUS.DETECTING,
      // Set only when the leader is an actual field. "outside"/"ambiguous"
      // are outcomes, not fields, and must never be handed out as a field id.
      detectedFieldId: decided && isFieldOutcome(leader) ? leader : null,
      leadingOutcome: leader,
      confidence,
      sampleCount,
      windowSize: this.windowSize,
      minSamples: this.minSamples,
      candidateThreshold: this.candidateThreshold,
      filled,
      decided,
      rejectedSampleCount: this.rejectedSampleCount,
      totalSampleCount: this.totalSampleCount,
      counts: Object.fromEntries([...counts].map(([key, count]) => [displayKey(key), count]))
    };
  }

  /**
   * Empties the window without forgetting the lifetime counters.
   *
   * Used when the set of registered fields changes underneath the sensor: the
   * old votes were cast against a different map and are no longer evidence
   * about anything.
   */
  reset() {
    this.outcomes = [];
    return this.summarize();
  }
}

// Symbols make the two non-field outcomes collision-proof without putting a
// NUL byte into source, storage, or UI text. Field ids remain ordinary strings
// so a field literally named "outside" is still a valid field id.
const OUTSIDE_OUTCOME = Symbol("qz1-outside");
const AMBIGUOUS_OUTCOME = Symbol("qz1-ambiguous");

/**
 * The vote a detection result casts, or null when it casts none.
 *
 * The two non-field outcomes use Symbols so they can never collide with a
 * real field id — `paddy-003` is a plausible id, `"outside"` would be a
 * plausible one too, and a field literally named "outside" must not be able to
 * impersonate the outside-every-field outcome.
 */
export function outcomeKey(detection) {
  switch (detection?.status) {
    case DETECTION_STATUS.INSIDE:
      return detection.fieldId ? String(detection.fieldId) : null;
    case DETECTION_STATUS.OUTSIDE:
      return OUTSIDE_OUTCOME;
    case DETECTION_STATUS.AMBIGUOUS:
      return AMBIGUOUS_OUTCOME;
    case DETECTION_STATUS.INVALID_POSITION:
    case DETECTION_STATUS.NO_FIELDS:
    default:
      return null;
  }
}

export function isFieldOutcome(key) {
  return typeof key === "string" && key !== OUTSIDE_OUTCOME && key !== AMBIGUOUS_OUTCOME;
}

function statusForOutcome(key) {
  if (key === OUTSIDE_OUTCOME) {
    return WINDOW_STATUS.OUTSIDE;
  }
  if (key === AMBIGUOUS_OUTCOME) {
    return WINDOW_STATUS.AMBIGUOUS;
  }
  return WINDOW_STATUS.CANDIDATE;
}

function displayKey(key) {
  if (key === OUTSIDE_OUTCOME) {
    return "[outside-known-fields]";
  }
  if (key === AMBIGUOUS_OUTCOME) {
    return "[ambiguous]";
  }
  return key;
}

/** Exposed for tests and for the debug readout; not part of the public vote API. */
export const OUTCOME_KEYS = { OUTSIDE: OUTSIDE_OUTCOME, AMBIGUOUS: AMBIGUOUS_OUTCOME };
