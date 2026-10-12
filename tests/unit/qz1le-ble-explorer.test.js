import test from "node:test";
import assert from "node:assert/strict";
import { hasTwoValidNmeaSentences, isChecksumValidNmea, mergeBleProfile, readRuntimeBleProfile, saveRuntimeBleProfile, Qz1LeBleExplorer } from "../../js/recording/qz1le-ble-explorer.js";

function sentence(body) {
  let checksum = 0;
  for (const char of body) checksum ^= char.charCodeAt(0);
  return `$${body}*${checksum.toString(16).padStart(2, "0").toUpperCase()}`;
}

test("NMEA candidate requires two independently checksum-valid complete sentences", () => {
  const valid = sentence("GNGGA,123519,4807.038,N,01131.000,E,2,12,0.8,545.4,M,46.9,M,,");
  const rmc = sentence("GNRMC,123519,A,4807.038,N,01131.000,E,0.0,0.0,230394,,,A");
  assert.equal(isChecksumValidNmea(valid), true);
  assert.equal(isChecksumValidNmea(`${valid.slice(0, -2)}00`), false);
  assert.equal(hasTwoValidNmeaSentences([valid]), false);
  assert.equal(hasTwoValidNmeaSentences([valid, rmc]), true);
});

test("runtime BLE profile persists locally and committed configuration wins", () => {
  const map = new Map();
  const storage = { setItem: (key, value) => map.set(key, value), getItem: (key) => map.get(key) };
  saveRuntimeBleProfile(storage, { serviceUuid: "180d", notifyCharacteristicUuid: "2a37", deviceName: "QZ1LE", deviceId: "device-a" });
  assert.equal(readRuntimeBleProfile(storage).deviceId, "device-a");
  assert.equal(mergeBleProfile({ serviceUuid: null }, readRuntimeBleProfile(storage)).source, "device-local");
  assert.equal(mergeBleProfile({ serviceUuid: "180f", notifyCharacteristicUuid: "2a19" }, readRuntimeBleProfile(storage)).serviceUuid, "180f");
});

test("explorer requests all devices and enumerates services without filtering guessed profiles", async () => {
  let options;
  const characteristic = { uuid: "2a37", properties: { notify: true }, async startNotifications() {}, addEventListener() {} };
  const service = { uuid: "180d", async getCharacteristics() { return [characteristic]; } };
  const device = { id: "ble-1", name: "QZ1LE", gatt: { async connect() { return { async getPrimaryServices() { return [service]; } }; } } };
  const explorer = new Qz1LeBleExplorer({ bluetooth: { async requestDevice(value) { options = value; return device; } } });
  const found = await explorer.discover();
  assert.equal(options.acceptAllDevices, true);
  assert.ok(options.optionalServices.length > 0);
  assert.equal(found.services[0].characteristics[0].characteristic.uuid, "2a37");
});
