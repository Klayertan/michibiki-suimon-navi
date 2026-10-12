import test from "node:test";
import assert from "node:assert/strict";
import { collectAndroidConnectionDiagnostics, formatAndroidConnectionDiagnostics, parseChromeVersion } from "../../js/recording/android-connection-diagnostics.js";

test("diagnostics probe all requested capabilities and only report serial port count", async () => {
  const nav = {
    userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/140.0.7339.0 Mobile Safari/537.36",
    serial: { async getPorts() { return [{ getInfo() { throw new Error("must not inspect ports"); } }, {}]; } },
    bluetooth: { async getAvailability() { return true; } }
  };
  const data = await collectAndroidConnectionDiagnostics({ navigatorLike: nav, isSecureContext: true, decision: { case: "B-serial", androidSerialAvailable: true } });
  assert.equal(data.chromeVersion, "140.0.7339.0");
  assert.equal(data.serialPortCount, 2);
  assert.equal(data.bluetoothAvailability, "true");
  assert.equal(data.acquisitionDecision, "B-serial");
  assert.match(formatAndroidConnectionDiagnostics(data), /getPorts\(\) count: 2/);
});

test("diagnostics tolerate unavailable APIs and report Chrome version parsing", async () => {
  assert.equal(parseChromeVersion("Chrome/126.0.0.0"), "126.0.0.0");
  assert.equal(parseChromeVersion("Android"), "不明");
  const data = await collectAndroidConnectionDiagnostics({ navigatorLike: { userAgent: "Android" }, isSecureContext: false });
  assert.equal(data.hasSerial, false);
  assert.equal(data.serialPortCount, "取得不可");
});
