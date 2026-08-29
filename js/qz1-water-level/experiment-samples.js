// The seam between the EXISTING shared NMEA stack and the water-level
// experiment. This project already has one GNSS parser
// (js/gnss/nmea-parser.js) that produces rich observation records — altitude,
// geoid separation, fix quality, satellites, HDOP/VDOP/PDOP, QZSS visibility
// and a reference back to every raw sentence. Adding a second parser would
// mean two definitions of "what the receiver said", and the experiment would
// then be measuring the difference between our own parsers as much as
// anything the receiver did.
//
// So: this module ADAPTS, it does not parse. Everything below is a field
// rename plus a unit conversion plus a segment label. If a value is missing
// from the observation it stays missing here — see NEVER SYNTHESIZE.
//
// NEVER SYNTHESIZE
// ----------------
// A sample whose altitude is absent is not a sample with altitude 0, and a
// fix with no VDOP is not a fix with VDOP 99. Missing telemetry is carried
// as `null` all the way into the CSV, and the analysis counts nulls rather
// than imputing them. QZ1's GGA carries no VDOP at all; VDOP arrives only if
// the receiver also emits GSA. That is a property of the device, and the
// output must show it rather than paper over it.
//
// UNITS
// -----
// NMEA GGA altitude is metres above the geoid (MSL). The experiment works in
// millimetres because its whole subject matter is 10–100 mm steps, and
// because floating-point metres would put the interesting digits four places
// down. `altitudeMm` is therefore the working value; `altitudeM` is kept
// beside it exactly as the receiver reported it, so nothing is lost.

/**
 * Converts one observation from `parseNmeaSession()` into an experiment
 * sample, tagged with the reference height it was taken at.
 *
 * @param observation one element of `parseNmeaSession().observations`
 * @param segment     `{ referenceHeightMm, stepIndex, visitIndex, direction }`
 *                    or null when the sample belongs to no labelled step
 */
export function observationToSample(observation, segment = null) {
  const altitudeM = finiteOrNull(observation?.altitudeMsl);
  return {
    // Identity / traceability back to raw
    id: observation?.id ?? null,
    sessionId: observation?.sessionId ?? null,
    sampleIndex: finiteOrNull(observation?.sequence),
    sourceLine: finiteOrNull(observation?.sourceLine),
    // The GGA sentence exactly as received, so any row in the experiment CSV
    // can be checked against the wire data by eye.
    nmea: findGgaSentence(observation) ?? "",

    // Time
    timestampUtcMs: finiteOrNull(observation?.timestampUtcMs),
    gnssTimeOfDay: observation?.timeOfDay ?? "",
    loggerTimestamp: observation?.loggerTimestamp ?? null,

    // Position
    latitude: finiteOrNull(observation?.lat),
    longitude: finiteOrNull(observation?.lon),
    altitudeM,
    altitudeMm: altitudeM === null ? null : altitudeM * 1000,
    geoidSeparationM: finiteOrNull(observation?.geoidSeparation),

    // Quality — every one of these may legitimately be null
    fix: finiteOrNull(observation?.fixQuality),
    fixValid: observation?.fixValid === true,
    satellites: finiteOrNull(observation?.satellites),
    hdop: finiteOrNull(observation?.hdop),
    vdop: finiteOrNull(observation?.vdop),
    pdop: finiteOrNull(observation?.pdop),
    qzssVisible: finiteOrNull(observation?.qzss?.visibleCount),
    qzssUsedInFix: observation?.qzss?.usedInFix ?? null,

    // Experiment labelling
    referenceHeightMm: segment ? finiteOrNull(segment.referenceHeightMm) : null,
    stepIndex: segment ? finiteOrNull(segment.stepIndex) : null,
    visitIndex: segment ? finiteOrNull(segment.visitIndex) : null,
    direction: segment ? (segment.direction ?? null) : null
  };
}

/** Batch form of `observationToSample` with no segment labelling. */
export function observationsToSamples(observations, segmentResolver = () => null) {
  return (observations || []).map((observation) =>
    observationToSample(observation, segmentResolver(observation)));
}

/**
 * Which of an observation's raw sentences is the GGA one.
 *
 * The parser groups every sentence that belongs to one fix epoch under
 * `rawRefs`, with GGA always first because GGA is what opens an epoch. The
 * search is explicit anyway rather than taking `[0]` on faith.
 */
export function findGgaSentence(observation) {
  const refs = observation?.rawRefs;
  if (!Array.isArray(refs)) {
    return null;
  }
  const gga = refs.find((ref) => typeof ref?.type === "string" && ref.type.endsWith("GGA"));
  return gga?.sentence ?? null;
}

/**
 * Adapts a LIVE fix from index.html's serial pipeline into an experiment
 * sample.
 *
 * WHICH CLOCK `timestampUtcMs` IS, AND WHY
 * ----------------------------------------
 * For live capture it is the HOST clock at the moment the sentence arrived,
 * not GNSS time. That is a deliberate choice, not a shortcut:
 *
 *   * The operator's level marks are stamped by the same host clock when they
 *     press 確認. Mixing clocks — marks on the host clock, samples on GNSS
 *     time — would offset every segment boundary by the difference between
 *     them, which is exactly the kind of silent mislabelling this pipeline
 *     is built to avoid.
 *   * GGA alone carries only a time of day, with no date. Reconstructing a
 *     full UTC timestamp from it means assuming a date, and an assumption
 *     about the date is precisely the sort of invented value the brief
 *     forbids.
 *
 * The receiver's own time of day is preserved verbatim in `gnssTimeOfDay` and
 * written to the CSV, so the two clocks can be compared after the fact. The
 * offline path (a recorded NMEA file through `parseNmeaSession`) uses real
 * GNSS UTC instead, because there RMC/ZDA supply the date — and the marks for
 * that path must be in the same GNSS UTC. See EXPERIMENT.md.
 *
 * @param point      one `point` from index.html's `parseNmea`
 * @param receivedAtMs host clock at arrival
 * @param rawLine    the GGA sentence as received
 */
export function serialPointToSample(point, receivedAtMs, rawLine = "") {
  const altitudeM = finiteOrNull(point?.altitude);
  return {
    id: point?.id ?? null,
    sessionId: null,
    sampleIndex: null,
    sourceLine: null,
    nmea: rawLine,
    timestampUtcMs: Number.isFinite(receivedAtMs) ? receivedAtMs : null,
    timestampSource: "host-clock",
    gnssTimeOfDay: point?.timestamp ?? "",
    loggerTimestamp: null,
    latitude: finiteOrNull(point?.lat),
    longitude: finiteOrNull(point?.lon),
    altitudeM,
    altitudeMm: altitudeM === null ? null : altitudeM * 1000,
    // The live parser reads GGA only and does not expose geoid separation or
    // the DOPs that live in GSA. Missing, not zero.
    geoidSeparationM: null,
    fix: finiteOrNull(point?.fixQuality),
    fixValid: finiteOrNull(point?.fixQuality) !== null && Number(point.fixQuality) > 0,
    satellites: finiteOrNull(point?.satellites),
    hdop: finiteOrNull(point?.hdop),
    vdop: null,
    pdop: null,
    qzssVisible: null,
    qzssUsedInFix: null,
    referenceHeightMm: null,
    stepIndex: null,
    visitIndex: null,
    direction: null
  };
}

/**
 * Reports which telemetry the receiver actually provided across a set of
 * samples, as a count of present values per field.
 *
 * This exists so the experiment report can state "VDOP: 0 / 1843 samples"
 * instead of quietly showing an empty column. The brief asks for VDOP and
 * PDOP; whether QZ1/QZ1LE emits them is an empirical question about the
 * device, and this is how the answer gets written down.
 */
export function describeTelemetryCoverage(samples) {
  const fields = [
    "altitudeMm", "latitude", "longitude", "fix", "satellites",
    "hdop", "vdop", "pdop", "geoidSeparationM", "timestampUtcMs",
    "qzssVisible", "nmea"
  ];
  const total = samples.length;
  const coverage = {};
  for (const field of fields) {
    const present = samples.filter((sample) => {
      const value = sample[field];
      return value !== null && value !== undefined && value !== "";
    }).length;
    coverage[field] = { present, total, missing: total - present };
  }
  return coverage;
}

/** Field names that were absent from EVERY sample — i.e. this receiver never sent them. */
export function alwaysMissingFields(coverage) {
  return Object.entries(coverage)
    .filter(([, entry]) => entry.total > 0 && entry.present === 0)
    .map(([field]) => field);
}

/**
 * A number, or null.
 *
 * The `null`/`""` guard is not defensive noise: `Number(null)` and
 * `Number("")` are both 0, so without it a receiver that never reported QZSS
 * visibility would show "0 satellites visible" — a fabricated observation,
 * and exactly what the NEVER SYNTHESIZE note at the top of this file forbids.
 * Absent stays absent.
 */
function finiteOrNull(value) {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) {
    return null;
  }
  if (typeof value !== "number" && typeof value !== "string") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
