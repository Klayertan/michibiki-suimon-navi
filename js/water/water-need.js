// Pure presentation calculation for 今日の水門判断's quantitative hero.
//
// Turns { area, current water level, target water level } into a farmer
// message ("水を 2.3 cm 入れてください") and an estimated volume. Deliberately
// does not touch the DOM and does not decide open/close/hold -- that remains
// evaluateGate()'s job in index.html. This only answers "how much water".
//
// requiredDepthCm = targetWaterLevelCm - currentWaterLevelCm (the one
// agronomic relationship the app already has real data for -- nothing else is
// invented). volumeLiters = areaM2 * depthCm * 10 (1mm over 1m² = 1L).
//
// Every numeric input is checked with Number.isFinite(), never coerced with
// bare Number(x): this app has previously shipped Number(null) === 0 bugs,
// and a missing reading must never silently become "0 cm".

const HOLD_EPSILON_CM = 0.1;
const STALE_DAYS_THRESHOLD = 3;

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

/**
 * @param {object} input
 * @param {string} [input.fieldId]
 * @param {number} [input.areaM2]
 * @param {number} [input.currentWaterLevelCm]
 * @param {number} [input.currentLevelRecordedAt] epoch ms
 * @param {number} [input.targetWaterLevelCm]
 * @param {number} [input.now] epoch ms, defaults to Date.now()
 */
function computeWaterNeed(input = {}) {
  const {
    fieldId = null,
    areaM2,
    currentWaterLevelCm,
    currentLevelRecordedAt,
    targetWaterLevelCm,
    now = Date.now()
  } = input;

  const missingInputs = [];
  if (!isFiniteNumber(areaM2) || areaM2 <= 0) missingInputs.push("areaM2");
  if (!isFiniteNumber(currentWaterLevelCm)) missingInputs.push("currentWaterLevelCm");
  if (!isFiniteNumber(targetWaterLevelCm)) missingInputs.push("targetWaterLevelCm");

  let staleDays = null;
  let isStale = false;
  if (isFiniteNumber(currentLevelRecordedAt)) {
    staleDays = Math.max(0, Math.floor((now - currentLevelRecordedAt) / 86400000));
    isStale = staleDays >= STALE_DAYS_THRESHOLD;
  }

  const hasDepthInputs = isFiniteNumber(currentWaterLevelCm) && isFiniteNumber(targetWaterLevelCm);
  if (!hasDepthInputs) {
    return {
      fieldId,
      areaM2: isFiniteNumber(areaM2) ? areaM2 : null,
      currentWaterLevelCm: isFiniteNumber(currentWaterLevelCm) ? currentWaterLevelCm : null,
      targetWaterLevelCm: isFiniteNumber(targetWaterLevelCm) ? targetWaterLevelCm : null,
      deltaWaterDepthCm: null,
      volumeLiters: null,
      volumeM3: null,
      direction: "unknown",
      missingInputs,
      staleDays,
      isStale
    };
  }

  const rawDelta = targetWaterLevelCm - currentWaterLevelCm;
  const deltaWaterDepthCm = round1(rawDelta);

  let direction;
  if (Math.abs(deltaWaterDepthCm) < HOLD_EPSILON_CM) {
    direction = "hold";
  } else if (deltaWaterDepthCm > 0) {
    direction = "add";
  } else {
    direction = "remove";
  }

  const hasArea = isFiniteNumber(areaM2) && areaM2 > 0;
  let volumeLiters = null;
  let volumeM3 = null;
  if (hasArea && (direction === "add" || direction === "remove")) {
    // Volume is always reported as a positive amount to move, never negative.
    const depthMagnitudeCm = Math.abs(deltaWaterDepthCm);
    volumeLiters = round1(areaM2 * depthMagnitudeCm * 10);
    volumeM3 = round1(volumeLiters / 1000);
  } else if (hasArea && direction === "hold") {
    volumeLiters = 0;
    volumeM3 = 0;
  } else if (!hasArea) {
    missingInputs.push("areaM2");
  }

  return {
    fieldId,
    areaM2: isFiniteNumber(areaM2) ? areaM2 : null,
    currentWaterLevelCm,
    targetWaterLevelCm,
    deltaWaterDepthCm,
    volumeLiters,
    volumeM3,
    direction,
    missingInputs,
    staleDays,
    isStale
  };
}

export { computeWaterNeed, isFiniteNumber, HOLD_EPSILON_CM, STALE_DAYS_THRESHOLD };
