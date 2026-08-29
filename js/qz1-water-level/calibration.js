// Turning a relative GNSS altitude change into a CALIBRATED water depth —
// and refusing to, until an experiment says it is allowed.
//
// THE ARITHMETIC IS TRIVIAL. THE PERMISSION IS NOT.
// -------------------------------------------------
// The formula is one line:
//
//     H(t) = H₀ + (Z(t) − Z₀)
//
// where Z₀ is the GNSS altitude at calibration time and H₀ is the water depth
// somebody measured with a ruler at that same moment. Anyone can write that.
// The reason this module exists is everything around it:
//
//   * `H(t)` is a DEPTH — the number a farmer would act on. Emitting one that
//     the receiver cannot actually support is the specific failure mode the
//     brief calls out ("DO NOT display Water depth = 29 mm unless a valid
//     calibrated reference actually allows that conclusion").
//   * So a calibration is not valid on its own. It must carry the analysis
//     that earned it: which step sizes PASSed, with which receiver, under
//     which filter chain. `deriveWaterDepth` refuses when the requested
//     precision is finer than what that analysis demonstrated, and the
//     refusal carries the reason.
//   * Every derived depth is stamped `source: "qz1-float"` and carries its
//     own uncertainty, so it can never be mistaken downstream for a ruler
//     reading. `js/water/water-measurement.js` labels that source
//     "QZ1浮体（実験・要検証）" in the UI for the same reason.
//
// DRIFT. Z₀ ages. GNSS altitude wanders over hours and days for reasons that
// have nothing to do with the float, so a calibration from last week does not
// describe today's Z. `calibrationAge` and `MAX_CALIBRATION_AGE_MS` exist so
// a stale calibration expires instead of quietly producing plausible numbers.

import { VERDICTS } from "./displacement-analysis.js";
import { buildWaterMeasurement } from "../water/water-measurement.js";

/**
 * How long a calibration may be used before it must be re-taken.
 *
 * 24 hours is a placeholder with no experimental basis yet — the drift
 * measurement that would justify a number has not been made. It is
 * deliberately short so the default behaviour is "re-calibrate", and it is
 * recorded in every refusal so it can be revised against data rather than
 * against opinion.
 */
export const MAX_CALIBRATION_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Builds a calibration record.
 *
 * @param baselineAltitudeMm  Z₀ — GNSS altitude at calibration time, mm
 * @param knownDepthMm        H₀ — independently measured water depth, mm,
 *                            signed against the soil-surface datum
 *                            (js/water/water-measurement.js)
 * @param validation          the analysis that licenses this calibration, from
 *                            `summarizeValidation(analysis)`
 */
export function buildCalibration({
  baselineAltitudeMm,
  knownDepthMm,
  deviceId,
  experimentId,
  fieldId = null,
  validation = null,
  calibratedAt = Date.now(),
  notes = ""
} = {}) {
  const errors = [];
  if (!Number.isFinite(baselineAltitudeMm)) {
    errors.push("baselineAltitudeMm: 基準GNSS標高(Z0)が必要です / Z0 is required");
  }
  if (!Number.isFinite(knownDepthMm)) {
    errors.push("knownDepthMm: 実測水深(H0)が必要です / H0 is required");
  }
  if (!deviceId) {
    errors.push("deviceId: 受信機の識別子が必要です / device id is required");
  }
  if (!experimentId) {
    errors.push("experimentId: 検証に用いた実験IDが必要です / validating experiment id is required");
  }
  const stamp = Number.isFinite(calibratedAt) ? calibratedAt : Date.parse(calibratedAt);
  if (!Number.isFinite(stamp)) {
    errors.push("calibratedAt: 較正時刻が必要です / calibration timestamp is required");
  }
  if (errors.length > 0) {
    return { calibration: null, errors };
  }

  return {
    calibration: {
      baselineAltitudeMm,
      knownDepthMm,
      deviceId,
      experimentId,
      fieldId,
      calibratedAt: stamp,
      validation,
      notes: String(notes ?? ""),
      reference: "soil-surface",
      formula: "H(t) = H0 + (Z(t) - Z0)"
    },
    errors: []
  };
}

/**
 * Distils an analysis into the evidence a calibration must carry.
 *
 * `resolvedStepMm` is the smallest step size that PASSed — the finest change
 * this setup demonstrably measured. Null when nothing passed, which is a
 * perfectly ordinary outcome and blocks depth derivation entirely.
 */
export function summarizeValidation(analysis) {
  if (!analysis?.ok) {
    return null;
  }
  const graded = analysis.levels.filter((level) => level.referenceHeightMm !== 0);
  const passed = graded.filter((level) => level.resolvability.verdict === VERDICTS.PASS);
  const worstPassedErrorMm = passed.length === 0
    ? null
    : Math.max(...passed.map((level) => level.absoluteErrorMm ?? Number.POSITIVE_INFINITY));

  return {
    experimentId: analysis.config.experimentId,
    stage: analysis.config.stage,
    sensor: analysis.config.sensor,
    toleranceMm: analysis.config.toleranceMm,
    filterChain: analysis.filterChain,
    verdicts: analysis.verdicts,
    resolvedStepMm: passed.length === 0
      ? null
      : Math.min(...passed.map((level) => Math.abs(level.referenceHeightMm))),
    worstPassedErrorMm: Number.isFinite(worstPassedErrorMm) ? worstPassedErrorMm : null,
    analyzedAt: Date.now()
  };
}

/** Milliseconds since the calibration was taken. */
export function calibrationAge(calibration, nowMs = Date.now()) {
  return Number.isFinite(calibration?.calibratedAt) ? nowMs - calibration.calibratedAt : null;
}

/**
 * May this calibration produce a depth at the requested precision?
 *
 * @param requiredResolutionMm the step size the caller intends to act on.
 *        Asking for 10 mm from a setup that only resolved 50 mm is refused.
 */
export function canDeriveWaterDepth(calibration, {
  requiredResolutionMm = null,
  nowMs = Date.now(),
  maxAgeMs = MAX_CALIBRATION_AGE_MS
} = {}) {
  if (!calibration) {
    return { allowed: false, reason: "較正がありません / no calibration" };
  }
  const validation = calibration.validation;
  if (!validation) {
    return {
      allowed: false,
      reason: "この較正には検証実験が紐づいていません。水深は表示できません。"
        + " / calibration carries no validating experiment; depth is not derivable"
    };
  }
  if (validation.resolvedStepMm === null) {
    return {
      allowed: false,
      reason: "検証実験ではどの段差も測定できませんでした（負の結果）。水深は導出できません。"
        + " / the validating experiment resolved no step size; depth is not derivable"
    };
  }
  if (requiredResolutionMm !== null && Number.isFinite(requiredResolutionMm)
    && requiredResolutionMm < validation.resolvedStepMm) {
    return {
      allowed: false,
      reason: `要求分解能 ${requiredResolutionMm}mm は実証済み分解能 ${validation.resolvedStepMm}mm より細かいため導出できません。`
        + ` / requested ${requiredResolutionMm} mm is finer than the demonstrated ${validation.resolvedStepMm} mm`
    };
  }
  const age = calibrationAge(calibration, nowMs);
  if (age === null || age > maxAgeMs) {
    return {
      allowed: false,
      reason: `較正が古すぎます（${age === null ? "不明" : Math.round(age / 3600000)}時間前、上限 ${Math.round(maxAgeMs / 3600000)}時間）。再較正してください。`
        + " / calibration is stale; re-calibrate"
    };
  }
  if (age < 0) {
    return { allowed: false, reason: "較正時刻が未来です / calibration timestamp is in the future" };
  }
  return { allowed: true, reason: "", resolutionMm: validation.resolvedStepMm };
}

/**
 * H(t) = H₀ + (Z(t) − Z₀), or a refusal.
 *
 * On success returns a water measurement in the shape the rest of the app
 * already uses, plus `uncertaintyMm` and `derivation` so the number can never
 * be displayed without its provenance.
 */
export function deriveWaterDepth(calibration, currentAltitudeMm, options = {}) {
  const gate = canDeriveWaterDepth(calibration, options);
  if (!gate.allowed) {
    return { measurement: null, allowed: false, reason: gate.reason };
  }
  if (!Number.isFinite(currentAltitudeMm)) {
    return { measurement: null, allowed: false, reason: "現在のGNSS標高がありません / no current altitude" };
  }

  const deltaMm = currentAltitudeMm - calibration.baselineAltitudeMm;
  const depthMm = calibration.knownDepthMm + deltaMm;
  const measuredAt = options.nowMs ?? Date.now();

  return {
    allowed: true,
    reason: "",
    measurement: buildWaterMeasurement({
      valueMm: depthMm,
      source: "qz1-float",
      measuredAt,
      reference: calibration.reference
    }),
    // The uncertainty is the tolerance the validating experiment actually
    // cleared, NOT the arithmetic precision of the subtraction above.
    uncertaintyMm: calibration.validation.worstPassedErrorMm ?? calibration.validation.toleranceMm,
    derivation: {
      formula: calibration.formula,
      baselineAltitudeMm: calibration.baselineAltitudeMm,
      currentAltitudeMm,
      deltaMm,
      knownDepthMm: calibration.knownDepthMm,
      demonstratedResolutionMm: gate.resolutionMm,
      experimentId: calibration.experimentId,
      deviceId: calibration.deviceId,
      calibratedAt: calibration.calibratedAt
    }
  };
}

/**
 * What the UI is allowed to print, as three separate strings.
 *
 * The brief is explicit that GNSS altitude, relative displacement and
 * calibrated depth must be distinguishable on screen. Returning them as
 * separate labelled fields — with `depth` null and `depthBlockedReason` set
 * whenever derivation is refused — makes it hard to render them as one
 * number by accident.
 */
export function describeForDisplay({ rawAltitudeMm, filteredAltitudeMm, baselineAltitudeMm, calibration, options = {} }) {
  const displacementMm = Number.isFinite(filteredAltitudeMm) && Number.isFinite(baselineAltitudeMm)
    ? filteredAltitudeMm - baselineAltitudeMm
    : null;

  const derived = calibration
    ? deriveWaterDepth(calibration, filteredAltitudeMm, options)
    : { measurement: null, allowed: false, reason: "較正がありません / no calibration" };

  return {
    rawAltitudeMm: Number.isFinite(rawAltitudeMm) ? rawAltitudeMm : null,
    filteredAltitudeMm: Number.isFinite(filteredAltitudeMm) ? filteredAltitudeMm : null,
    relativeDisplacementMm: displacementMm,
    depthMm: derived.allowed ? derived.measurement.valueMm : null,
    depthUncertaintyMm: derived.allowed ? derived.uncertaintyMm : null,
    depthBlockedReason: derived.allowed ? null : derived.reason
  };
}
