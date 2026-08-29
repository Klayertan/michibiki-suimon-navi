// Associating raw GNSS samples with the KNOWN vertical positions they were
// taken at. This is the step that turns a continuous altitude log into an
// experiment, and it is the step where an experimenter most easily fools
// themselves — so all of it is explicit, and none of it is automatic.
//
// A "mark" is the operator's statement: "between t0 and t1 the receiver was
// at reference height H." Marks come from the live runner (which stamps them
// as the run proceeds) or from a hand-written marks file when the log was
// captured with some other logger. Nothing here infers a step boundary from
// the altitude data itself: detecting the steps from the very signal whose
// step-detection ability is under test would be circular, and would
// manufacture a positive result.
//
// SETTLE WINDOW
// -------------
// The first `settleSeconds` of every mark are dropped. Receivers filter
// internally, so the altitude immediately after a physical move is a blend of
// the old and new positions. Keeping those samples would drag every level
// toward its predecessor. The dropped samples are NOT deleted — they are
// returned under `settling` so a re-analysis with a different settle window
// is possible from the same data, and so the plots can show them greyed out.

/**
 * Normalizes a mark. Returns null (with a reason) rather than guessing.
 *
 * `startMs`/`endMs` are epoch milliseconds in the same clock as the samples'
 * `timestampUtcMs`. `endMs` may be null for the final, still-open mark.
 */
export function normalizeMark(raw, index = 0) {
  const referenceHeightMm = numberOrNull(raw?.referenceHeightMm ?? raw?.reference_height_mm);
  const startMs = numberOrNull(raw?.startMs ?? raw?.start_ms);
  const endRaw = raw?.endMs ?? raw?.end_ms;
  const endMissing = endRaw === null || endRaw === undefined || endRaw === "";
  const endMs = endMissing ? null : numberOrNull(endRaw);

  if (!Number.isFinite(referenceHeightMm)) {
    return { mark: null, error: `mark[${index}]: reference height が数値ではありません / non-numeric reference height` };
  }
  if (!Number.isFinite(startMs)) {
    return { mark: null, error: `mark[${index}]: startMs が数値ではありません / non-numeric startMs` };
  }
  if (!endMissing && endMs === null) {
    return { mark: null, error: `mark[${index}]: endMs が数値ではありません / non-numeric endMs` };
  }
  if (endMs !== null && endMs <= startMs) {
    return { mark: null, error: `mark[${index}]: endMs が startMs 以前です / mark ends before it starts` };
  }

  const stepIndex = numberOrNull(raw?.stepIndex ?? raw?.step_index);
  const visitIndex = numberOrNull(raw?.visitIndex ?? raw?.visit_index);
  const settleRaw = raw?.settleSeconds ?? raw?.settle_seconds;
  const settleMissing = settleRaw === null || settleRaw === undefined || settleRaw === "";
  const settleSeconds = settleMissing ? null : numberOrNull(settleRaw);
  if (!settleMissing && settleSeconds === null) {
    return { mark: null, error: `mark[${index}]: settleSeconds が数値ではありません / non-numeric settleSeconds` };
  }
  if (settleSeconds !== null && settleSeconds < 0) {
    return { mark: null, error: `mark[${index}]: settleSeconds が負です / negative settleSeconds` };
  }

  return {
    mark: {
      stepIndex: stepIndex === null ? index : stepIndex,
      referenceHeightMm,
      visitIndex: visitIndex === null ? 0 : visitIndex,
      direction: typeof raw?.direction === "string" ? raw.direction : null,
      startMs,
      endMs,
      settleSeconds,
      note: typeof raw?.note === "string" ? raw.note : ""
    },
    error: null
  };
}

/** Validates a whole marks list, reporting every problem rather than the first. */
export function normalizeMarks(rawMarks, { defaultSettleSeconds = 0 } = {}) {
  const marks = [];
  const errors = [];
  (Array.isArray(rawMarks) ? rawMarks : []).forEach((raw, index) => {
    const { mark, error } = normalizeMark(raw, index);
    if (error) {
      errors.push(error);
      return;
    }
    if (mark.settleSeconds === null) {
      mark.settleSeconds = defaultSettleSeconds;
    }
    marks.push(mark);
  });

  const sorted = [...marks].sort((a, b) => a.startMs - b.startMs);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous.endMs !== null && current.startMs < previous.endMs) {
      errors.push(
        `mark[${current.stepIndex}]: 前のマーク（${previous.referenceHeightMm}mm）と時間が重なっています / overlapping marks`
      );
    }
  }

  return { marks: sorted, errors };
}

/**
 * Splits samples into labelled segments.
 *
 * Returns one entry per mark, each holding:
 *   `accepted`  — samples inside the mark and past its settle window
 *   `settling`  — samples inside the mark but within the settle window
 * plus `unassigned`: samples that fell in no mark at all (repositioning time,
 * pre-roll, post-roll). Those are kept, not dropped, because "how long the
 * operator took between levels" is part of the record.
 *
 * Samples with no usable timestamp cannot be placed in time and are returned
 * under `undatable`. They are never quietly attached to the nearest mark.
 */
export function assignSamplesToSegments(samples, marks) {
  const segments = marks.map((mark) => ({
    mark,
    referenceHeightMm: mark.referenceHeightMm,
    stepIndex: mark.stepIndex,
    visitIndex: mark.visitIndex,
    direction: mark.direction,
    accepted: [],
    settling: []
  }));
  const unassigned = [];
  const undatable = [];

  for (const sample of samples) {
    const timestampMs = sample?.timestampUtcMs;
    if (!Number.isFinite(timestampMs)) {
      undatable.push(sample);
      continue;
    }
    const segment = segments.find(({ mark }) =>
      timestampMs >= mark.startMs && (mark.endMs === null || timestampMs < mark.endMs));
    if (!segment) {
      unassigned.push(sample);
      continue;
    }
    const labelled = {
      ...sample,
      referenceHeightMm: segment.referenceHeightMm,
      stepIndex: segment.stepIndex,
      visitIndex: segment.visitIndex,
      direction: segment.direction
    };
    const settleUntilMs = segment.mark.startMs + segment.mark.settleSeconds * 1000;
    if (timestampMs < settleUntilMs) {
      segment.settling.push(labelled);
    } else {
      segment.accepted.push(labelled);
    }
  }

  return { segments, unassigned, undatable };
}

/**
 * Merges the repeated visits to one reference height into one bucket per
 * height, while keeping the per-visit split available.
 *
 * Merging is a judgement call, not a fact: an ascending 30 mm and a
 * descending 30 mm are the same physical position but not necessarily the
 * same measurement, and pooling them hides drift. Both views are therefore
 * produced, and the analysis reports the pooled figure alongside a
 * per-visit hysteresis number rather than instead of it.
 */
export function groupSegmentsByHeight(segments) {
  const byHeight = new Map();
  for (const segment of segments) {
    const key = segment.referenceHeightMm;
    if (!byHeight.has(key)) {
      byHeight.set(key, { referenceHeightMm: key, visits: [], accepted: [], settling: [] });
    }
    const entry = byHeight.get(key);
    entry.visits.push(segment);
    entry.accepted.push(...segment.accepted);
    entry.settling.push(...segment.settling);
  }
  return [...byHeight.values()].sort((a, b) => a.referenceHeightMm - b.referenceHeightMm);
}

/**
 * Builds marks straight from a plan when the operator ran the steps
 * back-to-back from a known start time — the simplest possible offline case,
 * and the one the synthetic fixtures use.
 */
export function marksFromPlan(plan, startMs) {
  let cursorMs = startMs;
  return plan.map((step) => {
    const mark = {
      stepIndex: step.stepIndex,
      referenceHeightMm: step.referenceHeightMm,
      visitIndex: step.visitIndex,
      direction: step.direction,
      startMs: cursorMs,
      endMs: cursorMs + step.dwellSeconds * 1000,
      settleSeconds: step.settleSeconds,
      note: ""
    };
    cursorMs = mark.endMs;
    return mark;
  });
}

/** Numeric strings are accepted for JSON/CSV marks; missing values are not 0. */
function numberOrNull(value) {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) {
    return null;
  }
  if (typeof value !== "number" && typeof value !== "string") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
