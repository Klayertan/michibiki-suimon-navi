import test from "node:test";
import assert from "node:assert/strict";
import { classifyFix } from "../../js/gnss/gnss-quality.js";
import { SatelliteTracker, constellationFor, skyPlotPosition, snrColor } from "../../js/gnss/satellite-tracker.js";
import { compassHeadingFromEvent, formatHeadingLabel, knotsToMs, normalizeHeading, resolveHeading, smoothHeading } from "../../js/gnss/heading.js";

test("classifyFix: augmented fix with good geometry is good (green)", () => {
  const result = classifyFix({ fixQuality: 2, hdop: 0.9, satellites: 14 });
  assert.equal(result.level, "good");
  assert.equal(result.color, "#15803d");
  assert.equal(result.augmented, true);
});

test("classifyFix: single-point fix is fair (orange), never good", () => {
  assert.equal(classifyFix({ fixQuality: 1, hdop: 0.7, satellites: 16 }).level, "fair");
});

test("classifyFix: augmented fix with weak geometry drops to fair or poor", () => {
  assert.equal(classifyFix({ fixQuality: 2, hdop: 3.1, satellites: 12 }).level, "fair");
  assert.equal(classifyFix({ fixQuality: 2, hdop: 1.0, satellites: 4 }).level, "fair");
  assert.equal(classifyFix({ fixQuality: 2, hdop: 6.5, satellites: 12 }).level, "poor");
  assert.equal(classifyFix({ fixQuality: 1, hdop: 1.0, satellites: 3 }).level, "poor");
});

test("classifyFix: missing hdop/satellites does not block an augmented fix", () => {
  assert.equal(classifyFix({ fixQuality: 2 }).level, "good");
});

test("classifyFix: no fix and invalid quality are none", () => {
  assert.equal(classifyFix({ fixQuality: 0 }).level, "none");
  assert.equal(classifyFix(null).level, "none");
  assert.equal(classifyFix({ fixQuality: 3 }).level, "none");
});

test("constellationFor: QZSS PRN range wins over the talker", () => {
  assert.equal(constellationFor("GP", "193"), "QZSS");
  assert.equal(constellationFor("GQ", "02"), "QZSS");
  assert.equal(constellationFor("GP", "07"), "GPS");
  assert.equal(constellationFor("GL", "70"), "GLONASS");
  assert.equal(constellationFor("GA", "11"), "Galileo");
  assert.equal(constellationFor("XX", "11"), "その他");
});

test("SatelliteTracker assembles a multi-sentence GSV cycle and marks used PRNs", () => {
  const tracker = new SatelliteTracker();
  tracker.ingest("$GPGSV,2,1,06,07,45,120,38,08,30,200,27,10,60,010,41,13,15,300,", 1000);
  assert.equal(tracker.snapshot(1000).inView, 0, "a cycle is not visible until its last message arrives");
  tracker.ingest("$GPGSV,2,2,06,193,70,180,44,194,12,045,20", 1000);
  tracker.ingest("$GNGSA,A,3,07,10,193,,,,,,,,,,1.2,0.9,0.8", 1000);
  const snapshot = tracker.snapshot(1500);
  assert.equal(snapshot.inView, 6);
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.qzssInView, 2);
  assert.equal(snapshot.used, 3);
  const untracked = snapshot.satellites.find((satellite) => satellite.prn === "13");
  assert.equal(untracked.tracked, false, "empty C/N0 means in view but not tracked");
  assert.equal(snapshot.tracked, 5);
  // QZSS sorts first.
  assert.equal(snapshot.satellites[0].constellation, "QZSS");
});

test("used satellites do not depend on sentence order and expire when GSA stops", () => {
  const tracker = new SatelliteTracker({ usedTtlMs: 3000 });
  tracker.ingest("$GPGSV,1,1,03,07,45,120,38,10,30,200,27,13,60,010,41", 0);
  tracker.ingest("$GNGSA,A,3,07,10,,,,,,,,,,,1.2,0.9,0.8", 100);
  // An RMC arriving after the GSA (receivers that send RMC last) must not wipe it.
  tracker.ingest("$GNRMC,012345.00,A,3439.2705,N,13549.8410,E,1.00,90.0,120726,,,D", 200);
  assert.deepEqual(tracker.snapshot(500).satellites.filter((s) => s.used).map((s) => s.prn), ["07", "10"]);
  // Several GSA lines per epoch accumulate (one per constellation).
  tracker.ingest("$GNGSA,A,3,13,,,,,,,,,,,,1.2,0.9,0.8", 600);
  assert.equal(tracker.snapshot(700).used, 3);
  // No GSA for longer than the TTL: nothing is claimed as used any more.
  assert.equal(tracker.snapshot(10_000).used, 0);
});

test("SatelliteTracker replaces a talker's satellites each cycle and ignores a cycle joined mid-way", () => {
  const tracker = new SatelliteTracker();
  tracker.ingest("$GPGSV,2,2,05,20,10,010,30", 0);
  assert.equal(tracker.snapshot(0).inView, 0);
  tracker.ingest("$GPGSV,1,1,02,07,45,120,38,08,30,200,27", 0);
  tracker.ingest("$GPGSV,1,1,01,09,45,120,38", 1000);
  const prns = tracker.snapshot(1000).satellites.map((satellite) => satellite.prn);
  assert.deepEqual(prns, ["09"]);
});

test("SatelliteTracker reports stale when GSV stops arriving", () => {
  const tracker = new SatelliteTracker({ staleAfterMs: 5000 });
  tracker.ingest("$GPGSV,1,1,01,09,45,120,38", 0);
  assert.equal(tracker.snapshot(4000).stale, false);
  assert.equal(tracker.snapshot(9000).stale, true);
  assert.equal(new SatelliteTracker().snapshot(0).stale, true);
});

test("SatelliteTracker reads course and speed from RMC and can enforce checksums", () => {
  const tracker = new SatelliteTracker();
  tracker.ingest("$GNRMC,012345.00,A,3439.2705,N,13549.8410,E,1.94,87.5,120726,,,D", 0);
  const snapshot = tracker.snapshot(0);
  assert.equal(snapshot.course, 87.5);
  assert.equal(snapshot.speedKnots, 1.94);

  const strict = new SatelliteTracker({ requireChecksum: true });
  assert.equal(strict.ingest("$GPGSV,1,1,01,09,45,120,38*00", 0), false);
  assert.equal(strict.snapshot(0).inView, 0);
});

test("skyPlotPosition puts zenith at the centre and north up", () => {
  const zenith = skyPlotPosition({ elevation: 90, azimuth: 123 });
  assert.ok(Math.abs(zenith.x) < 1e-9 && Math.abs(zenith.y) < 1e-9);
  const north = skyPlotPosition({ elevation: 0, azimuth: 0 });
  assert.ok(Math.abs(north.x) < 1e-9 && Math.abs(north.y + 1) < 1e-9);
  const east = skyPlotPosition({ elevation: 0, azimuth: 90 });
  assert.ok(Math.abs(east.x - 1) < 1e-9 && Math.abs(east.y) < 1e-9);
  assert.equal(skyPlotPosition({ elevation: null, azimuth: 10 }), null);
});

test("snrColor bands", () => {
  assert.equal(snrColor(40), "#15803d");
  assert.equal(snrColor(30), "#d97706");
  assert.equal(snrColor(15), "#b91c1c");
  assert.equal(snrColor(null), "#94a3b8");
});

test("resolveHeading prefers course while moving, compass when still, null with neither", () => {
  assert.deepEqual(resolveHeading({ courseDegrees: 90, speedMs: 1.5, compassDegrees: 200 }), { degrees: 90, source: "course" });
  assert.deepEqual(resolveHeading({ courseDegrees: 90, speedMs: 0.1, compassDegrees: 200 }), { degrees: 200, source: "compass" });
  assert.deepEqual(resolveHeading({ courseDegrees: 90, speedMs: null, compassDegrees: 370 }), { degrees: 10, source: "compass" });
  assert.equal(resolveHeading({ courseDegrees: 90, speedMs: 0.1 }), null);
  assert.equal(resolveHeading(), null);
});

test("compassHeadingFromEvent handles iOS, Android absolute, and rejects relative events", () => {
  assert.equal(compassHeadingFromEvent({ webkitCompassHeading: 45 }), 45);
  assert.equal(compassHeadingFromEvent({ absolute: true, alpha: 90 }), 270);
  assert.equal(compassHeadingFromEvent({ absolute: true, alpha: 0 }), 0);
  assert.equal(compassHeadingFromEvent({ absolute: false, alpha: 90 }), null);
  assert.equal(compassHeadingFromEvent({ absolute: true, alpha: 90 }, 90), 0);
  assert.equal(compassHeadingFromEvent(null), null);
});

test("smoothHeading takes the short way across north", () => {
  const next = smoothHeading(350, 10, 0.5);
  assert.equal(Math.round(next), 0);
  assert.equal(smoothHeading(null, 123), 123);
  assert.equal(smoothHeading(40, NaN), 40);
});

test("heading helpers", () => {
  assert.equal(normalizeHeading(-90), 270);
  assert.equal(normalizeHeading(Number.NaN), null);
  assert.ok(Math.abs(knotsToMs(10) - 5.14444) < 1e-6);
  assert.equal(formatHeadingLabel(null), "方位不明");
  assert.match(formatHeadingLabel({ degrees: 92, source: "course" }), /東 92°（進行方向）/);
});
