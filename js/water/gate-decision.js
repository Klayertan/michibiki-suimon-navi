// The water-gate recommendation: 開ける / 閉める / 様子見.
//
// WHY THIS FILE EXISTS
// The gate verdict used to be computed from rainfall alone, in index.html,
// with no knowledge of the growth stage or the water level. That produced a
// verdict that could contradict the water card sitting next to it, and in one
// case produced actively harmful advice:
//
//   中干し (mid-season drainage), 5 dry days  ->  old logic said 開ける
//
// i.e. "open the gate and flood the field" during the period the field is
// deliberately being dried. 中干し exists to firm the soil, control excess
// tillers and re-oxygenate the root zone; flooding it defeats the practice, and
// during 落水期 it also costs the ground bearing capacity a combine needs.
//
// The fix is structural rather than a patch: ONE function owns the verdict, and
// it takes the growth stage, the water measurement and the weather together.
// Two surfaces reading one function cannot disagree.
//
// DECISION ORDER (first match wins; each rule states why it outranks the next)
//
//   1. Drainage stages          -> never 開ける, whatever else is true.
//   2. Heavy rain just fell     -> 閉める; the field is already being filled.
//   3. Water below target       -> 開ける; the crop's own need outranks a
//                                  forecast that may not arrive. Rain only
//                                  changes the TIMING wording.
//   4. Water above target       -> 様子見; never an automatic drain order.
//   5. No measurement           -> fall back to the rainfall-only reasoning,
//                                  clearly labelled as weather-only.
//
// Rule 3 over rule 5 is the substantive agronomic choice, and it is deliberate:
// a field genuinely short of water during 出穂・開花期 must not be left dry
// because rain was forecast. NARO's guidance treats water shortage around
// heading/flowering as one of the serious risks of the season.
//
// WHAT THIS FILE WILL NOT DO
// It never orders drainage. Whether to drain is a human decision about this
// season's management plan, and an app that tells a farmer to dump water has a
// much worse failure mode than one that says "check the field".

import { growthStageRule, hasNumericTarget, isDrainageStage } from "./growth-stage-model.js";

export const GATE_VERDICT = {
  open: "open",
  close: "close",
  hold: "hold"
};

export const GATE_BASIS = {
  drainageStage: "drainage-stage",
  heavyRain: "heavy-rain",
  waterLevel: "water-level",
  weatherOnly: "weather-only"
};

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * @param {object} input
 * @param {string} [input.growthStage]
 * @param {object} [input.measurement]  normalized measurement record, or null
 * @param {object} [input.weather]      { rain24hMm, daysSinceRain, forecastRainProbPct }
 * @param {object} [input.thresholds]   { heavyRain24hMm, lightRain24hMm, forecastRainProbPct, drySpellDays }
 */
export function decideGate({
  growthStage,
  measurement = null,
  weather = {},
  thresholds = {}
} = {}) {
  const rule = growthStageRule(growthStage);
  const th = {
    heavyRain24hMm: isFiniteNumber(thresholds.heavyRain24hMm) ? thresholds.heavyRain24hMm : 20,
    lightRain24hMm: isFiniteNumber(thresholds.lightRain24hMm) ? thresholds.lightRain24hMm : 5,
    forecastRainProbPct: isFiniteNumber(thresholds.forecastRainProbPct) ? thresholds.forecastRainProbPct : 60,
    drySpellDays: isFiniteNumber(thresholds.drySpellDays) ? thresholds.drySpellDays : 3
  };
  const rain24 = isFiniteNumber(weather.rain24hMm) ? weather.rain24hMm : 0;
  const daysSinceRain = isFiniteNumber(weather.daysSinceRain) ? weather.daysSinceRain : 0;
  const forecastProb = isFiniteNumber(weather.forecastRainProbPct) ? weather.forecastRainProbPct : 0;

  // ---- 1. Drainage stages: hard override -------------------------------
  // Placed FIRST on purpose. No weather reading and no water level may
  // override a period whose entire purpose is to have no water in the field.
  if (isDrainageStage(rule.id)) {
    return {
      verdict: GATE_VERDICT.close,
      label: "閉める（入水しない）",
      labelEn: "Keep closed (no irrigation)",
      basis: GATE_BASIS.drainageStage,
      stageOverride: true,
      timingJa: "落水期間中",
      reasonJa: `${rule.labelJa}のため、水門は開けません。${rule.noteJa}`,
      reasonEn: `${rule.labelEn}: do not open the gate. ${rule.noteEn}`
    };
  }

  // ---- 2. Heavy rain already fell --------------------------------------
  if (rain24 >= th.heavyRain24hMm) {
    return {
      verdict: GATE_VERDICT.close,
      label: "閉める",
      labelEn: "Close",
      basis: GATE_BASIS.heavyRain,
      stageOverride: false,
      timingJa: "今すぐ",
      reasonJa: `直近24時間で${rain24}mmのまとまった降雨がありました。用水は足りているため、水門を閉めて入水を止めます。`,
      reasonEn: `${rain24}mm of rain fell in the last 24 hours; the field is being filled already, so close the gate.`
    };
  }

  const hasTarget = hasNumericTarget(rule.id);
  const currentMm = measurement && isFiniteNumber(measurement.valueMm) ? measurement.valueMm : null;

  // ---- 3 & 4. Measured water level decides ------------------------------
  if (hasTarget && currentMm !== null) {
    const belowBy = rule.targetMinMm - currentMm;
    const aboveBy = currentMm - rule.targetMaxMm;

    if (belowBy > 0) {
      // Rain does not veto the crop's need -- it only moves the timing.
      const rainComing = forecastProb >= th.forecastRainProbPct;
      const someRain = rain24 >= th.lightRain24hMm;
      const timingJa = rainComing
        ? `降水確率${forecastProb}% — 降雨後に再確認`
        : (someRain ? "降雨分を見てから" : "今日中");
      return {
        verdict: GATE_VERDICT.open,
        label: "開ける",
        labelEn: "Open",
        basis: GATE_BASIS.waterLevel,
        stageOverride: false,
        timingJa,
        deficitMm: belowBy,
        reasonJa: `${rule.labelJa}の参考水深（${rule.targetMinMm}〜${rule.targetMaxMm}mm）に対し、現在の水位は${Math.round(belowBy)}mm不足しています。`
          + (rainComing
            ? `今後の降水確率が${forecastProb}%と高いため、入水量を控えめにするか降雨後に再確認してください。`
            : "水門を開けて入水してください。"),
        reasonEn: `Water is ${Math.round(belowBy)}mm below the reference range for ${rule.labelEn}.`
          + (rainComing ? ` Rain probability is ${forecastProb}%, so irrigate conservatively or re-check after the rain.` : " Open the gate.")
      };
    }

    if (aboveBy > 0) {
      return {
        verdict: GATE_VERDICT.hold,
        label: "様子見",
        labelEn: "Hold",
        basis: GATE_BASIS.waterLevel,
        stageOverride: false,
        timingJa: "入水不要",
        excessMm: aboveBy,
        reasonJa: `現在の水位は参考範囲を${Math.round(aboveBy)}mm上回っています。入水は不要です。排水するかどうかは、この時期の管理方針と降雨予測をふまえて判断してください。本アプリは自動的な落水を推奨しません。`,
        reasonEn: `Water is ${Math.round(aboveBy)}mm above the reference range. No irrigation needed. Whether to drain is a human decision; this app does not recommend automatic drainage.`
      };
    }

    return {
      verdict: GATE_VERDICT.hold,
      label: "様子見（適正）",
      labelEn: "Hold (within range)",
      basis: GATE_BASIS.waterLevel,
      stageOverride: false,
      timingJa: "入水不要",
      reasonJa: `現在の水位は${rule.labelJa}の参考範囲（${rule.targetMinMm}〜${rule.targetMaxMm}mm）内です。現状を維持してください。`,
      reasonEn: `Water is within the reference range for ${rule.labelEn}. Hold.`
    };
  }

  // ---- 5. No usable measurement: weather-only, and say so ---------------
  if (rain24 >= th.lightRain24hMm) {
    return {
      verdict: GATE_VERDICT.hold,
      label: "様子見",
      labelEn: "Hold",
      basis: GATE_BASIS.weatherOnly,
      stageOverride: false,
      timingJa: "水位の記録を推奨",
      reasonJa: `直近24時間で${rain24}mmの降雨があり、当面の水は確保できています。現状を維持します。※水位が未記録のため、気象のみでの判断です。`,
      reasonEn: `${rain24}mm of rain in the last 24 hours; hold. Note: no water level recorded, so this is a weather-only judgement.`
    };
  }
  if (forecastProb >= th.forecastRainProbPct) {
    return {
      verdict: GATE_VERDICT.hold,
      label: "様子見",
      labelEn: "Hold",
      basis: GATE_BASIS.weatherOnly,
      stageOverride: false,
      timingJa: "水位の記録を推奨",
      reasonJa: `今後24時間の降水確率が${forecastProb}%と高いため、開放は降雨の結果を見てから判断します。※水位が未記録のため、気象のみでの判断です。`,
      reasonEn: `Rain probability ${forecastProb}%; wait for the result before opening. Weather-only judgement (no water level recorded).`
    };
  }
  if (daysSinceRain >= th.drySpellDays) {
    return {
      verdict: GATE_VERDICT.open,
      label: "開ける",
      labelEn: "Open",
      basis: GATE_BASIS.weatherOnly,
      stageOverride: false,
      timingJa: "水位の記録を推奨",
      reasonJa: `無降雨が${daysSinceRain}日続いており、乾燥が進んでいます。水門を開けて入水してください。※水位が未記録のため、気象のみでの判断です。現地で水位を確認してください。`,
      reasonEn: `${daysSinceRain} days without rain; open the gate. Weather-only judgement -- check the actual water level on site.`
    };
  }
  return {
    verdict: GATE_VERDICT.hold,
    label: "様子見",
    labelEn: "Hold",
    basis: GATE_BASIS.weatherOnly,
    stageOverride: false,
    timingJa: "水位の記録を推奨",
    reasonJa: "しきい値に達した条件はありません。現状を維持します。※水位が未記録のため、気象のみでの判断です。",
    reasonEn: "No threshold reached; hold. Weather-only judgement (no water level recorded)."
  };
}
