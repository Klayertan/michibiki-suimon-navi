export function pairObservations(qz1Observations, referenceObservations, options = {}) {
  const toleranceMs = clamp(Number(options.toleranceMs) || 750, 100, 2000);
  const qz1OffsetMs = Number(options.qz1OffsetMs) || 0;
  const referenceOffsetMs = Number(options.referenceOffsetMs) || 0;
  const qz1 = prepare(qz1Observations, qz1OffsetMs);
  const reference = prepare(referenceObservations, referenceOffsetMs);
  const pairs = [];
  const unmatchedQz1 = [];
  const unmatchedReference = [];
  let referenceIndex = 0;

  qz1.forEach((qz1Point) => {
    while (referenceIndex < reference.length && reference[referenceIndex].pairTimeMs < qz1Point.pairTimeMs - toleranceMs) {
      unmatchedReference.push(reference[referenceIndex].observation);
      referenceIndex += 1;
    }

    const candidates = [referenceIndex, referenceIndex + 1]
      .filter((index) => index < reference.length)
      .map((index) => ({ index, delta: reference[index].pairTimeMs - qz1Point.pairTimeMs }))
      .filter((candidate) => Math.abs(candidate.delta) <= toleranceMs)
      .sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta) || a.index - b.index);

    if (candidates.length === 0) {
      unmatchedQz1.push(qz1Point.observation);
      return;
    }

    const selected = candidates[0];
    for (let index = referenceIndex; index < selected.index; index += 1) unmatchedReference.push(reference[index].observation);
    const referencePoint = reference[selected.index];
    pairs.push({
      id: `pair-${qz1Point.observation.id}-${referencePoint.observation.id}`,
      qz1ObservationId: qz1Point.observation.id,
      referenceObservationId: referencePoint.observation.id,
      qz1: qz1Point.observation,
      reference: referencePoint.observation,
      qz1TimestampMs: qz1Point.pairTimeMs,
      referenceTimestampMs: referencePoint.pairTimeMs,
      timeDeltaMs: selected.delta,
      separationM: distanceMeters(qz1Point.observation.lat, qz1Point.observation.lon, referencePoint.observation.lat, referencePoint.observation.lon)
    });
    referenceIndex = selected.index + 1;
  });

  while (referenceIndex < reference.length) {
    unmatchedReference.push(reference[referenceIndex].observation);
    referenceIndex += 1;
  }

  return {
    toleranceMs,
    pairs,
    unmatchedQz1,
    unmatchedReference,
    qz1Continuity: summarizeContinuity(qz1Observations, options.qz1ExpectedRateHz || 1),
    referenceContinuity: summarizeContinuity(referenceObservations, options.referenceExpectedRateHz || 1)
  };
}

export function summarizeContinuity(observations, expectedRateHz = 1) {
  const sorted = prepareTimed(observations, 0, false);
  if (sorted.length === 0) return { expected: 0, observed: 0, ratio: 0, dropoutCount: 0, maxGapMs: null, durationMs: 0 };
  const intervalMs = 1000 / Math.max(0.1, Number(expectedRateHz) || 1);
  const durationMs = Math.max(0, sorted[sorted.length - 1].pairTimeMs - sorted[0].pairTimeMs);
  const expected = Math.max(1, Math.round(durationMs / intervalMs) + 1);
  let dropoutCount = 0;
  let maxGapMs = 0;
  for (let index = 1; index < sorted.length; index += 1) {
    const gap = sorted[index].pairTimeMs - sorted[index - 1].pairTimeMs;
    maxGapMs = Math.max(maxGapMs, gap);
    if (gap > intervalMs * 1.5) dropoutCount += Math.max(1, Math.round(gap / intervalMs) - 1);
  }
  return {
    expected,
    observed: sorted.length,
    validFixes: sorted.filter((item) => item.observation.fixValid).length,
    ratio: Math.min(1, sorted.length / expected),
    validFixRatio: sorted.filter((item) => item.observation.fixValid).length / sorted.length,
    dropoutCount,
    maxGapMs,
    durationMs
  };
}

function prepare(observations, offsetMs) {
  return prepareTimed(observations, offsetMs, true);
}

function prepareTimed(observations, offsetMs, validFixOnly) {
  const byTime = new Map();
  (observations || []).forEach((observation) => {
    if (validFixOnly && (!observation.fixValid || !Number.isFinite(observation.lat) || !Number.isFinite(observation.lon))) return;
    const rawTime = Number.isFinite(observation.timestampUtcMs) ? observation.timestampUtcMs : observation.timeOfDayMs;
    if (!Number.isFinite(rawTime)) return;
    const pairTimeMs = rawTime + offsetMs;
    const existing = byTime.get(pairTimeMs);
    if (!existing || completeness(observation) > completeness(existing.observation)) {
      byTime.set(pairTimeMs, { observation, pairTimeMs });
    }
  });
  return [...byTime.values()].sort((a, b) => a.pairTimeMs - b.pairTimeMs || a.observation.sequence - b.observation.sequence);
}

function completeness(observation) {
  return [observation.fixQuality, observation.satellites, observation.hdop, observation.pdop, observation.rmcMode, observation.qzss?.visibleCount]
    .filter((value) => value !== null && value !== undefined).length;
}

export function distanceMeters(lat1, lon1, lat2, lon2) {
  const meanLat = (lat1 + lat2) / 2 * Math.PI / 180;
  const x = (lon2 - lon1) * 111320 * Math.cos(meanLat);
  const y = (lat2 - lat1) * 111320;
  return Math.hypot(x, y);
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}
