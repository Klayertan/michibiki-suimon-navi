import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMarkedObservation,
  canTransitionRecording,
  classifySerialDiagnostics,
  DEFAULT_DIAGNOSTIC_THRESHOLDS_MS,
  formatBytes,
  isFixStale,
  makeObservationId,
  makeSessionId,
  markedObservationsToCsv,
  nextRecordingState,
  recordingFilename,
  structuredFixesToCsv,
  validateObservationCreation,
  verifyNmeaChecksum
} from "../../js/recording/recording-core.js";

test("recording state machine allows only the documented transitions", () => {
  assert.equal(nextRecordingState("idle", "start"), "recording");
  assert.equal(nextRecordingState("recording", "pause"), "paused");
  assert.equal(nextRecordingState("paused", "resume"), "recording");
  assert.equal(nextRecordingState("recording", "stop"), "stopped");
  assert.equal(nextRecordingState("stopped", "start"), "recording");
  assert.equal(nextRecordingState("recovery_available", "resume"), "recording");
  assert.equal(nextRecordingState("recovery_available", "finish"), "stopped");
  assert.equal(nextRecordingState("recovery_available", "delete"), "idle");

  // Invalid transitions must be rejected, not silently coerced.
  assert.equal(nextRecordingState("idle", "pause"), null);
  assert.equal(nextRecordingState("paused", "start"), null);
  assert.equal(nextRecordingState("stopped", "resume"), null);
  assert.equal(canTransitionRecording("idle", "start"), true);
  assert.equal(canTransitionRecording("idle", "resume"), false);
});

test("NMEA checksum verification distinguishes valid, invalid and checksum-absent lines", () => {
  // Real GGA sentence with a correct checksum.
  assert.equal(verifyNmeaChecksum("$GNGGA,012345.00,3439.2705,N,13549.8410,E,2,14,0.9,45.0,M,30.0,M,,*44"), true);
  // Same sentence, corrupted checksum byte.
  assert.equal(verifyNmeaChecksum("$GNGGA,012345.00,3439.2705,N,13549.8410,E,2,14,0.9,45.0,M,30.0,M,,*00"), false);
  // No checksum suffix at all — distinct from "checksum failed".
  assert.equal(verifyNmeaChecksum("not an nmea line"), null);
  assert.equal(verifyNmeaChecksum(""), null);
});

test("diagnostics never show a stall before any successful connection", () => {
  const now = 1_000_000;

  // Never connected at all: neutral, regardless of any stray diagTimes.
  const neverConnected = classifySerialDiagnostics({}, now, undefined, { everConnected: false });
  assert.equal(neverConnected.tier, "not-connected");
  assert.match(neverConnected.message, /Serial not connected/);
  assert.doesNotMatch(neverConnected.message, /stalled/i);

  // Connected, but not a single byte has arrived yet (e.g. right after open()).
  const connectedNoBytes = classifySerialDiagnostics({}, now, undefined, { everConnected: true });
  assert.equal(connectedNoBytes.tier, "no-data");
  assert.doesNotMatch(connectedNoBytes.message, /stalled/i);
});

test("diagnostics classify four distinct post-connection tiers instead of one generic stall", () => {
  const now = 1_000_000;
  const t = DEFAULT_DIAGNOSTIC_THRESHOLDS_MS;

  // Bytes flowing, but no complete line ever seen.
  const bytesOnly = classifySerialDiagnostics({ lastByteMs: now - 100 }, now, undefined, { everConnected: true });
  assert.equal(bytesOnly.tier, "line");

  // Only enters the "stalled" state because bytes were previously received
  // (lastByteMs is set) and then the timeout was exceeded — not merely
  // because no data has arrived yet (see the neutral-states test above).
  const byteStalled = classifySerialDiagnostics({
    lastByteMs: now - (t.byteStallMs + 500),
    lastLineMs: now - 100
  }, now, undefined, { everConnected: true });
  assert.equal(byteStalled.tier, "byte");
  assert.match(byteStalled.message, /stalled/i);

  // Lines flowing recently, never had a fix. Neutral wording, not alarming.
  const noFix = classifySerialDiagnostics({ lastByteMs: now - 100, lastLineMs: now - 100 }, now, undefined, { everConnected: true });
  assert.equal(noFix.tier, "no-fix");
  assert.match(noFix.message, /No valid fix/);

  // Had a fix, but it's old — distinct from "never had one".
  const staleFix = classifySerialDiagnostics({
    lastByteMs: now - 100,
    lastLineMs: now - 100,
    lastFixMs: now - (t.staleFixMs + 1000)
  }, now, undefined, { everConnected: true });
  assert.equal(staleFix.tier, "stale-fix");

  // Everything fresh.
  const healthy = classifySerialDiagnostics({
    lastByteMs: now - 100,
    lastLineMs: now - 100,
    lastFixMs: now - 100
  }, now);
  assert.equal(healthy.tier, "ok");
  assert.equal(healthy.message, "");
});

test("fix staleness gate refuses observation creation on missing or stale fixes, not silently", () => {
  const now = 1_000_000;
  assert.equal(isFixStale(null, now), true);
  assert.equal(isFixStale({ receivedAtMs: now - 5000 }, now, 10000), false);
  assert.equal(isFixStale({ receivedAtMs: now - 15000 }, now, 10000), true);

  const missing = validateObservationCreation(null, now);
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /No valid fix/);

  const stale = validateObservationCreation({ receivedAtMs: now - 20000, lat: 34, lon: 135 }, now, 10000);
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /stale/);

  const noCoords = validateObservationCreation({ receivedAtMs: now - 100, lat: NaN, lon: 135 }, now, 10000);
  assert.equal(noCoords.ok, false);

  const fresh = validateObservationCreation({ receivedAtMs: now - 100, lat: 34, lon: 135 }, now, 10000);
  assert.equal(fresh.ok, true);
});

test("marked observation never fabricates SLAS/augmentation status", () => {
  const plain = buildMarkedObservation({
    id: "obs-1",
    sessionId: "rec-1",
    fix: { lat: 34.1, lon: 135.2, altitude: 12, fixQuality: 1, satellites: 8, hdop: 1.2, rawLine: "$GNGGA,...", augmented: false },
    observationType: "weed",
    note: "畦際に密集",
    nowIso: "2026-07-19T10:00:00+09:00"
  });
  assert.equal(plain.fixAugmented, false);
  assert.equal(plain.observationType, "weed");
  assert.equal(plain.latitude, 34.1);
  assert.equal(plain.imageRef, null);

  const augmented = buildMarkedObservation({
    id: "obs-2",
    sessionId: "rec-1",
    fix: { lat: 34.1, lon: 135.2, fixQuality: 2, augmented: true, rawLine: "$GNGGA,..." },
    observationType: "unknown_bogus_type",
    nowIso: "2026-07-19T10:00:00+09:00"
  });
  assert.equal(augmented.fixAugmented, true);
  assert.equal(augmented.observationType, "other", "unknown types fall back to other, never invented");
});

test("CSV builders quote embedded commas and never drop rows", () => {
  const csv = structuredFixesToCsv([
    { receivedAt: "2026-07-19T10:00:00+09:00", timestamp: "100000.00", lat: 34.1, lon: 135.2, altitude: 10, fixQuality: 1, satellites: 8, hdop: 1.1, rawLine: "$GNGGA,a,b,c" }
  ]);
  const lines = csv.split("\r\n");
  assert.equal(lines.length, 2);
  assert.match(lines[1], /"\$GNGGA,a,b,c"/);

  const obsCsv = markedObservationsToCsv([
    { id: "obs-1", timestamp: "t", latitude: 34, longitude: 135, note: "contains, a comma", observationType: "weed" }
  ]);
  assert.match(obsCsv.split("\r\n")[1], /"contains, a comma"/);
});

test("ids and filenames are unique and timestamped", () => {
  const a = makeSessionId();
  const b = makeSessionId();
  assert.notEqual(a, b);
  assert.match(a, /^rec-/);
  const obsId = makeObservationId();
  assert.match(obsId, /^obs-/);
  const filename = recordingFilename("rec-abc", "raw", "nmea", Date.parse("2026-07-19T10:30:00Z"));
  assert.match(filename, /^qz1-recording-rec-abc-raw-2026-07-19-10-30\.nmea$/);
});

test("formatBytes renders human-readable sizes", () => {
  assert.equal(formatBytes(500), "500 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
  assert.equal(formatBytes(NaN), "—");
});
