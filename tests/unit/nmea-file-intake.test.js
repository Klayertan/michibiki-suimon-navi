import test from "node:test";
import assert from "node:assert/strict";
import {
  NMEA_FILE_EXTENSIONS,
  NMEA_INTAKE_REJECTED_MESSAGE,
  describeNmeaCandidate,
  hasExpectedNmeaExtension,
  hasNmeaSentences
} from "../../js/gnss/nmea-file-intake.js";

const VALID_LOG = [
  "$GNGGA,120000.00,3439.2880,N,13549.7892,E,1,8,1.1,45.0,M,30.0,M,,*7A",
  "$GNGGA,120010.00,3439.2880,N,13549.8162,E,1,8,1.1,45.0,M,30.0,M,,*72"
].join("\r\n");

// ---------------------------------------------------------------------------
// Content is what decides
// ---------------------------------------------------------------------------

test("a QZ1 log is recognised from its sentences", () => {
  assert.equal(hasNmeaSentences(VALID_LOG), true);
});

test("a timestamp-prefixed log (Serial Bluetooth Terminal and friends) is recognised", () => {
  const text = "2026-07-06 12:00:00.123 -> $GPGGA,120000.00,3439.2880,N,13549.7892,E,1,8,1.1,45.0,M,30.0,M,,*4E";
  assert.equal(hasNmeaSentences(text), true);
});

test("non-GGA sentences still count as NMEA -- whether they yield fixes is the parser's call", () => {
  assert.equal(hasNmeaSentences("$GPRMC,120000.00,A,3439.2880,N,13549.7892,E,0.0,0.0,060726,,,A*70"), true);
  assert.equal(hasNmeaSentences("$GPGSV,3,1,11,01,45,100,40*70"), true);
});

test("arbitrary files, empty files and non-strings are rejected", () => {
  assert.equal(hasNmeaSentences("hello world"), false);
  assert.equal(hasNmeaSentences('{"type":"FeatureCollection","features":[]}'), false);
  assert.equal(hasNmeaSentences(""), false);
  assert.equal(hasNmeaSentences(null), false);
  assert.equal(hasNmeaSentences(undefined), false);
  assert.equal(hasNmeaSentences(12345), false);
});

test("a dollar sign alone is not an NMEA sentence", () => {
  assert.equal(hasNmeaSentences("total: $1,200 spent on fertiliser"), false);
  assert.equal(hasNmeaSentences("$GG,"), false);
});

// ---------------------------------------------------------------------------
// Extension: expected, but never a reason to reject
// ---------------------------------------------------------------------------

test("the extensions we expect are the ones the old accept filter listed", () => {
  assert.deepEqual(NMEA_FILE_EXTENSIONS, [".nmea", ".txt", ".log"]);
  assert.equal(hasExpectedNmeaExtension("field01.nmea"), true);
  assert.equal(hasExpectedNmeaExtension("FIELD01.NMEA"), true);
  assert.equal(hasExpectedNmeaExtension("walk.txt"), true);
  assert.equal(hasExpectedNmeaExtension("session.log"), true);
  assert.equal(hasExpectedNmeaExtension("photo.jpg"), false);
  assert.equal(hasExpectedNmeaExtension(""), false);
  assert.equal(hasExpectedNmeaExtension(undefined), false);
});

test("an unexpected extension over valid NMEA is still accepted", () => {
  const result = describeNmeaCandidate({ name: "qz1-export", text: VALID_LOG });
  assert.equal(result.accepted, true);
  assert.equal(result.expectedExtension, false);
  assert.equal(result.message, null);
});

test("a .nmea name over garbage is still rejected", () => {
  const result = describeNmeaCandidate({ name: "field01.nmea", text: "not a recording at all" });
  assert.equal(result.accepted, false);
  assert.equal(result.expectedExtension, true);
  assert.equal(result.message, NMEA_INTAKE_REJECTED_MESSAGE);
});

// ---------------------------------------------------------------------------
// The iPhone case: MIME type must not participate
// ---------------------------------------------------------------------------

test("iOS-style File shapes are accepted -- MIME type is never consulted", () => {
  // iOS Safari reports "" or "application/octet-stream" for a custom .nmea
  // file. Both used to be indistinguishable from "not a text file".
  for (const type of ["", "application/octet-stream", "text/plain", undefined]) {
    const result = describeNmeaCandidate({ name: "field01.nmea", type, text: VALID_LOG });
    assert.equal(result.accepted, true, `type ${JSON.stringify(type)} should be accepted`);
  }
});

test("the rejection message is farmer-readable and names the recovery action", () => {
  assert.equal(
    NMEA_INTAKE_REJECTED_MESSAGE,
    "NMEAデータを確認できませんでした。QZ1から保存したNMEAログを選んでください。"
  );
});

test("a missing/blank candidate is rejected rather than throwing", () => {
  assert.equal(describeNmeaCandidate().accepted, false);
  assert.equal(describeNmeaCandidate({}).accepted, false);
  assert.equal(describeNmeaCandidate({ name: "x.nmea" }).accepted, false);
});
