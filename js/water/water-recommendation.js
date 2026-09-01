// The paddy water-management recommendation engine: pure, DOM-free, and the
// only place the mm -> L -> m³ conversion is allowed to happen.
//
// Input:  field area (m²), growth stage (id), a water-depth measurement record
// Output: target range, status, depth difference, theoretical standing-water
//         adjustment volume, a recommendation sentence, and the provenance of
//         every number in it.
//
// TWO QUANTITIES THAT MUST NEVER BE CONFLATED
//
// 1. Standing-water adjustment (what this engine returns as
//    `standingWaterAdjustment`, shown as 理論追加水量):
//       volume = area x depth change
//    Pure geometry. It answers "how much water would raise this field from the
//    measured depth to the target depth, if nothing were lost".
//
// 2. Real irrigation requirement (NOT returned as a number here):
//    additionally covers percolation/infiltration, evapotranspiration,
//    rainfall, runoff/drainage, soil properties, field levelling and
//    irrigation efficiency. The NARO 851-field survey shows how large and how
//    variable those daily losses are (see WATER_REQUIREMENT_REFERENCE), which
//    is exactly why this engine refuses to fold a research average into (1)
//    and hand the result back as if it were a field-specific irrigation plan.
//
// UNITS, spelled out once: depth is mm, area is m², and
//     1 mm over 1 m² = 1 L,  so  L = areaM2 * depthMm  and  m³ = L / 1000.
// The engine returns unrounded volumes; rounding is a formatting decision and
// belongs to the caller (formatVolumeRange() below is provided for the UI).

import {
  WATER_REQUIREMENT_REFERENCE,
  resolveSources,
  verificationLabel
} from "./water-management-sources.js";

import {
  growthStageRule,
  hasNumericTarget,
  isDrainageStage,
  managementMode,
  normalizeGrowthStageId,
  UNKNOWN_STAGE_ID
} from "./growth-stage-model.js";
import {
  hasStoredDepthValue,
  measurementAge,
  mmToCm,
  normalizeWaterMeasurement,
  storedDepthMm
} from "./water-measurement.js";

// Re-exported so the UI has ONE import surface for "everything needed to
// render a recommendation and its provenance".
export { verificationLabel };

export const STATUS = {
  unknownStage: "unknown-stage",
  noNumericTarget: "no-numeric-target",
  missingMeasurement: "missing-measurement",
  unreadableMeasurement: "unreadable-measurement",
  belowRange: "below-range",
  withinRange: "within-range",
  aboveRange: "above-range"
};

/** Depth differences smaller than this are treated as "at the range edge". */
export const DEPTH_EPSILON_MM = 1;

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// ---------------------------------------------------------------------------
// The physical conversion. Two lines of arithmetic, isolated and named, so no
// other file ever has to remember whether the factor is 10, 100 or 1000.
// ---------------------------------------------------------------------------

/** Litres needed to change the standing-water depth of `areaM2` by `depthMm`. */
export function litersForDepthChange(areaM2, depthMm) {
  if (!isFiniteNumber(areaM2) || areaM2 <= 0 || !isFiniteNumber(depthMm)) {
    return null;
  }
  return areaM2 * depthMm;
}

/** Cubic metres for the same change (1 m³ = 1000 L). */
export function cubicMetersForDepthChange(areaM2, depthMm) {
  const liters = litersForDepthChange(areaM2, depthMm);
  return liters === null ? null : liters / 1000;
}

// ---------------------------------------------------------------------------
// Recommendation
// ---------------------------------------------------------------------------

/**
 * @param {object} input
 * @param {number} [input.areaM2]        field area, m² (from field.properties.areaM2)
 * @param {string} [input.growthStage]   growth-stage id; anything unknown -> unknown stage
 * @param {object} [input.measurement]   measurement record OR legacy { valueCm, recordedAt }
 * @param {number} [input.now]           epoch ms, for staleness
 */
export function evaluateWaterManagement({
  areaM2,
  growthStage,
  measurement: rawMeasurement,
  now = Date.now()
} = {}) {
  const stageId = normalizeGrowthStageId(growthStage);
  const rule = growthStageRule(stageId);
  const mode = managementMode(rule.mode);
  const measurement = normalizeWaterMeasurement(rawMeasurement);
  const { ageDays, isStale } = measurementAge(measurement, now);
  const hasArea = isFiniteNumber(areaM2) && areaM2 > 0;

  const missingInputs = [];
  if (!hasArea) missingInputs.push("areaM2");
  if (stageId === UNKNOWN_STAGE_ID) missingInputs.push("growthStage");
  if (!measurement) missingInputs.push("measurement");

  const target = {
    stage: stageId,
    targetMinMm: rule.targetMinMm,
    targetMaxMm: rule.targetMaxMm,
    mode: rule.mode,
    modeLabelJa: mode.labelJa,
    modeLabelEn: mode.labelEn,
    sourceIds: rule.sourceIds.slice(),
    confidence: rule.confidence,
    noteJa: rule.noteJa,
    noteEn: rule.noteEn,
    conditional: Array.isArray(rule.conditional) ? rule.conditional.slice() : []
  };

  const base = {
    stage: {
      id: stageId,
      labelJa: rule.labelJa,
      labelEn: rule.labelEn
    },
    target,
    areaM2: hasArea ? areaM2 : null,
    measurement,
    measurementAgeDays: ageDays,
    isStale,
    differenceMm: null,
    deficitMinMm: null,
    deficitMaxMm: null,
    excessMm: null,
    standingWaterAdjustment: null,
    missingInputs,
    sources: resolveSources(rule.sourceIds),
    waterRequirementReference: WATER_REQUIREMENT_REFERENCE,
    caveatJa: REAL_REQUIREMENT_CAVEAT_JA,
    caveatEn: REAL_REQUIREMENT_CAVEAT_EN
  };

  // 1. No stage -> ask for the stage. Never guess one from area, month or
  //    anything else, and never fall through to a numeric comparison.
  if (stageId === UNKNOWN_STAGE_ID) {
    return {
      ...base,
      status: STATUS.unknownStage,
      statusLabelJa: "生育ステージ未設定",
      statusLabelEn: "Growth stage not set",
      recommendationJa: "生育ステージを選択すると、その時期の参考水深と必要水量を表示します。圃場面積からは水深を決められません。",
      recommendationEn: "Select the growth stage to see the reference depth and water volume for that period. Water depth cannot be derived from field area."
    };
  }

  // 2. Stage known, but the literature does not support a numeric target for
  //    it (中干し / 落水 / 登熟期の飽水管理 / 移植前の代かき). Returning a
  //    "fill to X mm" number here would be both invented and, for the two
  //    drainage stages, the opposite of the correct action -- so the engine
  //    reports the management state and stops. This branch is why a missing
  //    numeric target can never be read as "0 mm, so add water".
  if (!hasNumericTarget(stageId)) {
    const drainage = isDrainageStage(stageId);
    return {
      ...base,
      status: STATUS.noNumericTarget,
      statusLabelJa: drainage ? "落水・干し期間" : "管理状態で判断する時期",
      statusLabelEn: drainage ? "Drainage period" : "Managed by state, not by depth",
      recommendationJa: drainage
        ? `${rule.labelJa}のため、入水量の推奨は行いません。${rule.noteJa}`
        : `${rule.labelJa}は目標水深ではなく管理状態（${mode.labelJa}）で判断します。${rule.noteJa}`,
      recommendationEn: drainage
        ? `${rule.labelEn}: no fill recommendation is made. ${rule.noteEn}`
        : `${rule.labelEn} is managed by state (${mode.labelEn}) rather than by a target depth. ${rule.noteEn}`
    };
  }

  const rangeLabel = `${rule.targetMinMm}〜${rule.targetMaxMm} mm`;

  // 3. A value IS stored for this field, but this model cannot interpret it.
  //    Reporting "水位未記録" here would be a false statement about the farmer's
  //    own data, so it is named and a re-record is asked for.
  //
  //    A negative depth used to land here. It no longer does: with an explicit
  //    datum, -150 mm is a valid safe-AWD reading and flows through the normal
  //    comparison below. What reaches this branch now is an entry naming a
  //    datum this build does not know -- which must NOT be silently re-read
  //    against the soil surface, because a reading interpreted against the
  //    wrong datum is wrong by the size of the offset between them and looks
  //    perfectly plausible on screen.
  if (!measurement && hasStoredDepthValue(rawMeasurement)) {
    const storedMm = storedDepthMm(rawMeasurement);
    return {
      ...base,
      status: STATUS.unreadableMeasurement,
      statusLabelJa: "保存値を解釈できません",
      statusLabelEn: "Stored reading cannot be interpreted",
      storedDepthMm: storedMm,
      recommendationJa: `この圃場には ${formatMm(storedMm)} mm（${mmToCm(storedMm)} cm）が保存されていますが、基準面が不明なため解釈できません。現在の水位を記録し直してください。※ 今日の水門判断は同じ値を別の前提で計算するため、表示が食い違うことがあります。`,
      recommendationEn: `A value of ${formatMm(storedMm)} mm (${mmToCm(storedMm)} cm) is stored for this field, but it names a datum this model does not know, so it cannot be interpreted. Please re-record the current level. Note that 今日の水門判断 computes from the same value under different assumptions, so the two displays can disagree.`
    };
  }

  // 4. Numeric target exists but nothing has been measured. No zero, no NaN,
  //    no "0 mm below the range" -- an explicit request for a reading.
  if (!measurement) {
    return {
      ...base,
      status: STATUS.missingMeasurement,
      statusLabelJa: "水位未記録",
      statusLabelEn: "No measurement recorded",
      recommendationJa: `${rule.labelJa}の参考水深は ${rangeLabel}（${mode.labelJa}）です。現在の水位を記録すると、参考範囲との差と理論追加水量を計算します。`,
      recommendationEn: `The reference depth for ${rule.labelEn} is ${rangeLabel} (${mode.labelEn}). Record the current water level to get the difference from the range and the theoretical volume.`
    };
  }

  // SIGNED ARITHMETIC -- audited, and deliberately written without Math.abs()
  // or any clamp. `currentMm` may be negative (water table below the soil
  // surface; safe AWD's threshold is -150 mm), and both differences below stay
  // correct across zero because they are plain subtractions:
  //
  //   target 30-50 mm, measured  +40 mm -> belowBy -10, aboveBy -10  -> within
  //   target 30-50 mm, measured    0 mm -> belowBy  30               -> below by 30-50
  //   target 30-50 mm, measured -150 mm -> belowBy 180, deficitMax 200
  //
  // Introducing Math.abs(currentMm) here would turn -150 mm into +150 mm and
  // report a field that needs 180 mm of water as one that is 100 mm too deep.
  // Clamping to 0 would under-report the deficit by exactly the sub-surface
  // depth. Neither is a rounding difference; both invert the advice.
  const currentMm = measurement.valueMm;
  const belowBy = rule.targetMinMm - currentMm;
  const aboveBy = currentMm - rule.targetMaxMm;

  // 5a. Below the range: report the deficit as a RANGE (to the bottom and to
  //     the top of the target range), and the volume that range implies.
  if (belowBy >= DEPTH_EPSILON_MM) {
    const deficitMinMm = belowBy;
    const deficitMaxMm = rule.targetMaxMm - currentMm;
    return {
      ...base,
      status: STATUS.belowRange,
      statusLabelJa: `参考範囲より ${formatMm(deficitMinMm)}〜${formatMm(deficitMaxMm)} mm 低い`,
      statusLabelEn: `${formatMm(deficitMinMm)}-${formatMm(deficitMaxMm)} mm below reference range`,
      differenceMm: -deficitMinMm,
      deficitMinMm,
      deficitMaxMm,
      standingWaterAdjustment: buildAdjustment("add", areaM2, deficitMinMm, deficitMaxMm),
      recommendationJa: `現在の水位は${rule.labelJa}の参考範囲（${rangeLabel}）を下回っています。${mode.labelJa}の範囲まで入水することを検討してください。実際の必要用水量は、浸透・蒸発散・降雨・通水ロスにより下記の理論値と異なります。`,
      recommendationEn: `Water level is below the reference range (${rangeLabel}) for ${rule.labelEn}. Consider irrigating up into the ${mode.labelEn} range. Actual irrigation requirement will differ from the theoretical figure below because of percolation, evapotranspiration, rainfall and conveyance losses.`
    };
  }

  // 5b. Above the range: report the excess and the geometric volume it
  //     represents, but do NOT tell the farmer to drain -- this stage's rule
  //     is a standing-water target, not a drainage instruction, and rainfall
  //     may make the excess self-correcting.
  if (aboveBy >= DEPTH_EPSILON_MM) {
    return {
      ...base,
      status: STATUS.aboveRange,
      statusLabelJa: `参考範囲より ${formatMm(aboveBy)} mm 高い`,
      statusLabelEn: `${formatMm(aboveBy)} mm above reference range`,
      differenceMm: aboveBy,
      excessMm: aboveBy,
      standingWaterAdjustment: buildAdjustment("remove", areaM2, aboveBy, aboveBy),
      recommendationJa: `現在の水位は${rule.labelJa}の参考範囲（${rangeLabel}）を上回っています。入水は不要です。排水するかどうかは、この時期の管理方針・降雨予測・地域の指導をふまえて人が判断してください。本アプリは自動的な落水を推奨しません。`,
      recommendationEn: `Water level is above the reference range (${rangeLabel}) for ${rule.labelEn}. No irrigation is needed. Whether to drain is a human decision based on this period's management policy, the rain forecast and local guidance -- this app does not recommend automatic drainage.`
    };
  }

  // 5c. Inside the range (including within DEPTH_EPSILON_MM of either edge).
  return {
    ...base,
    status: STATUS.withinRange,
    statusLabelJa: "参考範囲内",
    statusLabelEn: "Within reference range",
    differenceMm: 0,
    standingWaterAdjustment: buildAdjustment("hold", areaM2, 0, 0),
    recommendationJa: `現在の水位は推奨範囲内です。${rule.labelJa}の参考範囲（${rangeLabel}）を保ってください。追加の入水は必要ありません。`,
    recommendationEn: `Water level is within the recommended range. Hold the reference range (${rangeLabel}) for ${rule.labelEn}. No additional water is required.`
  };
}

export const REAL_REQUIREMENT_CAVEAT_JA =
  "理論追加水量は「圃場面積 × 水深差」の幾何計算です。実際の必要用水量は、浸透・漏水、蒸発散、降雨、排水・かけ流し、土壌条件、均平度、通水効率によって変わります。";
export const REAL_REQUIREMENT_CAVEAT_EN =
  "The theoretical volume is the geometric product of field area and depth change. Actual irrigation requirement differs with infiltration/percolation, evapotranspiration, rainfall, drainage/runoff, soil properties, field levelling and irrigation efficiency.";

/**
 * The standing-water adjustment block. `direction` is a description of the
 * geometry ("which way would the level have to move"), never an instruction
 * to open or close a gate -- gate operation stays with evaluateGate() and,
 * ultimately, with the farmer.
 */
function buildAdjustment(direction, areaM2, minDepthMm, maxDepthMm) {
  const hasArea = isFiniteNumber(areaM2) && areaM2 > 0;
  return {
    direction,
    minDepthMm,
    maxDepthMm,
    minLiters: hasArea ? litersForDepthChange(areaM2, minDepthMm) : null,
    maxLiters: hasArea ? litersForDepthChange(areaM2, maxDepthMm) : null,
    minM3: hasArea ? cubicMetersForDepthChange(areaM2, minDepthMm) : null,
    maxM3: hasArea ? cubicMetersForDepthChange(areaM2, maxDepthMm) : null,
    areaKnown: hasArea
  };
}

/** Whole mm when whole, one decimal otherwise -- "12" not "12.0". */
export function formatMm(valueMm) {
  if (!isFiniteNumber(valueMm)) {
    return "—";
  }
  const rounded = Math.round(valueMm * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** "18 mm (1.8 cm)" -- the readability pairing the water card shows. */
export function formatDepthWithCm(valueMm) {
  if (!isFiniteNumber(valueMm)) {
    return "—";
  }
  return `${formatMm(valueMm)} mm (${mmToCm(valueMm)} cm)`;
}

/**
 * "25.7〜68.6 m³" / "60 m³" for the m³ line, and the same for litres with
 * thousands separators. A single value collapses instead of printing "60〜60".
 */
export function formatVolumeRange(minValue, maxValue, { unit = "m³", digits = 1 } = {}) {
  if (!isFiniteNumber(minValue) || !isFiniteNumber(maxValue)) {
    return "—";
  }
  const format = (value) => {
    const rounded = Number(value.toFixed(digits));
    return rounded.toLocaleString("ja-JP", { maximumFractionDigits: digits });
  };
  const low = format(Math.min(minValue, maxValue));
  const high = format(Math.max(minValue, maxValue));
  return low === high ? `${low} ${unit}` : `${low}〜${high} ${unit}`;
}
