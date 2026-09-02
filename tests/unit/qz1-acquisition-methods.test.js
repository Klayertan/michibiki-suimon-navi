import test from "node:test";
import assert from "node:assert/strict";
import {
  decideQz1AcquisitionUx,
  detectPlatformKind,
  DEVICE_COMPATIBILITY_GUIDE,
  IOS_FALLBACK_STEPS,
  QZ1LE_BLUETOOTH_STATE_MESSAGES
} from "../../js/recording/qz1-acquisition-methods.js";

const CONFIGURED_PROFILE = { configured: true, reason: null };
const UNCONFIGURED_PROFILE = { configured: false, reason: "service" };

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

test("classic iPhone/iPad/iPod user agents are detected as iOS", () => {
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
  const ipad = "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
  assert.equal(detectPlatformKind({ userAgent: iphone, platform: "iPhone", maxTouchPoints: 5 }), "ios");
  assert.equal(detectPlatformKind({ userAgent: ipad, platform: "iPad", maxTouchPoints: 5 }), "ios");
});

test("iPadOS 13+ masquerading as a Mac is still detected as iOS via maxTouchPoints", () => {
  const macLikeUa = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
  assert.equal(detectPlatformKind({ userAgent: macLikeUa, platform: "MacIntel", maxTouchPoints: 5 }), "ios");
});

test("a real Mac (no touch points) is not misdetected as an iPad", () => {
  const macUa = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  assert.equal(detectPlatformKind({ userAgent: macUa, platform: "MacIntel", maxTouchPoints: 0 }), "desktop");
});

test("Android Chrome is detected as android, not desktop", () => {
  const androidUa = "Mozilla/5.0 (Linux; Android 14; Pixel 6a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
  assert.equal(detectPlatformKind({ userAgent: androidUa, platform: "Linux armv81", maxTouchPoints: 5 }), "android");
});

test("Windows Chrome/Edge is desktop", () => {
  const windowsUa = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  assert.equal(detectPlatformKind({ userAgent: windowsUa, platform: "Win32", maxTouchPoints: 0 }), "desktop");
});

// ---------------------------------------------------------------------------
// Acquisition UX decision matrix -- one test per spec case (A/B/C/D)
// ---------------------------------------------------------------------------

test("A. Windows / supported desktop Chromium: Bluetooth + Serial + (implicitly) file", () => {
  const ux = decideQz1AcquisitionUx({
    isSecureContext: true, hasSerial: true, hasBluetooth: true,
    platformKind: "desktop", bleProfile: CONFIGURED_PROFILE
  });
  assert.equal(ux.showSerialOption, true);
  assert.equal(ux.showBluetoothOption, true);
  assert.equal(ux.showIosFallback, false);
  assert.equal(ux.showUnsupportedBrowserNotice, false);
  assert.equal(ux.bluetoothState, "configured-unverified");
  assert.equal(ux.bluetoothConnectEnabled, true);
});

test("B. Android + Chrome/Web Bluetooth: Bluetooth + file, no Serial", () => {
  const ux = decideQz1AcquisitionUx({
    isSecureContext: true, hasSerial: false, hasBluetooth: true,
    platformKind: "android", bleProfile: CONFIGURED_PROFILE
  });
  assert.equal(ux.showSerialOption, false);
  assert.equal(ux.showBluetoothOption, true);
  assert.equal(ux.showIosFallback, false);
  assert.equal(ux.showUnsupportedBrowserNotice, false);
});

test("C. iPhone / iPad: no working Bluetooth button, GNSS Analyzer fallback shown instead", () => {
  // iOS Safari reports both hasSerial/hasBluetooth false, but even a
  // hypothetical browser that claimed to expose navigator.bluetooth on iOS
  // must NOT get the direct-BLE button -- platformKind wins.
  const ux = decideQz1AcquisitionUx({
    isSecureContext: true, hasSerial: false, hasBluetooth: true,
    platformKind: "ios", bleProfile: CONFIGURED_PROFILE
  });
  assert.equal(ux.showBluetoothOption, false);
  assert.equal(ux.showSerialOption, false);
  assert.equal(ux.showIosFallback, true);
  assert.equal(ux.showUnsupportedBrowserNotice, false, "iOS must get its own fallback message, not the generic unsupported-browser one");
  assert.equal(ux.showFileImportReminder, true);
});

test("D. Browser without Web Bluetooth (and not iOS): generic unsupported notice, distinct from the iOS message", () => {
  const ux = decideQz1AcquisitionUx({
    isSecureContext: true, hasSerial: false, hasBluetooth: false,
    platformKind: "desktop", bleProfile: UNCONFIGURED_PROFILE
  });
  assert.equal(ux.showBluetoothOption, false);
  assert.equal(ux.showSerialOption, false);
  assert.equal(ux.showIosFallback, false);
  assert.equal(ux.showUnsupportedBrowserNotice, true);
  assert.equal(ux.showFileImportReminder, true);
});

test("iOS and 'unsupported browser' are mutually exclusive even though feature flags can be identical", () => {
  const flags = { isSecureContext: true, hasSerial: false, hasBluetooth: false, bleProfile: UNCONFIGURED_PROFILE };
  const ios = decideQz1AcquisitionUx({ ...flags, platformKind: "ios" });
  const other = decideQz1AcquisitionUx({ ...flags, platformKind: "desktop" });
  assert.notEqual(ios.showIosFallback, other.showIosFallback);
  assert.notEqual(ios.showUnsupportedBrowserNotice, other.showUnsupportedBrowserNotice);
});

test("missing BLE UUID configuration disables the connect action even though the option is shown", () => {
  const ux = decideQz1AcquisitionUx({
    isSecureContext: true, hasSerial: true, hasBluetooth: true,
    platformKind: "desktop", bleProfile: UNCONFIGURED_PROFILE
  });
  assert.equal(ux.showBluetoothOption, true, "the option itself stays visible");
  assert.equal(ux.bluetoothState, "not-configured");
  assert.equal(ux.bluetoothConnectEnabled, false, "but connecting is refused, never attempted with a guessed UUID");
  assert.ok(QZ1LE_BLUETOOTH_STATE_MESSAGES["not-configured"].length > 0);
});

test("an insecure context disables Bluetooth even with a configured profile", () => {
  const ux = decideQz1AcquisitionUx({
    isSecureContext: false, hasSerial: true, hasBluetooth: true,
    platformKind: "desktop", bleProfile: CONFIGURED_PROFILE
  });
  assert.equal(ux.bluetoothState, "insecure-context");
  assert.equal(ux.bluetoothConnectEnabled, false);
});

test("every bluetoothState the decision matrix can produce has a message", () => {
  const states = ["not-applicable", "insecure-context", "not-configured", "configured-unverified"];
  for (const state of states) {
    assert.equal(typeof QZ1LE_BLUETOOTH_STATE_MESSAGES[state], "string", state);
  }
});

test("the device compatibility guide covers all four documented routes, with no unsupported claim", () => {
  const devices = DEVICE_COMPATIBILITY_GUIDE.map((entry) => entry.device);
  assert.deepEqual(devices, ["Windows PC", "Android", "iPhone / iPad", "USB対応PC"]);
  for (const entry of DEVICE_COMPATIBILITY_GUIDE) {
    assert.ok(entry.route.length > 0);
  }
});

test("the iOS fallback steps are the four documented steps, in order", () => {
  assert.deepEqual(IOS_FALLBACK_STEPS, [
    "GNSS AnalyzerでQZ1LEへ接続",
    "NMEAログを記録",
    "ログを保存 / 共有",
    "SuiSuiNaviでNMEAファイルを読み込む"
  ]);
});
