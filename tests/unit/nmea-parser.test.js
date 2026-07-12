import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseNmeaSession, validateNmeaChecksum } from "../../js/gnss/nmea-parser.js";

test("bundled QZ1 log preserves no-fix epochs and available metadata", async () => {
  const text = await readFile(new URL("../../data/samples/qz1-dorm-walk-20260706.txt", import.meta.url), "utf8");
  const parsed = parseNmeaSession(text, {
    receiver: { id: "qz1", role: "qz1" },
    sessionId: "qz1-campus",
    captureDate: "2026-07-06"
  });

  assert.equal(parsed.session.parserSummary.observationCount, 426);
  assert.equal(parsed.session.parserSummary.validFixCount, 206);
  assert.equal(parsed.session.parserSummary.noFixCount, 220);
  assert.equal(parsed.session.parserSummary.augmentedCount, 48);
  assert.equal(parsed.session.parserSummary.invalidChecksums, 0);
  assert.ok(parsed.observations.some((observation) => observation.qzss.visibleCount > 0));
  assert.equal(parsed.observations.filter((observation) => observation.fixValid && observation.qzss.usedInFix).length, 190);
  assert.ok(parsed.observations.every((observation) => observation.timestampDateSource === "capture-date"));
  assert.equal(new Date(parsed.observations[0].timestampUtcMs).toISOString().slice(0, 10), "2026-07-06");
});

test("capture date advances across UTC midnight", () => {
  const text = [
    "$GPGGA,235959.00,3438.0000,N,13545.0000,E,1,08,0.9,10.0,M,30.0,M,,",
    "$GPGGA,000001.00,3438.0000,N,13545.0000,E,1,08,0.9,10.0,M,30.0,M,,"
  ].join("\n");
  const parsed = parseNmeaSession(text, { receiver: { id: "qz1", role: "qz1" }, sessionId: "midnight", captureDate: "2026-07-12" });
  assert.equal(parsed.observations[1].timestampUtcMs - parsed.observations[0].timestampUtcMs, 2000);
  assert.equal(new Date(parsed.observations[1].timestampUtcMs).toISOString().slice(0, 10), "2026-07-13");
});

test("GGA fix quality 2 is differential evidence, not an unsupported SLAS assertion", () => {
  const text = "$GPGGA,120000.00,3438.0000,N,13545.0000,E,2,08,0.9,10.0,M,30.0,M,,*49";
  const parsed = parseNmeaSession(text, { receiver: { id: "qz1", role: "qz1" }, sessionId: "s", captureDate: "2026-07-12" });
  const observation = parsed.observations[0];
  assert.equal(observation.fixQuality, 2);
  assert.equal(observation.augmentation.status, "inferred");
  assert.equal(observation.augmentation.service, null);
  assert.ok(observation.augmentation.evidence.includes("GGA_DIFFERENTIAL_FIX"));
});

test("checksum validation returns true, false, or null", () => {
  assert.equal(validateNmeaChecksum("$GPGGA,000106.00,3438.8264,N,13545.3307,E,0,00,2.0,0.0,M,0.0,M,,*5D"), true);
  assert.equal(validateNmeaChecksum("$GPGGA,000106.00,3438.8264,N,13545.3307,E,0,00,2.0,0.0,M,0.0,M,,*00"), false);
  assert.equal(validateNmeaChecksum("$GPGGA,without-checksum"), null);
});
