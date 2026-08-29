import test from "node:test";
import assert from "node:assert/strict";
import {
  EXPERIMENT_CSV_COLUMNS,
  csvEscape,
  experimentToCsv,
  marksFromLabelledSamples,
  parseCsv,
  parseExperimentCsv,
  sampleToRow
} from "../../js/qz1-water-level/experiment-csv.js";

const T0 = Date.UTC(2026, 0, 15, 2, 0, 0);

/** A SYNTHETIC labelled sample. */
function sample(overrides = {}) {
  return {
    sampleIndex: 3,
    sourceLine: 12,
    nmea: "$GPGGA,020000.00,3500.0000,N,13500.0000,E,1,09,0.9,50.123,M,36.0,M,,*5C",
    timestampUtcMs: T0,
    gnssTimeOfDay: "020000.00",
    latitude: 35,
    longitude: 135,
    altitudeM: 50.123,
    altitudeMm: 50123,
    geoidSeparationM: 36,
    fix: 1,
    satellites: 9,
    hdop: 0.9,
    vdop: 1.5,
    pdop: 1.8,
    qzssVisible: 2,
    referenceHeightMm: 30,
    stepIndex: 3,
    visitIndex: 0,
    direction: "ascending",
    ...overrides
  };
}

test("the brief's twelve columns come first, in the brief's order", () => {
  assert.deepEqual(EXPERIMENT_CSV_COLUMNS.slice(0, 12), [
    "timestamp", "experiment_id", "reference_height_mm", "latitude", "longitude",
    "altitude_m", "fix", "satellites", "hdop", "vdop", "pdop", "nmea"
  ]);
});

test("a row carries the raw sentence, quoted, so the CSV stays auditable", () => {
  const csv = experimentToCsv([sample()], { experimentId: "exp-1", stage: "controlled-rig" });
  const lines = csv.trim().split("\r\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[1].includes('"$GPGGA,020000.00'), "the comma-bearing sentence must be quoted");
  const reparsed = parseCsv(csv);
  assert.equal(reparsed[1][EXPERIMENT_CSV_COLUMNS.indexOf("nmea")], sample().nmea,
    "and must survive the round trip byte for byte");
});

test("missing telemetry is an empty cell, never 0 and never a sentinel", () => {
  const row = sampleToRow(sample({ vdop: null, pdop: null, qzssVisible: null }), { experimentId: "e", stage: "s" });
  assert.equal(row.vdop, "");
  assert.equal(row.pdop, "");
  assert.equal(row.qzss_visible, "");
});

test("a genuine zero is written as 0, not as empty", () => {
  const row = sampleToRow(sample({ fix: 0, satellites: 0, hdop: 0 }), { experimentId: "e", stage: "s" });
  assert.equal(row.fix, "0");
  assert.equal(row.satellites, "0");
  assert.equal(row.hdop, "0");
});

test("empty cells read back as null, so a consumer cannot mistake them for zero", () => {
  const csv = experimentToCsv([sample({ vdop: null, pdop: null })], { experimentId: "e", stage: "s" });
  const { samples, errors } = parseExperimentCsv(csv);
  assert.deepEqual(errors, []);
  assert.equal(samples[0].vdop, null);
  assert.equal(samples[0].pdop, null);
});

test("whitespace-only numeric cells remain missing, not zero", () => {
  const csv = [
    "timestamp,reference_height_mm,altitude_m",
    "2026-01-15T02:00:00.000Z, ,  "
  ].join("\r\n");
  const { samples, errors } = parseExperimentCsv(csv);
  assert.deepEqual(errors, []);
  assert.equal(samples[0].referenceHeightMm, null);
  assert.equal(samples[0].altitudeM, null);
});

test("a malformed sample timestamp exports as an empty cell", () => {
  assert.equal(sampleToRow(sample({ timestampUtcMs: NaN }), { experimentId: "e", stage: "s" }).timestamp, "");
});

test("a full round trip preserves every value the analysis needs", () => {
  const original = sample();
  const csv = experimentToCsv([original], { experimentId: "exp-1", stage: "controlled-rig" });
  const { samples } = parseExperimentCsv(csv);
  const restored = samples[0];
  assert.equal(restored.timestampUtcMs, T0);
  assert.equal(restored.altitudeM, 50.123);
  assert.equal(restored.altitudeMm, 50123);
  assert.equal(restored.referenceHeightMm, 30);
  assert.equal(restored.fix, 1);
  assert.equal(restored.satellites, 9);
  assert.equal(restored.hdop, 0.9);
  assert.equal(restored.direction, "ascending");
  assert.equal(restored.stepIndex, 3);
});

test("columns are matched by name, not by position", () => {
  const csv = [
    "altitude_m,reference_height_mm,timestamp",
    "50.500,20,2026-01-15T02:00:00.000Z"
  ].join("\r\n");
  const { samples, errors } = parseExperimentCsv(csv);
  assert.deepEqual(errors, []);
  assert.equal(samples[0].altitudeMm, 50500);
  assert.equal(samples[0].referenceHeightMm, 20);
});

test("a CSV missing a required column is an error, not a partially filled load", () => {
  const { samples, errors } = parseExperimentCsv("timestamp,latitude\n2026-01-15T02:00:00.000Z,35");
  assert.deepEqual(samples, []);
  assert.ok(errors.some((error) => error.includes("altitude_m")));
  assert.ok(errors.some((error) => error.includes("reference_height_mm")));
});

test("an empty CSV is reported rather than silently yielding no samples", () => {
  assert.ok(parseExperimentCsv("").errors.length > 0);
});

test("RFC 4180 quoting: embedded quotes, commas and newlines survive", () => {
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(csvEscape("a,b"), '"a,b"');
  assert.equal(csvEscape("line1\nline2"), '"line1\nline2"');
  assert.equal(csvEscape(null), "");
  const table = parseCsv('a,"b,c","d""e"\r\n1,2,3\r\n');
  assert.deepEqual(table[0], ["a", "b,c", 'd"e']);
  assert.deepEqual(table[1], ["1", "2", "3"]);
});

test("marks are reconstructable from a labelled CSV, with the settle window already spent", () => {
  const samples = [
    sample({ timestampUtcMs: T0, referenceHeightMm: 0, stepIndex: 0, direction: "ascending" }),
    sample({ timestampUtcMs: T0 + 1000, referenceHeightMm: 0, stepIndex: 0, direction: "ascending" }),
    sample({ timestampUtcMs: T0 + 5000, referenceHeightMm: 10, stepIndex: 1, direction: "ascending" })
  ];
  const marks = marksFromLabelledSamples(samples);
  assert.equal(marks.length, 2);
  assert.equal(marks[0].referenceHeightMm, 0);
  assert.equal(marks[0].startMs, T0);
  assert.equal(marks[0].endMs, T0 + 1001, "half-open range includes the final sample of the step");
  assert.equal(marks[0].settleSeconds, 0,
    "the settle window was already applied when the CSV was written; re-applying would discard real data twice");
});

test("unlabelled rows are skipped when reconstructing marks, not assigned to 0 mm", () => {
  const marks = marksFromLabelledSamples([
    sample({ timestampUtcMs: T0, referenceHeightMm: null, stepIndex: null }),
    sample({ timestampUtcMs: T0 + 1000, referenceHeightMm: 50, stepIndex: 1 })
  ]);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].referenceHeightMm, 50);
});
