// Daily water loss from a paddy: evapotranspiration + percolation.
//
// THIS IS THE SECOND OF TWO NUMBERS, AND THEY MUST NEVER BE ADDED TOGETHER
// INTO ONE CONFIDENT FIGURE.
//
//   1. Standing-water adjustment (water-recommendation.js)
//        volume = area x depth change.  Pure geometry. EXACT.
//   2. Daily loss (this file)
//        ETc + percolation.  A RANGE, and an uncertain one.
//
// Merging them would take an exact number and an estimate with a stated error
// bar of several mm/day and present the sum as though the whole thing were
// measured. The literature is unusually explicit that this would be false
// precision:
//
//   - 華山 謙 (1964)「減水深法の再検討」農業土木研究 32(1):15-23,
//     DOI 10.11408/jjsidre1929.32.15 -- concludes that estimating a region's
//     水必要量 by the 減水深 method carries an unavoidable error of about
//     +/-3 mm/day, and that the conventional practice of treating a sample
//     mean as the area's requirement is not sound.
//   - 福本昌人・進藤惣治 (2019) -- across 851 surveyed fields the coefficient
//     of variation of 期別減水深 was 70.6-79.4.
//
// So: percolation is presented as a RANGE with its source, ETc is computed from
// this field's own live weather, and the caller shows them as separate lines.
//
// UNITS: mm/day throughout, because 1 mm over 1 m2 = 1 L (see
// water-recommendation.js). Area only converts a rate into a volume.

import { growthStageRule, isDrainageStage } from "./growth-stage-model.js";

/**
 * FAO-56 single crop coefficients for RICE, Table 12.
 * Allen, R.G., Pereira, L.S., Raes, D., Smith, M. (1998),
 * "Crop evapotranspiration -- Guidelines for computing crop water
 * requirements", FAO Irrigation and Drainage Paper 56, ISBN 92-5-104219-5.
 *
 * Verbatim from Table 12: Kc_ini 1.05, Kc_mid 1.20, Kc_end 0.90-0.60
 * (maximum crop height 1 m). The 0.90/0.60 pair is FAO's own range for the end
 * of the late season depending on whether the field is kept ponded or drained;
 * we use 0.90 while ponded and 0.60 approaching drainage.
 *
 * Mapping FAO's four periods onto this app's growth stages is a project
 * decision, not FAO's -- recorded here rather than buried in a lookup.
 */
export const RICE_KC = {
  initial: 1.05,
  mid: 1.20,
  endPonded: 0.90,
  endDrained: 0.60
};

/** Growth stage -> Kc, following FAO 56's initial/development/mid/late periods. */
export const STAGE_KC = {
  pre_transplant: RICE_KC.initial,
  after_transplanting: RICE_KC.initial,
  establishment: RICE_KC.initial,
  // Development period ramps from Kc_ini toward Kc_mid; tillering sits in it.
  tillering: (RICE_KC.initial + RICE_KC.mid) / 2,
  midseason_drainage: RICE_KC.mid,
  panicle_initiation: RICE_KC.mid,
  booting: RICE_KC.mid,
  heading_flowering: RICE_KC.mid,
  ripening: RICE_KC.endPonded,
  final_drainage: RICE_KC.endDrained
};

/**
 * Percolation (降下浸透量) range, mm/day.
 *
 * NOT computed -- deliberately. Percolation is set by this paddy's own soil
 * texture, plough-pan condition, groundwater level and drainage, none of which
 * the app knows. What it CAN do is state the range Japanese paddy fields
 * ordinarily fall in, name the source, and make clear the figure is not
 * specific to this field.
 *
 * The 5-20 mm/day span reflects MAFF's own classification of paddy fields by
 * 透水条件 in 土地改良事業計画設計基準・設計「農業用水（水田）」§7, where
 * appropriate percolation is treated as a design target varying with soil and
 * hydraulic conditions rather than a constant.
 */
export const PERCOLATION_RANGE_MM_PER_DAY = {
  minMm: 5,
  maxMm: 20,
  typicalMm: 12,
  sourceId: "maffCultivation",
  noteJa: "浸透量は土壌・耕盤・地下水位で大きく変わるため、この圃場の実測値ではなく一般的な範囲です。",
  noteEn: "Percolation varies widely with soil, plough pan and groundwater; this is a general range, not a measurement of this field."
};

/**
 * The irreducible uncertainty in any 減水深-based estimate, per 華山 (1964).
 * Carried as data so the UI can state it rather than implying precision.
 */
export const ESTIMATION_ERROR_MM_PER_DAY = 3;

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** Kc for a stage; unknown stages get null rather than a plausible default. */
export function kcForStage(stageId) {
  return Object.prototype.hasOwnProperty.call(STAGE_KC, stageId) ? STAGE_KC[stageId] : null;
}

/**
 * ETc = Kc x ETo  (FAO 56, Chapter 6).
 * `eto` is FAO-56 reference evapotranspiration in mm/day -- Open-Meteo returns
 * exactly this as `et0_fao_evapotranspiration`, so no ETo model is
 * reimplemented here.
 */
export function cropEvapotranspiration(etoMmPerDay, stageId) {
  const kc = kcForStage(stageId);
  if (!isFiniteNumber(etoMmPerDay) || etoMmPerDay < 0 || kc === null) {
    return null;
  }
  return etoMmPerDay * kc;
}

/**
 * Daily loss for one field, as a RANGE.
 *
 * @param {object} input
 * @param {number} [input.etoMmPerDay] FAO-56 reference ET for this location
 * @param {string} [input.growthStage]
 * @param {number} [input.areaM2]      only used to express the range as volume
 * @returns {object} always defined; every numeric field is null when unknown
 */
export function estimateDailyLoss({ etoMmPerDay, growthStage, areaM2 } = {}) {
  const rule = growthStageRule(growthStage);
  const kc = kcForStage(rule.id);
  const etc = cropEvapotranspiration(etoMmPerDay, rule.id);
  const hasArea = isFiniteNumber(areaM2) && areaM2 > 0;

  // A field being deliberately dried is not being topped up, so reporting a
  // daily replacement requirement for it would invite exactly the wrong action.
  if (isDrainageStage(rule.id)) {
    return {
      applicable: false,
      reasonJa: `${rule.labelJa}は落水期間のため、日々の減水量の補給は行いません。`,
      reasonEn: `${rule.labelEn} is a drainage period; daily replacement is not applicable.`,
      etoMmPerDay: isFiniteNumber(etoMmPerDay) ? etoMmPerDay : null,
      kc, etcMmPerDay: etc,
      percolation: PERCOLATION_RANGE_MM_PER_DAY,
      minMmPerDay: null, maxMmPerDay: null,
      minM3PerDay: null, maxM3PerDay: null,
      errorMmPerDay: ESTIMATION_ERROR_MM_PER_DAY,
      areaM2: hasArea ? areaM2 : null
    };
  }

  const minMm = etc === null ? null : etc + PERCOLATION_RANGE_MM_PER_DAY.minMm;
  const maxMm = etc === null ? null : etc + PERCOLATION_RANGE_MM_PER_DAY.maxMm;

  return {
    applicable: true,
    reasonJa: null,
    reasonEn: null,
    etoMmPerDay: isFiniteNumber(etoMmPerDay) ? etoMmPerDay : null,
    kc,
    etcMmPerDay: etc,
    percolation: PERCOLATION_RANGE_MM_PER_DAY,
    minMmPerDay: minMm,
    maxMmPerDay: maxMm,
    // 1 mm over 1 m2 = 1 L, so mm/day * m2 = L/day, / 1000 = m3/day.
    minM3PerDay: hasArea && minMm !== null ? (areaM2 * minMm) / 1000 : null,
    maxM3PerDay: hasArea && maxMm !== null ? (areaM2 * maxMm) / 1000 : null,
    errorMmPerDay: ESTIMATION_ERROR_MM_PER_DAY,
    areaM2: hasArea ? areaM2 : null
  };
}

/**
 * Volume per 10 mm of depth change, for a field with NO measurement yet.
 *
 * This is the honest answer to "how much water does this field need?" before
 * anyone has looked at it: the app cannot know the deficit without knowing the
 * current level, but the CONVERSION RATE depends only on area, which the QZ1
 * survey already established. The farmer multiplies by whatever depth they can
 * see. Nothing is assumed about the current level.
 */
export function volumePerTenMm(areaM2) {
  if (!isFiniteNumber(areaM2) || areaM2 <= 0) {
    return null;
  }
  return {
    depthMm: 10,
    liters: areaM2 * 10,
    m3: (areaM2 * 10) / 1000,
    areaM2
  };
}
