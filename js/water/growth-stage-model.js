// Growth-stage -> target water depth model (pure data + lookups, no DOM).
//
// THE ONE SCIENTIFIC RULE THIS FILE ENCODES:
//
//     growth stage + management conditions  ->  target water depth
//     field area x required depth change    ->  required water volume
//
// Field AREA never appears in this file. A 2ha paddy and a 2a paddy at the
// same growth stage get the same target depth; only the volume needed to
// change that depth differs, and that is water-recommendation.js's job.
//
// Depth unit is MILLIMETRES everywhere in this module, because that is the
// unit the physical conversion is defined in (1mm over 1m² = 1L). cm is a
// display concern only.
//
// Every numeric range in this file is traceable to a source that was fetched
// and read (see js/water/water-management-sources.js, `verification`), and is
// annotated with the wording it came from. Where the verified guidance manages
// a period by STATE rather than by depth -- 中干し and 落水 (drainage), 登熟期
// (intermittent/saturated), 幼穂形成期 and 穂ばらみ期 (intermittent irrigation,
// with deep water only as a stated cold-weather exception), and the
// pre-transplant preparation period, whose depth follows the puddling work
// rather than the crop -- the rule carries `null` targets and a management
// MODE instead. Inventing a number for those stages would be fabrication, and
// for the two drainage stages it would make the engine tell a farmer to fill a
// field it is supposed to be drying.
//
// `conditional` entries are alternative managements that apply only under a
// stated condition (currently low temperature). They are surfaced to the
// farmer as information; the engine never auto-selects them, because this app
// has no reliable per-field temperature history to select them WITH. That is
// the hook a future weather/forecast integration plugs into.

import { CONFIDENCE_LEVELS } from "./water-management-sources.js";

/** Management modes, matching NARO smart-water-management's mode concept. */
export const MANAGEMENT_MODES = {
  flooded_preparation: { id: "flooded_preparation", labelJa: "代かき・整地に合わせた湛水", labelEn: "Flooded for puddling / levelling" },
  slightly_deep: { id: "slightly_deep", labelJa: "やや深水管理", labelEn: "Slightly deep water" },
  shallow: { id: "shallow", labelJa: "浅水管理", labelEn: "Shallow water" },
  flooded: { id: "flooded", labelJa: "湛水管理", labelEn: "Constant flooding" },
  intermittent: { id: "intermittent", labelJa: "間断灌漑", labelEn: "Intermittent irrigation" },
  saturated: { id: "saturated", labelJa: "飽水管理", labelEn: "Saturated (no standing water target)" },
  deep: { id: "deep", labelJa: "深水管理", labelEn: "Deep water" },
  drain_dry: { id: "drain_dry", labelJa: "落水・干し", labelEn: "Drain / dry" },
  unknown: { id: "unknown", labelJa: "未設定", labelEn: "Not set" }
};

export function managementMode(modeId) {
  return MANAGEMENT_MODES[modeId] || MANAGEMENT_MODES.unknown;
}

export const UNKNOWN_STAGE_ID = "unknown";

/**
 * The stage table. Order is the cultivation-calendar order, so a <select>
 * built from this reads the way a farmer thinks about the season.
 *
 * targetMinMm/targetMaxMm === null means "no defensible numeric target for
 * this stage" -- NOT "0 mm" and NOT "unknown data". The engine treats those
 * two cases differently and so must every caller.
 */
export const GROWTH_STAGES = [
  {
    id: "pre_transplant",
    labelJa: "移植前（代かき・整地）",
    labelEn: "Pre-transplant / preparation",
    mode: "flooded_preparation",
    targetMinMm: null,
    targetMaxMm: null,
    sourceIds: ["naroSmartWater", "maffCultivation"],
    confidence: CONFIDENCE_LEVELS.managementState.id,
    noteJa: "水深は代かき・整地作業の進み方に合わせて決まるため、作物側からの目標水深はありません。作業計画に従ってください。",
    noteEn: "Depth follows the puddling/levelling work rather than the crop, so there is no crop-side target depth. Follow the work plan."
  },
  {
    id: "after_transplanting",
    labelJa: "移植直後",
    labelEn: "Immediately after transplanting",
    mode: "slightly_deep",
    // 図説：生育時期別の一般的な水管理（活着期）:「日中止水で３〜４ｃｍの浅水
    // とし，水温を上昇させ，夜間は５ｃｍ程度の水深にする」-> 30-50mm.
    targetMinMm: 30,
    targetMaxMm: 50,
    sourceIds: ["naroGeneralWaterManagement", "irriWaterManagement"],
    confidence: CONFIDENCE_LEVELS.reference.id,
    noteJa: "活着を早めるため水温を高く保ちます。出典は日中３〜４cm・夜間５cm程度としています。適正水深は苗丈に依存し、苗が水没する深さは避けてください。",
    noteEn: "Water depth is used to keep water temperature up so the crop establishes quickly; the source gives 3-4cm by day and about 5cm at night. The right depth depends on seedling height -- never deep enough to submerge them.",
    conditional: [
      {
        conditionJa: "低温に風が加わるとき",
        conditionEn: "Under low temperature combined with wind",
        mode: "deep",
        sourceIds: ["naroGeneralWaterManagement"],
        noteJa: "低温に風が加わると植え傷み・枯死のおそれがあるため、出典は「苗丈の４分の３程度が浸かる程度の深水」で苗を保護するとしています。",
        noteEn: "Low temperature plus wind risks transplanting damage, so the source advises deep water covering about three quarters of the seedling height to protect them."
      }
    ]
  },
  {
    id: "establishment",
    labelJa: "活着期",
    labelEn: "Establishment",
    mode: "slightly_deep",
    targetMinMm: 30,
    targetMaxMm: 50,
    sourceIds: ["naroGeneralWaterManagement", "naroTillering"],
    confidence: CONFIDENCE_LEVELS.reference.id,
    noteJa: "活着の適温は２５〜３０度とされ、水深の調節で水温をできるだけ高く保つ時期です。活着後は浅水管理に移します。",
    noteEn: "Establishment is favoured by 25-30C, and depth is used to hold water temperature as high as possible. Move to shallow-water management once the crop has established."
  },
  {
    id: "tillering",
    labelJa: "分げつ期",
    labelEn: "Tillering",
    mode: "shallow",
    // 図説：生育時期別の一般的な水管理（分げつ期）:「水深３ｃｍ前後の浅水管理」
    // -> encoded as a 3cm-centred band, not widened past what the source says.
    targetMinMm: 25,
    targetMaxMm: 35,
    sourceIds: ["naroGeneralWaterManagement", "naroTillering"],
    confidence: CONFIDENCE_LEVELS.reference.id,
    noteJa: "出典は「水深３ｃｍ前後の浅水管理」とし、日中は水温を高め夜間は低下させて日較差を大きくすることを基本としています。稲わら連用田や排水不良田では温暖な日に間断灌漑を行います。",
    noteEn: "The source gives shallow water of about 3cm, warming by day and cooling at night to widen the daily swing. On fields with repeated straw application or poor drainage, use intermittent irrigation on warm days.",
    conditional: [
      {
        conditionJa: "低温・強風時",
        conditionEn: "Under low temperature or strong wind",
        mode: "deep",
        sourceIds: ["naroTillering", "naroGeneralWaterManagement"],
        noteJa: "「分げつ形成期は、低温・強風時を除いて、水管理は浅水を基本とする」とされ、低温・強風時は浅水の原則から外れます。実施水深は地域の指示に従ってください。",
        noteEn: "Shallow water is the basis during tiller formation 'except under low temperature or strong wind', when the shallow-water rule does not apply. Follow local instructions for the actual depth."
      }
    ]
  },
  {
    id: "midseason_drainage",
    labelJa: "中干し",
    labelEn: "Mid-season drainage",
    mode: "drain_dry",
    targetMinMm: null,
    targetMaxMm: null,
    sourceIds: ["naroGeneralWaterManagement", "naroSmartWater"],
    confidence: CONFIDENCE_LEVELS.managementState.id,
    noteJa: "「目標茎数を確保したら，直ちに中干しに入る」時期です。程度の目安は田面に１ｃｍ以内の小ヒビが入る程度（足跡がつく程度）。この期間は入水量の推奨を行いません。",
    noteEn: "Mid-season drainage begins as soon as the target tiller count is reached; the guide of degree is cracks under 1cm in the soil surface. No fill recommendation is made during this period."
  },
  {
    id: "panicle_initiation",
    labelJa: "幼穂形成期",
    labelEn: "Panicle initiation",
    // The verified source manages this period by intermittent irrigation, not
    // by a standing depth -- so no numeric target is offered, even though this
    // is a high-water-demand stage. Inventing one here would be exactly the
    // fabrication the model exists to avoid.
    mode: "intermittent",
    targetMinMm: null,
    targetMaxMm: null,
    sourceIds: ["naroGeneralWaterManagement"],
    confidence: CONFIDENCE_LEVELS.managementState.id,
    noteJa: "中干し終了後は、水分と酸素を交互に供給する間断灌漑を行う時期です。一定の湛水深を目標にはしません。",
    noteEn: "After mid-season drainage, this period is managed with intermittent irrigation supplying water and oxygen alternately, rather than by holding a fixed depth.",
    conditional: [
      {
        conditionJa: "低温が予想されるとき（特に減数分裂期）",
        conditionEn: "When low temperature is forecast (especially at meiosis)",
        mode: "deep",
        sourceIds: ["naroGeneralWaterManagement"],
        noteJa: "この期間は低温による不稔障害を最も受けやすいため、出典は「低温が予想されるときは可能な限りの深水にして，幼穂を保護する」としています。",
        noteEn: "This period is the most vulnerable to cold-induced sterility, so the source advises flooding as deeply as possible to protect the young panicle when low temperature is forecast."
      }
    ]
  },
  {
    id: "booting",
    labelJa: "穂ばらみ期",
    labelEn: "Booting",
    mode: "intermittent",
    targetMinMm: null,
    targetMaxMm: null,
    sourceIds: ["naroGeneralWaterManagement"],
    confidence: CONFIDENCE_LEVELS.managementState.id,
    noteJa: "穂首分化期〜穂ばらみ期は間断灌漑で管理します。低温による不稔障害を最も受けやすい時期でもあります。落水は避けてください。",
    noteEn: "From panicle differentiation through booting the field is managed with intermittent irrigation. This is also the period most vulnerable to cold-induced sterility; do not drain.",
    conditional: [
      {
        conditionJa: "低温が予想されるとき（特に減数分裂期）",
        conditionEn: "When low temperature is forecast (especially at meiosis)",
        mode: "deep",
        sourceIds: ["naroGeneralWaterManagement"],
        noteJa: "「低温が予想されるときは可能な限りの深水にして，幼穂を保護する」とされています。実施水深は地域の指示に従ってください。",
        noteEn: "The source advises flooding as deeply as possible to protect the young panicle when low temperature is forecast. Follow local instructions for the depth."
      }
    ]
  },
  {
    id: "heading_flowering",
    labelJa: "出穂・開花期",
    labelEn: "Heading / flowering",
    mode: "flooded",
    // NARO: 穂ばらみ期〜開花期 is 「水分補給を重視した湛水（花水）」 but states no
    // depth. IRRI states one: keep flooded from a week before to a week after
    // flowering, "topping up to a depth of 5 cm as needed" -> a 5cm-centred
    // band. Both are cited, and the IRRI entry carries its own "international
    // guidance, not Japanese instruction" caveat.
    targetMinMm: 40,
    targetMaxMm: 60,
    sourceIds: ["naroGeneralWaterManagement", "irriWaterManagement"],
    confidence: CONFIDENCE_LEVELS.reference.id,
    noteJa: "出穂直後の穂は損傷を受けやすく、水分生理の乱れが開花・受精に影響するため、水分補給を重視した湛水（花水）とします。数値はIRRIの「約5cmまで補給して湛水を保つ」に基づく参考値です。",
    noteEn: "Panicles just after heading are easily damaged and water stress affects flowering and fertilisation, so the field is kept flooded. The numeric band follows IRRI's 'topping up to a depth of 5 cm as needed'."
  },
  {
    id: "ripening",
    labelJa: "登熟期",
    labelEn: "Ripening",
    mode: "saturated",
    targetMinMm: null,
    targetMaxMm: null,
    sourceIds: ["naroGeneralWaterManagement", "naroSmartWater"],
    confidence: CONFIDENCE_LEVELS.managementState.id,
    noteJa: "開花後は間断灌漑を行い、分枝根の発生と伸長を促して根の活力維持に努めます。一定の湛水深を目標にはしません。",
    noteEn: "After flowering, intermittent irrigation encourages branch-root development and keeps roots active. There is no single standing-water depth target."
  },
  {
    id: "final_drainage",
    labelJa: "落水期",
    labelEn: "Final drainage",
    mode: "drain_dry",
    targetMinMm: null,
    targetMaxMm: null,
    sourceIds: ["naroGeneralWaterManagement"],
    confidence: CONFIDENCE_LEVELS.managementState.id,
    noteJa: "落水時期は機械収穫を考慮して出穂後３０日が目安とされますが、収量・品質のためには遅いほど良いとされ、収穫日と土壌条件で決めます。入水量の推奨は行いません。",
    noteEn: "Final drainage is guided by about 30 days after heading for machine harvest, though later is better for yield and quality; decide from the harvest date and soil conditions. No fill recommendation is made."
  },
  {
    id: UNKNOWN_STAGE_ID,
    labelJa: "未設定・不明",
    labelEn: "Not set / unknown",
    mode: "unknown",
    targetMinMm: null,
    targetMaxMm: null,
    sourceIds: [],
    confidence: CONFIDENCE_LEVELS.unknown.id,
    noteJa: "生育ステージが選択されていないため、目標水深を提示できません。ステージを選択してください。",
    noteEn: "No growth stage selected, so no target depth can be offered. Please select a stage."
  }
];

const STAGES_BY_ID = new Map(GROWTH_STAGES.map((stage) => [stage.id, stage]));

export function isGrowthStageId(stageId) {
  return STAGES_BY_ID.has(stageId);
}

/**
 * Unknown / missing / non-string stage ids resolve to the explicit `unknown`
 * stage rather than to a plausible-looking default. Guessing "probably
 * tillering, it's August" would be exactly the fabrication this feature is
 * meant to avoid.
 */
export function normalizeGrowthStageId(stageId) {
  return isGrowthStageId(stageId) ? stageId : UNKNOWN_STAGE_ID;
}

/** The full rule for a stage id (always returns a rule; never null). */
export function growthStageRule(stageId) {
  return STAGES_BY_ID.get(normalizeGrowthStageId(stageId));
}

/** True when this stage's management is "get the water OUT / keep it out". */
export function isDrainageStage(stageId) {
  return growthStageRule(stageId).mode === "drain_dry";
}

/** True when the stage carries a numeric depth range we can compare against. */
export function hasNumericTarget(stageId) {
  const rule = growthStageRule(stageId);
  return Number.isFinite(rule.targetMinMm) && Number.isFinite(rule.targetMaxMm);
}

/**
 * Options for a stage <select>, unknown last so the calendar order reads
 * naturally and "未設定" is where a farmer expects a fallback to be.
 */
export function growthStageOptions() {
  return GROWTH_STAGES.map((stage) => ({
    value: stage.id,
    labelJa: stage.labelJa,
    labelEn: stage.labelEn,
    modeLabelJa: managementMode(stage.mode).labelJa
  }));
}

/**
 * Per-field growth-stage record. `source` exists for the same reason the
 * measurement record has one: manual selection is the MVP, and a later
 * implementation may derive the stage from transplanting date + variety +
 * accumulated temperature + a NARO/WAGRI growth-prediction API, at which
 * point that writer sets its own source and nothing else changes.
 *
 * `transplantedOn` is accepted and preserved (nullable ISO date string) so
 * the field that a future derivation needs can start being collected before
 * the derivation exists -- it is stored, never used to guess a stage here.
 */
export function buildGrowthStageRecord({
  stage,
  source = "manual",
  transplantedOn = null,
  variety = null,
  updatedAt = Date.now()
} = {}) {
  return {
    stage: normalizeGrowthStageId(stage),
    source: typeof source === "string" && source ? source : "manual",
    transplantedOn: typeof transplantedOn === "string" && transplantedOn ? transplantedOn : null,
    variety: typeof variety === "string" && variety ? variety : null,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now()
  };
}

/**
 * Normalizes whatever came out of storage. Accepts a bare stage-id string
 * (a plausible older/hand-edited shape) as well as the record object, and
 * never throws -- a corrupt entry degrades to the unknown stage, which the
 * UI then asks the farmer to fix.
 */
export function normalizeGrowthStageRecord(raw) {
  if (typeof raw === "string") {
    return buildGrowthStageRecord({ stage: raw, updatedAt: null });
  }
  if (!raw || typeof raw !== "object") {
    return null;
  }
  return buildGrowthStageRecord({
    stage: raw.stage,
    source: raw.source,
    transplantedOn: raw.transplantedOn,
    variety: raw.variety,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : null
  });
}
