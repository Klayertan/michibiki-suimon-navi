// Regional cultivation calendar -> a SUGGESTED growth stage.
//
// WHAT THIS IS FOR
// Picking a growth stage from a blank dropdown is friction a farmer should not
// have to pay every time they open the app. Japan's rice calendar is regionally
// standardised enough that the date plus the field's own latitude gives a
// sensible starting guess, which the farmer then corrects if their field is
// off-calendar.
//
// WHAT THIS IS NOT
// This is NOT a claim that the calendar knows the crop. A cold spring, a late
// transplant, a different variety or a double-cropped field all break it. So:
//
//   - Every result carries `source: "calendar"` and `confidence`, so the UI can
//     mark it 推定 rather than presenting it as observed fact.
//   - A farmer's manual choice ALWAYS wins and is never overwritten by a later
//     calendar evaluation (see manualOverridesCalendar() and its test).
//   - The stage this returns feeds the same growth-stage model as a manual
//     choice; it does not get its own privileged path or its own depth numbers.
//
// PRECEDENT: NARO's own smart water-management software ships「全国の典型的な
// 水管理暦に応じた7種類のテンプレート」-- seven regional water-management
// calendar templates -- and ties each period boundary to a developmental stage.
// Regionally-templated calendars are established practice, not an invention
// here. See docs/RESEARCH_REFERENCES.md (naroSmartWater).
//
// LIMITATION, stated in the data itself: these are typical windows for ordinary
// 一期作 (single-cropping) paddy rice. They are approximate by construction.

import { UNKNOWN_STAGE_ID } from "./growth-stage-model.js";

/**
 * Regions ordered north -> south, each with the latitude band it covers and a
 * transplanting-to-harvest calendar. Boundaries are the conventional 地方
 * divisions; the latitude cut-points are the approximate borders between them
 * and exist only so a field polygon can select a region without asking.
 *
 * `stages` maps a stage id to the [startMonthDay, endMonthDay] window in which
 * that stage is typical, as "MM-DD". Windows are contiguous and ordered.
 */
export const REGIONAL_CALENDARS = [
  {
    id: "hokkaido",
    labelJa: "北海道",
    labelEn: "Hokkaido",
    minLat: 41.4,
    maxLat: 46.0,
    // Cold region: late transplanting, early harvest.
    stages: [
      ["pre_transplant", "04-20", "05-19"],
      ["after_transplanting", "05-20", "05-31"],
      ["establishment", "06-01", "06-10"],
      ["tillering", "06-11", "07-05"],
      ["midseason_drainage", "07-06", "07-18"],
      ["panicle_initiation", "07-19", "07-31"],
      ["booting", "08-01", "08-10"],
      ["heading_flowering", "08-11", "08-22"],
      ["ripening", "08-23", "09-20"],
      ["final_drainage", "09-21", "10-05"]
    ]
  },
  {
    id: "tohoku",
    labelJa: "東北",
    labelEn: "Tohoku",
    minLat: 37.0,
    maxLat: 41.4,
    stages: [
      ["pre_transplant", "04-25", "05-14"],
      ["after_transplanting", "05-15", "05-26"],
      ["establishment", "05-27", "06-05"],
      ["tillering", "06-06", "07-05"],
      ["midseason_drainage", "07-06", "07-18"],
      ["panicle_initiation", "07-19", "07-31"],
      ["booting", "08-01", "08-10"],
      ["heading_flowering", "08-11", "08-22"],
      ["ripening", "08-23", "09-25"],
      ["final_drainage", "09-26", "10-10"]
    ]
  },
  {
    id: "hokuriku_kanto",
    labelJa: "北陸・関東",
    labelEn: "Hokuriku / Kanto",
    minLat: 35.6,
    maxLat: 37.0,
    stages: [
      ["pre_transplant", "04-20", "05-09"],
      ["after_transplanting", "05-10", "05-21"],
      ["establishment", "05-22", "05-31"],
      ["tillering", "06-01", "06-30"],
      ["midseason_drainage", "07-01", "07-13"],
      ["panicle_initiation", "07-14", "07-26"],
      ["booting", "07-27", "08-05"],
      ["heading_flowering", "08-06", "08-17"],
      ["ripening", "08-18", "09-20"],
      ["final_drainage", "09-21", "10-05"]
    ]
  },
  {
    id: "kinki_tokai",
    labelJa: "近畿・東海",
    labelEn: "Kinki / Tokai",
    // The project's own field (Nara, ~34.65N) sits in this band.
    minLat: 33.6,
    maxLat: 35.6,
    stages: [
      ["pre_transplant", "05-15", "06-04"],
      ["after_transplanting", "06-05", "06-16"],
      ["establishment", "06-17", "06-26"],
      ["tillering", "06-27", "07-25"],
      ["midseason_drainage", "07-26", "08-05"],
      ["panicle_initiation", "08-06", "08-15"],
      ["booting", "08-16", "08-24"],
      ["heading_flowering", "08-25", "09-04"],
      ["ripening", "09-05", "10-05"],
      ["final_drainage", "10-06", "10-20"]
    ]
  },
  {
    id: "chugoku_shikoku_kyushu",
    labelJa: "中国・四国・九州",
    labelEn: "Chugoku / Shikoku / Kyushu",
    minLat: 30.0,
    maxLat: 33.6,
    stages: [
      ["pre_transplant", "05-20", "06-09"],
      ["after_transplanting", "06-10", "06-21"],
      ["establishment", "06-22", "07-01"],
      ["tillering", "07-02", "07-30"],
      ["midseason_drainage", "07-31", "08-10"],
      ["panicle_initiation", "08-11", "08-20"],
      ["booting", "08-21", "08-29"],
      ["heading_flowering", "08-30", "09-09"],
      ["ripening", "09-10", "10-10"],
      ["final_drainage", "10-11", "10-25"]
    ]
  }
];

const DEFAULT_REGION_ID = "kinki_tokai";

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Region for a latitude. Out-of-range latitudes (a field outside Japan, or a
 * missing coordinate) fall back to the project's own region rather than
 * throwing -- the caller still gets a usable suggestion, and the record says
 * where it came from.
 */
export function regionForLatitude(lat) {
  if (!isFiniteNumber(lat)) {
    return REGIONAL_CALENDARS.find((r) => r.id === DEFAULT_REGION_ID);
  }
  const match = REGIONAL_CALENDARS.find((r) => lat >= r.minLat && lat < r.maxLat);
  return match || REGIONAL_CALENDARS.find((r) => r.id === DEFAULT_REGION_ID);
}

/** Region for a field record, from the mean latitude of its boundary. */
export function regionForField(field) {
  const coords = Array.isArray(field?.coordinates) ? field.coordinates : [];
  const lats = coords.map((c) => Array.isArray(c) ? c[0] : NaN).filter(isFiniteNumber);
  if (lats.length === 0) {
    return regionForLatitude(NaN);
  }
  return regionForLatitude(lats.reduce((a, b) => a + b, 0) / lats.length);
}

/** "MM-DD" -> comparable integer (month*100 + day). */
function monthDayKey(monthDay) {
  const [m, d] = String(monthDay).split("-").map(Number);
  return m * 100 + d;
}

function dateKey(date) {
  return (date.getMonth() + 1) * 100 + date.getDate();
}

/**
 * The stage a regional calendar expects on a given date.
 *
 * Returns UNKNOWN_STAGE_ID outside the cultivation season (roughly late autumn
 * to early spring). That is a truthful answer, not a failure: there is no rice
 * in the field in January, so there is no stage to suggest and no water
 * recommendation to make.
 */
export function stageForDate(region, date = new Date()) {
  if (!region || !Array.isArray(region.stages)) {
    return UNKNOWN_STAGE_ID;
  }
  const key = dateKey(date);
  for (const [stageId, from, to] of region.stages) {
    const start = monthDayKey(from);
    const end = monthDayKey(to);
    // No window in these calendars wraps the new year, so a plain range test
    // is correct; a wrapping window would need the `start > end` case.
    if (key >= start && key <= end) {
      return stageId;
    }
  }
  return UNKNOWN_STAGE_ID;
}

/**
 * The suggestion a field gets when the farmer has not chosen a stage.
 *
 * @returns {{stage:string, source:"calendar", regionId:string, regionLabelJa:string,
 *            isEstimate:true, noteJa:string, noteEn:string}}
 */
export function suggestGrowthStage(field, date = new Date()) {
  const region = regionForField(field);
  const stage = stageForDate(region, date);
  return {
    stage,
    source: "calendar",
    regionId: region.id,
    regionLabelJa: region.labelJa,
    regionLabelEn: region.labelEn,
    isEstimate: true,
    noteJa: stage === UNKNOWN_STAGE_ID
      ? `${region.labelJa}の作付け期間外です。生育ステージを選択してください。`
      : `${region.labelJa}の標準的な作期からの推定です。実際の生育に合わせて変更できます。`,
    noteEn: stage === UNKNOWN_STAGE_ID
      ? `Outside the typical cultivation season for ${region.labelEn}. Please select a growth stage.`
      : `Estimated from the typical ${region.labelEn} cultivation calendar. Correct it to match your field.`
  };
}

/**
 * Resolves the stage actually used, given what is stored for a field.
 *
 * THE ONE RULE: a manual choice always wins. Once a farmer has said "this field
 * is at 分げつ期", the calendar must never quietly move it -- their eyes on the
 * crop beat a regional average, and an app that overwrites a human correction
 * teaches farmers not to trust it.
 */
export function resolveGrowthStage(storedRecord, field, date = new Date()) {
  const manual = storedRecord
    && storedRecord.source === "manual"
    && storedRecord.stage
    && storedRecord.stage !== UNKNOWN_STAGE_ID;

  if (manual) {
    return {
      stage: storedRecord.stage,
      source: "manual",
      isEstimate: false,
      regionId: null,
      regionLabelJa: null,
      noteJa: "手動で設定した生育ステージです。",
      noteEn: "Growth stage set manually."
    };
  }
  return suggestGrowthStage(field, date);
}

/** True when a stored record would suppress the calendar suggestion. */
export function manualOverridesCalendar(storedRecord) {
  return Boolean(
    storedRecord
    && storedRecord.source === "manual"
    && storedRecord.stage
    && storedRecord.stage !== UNKNOWN_STAGE_ID
  );
}
