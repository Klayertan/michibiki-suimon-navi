import { pairObservations, summarizeContinuity, distanceMeters } from "./pairing.js";

export const ASSURANCE_PROFILES = {
  survey: { id: "survey", label: "一般圃場測量", minPairs: 5, greenSeparationM: 2, yellowSeparationM: 5, minContinuity: 0.9, correctionRequired: false, minimumGrade: "B", maxSpeedMps: 3 },
  drone: { id: "drone", label: "ドローン境界飛行", minPairs: 10, greenSeparationM: 1.5, yellowSeparationM: 3, minContinuity: 0.95, correctionRequired: true, minimumGrade: "A", maxSpeedMps: 12 },
  inlet: { id: "inlet", label: "取水口・排水口接近", minPairs: 10, greenSeparationM: 1, yellowSeparationM: 2.5, minContinuity: 0.95, correctionRequired: true, minimumGrade: "A", maxSpeedMps: 2 },
  tagging: { id: "tagging", label: "雑草・病害地点タグ", minPairs: 5, greenSeparationM: 2, yellowSeparationM: 5, minContinuity: 0.85, correctionRequired: false, minimumGrade: "B", maxSpeedMps: 3 },
  manual: { id: "manual", label: "手動確認", minPairs: 3, greenSeparationM: 5, yellowSeparationM: 10, minContinuity: 0.7, correctionRequired: false, minimumGrade: "C", maxSpeedMps: 3 }
};

const WEIGHTS = { augmentation: 20, fix: 10, hdop: 15, satellites: 5, agreement: 20, continuity: 15, stability: 15 };
const GRADE_RANK = { D: 0, C: 1, B: 2, A: 3 };

// Farmer-facing result vocabulary (測量チェック). Internal classification
// keys (green/yellow/red/grey/simulated) are unchanged — only the label
// shown to the user is simplified here, in one place.
export const RESULT_STATUS_LABELS = {
  green: "使用可能",
  yellow: "要確認",
  red: "再測量推奨",
  grey: "証拠不足",
  simulated: "テスト用"
};

export const QZ1_ONLY_MODE_MESSAGE = "比較用GPSログがないため、QZ1単独の簡易チェックを行います。絶対精度や受信機間誤差は評価できません。";

export function calculateAssurance(input) {
  const baseProfile = ASSURANCE_PROFILES[input.profileId] || ASSURANCE_PROFILES.survey;
  const profile = { ...baseProfile, minimumGrade: input.minimumGrade || baseProfile.minimumGrade };
  const pairing = pairObservations(input.qz1Observations, input.referenceObservations, {
    toleranceMs: input.toleranceMs,
    qz1OffsetMs: input.qz1OffsetMs,
    referenceOffsetMs: input.referenceOffsetMs,
    qz1ExpectedRateHz: input.qz1ExpectedRateHz,
    referenceExpectedRateHz: input.referenceExpectedRateHz
  });
  const simulated = Boolean(input.simulated);
  const jumpFlags = buildJumpFlags(pairing.pairs, profile.maxSpeedMps);
  const pairResults = pairing.pairs.map((pair, index) => scorePair(pair, profile, pairing, jumpFlags[index], simulated));
  const boundary = input.boundary || [];
  const cells = generateClippedGrid(boundary, Number(input.gridSizeM) || 5, input.fieldId || "field");

  pairResults.forEach((pairResult) => {
    const anchor = pairResult.pair.qz1;
    const cell = findGridCell(cells, [anchor.lat, anchor.lon]);
    if (cell) {
      cell.pairs.push(pairResult);
      pairResult.gridCellId = cell.id;
    }
  });

  cells.forEach((cell) => aggregateCell(cell, profile, simulated));
  const fieldAreaM2 = polygonAreaMeters(boundary);
  const measuredCells = cells.filter((cell) => cell.pairs.length > 0);
  const areaByStatus = { green: 0, yellow: 0, red: 0, grey: 0, simulated: 0 };
  cells.forEach((cell) => { areaByStatus[cell.classification] += cell.areaM2; });
  const augmentedCount = input.qz1Observations.filter((observation) => ["active", "inferred"].includes(observation.augmentation?.status)).length;
  const validQz1 = input.qz1Observations.filter((observation) => observation.fixValid);
  const qzssVisibleCount = validQz1.filter((observation) => Number(observation.qzss?.visibleCount) > 0).length;
  const qzssUsedCount = validQz1.filter((observation) => observation.qzss?.usedInFix === true).length;
  const separations = pairing.pairs.map((pair) => pair.separationM);
  const pointMetrics = computeQz1PointMetrics(input.qz1Observations);

  return {
    calculationVersion: "satellite-assurance.v1",
    calculatedAt: new Date().toISOString(),
    mode: "comparison",
    profile,
    simulated,
    pairing,
    pairs: pairResults,
    cells,
    summary: {
      pairedCount: pairing.pairs.length,
      unmatchedQz1Count: pairing.unmatchedQz1.length,
      unmatchedReferenceCount: pairing.unmatchedReference.length,
      medianSeparationM: percentile(separations, 0.5),
      p95SeparationM: percentile(separations, 0.95),
      maximumSeparationM: separations.length ? Math.max(...separations) : null,
      qz1AugmentationPercent: input.qz1Observations.length ? augmentedCount / input.qz1Observations.length * 100 : null,
      qzssVisiblePercent: validQz1.length ? qzssVisibleCount / validQz1.length * 100 : null,
      qzssUsedPercent: validQz1.some((observation) => observation.qzss?.usedInFix !== null)
        ? qzssUsedCount / validQz1.length * 100 : null,
      qz1Continuity: pairing.qz1Continuity,
      referenceContinuity: pairing.referenceContinuity,
      fieldAreaM2,
      measuredAreaPercent: percent(sum(measuredCells.map((cell) => cell.areaM2)), fieldAreaM2),
      greenAreaPercent: percent(areaByStatus.green, fieldAreaM2),
      yellowAreaPercent: percent(areaByStatus.yellow, fieldAreaM2),
      redAreaPercent: percent(areaByStatus.red, fieldAreaM2),
      unknownAreaPercent: percent(areaByStatus.grey, fieldAreaM2),
      simulatedAreaPercent: percent(areaByStatus.simulated, fieldAreaM2),
      statusCounts: Object.fromEntries(Object.keys(areaByStatus).map((status) => [status, cells.filter((cell) => cell.classification === status).length])),
      problematicCells: cells.filter((cell) => cell.classification === "red" || cell.classification === "yellow")
        .sort((a, b) => (a.score ?? 100) - (b.score ?? 100)).slice(0, 5).map((cell) => cell.id),
      pointMetrics
    },
    warnings: buildWarnings(pairing, cells, profile, simulated)
  };
}

/**
 * Point-quality counts shared by both check modes (QZ1-only and
 * comparison), so 有効な測位点/GPS単独の点/DGPS・補強ありの点/QZSSを使った点
 * mean exactly the same thing regardless of which mode produced them.
 */
export function computeQz1PointMetrics(observations) {
  const list = observations || [];
  const valid = list.filter((observation) => observation.fixValid);
  const gpsOnlyCount = valid.filter((observation) => observation.fixQuality === 1).length;
  const dgpsCount = valid.filter((observation) => observation.fixQuality === 2
    || ["active", "inferred"].includes(observation.augmentation?.status)).length;
  const qzssUsedCount = valid.filter((observation) => observation.qzss?.usedInFix === true).length;
  return {
    totalCount: list.length,
    validCount: valid.length,
    validRatio: list.length ? valid.length / list.length : null,
    gpsOnlyCount,
    dgpsCount,
    qzssUsedCount
  };
}

/**
 * Flags consecutive-point jumps by raw distance rather than distance/time,
 * because imported legacy/registered-session points often carry only an
 * NMEA time-of-day string (no parseable date), so a speed-based check would
 * silently see every gap as infinite speed. At ~1 Hz walking-survey logging,
 * a >maxJumpM gap between consecutive fixes is anomalous regardless of the
 * exact elapsed time.
 */
export function countPositionJumps(observations, maxJumpM = 50) {
  const valid = (observations || []).filter((observation) => observation.fixValid
    && Number.isFinite(observation.lat) && Number.isFinite(observation.lon));
  let count = 0;
  for (let index = 1; index < valid.length; index += 1) {
    const step = distanceMeters(valid[index - 1].lat, valid[index - 1].lon, valid[index].lat, valid[index].lon);
    if (step > maxJumpM) count += 1;
  }
  return count;
}

/**
 * Simplified single-receiver 測量チェック for when no comparison GPS log is
 * available. Never leaves the result blank — always derives a
 * classification and farmer-readable reasons from what QZ1 alone shows:
 * valid-fix rate, GPS単独 vs DGPS/補強 vs QZSS evidence, point count,
 * position jumps, and (when a boundary is given) how well it closes.
 */
export function calculateQz1OnlyCheck(input) {
  const observations = input.qz1Observations || [];
  const metrics = computeQz1PointMetrics(observations);
  const continuity = summarizeContinuity(observations, input.qz1ExpectedRateHz || 1);
  const jumpCount = countPositionJumps(observations, input.maxJumpM || 50);
  const boundary = input.boundary || [];
  const closureGapM = boundary.length >= 3
    ? distanceMeters(boundary[0][0], boundary[0][1], boundary[boundary.length - 1][0], boundary[boundary.length - 1][1])
    : null;
  const rawNmeaStored = Boolean(input.rawNmeaStored);
  const dgpsRatio = metrics.validCount ? metrics.dgpsCount / metrics.validCount : 0;

  const reasons = [];
  let classification;

  if (metrics.totalCount === 0) {
    classification = "grey";
    reasons.push("測位点がありません。");
  } else {
    if (dgpsRatio < 0.3) reasons.push("GPS単独の測位が多い");
    reasons.push("比較用GPSログがありません");
    if (closureGapM !== null && closureGapM > 10) reasons.push("圃場範囲が完全に閉じていません");
    if (jumpCount > 0) reasons.push(`急な位置ジャンプを${jumpCount}件検出しました`);
    if (!rawNmeaStored) reasons.push("元のNMEAログは保存されていません");
    reasons.push(`有効な測位点は${metrics.validCount}点あります`);

    if (metrics.validCount < 3 || metrics.validRatio < 0.5 || jumpCount > 0) {
      classification = "red";
    } else if (metrics.validCount >= 5 && dgpsRatio >= 0.5
      && (closureGapM === null || closureGapM <= 10)) {
      classification = "green";
    } else {
      classification = "yellow";
    }
  }

  return {
    calculationVersion: "satellite-assurance.v1",
    calculatedAt: new Date().toISOString(),
    mode: "qz1_only",
    message: QZ1_ONLY_MODE_MESSAGE,
    classification,
    reasons,
    metrics: { ...metrics, continuity, jumpCount, closureGapM, rawNmeaStored }
  };
}

/**
 * Derives one overall 総合判定 + farmer-readable reasons from a comparison
 * (calculateAssurance) result, mirroring what calculateQz1OnlyCheck
 * produces for the no-comparison-data path so the controller can render
 * both modes through the same summary card.
 */
export function summarizeComparisonResult(result) {
  const { summary, simulated } = result;
  const reasons = [];
  let classification;

  if (simulated) {
    classification = "simulated";
    reasons.push("SIMULATEDデータを含むため、テスト用の結果です。運用判断には使えません。");
  } else if (summary.pairedCount === 0) {
    classification = "grey";
    reasons.push("比較できた点がありません。時刻・圃場範囲・データセットを確認してください。");
  } else {
    reasons.push(`比較できた点は${summary.pairedCount}組です`);
    if (Number.isFinite(summary.medianSeparationM)) reasons.push(`位置差の中央値は${summary.medianSeparationM.toFixed(2)}mです`);
    if (summary.unmatchedQz1Count || summary.unmatchedReferenceCount) {
      reasons.push(`対応しなかった点があります（QZ1 ${summary.unmatchedQz1Count} / 比較用 ${summary.unmatchedReferenceCount}）`);
    }
    if (summary.redAreaPercent > 0) {
      classification = "red";
      reasons.push("再測量推奨の範囲があります");
    } else if (summary.unknownAreaPercent >= 50) {
      classification = "grey";
      reasons.push("証拠不足の範囲が多くあります");
    } else if (summary.yellowAreaPercent > 0 || summary.greenAreaPercent < 50) {
      classification = "yellow";
      reasons.push("要確認の範囲があります");
    } else {
      classification = "green";
    }
  }

  return { classification, reasons };
}

function scorePair(pair, profile, pairing, jump, simulated) {
  const augmentation = augmentationScore(pair.qz1, profile);
  const values = {
    augmentation,
    fix: pair.qz1.fixValid ? 100 : 0,
    hdop: hdopScore(pair.qz1.hdop),
    satellites: satelliteScore(pair.qz1.satellites),
    agreement: agreementScore(pair.separationM, profile),
    continuity: continuityScore(Math.min(pairing.qz1Continuity.validFixRatio ?? 0, pairing.referenceContinuity.validFixRatio ?? 0)),
    stability: jump ? 0 : 100
  };
  let weighted = 0;
  let availableWeight = 0;
  const contributors = [];
  Object.entries(WEIGHTS).forEach(([key, weight]) => {
    const value = values[key];
    if (value === null) {
      contributors.push({ key, available: false, weight, reason: `${key} の証拠なし` });
      return;
    }
    weighted += value * weight;
    availableWeight += weight;
    contributors.push({ key, available: true, weight, score: Math.round(value) });
  });
  const rawScore = availableWeight ? weighted / availableWeight : null;
  const score = rawScore === null ? null : Math.round(rawScore / 5) * 5;
  const completeness = availableWeight / 100;
  return { pair, score, completeness, contributors, jump, simulated, gridCellId: null };
}

function aggregateCell(cell, profile, simulated) {
  if (cell.pairs.length === 0) {
    Object.assign(cell, { classification: "grey", evidenceGrade: "D", score: null, explanation: ["測定データがありません。"] });
    return;
  }
  const scores = cell.pairs.map((pair) => pair.score).filter(Number.isFinite);
  const completeness = median(cell.pairs.map((pair) => pair.completeness));
  const score = scores.length ? Math.round(median(scores) / 5) * 5 : null;
  const separations = cell.pairs.map((pair) => pair.pair.separationM);
  const fullTimestamps = cell.pairs.every((pair) => Number.isFinite(pair.pair.qz1.timestampUtcMs) && Number.isFinite(pair.pair.reference.timestampUtcMs));
  const correctionKnown = cell.pairs.some((pair) => ["active", "inferred"].includes(pair.pair.qz1.augmentation?.status));
  const correctionConfirmed = cell.pairs.some((pair) => pair.pair.qz1.augmentation?.status === "active");
  const durationMs = cell.pairs.length > 1
    ? Math.max(...cell.pairs.map((pair) => pair.pair.qz1TimestampMs)) - Math.min(...cell.pairs.map((pair) => pair.pair.qz1TimestampMs))
    : 0;
  let evidenceGrade = "D";
  if (cell.pairs.length >= 10 && durationMs >= 9000 && completeness >= 0.8 && fullTimestamps && correctionKnown) evidenceGrade = "A";
  else if (cell.pairs.length >= 5 && completeness >= 0.6 && fullTimestamps) evidenceGrade = "B";
  else if (cell.pairs.length >= 3) evidenceGrade = "C";

  let classification = "grey";
  const hardFailure = cell.pairs.some((pair) => pair.jump) || Math.max(...separations) > profile.yellowSeparationM * 1.5;
  if (simulated) classification = "simulated";
  else if (evidenceGrade !== "D") {
    if (hardFailure || (score !== null && score < 55)) classification = "red";
    else if (score >= 80 && completeness >= 0.7 && GRADE_RANK[evidenceGrade] >= GRADE_RANK[profile.minimumGrade]
      && (!profile.correctionRequired || correctionConfirmed) && cell.pairs.length >= profile.minPairs) classification = "green";
    else classification = "yellow";
  }

  Object.assign(cell, {
    classification,
    evidenceGrade: simulated ? "SIM" : evidenceGrade,
    score,
    completeness,
    sampleCount: cell.pairs.length,
    medianSeparationM: median(separations),
    p95SeparationM: percentile(separations, 0.95),
    maximumSeparationM: Math.max(...separations),
    jumpCount: cell.pairs.filter((pair) => pair.jump).length,
    augmentationPercent: percent(cell.pairs.filter((pair) => ["active", "inferred"].includes(pair.pair.qz1.augmentation?.status)).length, cell.pairs.length),
    medianHdop: median(cell.pairs.map((pair) => pair.pair.qz1.hdop).filter(Number.isFinite)),
    explanation: explainCell({ classification, evidenceGrade, score, completeness, correctionKnown, correctionConfirmed, hardFailure, profile, simulated })
  });
}

function generateClippedGrid(boundary, gridSizeM, fieldId) {
  if (!Array.isArray(boundary) || boundary.length < 3 || gridSizeM <= 0) return [];
  const projection = localProjection(boundary);
  const polygon = boundary.map(projection.toXY);
  const xs = polygon.map((point) => point.x);
  const ys = polygon.map((point) => point.y);
  const minX = Math.floor(Math.min(...xs) / gridSizeM) * gridSizeM;
  const maxX = Math.ceil(Math.max(...xs) / gridSizeM) * gridSizeM;
  const minY = Math.floor(Math.min(...ys) / gridSizeM) * gridSizeM;
  const maxY = Math.ceil(Math.max(...ys) / gridSizeM) * gridSizeM;
  const cells = [];
  for (let row = 0, y = minY; y < maxY; row += 1, y += gridSizeM) {
    for (let column = 0, x = minX; x < maxX; column += 1, x += gridSizeM) {
      const clipped = clipPolygonToRect(polygon, x, y, x + gridSizeM, y + gridSizeM);
      const areaM2 = Math.abs(areaXY(clipped));
      if (areaM2 < 0.01) continue;
      cells.push({
        id: `${fieldId}:${gridSizeM}m:r${row}:c${column}`,
        row,
        column,
        gridSizeM,
        areaM2,
        coordinates: clipped.map(projection.toLatLng),
        pairs: [],
        classification: "grey",
        evidenceGrade: "D"
      });
    }
  }
  const byIndex = new Map(cells.map((cell) => [`${cell.row}:${cell.column}`, cell]));
  Object.defineProperty(cells, "lookup", { value: { projection, minX, minY, gridSizeM, byIndex }, enumerable: false });
  return cells;
}

function findGridCell(cells, coordinate) {
  const lookup = cells.lookup;
  if (!lookup) return cells.find((cell) => pointInPolygon(coordinate, cell.coordinates));
  const point = lookup.projection.toXY(coordinate);
  const row = Math.floor((point.y - lookup.minY) / lookup.gridSizeM);
  const column = Math.floor((point.x - lookup.minX) / lookup.gridSizeM);
  const candidate = lookup.byIndex.get(`${row}:${column}`);
  return candidate && pointInPolygon(coordinate, candidate.coordinates) ? candidate : null;
}

function clipPolygonToRect(polygon, minX, minY, maxX, maxY) {
  let output = polygon;
  const boundaries = [
    { inside: (p) => p.x >= minX, intersect: (a, b) => intersectVertical(a, b, minX) },
    { inside: (p) => p.x <= maxX, intersect: (a, b) => intersectVertical(a, b, maxX) },
    { inside: (p) => p.y >= minY, intersect: (a, b) => intersectHorizontal(a, b, minY) },
    { inside: (p) => p.y <= maxY, intersect: (a, b) => intersectHorizontal(a, b, maxY) }
  ];
  boundaries.forEach((boundary) => {
    const input = output;
    output = [];
    if (input.length === 0) return;
    let previous = input[input.length - 1];
    input.forEach((current) => {
      if (boundary.inside(current)) {
        if (!boundary.inside(previous)) output.push(boundary.intersect(previous, current));
        output.push(current);
      } else if (boundary.inside(previous)) output.push(boundary.intersect(previous, current));
      previous = current;
    });
  });
  return output;
}

function buildJumpFlags(pairs, maxSpeedMps) {
  return pairs.map((pair, index) => {
    if (index === 0) return false;
    const previous = pairs[index - 1];
    const deltaSeconds = Math.max(0.001, (pair.qz1TimestampMs - previous.qz1TimestampMs) / 1000);
    const allowance = maxSpeedMps * deltaSeconds + 3;
    const qz1Step = distanceMeters(previous.qz1.lat, previous.qz1.lon, pair.qz1.lat, pair.qz1.lon);
    const referenceStep = distanceMeters(previous.reference.lat, previous.reference.lon, pair.reference.lat, pair.reference.lon);
    return qz1Step > allowance || referenceStep > allowance;
  });
}

function buildWarnings(pairing, cells, profile, simulated) {
  const warnings = [];
  if (simulated) warnings.push("SIMULATED: この結果はUI・計算確認専用で、実運用判断には使用できません。");
  if (pairing.pairs.length < profile.minPairs) warnings.push(`プロファイルに必要なペア数（${profile.minPairs}）を満たしていません。`);
  if (pairing.unmatchedQz1.length || pairing.unmatchedReference.length) warnings.push(`未対応点: QZ1 ${pairing.unmatchedQz1.length} / 基準受信機 ${pairing.unmatchedReference.length}`);
  if (!cells.some((cell) => cell.pairs.length)) warnings.push("圃場内に対応ペアがありません。時刻・圃場範囲・データセットを確認してください。");
  if (cells.some((cell) => cell.classification === "grey")) warnings.push("灰色セルは未測定または証拠不足です。補間していません。");
  const problemCells = cells.filter((cell) => cell.classification === "red" || cell.classification === "yellow").slice(0, 5);
  if (problemCells.length) warnings.push(`要確認セル: ${problemCells.map((cell) => cell.id).join(", ")}`);
  return warnings;
}

function explainCell({ classification, evidenceGrade, score, completeness, correctionKnown, correctionConfirmed, hardFailure, profile, simulated }) {
  if (simulated) return ["シミュレーションデータです。運用判断は禁止です。"];
  const lines = [`スコア ${score ?? "—"}（5点刻み）`, `証拠等級 ${evidenceGrade}`, `証拠充足率 ${Math.round(completeness * 100)}%`];
  if (!correctionKnown) lines.push("QZ1補強状態の証拠が不足しています。");
  if (profile.correctionRequired && !correctionConfirmed) lines.push("このプロファイルは明示的な補正・補強状態を必須とします。GGA fix quality 2だけでは確認済みとしません。");
  if (hardFailure) lines.push("急な位置ジャンプまたは大きな受信機差を検出しました。");
  if (classification === "grey") lines.push("サンプル数が不足しています。");
  return lines;
}

function augmentationScore(observation, profile) {
  const status = observation.augmentation?.status;
  if (status === "active") return 100;
  if (status === "inferred") return 75;
  if (status === "inactive") return profile.correctionRequired ? 0 : 40;
  return null;
}

function hdopScore(hdop) {
  if (!Number.isFinite(hdop)) return null;
  if (hdop <= 1) return 100;
  if (hdop <= 2) return interpolate(hdop, 1, 2, 100, 75);
  if (hdop <= 5) return interpolate(hdop, 2, 5, 75, 40);
  if (hdop <= 10) return interpolate(hdop, 5, 10, 40, 0);
  return 0;
}

function satelliteScore(count) {
  if (!Number.isFinite(count)) return null;
  if (count >= 9) return 100;
  if (count >= 6) return 70;
  if (count >= 4) return 40;
  return 0;
}

function agreementScore(separation, profile) {
  if (!Number.isFinite(separation)) return null;
  if (separation <= profile.greenSeparationM) return 100;
  if (separation <= profile.yellowSeparationM) return interpolate(separation, profile.greenSeparationM, profile.yellowSeparationM, 100, 50);
  if (separation <= profile.yellowSeparationM * 1.5) return interpolate(separation, profile.yellowSeparationM, profile.yellowSeparationM * 1.5, 50, 0);
  return 0;
}

function continuityScore(ratio) {
  if (!Number.isFinite(ratio)) return null;
  if (ratio >= 0.95) return 100;
  if (ratio >= 0.8) return interpolate(ratio, 0.8, 0.95, 50, 100);
  if (ratio > 0.5) return interpolate(ratio, 0.5, 0.8, 0, 50);
  return 0;
}

function localProjection(points) {
  const origin = points[0];
  const metersLon = 111320 * Math.cos(origin[0] * Math.PI / 180);
  return {
    toXY: ([lat, lon]) => ({ x: (lon - origin[1]) * metersLon, y: (lat - origin[0]) * 111320 }),
    toLatLng: ({ x, y }) => [origin[0] + y / 111320, origin[1] + x / metersLon]
  };
}

function pointInPolygon([lat, lon], polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const yi = polygon[i][0]; const xi = polygon[i][1];
    const yj = polygon[j][0]; const xj = polygon[j][1];
    if (((yi > lat) !== (yj > lat)) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function polygonAreaMeters(points) {
  if (!Array.isArray(points) || points.length < 3) return 0;
  const projection = localProjection(points);
  return Math.abs(areaXY(points.map(projection.toXY)));
}

function areaXY(points) {
  if (points.length < 3) return 0;
  return points.reduce((sumValue, point, index) => {
    const next = points[(index + 1) % points.length];
    return sumValue + point.x * next.y - next.x * point.y;
  }, 0) / 2;
}

function intersectVertical(a, b, x) {
  const denominator = b.x - a.x;
  if (Math.abs(denominator) < Number.EPSILON) return { x, y: a.y };
  const t = (x - a.x) / denominator;
  return { x, y: a.y + t * (b.y - a.y) };
}
function intersectHorizontal(a, b, y) {
  const denominator = b.y - a.y;
  if (Math.abs(denominator) < Number.EPSILON) return { x: a.x, y };
  const t = (y - a.y) / denominator;
  return { x: a.x + t * (b.x - a.x), y };
}
function interpolate(value, inA, inB, outA, outB) { return outA + (value - inA) / (inB - inA) * (outB - outA); }
function sum(values) { return values.reduce((total, value) => total + value, 0); }
function percent(part, whole) { return whole > 0 ? part / whole * 100 : 0; }
function median(values) { return percentile(values, 0.5); }
function percentile(values, ratio) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * ratio;
  const lower = Math.floor(index); const upper = Math.ceil(index);
  return lower === upper ? sorted[lower] : sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}
