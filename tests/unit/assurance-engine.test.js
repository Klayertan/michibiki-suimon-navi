import test from "node:test";
import assert from "node:assert/strict";
import {
  QZ1_ONLY_MODE_MESSAGE,
  RESULT_STATUS_LABELS,
  calculateAssurance,
  calculateQz1OnlyCheck,
  computeQz1PointMetrics,
  countPositionJumps,
  summarizeComparisonResult
} from "../../js/assurance/assurance-engine.js";

function observations(prefix, eastOffsetM = 0, simulated = false) {
  const baseLat = 35;
  const baseLon = 135;
  return [0, 1, 2, 3].map((index) => ({
    id: `${prefix}${index}`,
    sequence: index,
    receiverId: prefix,
    timestampUtcMs: 1_700_000_000_000 + index * 1000,
    timeOfDayMs: index * 1000,
    lat: baseLat + index * 0.000005,
    lon: baseLon + eastOffsetM / (111320 * Math.cos(baseLat * Math.PI / 180)),
    fixQuality: 1,
    fixValid: true,
    satellites: 10,
    hdop: 0.8,
    augmentation: { service: null, status: "inactive", evidence: [] },
    simulated
  }));
}

const boundary = [[34.9999, 134.9999], [34.9999, 135.0001], [35.0001, 135.0001], [35.0001, 134.9999]];

test("rule-based assurance reports measured cells without interpolating unknown cells", () => {
  const result = calculateAssurance({
    qz1Observations: observations("q"),
    referenceObservations: observations("r", 0.4),
    profileId: "manual",
    gridSizeM: 10,
    boundary,
    fieldId: "field",
    toleranceMs: 100
  });
  assert.equal(result.summary.pairedCount, 4);
  assert.ok(result.cells.some((cell) => cell.pairs.length > 0));
  assert.ok(result.cells.some((cell) => cell.classification === "grey"));
  assert.ok(result.summary.unknownAreaPercent > 0);
  assert.equal(result.calculationVersion, "satellite-assurance.v1");
});

test("simulated data can never produce an operational green classification", () => {
  const result = calculateAssurance({
    qz1Observations: observations("q"),
    referenceObservations: observations("r", 0.4),
    profileId: "manual",
    gridSizeM: 50,
    boundary,
    fieldId: "field",
    toleranceMs: 100,
    simulated: true
  });
  assert.ok(result.cells.filter((cell) => cell.pairs.length).every((cell) => cell.classification === "simulated"));
  assert.ok(result.warnings.some((warning) => warning.includes("SIMULATED")));
});

// 測量チェック (Mode A: QZ1-only) fixtures — walking-survey-style points a
// few meters apart, well inside the >50m jump threshold.
function qz1Points(count, { augmentedFraction = 0 } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const augmented = index < Math.round(count * augmentedFraction);
    return {
      id: `qz1-${index}`,
      sequence: index,
      receiverId: "qz1",
      timestampUtcMs: 1_700_000_000_000 + index * 1000,
      timeOfDayMs: index * 1000,
      lat: 35 + index * 0.000005,
      lon: 135,
      fixQuality: augmented ? 2 : 1,
      fixValid: true,
      satellites: 9,
      hdop: 0.9,
      augmentation: { service: null, status: augmented ? "active" : "inactive", evidence: [] },
      qzss: { visibleCount: 3, satellites: [], usedInFix: false }
    };
  });
}

// A walked-loop boundary repeats its start point as its last point when the
// loop actually closes; closureGapM is measured between boundary[0] and the
// last coordinate.
const closedSquareBoundary = [[35, 135], [35, 135.0002], [35.0002, 135.0002], [35.0002, 135], [35, 135]];
const openBoundary = [[35, 135], [35, 135.0002], [35.0002, 135.0002]]; // ~31m gap between start and end, well over the 10m closure threshold

test("calculateQz1OnlyCheck never leaves the result blank and reports classification=green with mostly-DGPS points on a closed boundary", () => {
  const result = calculateQz1OnlyCheck({
    qz1Observations: qz1Points(10, { augmentedFraction: 0.7 }),
    boundary: closedSquareBoundary,
    rawNmeaStored: true
  });
  assert.equal(result.mode, "qz1_only");
  assert.equal(result.message, QZ1_ONLY_MODE_MESSAGE);
  assert.equal(result.classification, "green");
  assert.ok(result.reasons.includes("有効な測位点は10点あります"));
  assert.ok(result.reasons.includes("比較用GPSログがありません"), "the no-comparison-log reason is always present in Mode A");
  assert.equal(result.metrics.validCount, 10);
  assert.equal(result.metrics.dgpsCount, 7);
});

test("calculateQz1OnlyCheck reports yellow and the GPS単独 reason when most points are GPS単独", () => {
  const result = calculateQz1OnlyCheck({
    qz1Observations: qz1Points(10, { augmentedFraction: 0 }),
    boundary: closedSquareBoundary,
    rawNmeaStored: true
  });
  assert.equal(result.classification, "yellow");
  assert.ok(result.reasons.includes("GPS単独の測位が多い"));
});

test("calculateQz1OnlyCheck flags an unclosed boundary with the exact reason text and drops out of green", () => {
  const result = calculateQz1OnlyCheck({
    qz1Observations: qz1Points(10, { augmentedFraction: 0.7 }),
    boundary: openBoundary,
    rawNmeaStored: true
  });
  assert.notEqual(result.classification, "green");
  assert.ok(result.reasons.includes("圃場範囲が完全に閉じていません"));
});

test("calculateQz1OnlyCheck reports red on a hard position jump between consecutive points", () => {
  const points = qz1Points(10, { augmentedFraction: 0.7 });
  points[5] = { ...points[5], lat: points[5].lat + 0.01 }; // ~1.1km jump
  const result = calculateQz1OnlyCheck({ qz1Observations: points, boundary: closedSquareBoundary, rawNmeaStored: true });
  assert.equal(result.classification, "red");
  assert.ok(result.reasons.some((reason) => reason.includes("急な位置ジャンプ")));
});

test("calculateQz1OnlyCheck reports grey with no points, still returning a real (non-blank) result", () => {
  const result = calculateQz1OnlyCheck({ qz1Observations: [], boundary: [], rawNmeaStored: false });
  assert.equal(result.classification, "grey");
  assert.deepEqual(result.reasons, ["測位点がありません。"]);
  assert.equal(result.metrics.totalCount, 0);
});

test("calculateQz1OnlyCheck mentions unsaved raw NMEA only when rawNmeaStored is false", () => {
  const stored = calculateQz1OnlyCheck({ qz1Observations: qz1Points(10, { augmentedFraction: 0.7 }), boundary: closedSquareBoundary, rawNmeaStored: true });
  assert.ok(!stored.reasons.some((reason) => reason.includes("保存されていません")));
  const notStored = calculateQz1OnlyCheck({ qz1Observations: qz1Points(10, { augmentedFraction: 0.7 }), boundary: closedSquareBoundary, rawNmeaStored: false });
  assert.ok(notStored.reasons.some((reason) => reason.includes("保存されていません")));
});

test("computeQz1PointMetrics counts GPS単独/DGPS/QZSS evidence independently of pairing", () => {
  const metrics = computeQz1PointMetrics(qz1Points(10, { augmentedFraction: 0.3 }));
  assert.equal(metrics.totalCount, 10);
  assert.equal(metrics.validCount, 10);
  assert.equal(metrics.gpsOnlyCount, 7);
  assert.equal(metrics.dgpsCount, 3);
  assert.equal(metrics.qzssUsedCount, 0);
});

test("countPositionJumps flags only steps beyond the threshold, not normal walking-survey spacing", () => {
  const steady = qz1Points(10);
  assert.equal(countPositionJumps(steady, 50), 0);
  // Shifting index 4 onward by a constant offset creates exactly one large
  // step (3→4); every step after that stays small since it's shifted by the
  // same amount, so this counts one jump event, not a spike-and-return pair.
  const withJump = steady.map((point, index) => (index >= 4 ? { ...point, lat: point.lat + 0.01 } : point));
  assert.equal(countPositionJumps(withJump, 50), 1);
});

test("summarizeComparisonResult maps a comparison result to one overall classification with reasons", () => {
  const base = calculateAssurance({
    qz1Observations: observations("q"),
    referenceObservations: observations("r", 0.4),
    profileId: "manual",
    gridSizeM: 10,
    boundary,
    fieldId: "field",
    toleranceMs: 100
  });
  const summarized = summarizeComparisonResult(base);
  assert.ok(["green", "yellow", "red", "grey"].includes(summarized.classification));
  assert.ok(summarized.reasons.some((reason) => reason.includes("比較できた点は4組です")));

  const simulatedResult = calculateAssurance({
    qz1Observations: observations("q"),
    referenceObservations: observations("r", 0.4),
    profileId: "manual",
    gridSizeM: 50,
    boundary,
    fieldId: "field",
    toleranceMs: 100,
    simulated: true
  });
  assert.deepEqual(summarizeComparisonResult(simulatedResult).classification, "simulated");

  const noPairsResult = calculateAssurance({
    qz1Observations: [],
    referenceObservations: [],
    profileId: "manual",
    gridSizeM: 10,
    boundary,
    fieldId: "field",
    toleranceMs: 100
  });
  assert.equal(summarizeComparisonResult(noPairsResult).classification, "grey");
});

test("RESULT_STATUS_LABELS carries the exact 使用可能/要確認/再測量推奨/証拠不足/テスト用 vocabulary", () => {
  assert.deepEqual(RESULT_STATUS_LABELS, {
    green: "使用可能",
    yellow: "要確認",
    red: "再測量推奨",
    grey: "証拠不足",
    simulated: "テスト用"
  });
});
