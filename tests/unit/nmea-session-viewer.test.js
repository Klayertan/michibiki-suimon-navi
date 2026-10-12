import test from "node:test";
import assert from "node:assert/strict";
import {
  buildNmeaText,
  canDeleteSession,
  compareSessionsNewestFirst,
  describeSession,
  mapApplySourceLabel,
  nmeaLinesFromRecords,
  previewLines,
  previewToText,
  summarizeNmea
} from "../../js/recording/nmea-session-viewer.js";

function withChecksum(body) {
  let sum = 0;
  for (const character of body) sum ^= character.charCodeAt(0);
  return `$${body}*${sum.toString(16).toUpperCase().padStart(2, "0")}`;
}

const GOOD = withChecksum("GNGGA,012345.00,3439.2705,N,13549.8410,E,2,14,0.9,45.0,M,30.0,M,,");
const SINGLE = withChecksum("GNGGA,012346.00,3439.2706,N,13549.8412,E,1,09,1.4,45.1,M,30.0,M,,");
const POOR = withChecksum("GNGGA,012347.00,3439.2707,N,13549.8414,E,1,04,6.5,45.2,M,30.0,M,,");
const NOFIX = withChecksum("GNGGA,012348.00,,,,,0,00,99.99,,M,,M,,");
const RMC = withChecksum("GNRMC,012345.00,A,3439.2705,N,13549.8410,E,1.0,90.0,120726,,,D");

test("records are ordered by seq and joined with CRLF, byte-identical to the .nmea export", () => {
  const records = [{ seq: 2, line: "$B" }, { seq: 1, line: "$A" }, { seq: 3, line: "" }];
  assert.deepEqual(nmeaLinesFromRecords(records), ["$A", "$B"]);
  assert.equal(buildNmeaText(records), "$A\r\n$B\r\n");
  assert.equal(buildNmeaText([]), "");
  assert.equal(buildNmeaText(null), "");
});

test("summarizeNmea counts fixes, quality grades, sentence types, time span and bad checksums", () => {
  const lines = [GOOD, RMC, SINGLE, POOR, NOFIX, "$GNGGA,012349.00,3439.2705,N,13549.8410,E,2,14,0.9,45.0,M,30.0,M,,*00"];
  const summary = summarizeNmea(lines);
  assert.equal(summary.totalLines, 6);
  assert.equal(summary.ggaTotal, 5);
  assert.equal(summary.validFixes, 4);
  assert.equal(summary.noFix, 1);
  assert.deepEqual(summary.quality, { good: 2, fair: 1, poor: 1 });
  assert.equal(summary.checksumInvalid, 1);
  assert.equal(summary.firstUtc, "01:23:45");
  assert.equal(summary.lastUtc, "01:23:49");
  assert.deepEqual(summary.sentenceTypes[0], ["GGA", 5]);
  assert.ok(summary.bytes > 0);
});

test("summarizeNmea copes with an empty or GGA-less recording", () => {
  const empty = summarizeNmea([]);
  assert.equal(empty.totalLines, 0);
  assert.equal(empty.validFixes, 0);
  assert.equal(empty.firstUtc, null);
  const rmcOnly = summarizeNmea([RMC]);
  assert.equal(rmcOnly.validFixes, 0);
  assert.equal(rmcOnly.totalLines, 1);
});

test("previewLines keeps a short log whole and elides the middle of a long one", () => {
  const short = Array.from({ length: 10 }, (_, i) => `l${i}`);
  assert.deepEqual(previewLines(short, { head: 5, tail: 5 }), { head: short, tail: [], hidden: 0 });
  const long = Array.from({ length: 100 }, (_, i) => `l${i}`);
  const preview = previewLines(long, { head: 3, tail: 2 });
  assert.deepEqual(preview.head, ["l0", "l1", "l2"]);
  assert.deepEqual(preview.tail, ["l98", "l99"]);
  assert.equal(preview.hidden, 95);
  const text = previewToText(preview);
  assert.match(text, /95 行を省略/);
  assert.equal(text.split("\n").length, 6);
});

test("describeSession and ordering", () => {
  const label = describeSession({ startedAt: "2026-10-12T07:30:00.000Z", status: "stopped", fieldName: "圃場A" }, 1234);
  assert.match(label, /圃場A/);
  assert.match(label, /1,234行/);
  assert.match(label, /（終了）/);
  assert.match(describeSession({ status: "recording" }, null), /日時不明.*（記録中）/);
  const sorted = [{ startedAt: "2026-01-01" }, { startedAt: "2026-03-01" }, { startedAt: "2026-02-01" }].sort(compareSessionsNewestFirst);
  assert.deepEqual(sorted.map((s) => s.startedAt), ["2026-03-01", "2026-02-01", "2026-01-01"]);
});

test("a session that is still being recorded cannot be deleted; a finished or other one can", () => {
  const session = { sessionId: "s1" };
  assert.equal(canDeleteSession(session, "s1", "recording").allowed, false);
  assert.equal(canDeleteSession(session, "s1", "paused").allowed, false);
  assert.equal(canDeleteSession(session, "s1", "stopped").allowed, true);
  assert.equal(canDeleteSession(session, "other", "recording").allowed, true);
  assert.equal(canDeleteSession(null, "s1", "stopped").allowed, false);
  assert.match(canDeleteSession(session, "s1", "recording").reason, /記録終了/);
});

test("mapApplySourceLabel names the session", () => {
  assert.equal(mapApplySourceLabel({ sessionId: "abc" }), "記録 abc");
});
