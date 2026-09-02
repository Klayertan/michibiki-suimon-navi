import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeQz1LeBleProfile,
  readQz1LeBleProfile,
  unconfiguredQz1LeReasonText
} from "../../js/recording/qz1le-ble-config.js";

test("the shipped, unfilled profile is not configured", () => {
  const profile = normalizeQz1LeBleProfile({ serviceUuid: null, notifyCharacteristicUuid: null, deviceNamePrefix: "QZ1LE" });
  assert.equal(profile.configured, false);
  assert.equal(profile.reason, "service");
});

test("a missing profile object is not an error, just unconfigured", () => {
  // [] is typeof "object" and falls through to normal field extraction
  // (mirroring js/cloud/cloud-config.js's own normalizeCloudConfig()), so
  // only `configured` is asserted here -- the specific `reason` for that one
  // is covered by the dedicated "service"/"missing" tests below.
  for (const input of [undefined, null, "", 42, []]) {
    const profile = normalizeQz1LeBleProfile(input);
    assert.equal(profile.configured, false, `input ${JSON.stringify(input)}`);
  }
  assert.equal(normalizeQz1LeBleProfile(undefined).reason, "missing");
  assert.equal(normalizeQz1LeBleProfile(null).reason, "missing");
});

test("a service uuid alone, with no notify characteristic, is still unconfigured", () => {
  const profile = normalizeQz1LeBleProfile({ serviceUuid: "0000180d-0000-1000-8000-00805f9b34fb" });
  assert.equal(profile.configured, false);
  assert.equal(profile.reason, "characteristic");
  assert.equal(profile.serviceUuid, "0000180d-0000-1000-8000-00805f9b34fb");
});

test("both uuids present makes the profile configured", () => {
  const profile = normalizeQz1LeBleProfile({
    serviceUuid: "0000180d-0000-1000-8000-00805f9b34fb",
    notifyCharacteristicUuid: "00002a37-0000-1000-8000-00805f9b34fb"
  });
  assert.equal(profile.configured, true);
  assert.equal(profile.reason, null);
  assert.equal(profile.deviceNamePrefix, "QZ1LE");
});

test("deviceNamePrefix falls back to QZ1LE when unset, but is otherwise passed through", () => {
  assert.equal(normalizeQz1LeBleProfile({}).deviceNamePrefix, "QZ1LE");
  assert.equal(normalizeQz1LeBleProfile({ deviceNamePrefix: "MyReceiver" }).deviceNamePrefix, "MyReceiver");
  // Whitespace-only counts as unset.
  assert.equal(normalizeQz1LeBleProfile({ deviceNamePrefix: "   " }).deviceNamePrefix, "QZ1LE");
});

test("whitespace-only uuids are treated as unset, not as garbage values", () => {
  const profile = normalizeQz1LeBleProfile({ serviceUuid: "   ", notifyCharacteristicUuid: "  " });
  assert.equal(profile.configured, false);
  assert.equal(profile.serviceUuid, null);
});

test("readQz1LeBleProfile reads off a global scope, defaulting safely when unset", () => {
  assert.equal(readQz1LeBleProfile({}).configured, false);
  const profile = readQz1LeBleProfile({
    SUISUI_QZ1LE_BLE_PROFILE: {
      serviceUuid: "0000180d-0000-1000-8000-00805f9b34fb",
      notifyCharacteristicUuid: "00002a37-0000-1000-8000-00805f9b34fb"
    }
  });
  assert.equal(profile.configured, true);
});

test("unconfiguredQz1LeReasonText gives a distinct, non-empty message per reason", () => {
  const missing = unconfiguredQz1LeReasonText("missing");
  const service = unconfiguredQz1LeReasonText("service");
  const characteristic = unconfiguredQz1LeReasonText("characteristic");
  assert.ok(missing.length > 0);
  assert.ok(service.length > 0);
  assert.equal(service, characteristic);
  assert.notEqual(missing, service);
});
