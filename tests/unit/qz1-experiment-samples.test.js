import test from "node:test";
import assert from "node:assert/strict";
import { parseNmeaSession } from "../../js/gnss/nmea-parser.js";
import {
  alwaysMissingFields,
  describeTelemetryCoverage,
  findGgaSentence,
  observationToSample,
  observationsToSamples,
  serialPointToSample
} from "../../js/qz1-water-level/experiment-samples.js";

// SYNTHETIC fixtures. Hand-written sentences with correct checksums; they
// exercise the adapter, and prove nothing about any receiver's accuracy.
const SYNTHETIC_GGA_WITH_GSA = [
  "$GPGGA,020000.00,3500.0000,N,13500.0000,E,1,09,0.9,50.123,M,36.0,M,,*5C",
  "$GNGSA,A,3,01,02,03,04,05,06,07,08,,,,,1.8,0.9,1.5*2E",
  "$GNRMC,020000.00,A,3500.0000,N,13500.0000,E,0.0,0.0,150126,,,A*68",
  ""
].join("\r\n");

// GGA only — no GSA, so no VDOP/PDOP exists to report.
const SYNTHETIC_GGA_ONLY = [
  "$GPGGA,020001.00,3500.0000,N,13500.0000,E,1,09,0.9,50.150,M,36.0,M,,*5A",
  ""
].join("\r\n");

test("altitude is carried in both metres and millimetres, with no rounding loss", () => {
  const parsed = parseNmeaSession(SYNTHETIC_GGA_WITH_GSA, { captureDate: "2026-01-15" });
  const [sample] = observationsToSamples(parsed.observations);
  assert.equal(sample.altitudeM, 50.123);
  assert.ok(Math.abs(sample.altitudeMm - 50123) < 1e-6, "50.123 m is 50123 mm");
});

test("DOPs from GSA reach the sample", () => {
  const parsed = parseNmeaSession(SYNTHETIC_GGA_WITH_GSA, { captureDate: "2026-01-15" });
  const [sample] = observationsToSamples(parsed.observations);
  assert.equal(sample.hdop, 0.9);
  assert.equal(sample.vdop, 1.5);
  assert.equal(sample.pdop, 1.8);
  assert.equal(sample.satellites, 9);
  assert.equal(sample.fix, 1);
});

test("a GGA-only log leaves VDOP/PDOP null — it does not invent them", () => {
  const parsed = parseNmeaSession(SYNTHETIC_GGA_ONLY, { captureDate: "2026-01-15" });
  const [sample] = observationsToSamples(parsed.observations);
  assert.equal(sample.vdop, null, "absent VDOP must stay absent");
  assert.equal(sample.pdop, null);
  assert.equal(sample.hdop, 0.9, "HDOP is in GGA and is present");
});

test("absent telemetry is null, never 0 (Number(null) === 0 is the trap)", () => {
  // The single most dangerous coercion in this pipeline: a receiver that
  // never reports QZSS visibility must not read as "0 satellites visible".
  const sample = observationToSample({
    altitudeMsl: 50, qzss: { visibleCount: null }, satellites: null, hdop: "", vdop: undefined
  });
  assert.equal(sample.qzssVisible, null);
  assert.equal(sample.satellites, null);
  assert.equal(sample.hdop, null);
  assert.equal(sample.vdop, null);
});

test("a zero that the receiver really did report survives", () => {
  const sample = observationToSample({ altitudeMsl: 0, satellites: 0, fixQuality: 0, hdop: 0 });
  assert.equal(sample.altitudeMm, 0, "0.000 m is a real altitude reading");
  assert.equal(sample.satellites, 0);
  assert.equal(sample.fix, 0);
  assert.equal(sample.hdop, 0);
});

test("the raw GGA sentence is preserved verbatim for audit", () => {
  const parsed = parseNmeaSession(SYNTHETIC_GGA_WITH_GSA, { captureDate: "2026-01-15" });
  const [sample] = observationsToSamples(parsed.observations);
  assert.equal(sample.nmea, "$GPGGA,020000.00,3500.0000,N,13500.0000,E,1,09,0.9,50.123,M,36.0,M,,*5C");
});

test("findGgaSentence picks GGA out of an epoch, not merely the first sentence", () => {
  assert.equal(findGgaSentence({ rawRefs: [{ type: "$GNRMC", sentence: "R" }, { type: "$GPGGA", sentence: "G" }] }), "G");
  assert.equal(findGgaSentence({ rawRefs: [{ type: "$GNRMC", sentence: "R" }] }), null);
  assert.equal(findGgaSentence({}), null);
});

test("malformed input produces a sample full of nulls rather than throwing", () => {
  for (const input of [null, undefined, {}, { altitudeMsl: "not a number" }]) {
    const sample = observationToSample(input);
    assert.equal(sample.altitudeMm, null);
    assert.equal(sample.latitude, null);
  }
});

test("a live serial fix uses the host clock and says so", () => {
  const sample = serialPointToSample(
    { lat: 35, lon: 135, altitude: 50.5, fixQuality: 2, satellites: 12, hdop: 0.8, timestamp: "020000.00" },
    1_700_000_000_000,
    "$GPGGA,..."
  );
  assert.equal(sample.timestampUtcMs, 1_700_000_000_000);
  assert.equal(sample.timestampSource, "host-clock");
  assert.equal(sample.gnssTimeOfDay, "020000.00", "the receiver's own time is kept for comparison");
  assert.equal(sample.altitudeMm, 50500);
  // The live path reads GGA only; those fields genuinely are not available.
  assert.equal(sample.vdop, null);
  assert.equal(sample.pdop, null);
  assert.equal(sample.geoidSeparationM, null);
});

test("telemetry coverage counts what the receiver actually sent", () => {
  const parsed = parseNmeaSession(`${SYNTHETIC_GGA_WITH_GSA}${SYNTHETIC_GGA_ONLY}`, { captureDate: "2026-01-15" });
  const samples = observationsToSamples(parsed.observations);
  const coverage = describeTelemetryCoverage(samples);
  assert.equal(coverage.altitudeMm.present, 2);
  assert.equal(coverage.vdop.present, 1, "only the epoch with GSA has VDOP");
  assert.equal(coverage.vdop.missing, 1);
});

test("fields the receiver never sent are listed by name", () => {
  const parsed = parseNmeaSession(SYNTHETIC_GGA_ONLY, { captureDate: "2026-01-15" });
  const coverage = describeTelemetryCoverage(observationsToSamples(parsed.observations));
  const missing = alwaysMissingFields(coverage);
  assert.ok(missing.includes("vdop"), "a GGA-only receiver must be reported as never sending VDOP");
  assert.ok(missing.includes("pdop"));
  assert.ok(!missing.includes("altitudeMm"));
});
