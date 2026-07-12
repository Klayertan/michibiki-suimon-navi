const VALID_FIX_QUALITIES = new Set([1, 2, 4, 5]);

export function validateNmeaChecksum(sentence) {
  const match = String(sentence).match(/^\$([^*]+)\*([0-9A-F]{2})/i);
  if (!match) return null;
  let value = 0;
  for (const character of match[1]) value ^= character.charCodeAt(0);
  return value === Number.parseInt(match[2], 16);
}

export function parseNmeaSession(text, options = {}) {
  const receiver = options.receiver || { id: "receiver-unknown", role: "unknown" };
  const sessionId = options.sessionId || `session-${Date.now()}`;
  const captureDate = parseIsoDate(options.captureDate);
  const rawLines = String(text || "").split(/\r?\n/);
  const observations = [];
  const sentenceCounts = {};
  const parserWarnings = [];
  let current = null;
  let sequence = 0;
  let validChecksums = 0;
  let invalidChecksums = 0;
  let missingChecksums = 0;
  let ignoredLines = 0;
  let captureDayOffset = 0;
  let lastCaptureTimeOfDayMs = null;

  const finishCurrent = () => {
    if (!current) return;
    const dateParts = captureDate || current.dateParts;
    if (captureDate && Number.isFinite(lastCaptureTimeOfDayMs) && Number.isFinite(current.timeOfDayMs)
      && current.timeOfDayMs < lastCaptureTimeOfDayMs - 12 * 60 * 60 * 1000) captureDayOffset += 1;
    const timestampUtcMs = dateParts && current.timeOfDayMs !== null
      ? Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day + (captureDate ? captureDayOffset : 0)) + current.timeOfDayMs
      : null;
    const qzssSatellites = [...current.qzssSatelliteMap.values()];
    const qzssUsedPrns = current.satellitesUsed.filter(isQzssGsaPrn);
    const augmentation = deriveAugmentation(current.fixQuality, current.rmcMode, receiver, qzssSatellites.length);
    observations.push({
      id: `${sessionId}:obs-${sequence}`,
      sessionId,
      receiverId: receiver.id,
      sequence,
      sourceLine: current.sourceLine,
      timestampUtcMs,
      timestampDateSource: captureDate ? "capture-date" : current.dateParts ? "nmea" : "time-only",
      reportedDateParts: current.dateParts,
      timeOfDay: current.timeOfDay,
      timeOfDayMs: current.timeOfDayMs,
      loggerTimestamp: current.loggerTimestamp,
      lat: current.lat,
      lon: current.lon,
      altitudeMsl: current.altitudeMsl,
      geoidSeparation: current.geoidSeparation,
      fixQuality: current.fixQuality,
      fixValid: VALID_FIX_QUALITIES.has(current.fixQuality) && Number.isFinite(current.lat) && Number.isFinite(current.lon),
      satellites: current.satellites,
      hdop: current.hdop,
      pdop: current.pdop,
      vdop: current.vdop,
      gsaFixType: current.gsaFixType,
      satellitesUsed: current.satellitesUsed,
      rmcStatus: current.rmcStatus,
      rmcMode: current.rmcMode,
      speedMps: Number.isFinite(current.speedKnots) ? current.speedKnots * 0.514444 : null,
      courseDegrees: current.courseDegrees,
      augmentation,
      qzss: {
        visibleCount: current.qzssVisibleCount,
        satellites: qzssSatellites,
        usedInFix: current.satellitesUsed.length ? qzssUsedPrns.length > 0 : null,
        usedPrns: qzssUsedPrns
      },
      checksumValid: current.checksumValid,
      rawRefs: current.rawRefs
    });
    if (Number.isFinite(current.timeOfDayMs)) lastCaptureTimeOfDayMs = current.timeOfDayMs;
    sequence += 1;
    current = null;
  };

  rawLines.forEach((rawLine, lineIndex) => {
    const dollarIndex = rawLine.indexOf("$");
    if (dollarIndex < 0) {
      if (rawLine.trim()) ignoredLines += 1;
      return;
    }
    const loggerTimestamp = rawLine.slice(0, dollarIndex).trim() || null;
    const sentence = rawLine.slice(dollarIndex).trim();
    const checksumValid = validateNmeaChecksum(sentence);
    if (checksumValid === true) validChecksums += 1;
    else if (checksumValid === false) invalidChecksums += 1;
    else missingChecksums += 1;

    const withoutChecksum = sentence.split("*")[0];
    const fields = withoutChecksum.split(",");
    const sentenceId = fields[0];
    const type = sentenceId.slice(-3);
    sentenceCounts[sentenceId] = (sentenceCounts[sentenceId] || 0) + 1;

    if (type === "GGA") {
      finishCurrent();
      const fixQuality = numberOrNull(fields[6]);
      current = {
        sourceLine: lineIndex + 1,
        loggerTimestamp,
        timeOfDay: fields[1] || "",
        timeOfDayMs: parseNmeaTime(fields[1]),
        dateParts: null,
        lat: parseCoordinate(fields[2], fields[3], 2),
        lon: parseCoordinate(fields[4], fields[5], 3),
        fixQuality,
        satellites: numberOrNull(fields[7]),
        hdop: numberOrNull(fields[8]),
        altitudeMsl: numberOrNull(fields[9]),
        geoidSeparation: numberOrNull(fields[11]),
        pdop: null,
        vdop: null,
        gsaFixType: null,
        satellitesUsed: [],
        rmcStatus: null,
        rmcMode: null,
        speedKnots: null,
        courseDegrees: null,
        qzssVisibleCount: null,
        qzssSatelliteMap: new Map(),
        checksumValid,
        rawRefs: [{ line: lineIndex + 1, type: sentenceId, sentence }]
      };
      return;
    }

    if (!current) {
      ignoredLines += 1;
      return;
    }
    current.rawRefs.push({ line: lineIndex + 1, type: sentenceId, sentence });

    if (type === "RMC") {
      current.rmcStatus = fields[2] || null;
      current.rmcMode = fields[12] || null;
      current.speedKnots = numberOrNull(fields[7]);
      current.courseDegrees = numberOrNull(fields[8]);
      current.dateParts = parseRmcDate(fields[9]) || current.dateParts;
    } else if (type === "ZDA") {
      current.dateParts = parseZdaDate(fields) || current.dateParts;
    } else if (type === "GLL") {
      current.rmcMode = current.rmcMode || fields[7] || null;
    } else if (type === "GSA") {
      current.gsaFixType = numberOrNull(fields[2]);
      current.satellitesUsed = fields.slice(3, 15).filter(Boolean);
      current.pdop = numberOrNull(fields[15]);
      current.hdop = current.hdop ?? numberOrNull(fields[16]);
      current.vdop = numberOrNull(fields[17]);
    } else if (sentenceId === "$GQGSV") {
      current.qzssVisibleCount = Math.max(current.qzssVisibleCount || 0, numberOrNull(fields[3]) || 0);
      for (let index = 4; index + 3 < fields.length; index += 4) {
        const prn = fields[index];
        if (!prn) continue;
        current.qzssSatelliteMap.set(prn, {
          prn,
          elevationDegrees: numberOrNull(fields[index + 1]),
          azimuthDegrees: numberOrNull(fields[index + 2]),
          snrDbHz: numberOrNull(fields[index + 3])
        });
      }
    }
  });
  finishCurrent();

  if (invalidChecksums > 0) parserWarnings.push(`${invalidChecksums}件のNMEAチェックサム不一致があります。`);
  if (observations.every((observation) => observation.timestampUtcMs === null)) {
    parserWarnings.push("完全なUTC日時を作れません。捕捉日を設定してください。");
  }

  const validObservations = observations.filter((observation) => observation.fixValid);
  const augmentedObservations = observations.filter((observation) => observation.augmentation.status === "inferred" || observation.augmentation.status === "active");
  return {
    session: {
      id: sessionId,
      receiverId: receiver.id,
      captureGroupId: options.captureGroupId || "capture-default",
      sourceType: options.sourceType || "file",
      sourceName: options.sourceName || "NMEA",
      simulated: Boolean(options.simulated),
      expectedRateHz: Number(options.expectedRateHz) || 1,
      captureDate: options.captureDate || null,
      manualClockOffsetMs: Number(options.manualClockOffsetMs) || 0,
      parserSummary: {
        rawLineCount: rawLines.length,
        observationCount: observations.length,
        validFixCount: validObservations.length,
        noFixCount: observations.length - validObservations.length,
        augmentedCount: augmentedObservations.length,
        sentenceCounts,
        validChecksums,
        invalidChecksums,
        missingChecksums,
        ignoredLines
      },
      warnings: parserWarnings
    },
    observations
  };
}

export function parseCoordinate(value, hemisphere, degreeDigits) {
  if (!value || !hemisphere || value.length <= degreeDigits) return null;
  const degrees = Number.parseInt(value.slice(0, degreeDigits), 10);
  const minutes = Number.parseFloat(value.slice(degreeDigits));
  if (!Number.isFinite(degrees) || !Number.isFinite(minutes)) return null;
  const direction = hemisphere.toUpperCase();
  if (!["N", "S", "E", "W"].includes(direction)) return null;
  return (direction === "S" || direction === "W" ? -1 : 1) * (degrees + minutes / 60);
}

function deriveAugmentation(fixQuality, rmcMode, receiver, qzssVisibleCount) {
  const evidence = [];
  if (fixQuality === 2) evidence.push("GGA_DIFFERENTIAL_FIX");
  if (rmcMode === "D") evidence.push("RMC_DIFFERENTIAL_MODE");
  if (qzssVisibleCount > 0) evidence.push("QZSS_VISIBLE");
  if (fixQuality === 2) return { service: null, status: "inferred", evidence };
  if (fixQuality === 4 || fixQuality === 5) return { service: "RTK", status: "active", evidence: [`GGA_FIX_${fixQuality}`] };
  return { service: null, status: fixQuality === 1 ? "inactive" : "unknown", evidence };
}

function parseNmeaTime(value) {
  const match = String(value || "").match(/^(\d{2})(\d{2})(\d{2})(?:\.(\d+))?$/);
  if (!match) return null;
  const milliseconds = Number(`0.${match[4] || "0"}`) * 1000;
  return ((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000 + Math.round(milliseconds);
}

function parseRmcDate(value) {
  const match = String(value || "").match(/^(\d{2})(\d{2})(\d{2})$/);
  if (!match) return null;
  const year = Number(match[3]);
  return { day: Number(match[1]), month: Number(match[2]), year: year >= 80 ? 1900 + year : 2000 + year };
}

function parseZdaDate(fields) {
  const day = Number(fields[2]);
  const month = Number(fields[3]);
  const year = Number(fields[4]);
  return Number.isFinite(day) && Number.isFinite(month) && Number.isFinite(year) ? { day, month, year } : null;
}

function parseIsoDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) } : null;
}

function numberOrNull(value) {
  if (value === "" || value === undefined || value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isQzssGsaPrn(value) {
  const prn = Number(value);
  return Number.isFinite(prn) && prn >= 193 && prn <= 202;
}
