import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY,
  batteryWarning,
  describeReason,
  formatAge,
  formatAltitude,
  formatArmedState,
  formatConnectionState,
  formatCoordinate,
  formatCurrent,
  formatDegrees,
  formatFixType,
  formatFreshness,
  formatHeading,
  formatNumber,
  formatPercent,
  formatSatellites,
  formatSeverity,
  formatSpeed,
  formatVoltage
} from "../../js/drone/drone-formatters.js";

test("missing telemetry renders as the placeholder, never as zero", () => {
  for (const format of [formatVoltage, formatCurrent, formatPercent, formatDegrees, formatSpeed, formatAltitude, formatCoordinate, formatSatellites, formatHeading]) {
    assert.equal(format(null), EMPTY);
    assert.equal(format(undefined), EMPTY);
  }
});

test("non-finite numbers are rejected rather than printed", () => {
  assert.equal(formatVoltage(Number.NaN), EMPTY);
  assert.equal(formatSpeed(Number.POSITIVE_INFINITY), EMPTY);
  assert.equal(formatNumber("16.2"), EMPTY, "strings are not silently coerced");
});

test("zero is a real reading and must be displayed", () => {
  assert.equal(formatSpeed(0), "0.00 m/s");
  assert.equal(formatPercent(0), "0%");
  assert.equal(formatSatellites(0), "0");
});

test("units and precision match the panel", () => {
  assert.equal(formatVoltage(16.213), "16.21 V");
  assert.equal(formatCurrent(1.456), "1.46 A");
  assert.equal(formatPercent(87.4), "87%");
  assert.equal(formatDegrees(-2.34), "-2.3 °");
  assert.equal(formatSpeed(0.456), "0.46 m/s");
  assert.equal(formatAltitude(62.16), "62.2 m");
});

test("coordinates keep seven decimals for centimetre-level survey work", () => {
  assert.equal(formatCoordinate(34.54), "34.5400000");
  assert.equal(formatCoordinate(135.7350123), "135.7350123");
});

test("heading wraps into 0-359", () => {
  assert.equal(formatHeading(0), "0°");
  assert.equal(formatHeading(359.6), "0°");
  assert.equal(formatHeading(-90), "270°");
  assert.equal(formatHeading(450), "90°");
});

test("age is rendered at a human scale", () => {
  assert.equal(formatAge(0.4), "1秒未満");
  assert.equal(formatAge(2.5), "2.5秒前");
  assert.equal(formatAge(125), "2分前");
  assert.equal(formatAge(7200), "2時間前");
  assert.equal(formatAge(-1), EMPTY);
  assert.equal(formatAge(null), EMPTY);
});

test("every connection state has a distinct label", () => {
  const states = ["disconnected", "connecting", "connected", "telemetry_stale", "link_lost", "reconnecting", "error"];
  const labels = states.map((state) => formatConnectionState(state).label);
  assert.equal(new Set(labels).size, states.length, "states must be distinguishable");
  assert.equal(formatConnectionState("connected").tone, "ok");
  assert.equal(formatConnectionState("link_lost").tone, "danger");
  assert.equal(formatConnectionState("telemetry_stale").tone, "warn");
});

test("an unknown connection state degrades gracefully", () => {
  assert.equal(formatConnectionState("something-new").label, "不明");
});

test("armed state distinguishes unknown from disarmed", () => {
  assert.deepEqual(formatArmedState(true), { label: "ARMED（アーム中）", tone: "danger", armed: true });
  assert.equal(formatArmedState(false).armed, false);
  assert.equal(formatArmedState(false).tone, "ok");

  const unknown = formatArmedState(null);
  assert.equal(unknown.armed, null, "unknown must never collapse into disarmed");
  assert.equal(unknown.tone, "warn");
});

test("battery warning tiers follow the aircraft failsafe voltages", () => {
  assert.equal(batteryWarning({ voltage: 16.2 }).tone, "ok");
  assert.equal(batteryWarning({ voltage: 14.0 }).tone, "warn", "14.0V is the low-battery RTL threshold");
  assert.equal(batteryWarning({ voltage: 13.9 }).tone, "warn");
  assert.equal(batteryWarning({ voltage: 13.6 }).tone, "danger", "13.6V is the critical LAND threshold");
  assert.equal(batteryWarning({ voltage: 12.0 }).tone, "danger");
});

test("battery warning falls back to percentage when voltage is unavailable", () => {
  assert.equal(batteryWarning({ remaining: 80 }).tone, "ok");
  assert.equal(batteryWarning({ remaining: 25 }).tone, "warn");
  assert.equal(batteryWarning({ remaining: 10 }).tone, "danger");
  assert.equal(batteryWarning({}).tone, "unknown");
  assert.equal(batteryWarning().tone, "unknown");
});

test("voltage takes priority over percentage", () => {
  assert.equal(batteryWarning({ voltage: 13.5, remaining: 90 }).tone, "danger");
});

test("freshness reflects the backend stale flag", () => {
  assert.equal(formatFreshness({ stale: false, lastMessageAge: 0.2 }).tone, "ok");
  assert.equal(formatFreshness({ stale: true, lastMessageAge: 8 }).tone, "warn");
  assert.equal(formatFreshness({}).tone, "unknown");
  assert.equal(formatFreshness().tone, "unknown");
});

test("GPS fix types get readable text", () => {
  assert.equal(formatFixType("3D_FIX"), "3D測位");
  assert.equal(formatFixType("NO_FIX"), "測位なし");
  assert.equal(formatFixType("DGPS"), "DGNSS");
  assert.equal(formatFixType(null), EMPTY);
  assert.equal(formatFixType("UNKNOWN_9"), "UNKNOWN_9", "unmapped values pass through");
});

test("severity maps to a label and a tone", () => {
  assert.equal(formatSeverity("CRITICAL").tone, "danger");
  assert.equal(formatSeverity("WARNING").tone, "warn");
  assert.equal(formatSeverity("INFO").tone, "info");
  assert.equal(formatSeverity("NOPE").tone, "muted");
});

test("every backend rejection reason has an operator-facing explanation", () => {
  const reasons = [
    "commands_disabled",
    "not_connected",
    "link_stale",
    "armed",
    "arm_state_unknown",
    "mode_not_allowed",
    "mode_forbidden",
    "stream_not_allowed",
    "rejected_by_vehicle",
    "ack_timeout",
    "verify_timeout",
    "transmit_failed",
    "not_implemented",
    "props_not_confirmed",
    "confirmation_required",
    "port_busy",
    "port_not_found",
    "backend_unreachable"
  ];
  for (const reason of reasons) {
    const text = describeReason(reason);
    assert.ok(text.length > 5, `${reason} needs a real explanation`);
    assert.notEqual(text, "不明なエラーです。", `${reason} must not fall through to the default`);
  }
});

test("the port-busy explanation names QGroundControl", () => {
  assert.match(describeReason("port_busy"), /QGroundControl/);
});

test("an unmapped reason falls back without throwing", () => {
  assert.equal(describeReason("brand_new_reason"), "不明なエラーです。");
  assert.equal(describeReason("brand_new_reason", "サーバーからの説明"), "サーバーからの説明");
});
