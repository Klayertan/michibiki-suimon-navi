// The actual experiment: does relative GNSS altitude track a known vertical
// displacement, and at which step sizes?
//
// THE FIVE QUANTITIES THE BRIEF REQUIRES ARE KEPT APART, EVERYWHERE
// ----------------------------------------------------------------
//   1. raw GNSS altitude              `raw.meanMm`      (as received)
//   2. filtered GNSS altitude         `filtered.meanMm` (chain recorded)
//   3. observed relative displacement `deltaGnssMm`     (filtered − baseline)
//   4. actual reference displacement  `deltaReferenceMm`(what was really done)
//   5. calculated error               `errorMm` = 3 − 4
//
// They never merge and they are never renamed into each other. A reader of
// any output of this module can always ask "is this number something the
// receiver said, something we computed from it, or something a tape measure
// said" and get an answer.
//
// THE VERDICT IS ALLOWED TO SAY NO
// --------------------------------
// `resolvability` may come back FAIL for 10 mm and 20 mm and PASS only at
// 100 mm — or FAIL everywhere. That is a result, not a bug, and nothing in
// this module is tuned to avoid it. Two conditions must BOTH hold before a
// step size is called resolved:
//
//   separated — the 95% confidence intervals of the baseline mean and this
//               level's mean do not overlap. Without this, the receiver
//               cannot tell the two positions apart at all, and any apparent
//               displacement is noise that happened to point somewhere.
//   accurate  — |error| ≤ tolerance, and the displacement has the right sign.
//               A receiver that reliably reports +180 mm when the rig moved
//               +30 mm has DETECTED the step but cannot MEASURE it.
//
// A step size that is separated but not accurate is INCONCLUSIVE, not PASS:
// detection and measurement are different claims and this project needs the
// second one. Repeatability across an up-visit and a down-visit is checked on
// top of that, and a level that fails it is downgraded — a number that only
// works in one direction is not a measurement either.

import { summarizeAltitudes, sampleInterval95 } from "./displacement-statistics.js";
import { applyFilterChain, normalizeFilterChain } from "./altitude-filters.js";
import { assignSamplesToSegments, groupSegmentsByHeight, normalizeMarks } from "./experiment-segments.js";
import { describeTelemetryCoverage, alwaysMissingFields } from "./experiment-samples.js";

export const VERDICTS = {
  PASS: "PASS",
  INCONCLUSIVE: "INCONCLUSIVE",
  FAIL: "FAIL",
  INSUFFICIENT: "INSUFFICIENT"
};

/** Minimum accepted samples at a level before any verdict is attempted. */
export const MIN_SAMPLES_FOR_VERDICT = 10;

/**
 * Full analysis of one experiment run.
 *
 * @param samples      experiment samples (see experiment-samples.js), unlabelled
 * @param rawMarks     operator's level marks (see experiment-segments.js)
 * @param config       normalized experiment config (experiment-config.js)
 * @param rawChain     filter chain or preset name; `[]`/omitted means none
 */
export function analyzeExperiment({ samples = [], marks: rawMarks = [], config, filterChain: rawChain = [] }) {
  const errors = [];
  const warnings = [];

  if (!config) {
    return { ok: false, errors: ["config: 実験設定が必要です / experiment config is required"], warnings: [] };
  }

  const { chain, errors: chainErrors } = normalizeFilterChain(rawChain);
  if (!chain) {
    return { ok: false, errors: chainErrors, warnings: [] };
  }

  const { marks, errors: markErrors } = normalizeMarks(rawMarks, { defaultSettleSeconds: config.settleSeconds });
  errors.push(...markErrors);
  if (marks.length === 0) {
    errors.push("marks: 基準高さのマークが1つもありません / no reference-height marks");
  }
  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }

  const assignment = assignSamplesToSegments(samples, marks);
  if (assignment.undatable.length > 0) {
    warnings.push(
      `${assignment.undatable.length}件のサンプルに時刻がなく、どの基準高さにも割り当てられません（NMEAにRMC/ZDAが無い場合は捕捉日を設定してください）。`
      + ` / ${assignment.undatable.length} samples have no timestamp and were excluded.`
    );
  }

  const byHeight = groupSegmentsByHeight(assignment.segments);
  const baselineGroup = byHeight.find((group) => group.referenceHeightMm === 0);
  if (!baselineGroup) {
    return {
      ok: false,
      errors: ["baseline: 0mm の基準位置がありません。相対変位を計算できません / no 0 mm baseline; ΔZ is undefined"],
      warnings
    };
  }

  const levels = byHeight.map((group) => analyzeLevel(group, chain));
  const baseline = levels.find((level) => level.referenceHeightMm === 0);

  for (const level of levels) {
    attachDisplacement(level, baseline, config);
  }

  const telemetryCoverage = describeTelemetryCoverage(samples);
  const missing = alwaysMissingFields(telemetryCoverage);
  if (missing.length > 0) {
    warnings.push(
      `この受信機/ログはこれらの項目を一度も出力していません: ${missing.join(", ")}。`
      + " 値を補完せず欠測として扱います。"
      + ` / Never reported by this receiver: ${missing.join(", ")}. Left missing, never imputed.`
    );
  }
  if (chain.length === 0) {
    warnings.push("フィルタ未適用（raw のみ）。filtered 列は raw と同一です。 / No filter applied; filtered equals raw.");
  }
  // Smoothing looks like it should help and statistically does the opposite.
  // A moving mean/median raises the sample-to-sample correlation, which
  // lowers the AR(1) effective sample size, which WIDENS the confidence
  // interval. The plotted trace gets prettier and the evidence gets weaker.
  // Saying so here is the difference between a tool that reports a result and
  // one that can be talked into a result.
  if (chain.some((stage) => stage.kind === "moving-mean" || stage.kind === "moving-median")) {
    warnings.push(
      "平滑化フィルタが含まれています。平滑化は見た目のばらつきを減らしますが、サンプル間の相関を高めるため"
      + "有効サンプル数はむしろ減り、信頼区間は広がります。統計的な検出力は平滑化では買えません。"
      + " / The chain smooths. Smoothing raises autocorrelation, lowers effective n and WIDENS the CI:"
      + " it cannot buy statistical power."
    );
  }

  const totalAccepted = levels.reduce((total, level) => total + level.filtered.count, 0);
  if (totalAccepted === 0) {
    warnings.push("有効サンプルが0件です。fix品質・整定時間・マーク時刻を確認してください。 / Zero usable samples.");
  }

  return {
    ok: true,
    errors: [],
    warnings,
    config,
    filterChain: chain,
    baselineReferenceHeightMm: 0,
    levels,
    unassignedSampleCount: assignment.unassigned.length,
    undatableSampleCount: assignment.undatable.length,
    settlingSampleCount: assignment.segments.reduce((total, segment) => total + segment.settling.length, 0),
    telemetryCoverage,
    alwaysMissingFields: missing,
    verdicts: Object.fromEntries(
      levels
        .filter((level) => level.referenceHeightMm !== 0)
        .map((level) => [level.referenceHeightMm, level.resolvability.verdict])
    )
  };
}

/** Raw + filtered statistics for one reference height, plus each visit separately. */
function analyzeLevel(group, chain) {
  const rawSamples = group.accepted;
  const applied = applyFilterChain(rawSamples, chain);

  const visits = group.visits.map((segment) => {
    const visitFiltered = applyFilterChain(segment.accepted, chain);
    return {
      stepIndex: segment.stepIndex,
      visitIndex: segment.visitIndex,
      direction: segment.direction,
      startMs: segment.mark.startMs,
      endMs: segment.mark.endMs,
      settlingCount: segment.settling.length,
      raw: summarizeAltitudes(segment.accepted.map((sample) => sample.altitudeMm)),
      filtered: summarizeAltitudes(visitFiltered.samples.map((sample) => sample.altitudeMm))
    };
  });

  return {
    referenceHeightMm: group.referenceHeightMm,
    visits,
    rawSampleCount: rawSamples.length,
    settlingSampleCount: group.settling.length,
    raw: summarizeAltitudes(rawSamples.map((sample) => sample.altitudeMm)),
    filtered: summarizeAltitudes(applied.samples.map((sample) => sample.altitudeMm)),
    sampleInterval95: sampleInterval95(applied.samples.map((sample) => sample.altitudeMm)),
    filterStages: applied.stages,
    rejectedByFilter: applied.rejected.length,
    // Kept for the plots; these are the values actually summarized above.
    filteredAltitudesMm: applied.samples.map((sample) => sample.altitudeMm),
    rawAltitudesMm: rawSamples.map((sample) => sample.altitudeMm),
    filteredSamples: applied.samples
  };
}

/** Adds ΔZ, error and the verdict to one level, relative to the baseline level. */
function attachDisplacement(level, baseline, config) {
  const deltaReferenceMm = level.referenceHeightMm - baseline.referenceHeightMm;
  const deltaGnssRawMm = differenceOrNull(level.raw.meanMm, baseline.raw.meanMm);
  const deltaGnssMm = differenceOrNull(level.filtered.meanMm, baseline.filtered.meanMm);
  const errorMm = deltaGnssMm === null ? null : deltaGnssMm - deltaReferenceMm;
  const errorRawMm = deltaGnssRawMm === null ? null : deltaGnssRawMm - deltaReferenceMm;

  level.deltaReferenceMm = deltaReferenceMm;
  level.deltaGnssRawMm = deltaGnssRawMm;
  level.deltaGnssMm = deltaGnssMm;
  level.errorMm = errorMm;
  level.errorRawMm = errorRawMm;
  level.absoluteErrorMm = errorMm === null ? null : Math.abs(errorMm);
  level.hysteresis = computeHysteresis(level);
  level.resolvability = level.referenceHeightMm === 0
    ? { verdict: null, reasons: ["baseline"], separated: null, accurate: null, repeatable: null }
    : judgeResolvability(level, baseline, config);
}

/**
 * The difference between the same height measured on the way up and on the
 * way down. Null when the height was visited once (nothing to compare) or
 * when either visit lacks a mean.
 *
 * A large hysteresis means the receiver's altitude is drifting over the run,
 * so part of every "displacement" above is really elapsed time.
 */
function computeHysteresis(level) {
  const ascending = level.visits.filter((visit) => visit.direction === "ascending" && visit.filtered.meanMm !== null);
  const descending = level.visits.filter((visit) => visit.direction === "descending" && visit.filtered.meanMm !== null);
  if (ascending.length === 0 || descending.length === 0) {
    return { differenceMm: null, ascendingMeanMm: null, descendingMeanMm: null };
  }
  const ascendingMeanMm = average(ascending.map((visit) => visit.filtered.meanMm));
  const descendingMeanMm = average(descending.map((visit) => visit.filtered.meanMm));
  return {
    differenceMm: descendingMeanMm - ascendingMeanMm,
    ascendingMeanMm,
    descendingMeanMm
  };
}

/**
 * PASS / INCONCLUSIVE / FAIL / INSUFFICIENT for one step size.
 *
 * Every branch records WHY in `reasons`, in both languages, so a verdict can
 * never be quoted without the argument behind it.
 */
export function judgeResolvability(level, baseline, config) {
  const reasons = [];
  const toleranceMm = config.toleranceMm;

  if (level.filtered.count < MIN_SAMPLES_FOR_VERDICT || baseline.filtered.count < MIN_SAMPLES_FOR_VERDICT) {
    reasons.push(
      `サンプル不足（この位置 ${level.filtered.count}件 / 基準 ${baseline.filtered.count}件、必要 ${MIN_SAMPLES_FOR_VERDICT}件）`
      + ` / too few samples`
    );
    return { verdict: VERDICTS.INSUFFICIENT, reasons, separated: null, accurate: null, repeatable: null, toleranceMm };
  }

  const separated = confidenceIntervalsDisjoint(level.filtered, baseline.filtered);
  if (separated === null) {
    // Almost always the autocorrelation case: hundreds of fixes that between
    // them carry fewer than two independent measurements of the position.
    // The remedy is a longer dwell (or a quieter site), not a filter -- so
    // the reason says which one it is rather than "unavailable".
    for (const [label, summary] of [["この位置 / this level", level.filtered], ["基準 / baseline", baseline.filtered]]) {
      if (summary.ciMethod === "insufficient-independent-samples") {
        reasons.push(
          `${label}: ${summary.count}件のサンプルの相関が強く（r₁=${formatNumber(summary.lag1Autocorrelation, 3)}）、`
          + `独立なサンプルは実質 ${formatNumber(summary.effectiveCount, 1)} 件しかありません。`
          + "滞在時間を延ばしてください（フィルタでは解決しません）。"
          + ` / samples too correlated: effective n = ${formatNumber(summary.effectiveCount, 1)}; dwell longer`
        );
      }
    }
    if (reasons.length === 0) {
      reasons.push("信頼区間を計算できません（分散が得られません） / confidence interval unavailable");
    }
    return { verdict: VERDICTS.INSUFFICIENT, reasons, separated: null, accurate: null, repeatable: null, toleranceMm };
  }

  const correctSign = level.deltaGnssMm !== null
    && Math.sign(level.deltaGnssMm) === Math.sign(level.deltaReferenceMm);
  const accurate = level.absoluteErrorMm !== null && level.absoluteErrorMm <= toleranceMm && correctSign;

  if (!separated) {
    reasons.push(
      `基準位置と95%信頼区間が重なります（この段差を雑音と区別できません） / 95% CIs overlap with the baseline`
    );
    return { verdict: VERDICTS.FAIL, reasons, separated, accurate, repeatable: null, toleranceMm };
  }

  reasons.push("基準位置と95%信頼区間が分離しています / separated from baseline at 95%");

  if (!correctSign) {
    reasons.push(
      `変位の符号が逆です（GNSS ${formatMm(level.deltaGnssMm)} / 実際 ${formatMm(level.deltaReferenceMm)}）`
      + " / displacement has the wrong sign"
    );
    return { verdict: VERDICTS.INCONCLUSIVE, reasons, separated, accurate: false, repeatable: null, toleranceMm };
  }

  if (!accurate) {
    reasons.push(
      `誤差 ${formatMm(level.errorMm)} が許容 ±${toleranceMm}mm を超えます（検知はできても測定はできていません）`
      + ` / error exceeds ±${toleranceMm} mm: detected but not measured`
    );
    return { verdict: VERDICTS.INCONCLUSIVE, reasons, separated, accurate, repeatable: null, toleranceMm };
  }

  reasons.push(`誤差 ${formatMm(level.errorMm)} は許容 ±${toleranceMm}mm 以内 / error within tolerance`);

  const hysteresisMm = level.hysteresis?.differenceMm;
  if (hysteresisMm === null || hysteresisMm === undefined) {
    reasons.push("往路のみ（復路が無いため再現性は未検証） / single visit: repeatability untested");
    return { verdict: VERDICTS.PASS, reasons, separated, accurate, repeatable: null, toleranceMm };
  }

  const repeatable = Math.abs(hysteresisMm) <= toleranceMm;
  if (!repeatable) {
    reasons.push(
      `往路と復路で ${formatMm(hysteresisMm)} 食い違います（許容 ±${toleranceMm}mm 超）`
      + " / up and down visits disagree by more than the tolerance"
    );
    return { verdict: VERDICTS.INCONCLUSIVE, reasons, separated, accurate, repeatable, toleranceMm };
  }

  reasons.push(`往路と復路の差 ${formatMm(hysteresisMm)} は許容内 / repeatable across directions`);
  return { verdict: VERDICTS.PASS, reasons, separated, accurate, repeatable, toleranceMm };
}

/**
 * Whether two means' 95% confidence intervals are disjoint.
 *
 * Non-overlapping CIs is a CONSERVATIVE test of a difference (it is stricter
 * than the corresponding two-sample t-test), which is the right way round for
 * this project: it makes it harder, not easier, to declare a step resolved.
 */
export function confidenceIntervalsDisjoint(a, b) {
  if (a.meanMm === null || b.meanMm === null || a.ci95Mm === null || b.ci95Mm === null) {
    return null;
  }
  const aLow = a.meanMm - a.ci95Mm;
  const aHigh = a.meanMm + a.ci95Mm;
  const bLow = b.meanMm - b.ci95Mm;
  const bHigh = b.meanMm + b.ci95Mm;
  return aHigh < bLow || bHigh < aLow;
}

/**
 * The plain result table the brief asks for, as rows.
 * Values stay numbers (or null) — formatting belongs to the caller.
 */
export function buildResultTable(analysis) {
  return analysis.levels.map((level) => ({
    referenceMm: level.referenceHeightMm,
    deltaReferenceMm: level.deltaReferenceMm,
    rawEstimateMm: level.deltaGnssRawMm,
    filteredEstimateMm: level.deltaGnssMm,
    errorMm: level.errorMm,
    absoluteErrorMm: level.absoluteErrorMm,
    sampleCount: level.filtered.count,
    sdMm: level.filtered.sdMm,
    ci95Mm: level.filtered.ci95Mm,
    verdict: level.resolvability.verdict
  }));
}

/**
 * One-line summary of what the run established, phrased so it cannot be
 * mistaken for a claim about the technique in general: it describes THIS run,
 * with this receiver, at this site.
 */
export function summarizeOutcome(analysis) {
  const graded = analysis.levels.filter((level) => level.referenceHeightMm !== 0);
  const passed = graded.filter((level) => level.resolvability.verdict === VERDICTS.PASS);
  if (graded.length === 0) {
    return "判定できる基準高さがありません。 / No gradeable reference heights.";
  }
  if (passed.length === 0) {
    return "この実験では、いずれの段差も測定できませんでした（負の結果）。"
      + " / In this run, no step size was resolved. This is a valid negative result.";
  }
  const smallest = Math.min(...passed.map((level) => Math.abs(level.referenceHeightMm)));
  return `この実験で測定できた最小の段差は ${smallest} mm です（この受信機・この設置条件・このフィルタでの結果）。`
    + ` / Smallest step resolved in this run: ${smallest} mm — for this receiver, site and filter chain only.`;
}

function differenceOrNull(a, b) {
  return a === null || b === null || a === undefined || b === undefined ? null : a - b;
}

function average(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function formatMm(value) {
  return value === null || value === undefined ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(1)}mm`;
}

function formatNumber(value, decimals) {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : value.toFixed(decimals);
}
