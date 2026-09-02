import test from "node:test";
import assert from "node:assert/strict";
import {
  NmeaLineSplitter,
  Qz1LeBluetoothError,
  Qz1LeBluetoothTransport,
  QZ1LE_LINE_BUFFER_LIMIT,
  isWebBluetoothSupported
} from "../../js/recording/qz1le-bluetooth.js";

// ---------------------------------------------------------------------------
// NmeaLineSplitter -- byte-chunk / line-boundary logic, no BLE involved.
// ---------------------------------------------------------------------------

test("a single chunk with multiple complete sentences yields them all, buffering nothing", () => {
  const splitter = new NmeaLineSplitter();
  const { lines, overflowed } = splitter.push("$GNGGA,1*00\r\n$GNRMC,2*00\r\n");
  assert.deepEqual(lines, ["$GNGGA,1*00", "$GNRMC,2*00"]);
  assert.equal(overflowed, false);
  assert.equal(splitter.buffer, "");
});

test("a sentence split across two notifications (byte-chunk boundary) is reassembled, not truncated", () => {
  const splitter = new NmeaLineSplitter();
  const first = splitter.push("$GNGGA,0123");
  assert.deepEqual(first.lines, [], "nothing complete yet");
  const second = splitter.push("45.00,N*7C\r\n");
  assert.deepEqual(second.lines, ["$GNGGA,012345.00,N*7C"]);
});

test("a chunk boundary landing exactly on the line terminator still completes the line", () => {
  const splitter = new NmeaLineSplitter();
  splitter.push("$GNGGA,1*00\r\n");
  const { lines } = splitter.push("$GNGGA,2*00\r\n");
  assert.deepEqual(lines, ["$GNGGA,2*00"]);
});

test("multiple sentences in one notification, with one incomplete at the end, only completes the finished ones", () => {
  const splitter = new NmeaLineSplitter();
  const { lines } = splitter.push("$GNGGA,1*00\r\n$GNRMC,2*00\r\n$GNGSA,3,partial");
  assert.deepEqual(lines, ["$GNGGA,1*00", "$GNRMC,2*00"]);
  const { lines: rest } = splitter.push("-tail*00\r\n");
  assert.deepEqual(rest, ["$GNGSA,3,partial-tail*00"]);
});

test("malformed/partial data with no line terminator at all never crashes, and is capped rather than growing forever", () => {
  const splitter = new NmeaLineSplitter({ bufferLimit: 32 });
  let sawOverflow = false;
  for (let i = 0; i < 20; i += 1) {
    const { overflowed } = splitter.push("garbage-no-newline-");
    if (overflowed) sawOverflow = true;
  }
  assert.equal(sawOverflow, true);
  assert.ok(splitter.buffer.length <= 256, "buffer is trimmed, not left to grow unbounded");
});

test("the default buffer limit matches the shared Web Serial pipeline's limit", () => {
  assert.equal(QZ1LE_LINE_BUFFER_LIMIT, 8192);
});

test("reset() discards an incomplete trailing line instead of ever emitting it as if complete", () => {
  const splitter = new NmeaLineSplitter();
  splitter.push("$GNGGA,truncated-by-disconnect");
  splitter.reset();
  const { lines } = splitter.push("$GNGGA,3*00\r\n");
  assert.deepEqual(lines, ["$GNGGA,3*00"], "the pre-reset fragment must not resurface glued to new data");
});

test("real BLE-shaped bytes (DataView over a UTF-8 ArrayBuffer) decode correctly, including a multi-byte char split across chunks", () => {
  const splitter = new NmeaLineSplitter();
  const full = new TextEncoder().encode("$GPTXT,0,1,01,基地局*00\r\n");
  // Split mid multi-byte UTF-8 sequence on purpose (inside the 3-byte 基 char).
  const cut = 20;
  const first = new DataView(full.buffer.slice(0, cut));
  const second = new DataView(full.buffer.slice(cut));
  splitter.push(first);
  const { lines } = splitter.push(second);
  assert.deepEqual(lines, ["$GPTXT,0,1,01,基地局*00"]);
});

// ---------------------------------------------------------------------------
// Fakes for the GATT lifecycle -- no physical hardware, no real browser.
// ---------------------------------------------------------------------------

class FakeEventTarget {
  constructor() {
    this._listeners = new Map();
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this._listeners.get(type)?.delete(fn);
  }
  dispatch(type, event) {
    for (const fn of [...(this._listeners.get(type) || [])]) fn(event);
  }
}

class FakeCharacteristic extends FakeEventTarget {
  constructor() {
    super();
    this.notifying = false;
    this.stopCalls = 0;
  }
  async startNotifications() {
    this.notifying = true;
    return this;
  }
  async stopNotifications() {
    this.notifying = false;
    this.stopCalls += 1;
    return this;
  }
  notifyText(text) {
    const bytes = new TextEncoder().encode(text);
    this.dispatch("characteristicvaluechanged", { target: { value: new DataView(bytes.buffer) } });
  }
}

class FakeService {
  constructor({ characteristic, characteristicUuid }) {
    this.characteristic = characteristic;
    this.characteristicUuid = characteristicUuid;
  }
  async getCharacteristic(uuid) {
    if (uuid !== this.characteristicUuid) {
      const error = new Error(`NotFoundError: no characteristic ${uuid}`);
      error.name = "NotFoundError";
      throw error;
    }
    return this.characteristic;
  }
}

class FakeGatt {
  constructor({ service, serviceUuid }) {
    this.connected = false;
    this.service = service;
    this.serviceUuid = serviceUuid;
    this.disconnectCalls = 0;
  }
  async connect() {
    this.connected = true;
    return this;
  }
  disconnect() {
    this.connected = false;
    this.disconnectCalls += 1;
  }
  async getPrimaryService(uuid) {
    if (uuid !== this.serviceUuid) {
      const error = new Error(`NotFoundError: no service ${uuid}`);
      error.name = "NotFoundError";
      throw error;
    }
    return this.service;
  }
}

class FakeDevice extends FakeEventTarget {
  constructor(gatt) {
    super();
    this.gatt = gatt;
  }
}

class FakeBluetooth {
  constructor(device, { rejectPicker = false } = {}) {
    this.device = device;
    this.rejectPicker = rejectPicker;
    this.requestCalls = [];
  }
  async requestDevice(options) {
    this.requestCalls.push(options);
    if (this.rejectPicker) {
      const error = new Error("User cancelled the requestDevice() chooser.");
      error.name = "NotFoundError";
      throw error;
    }
    return this.device;
  }
}

const REAL_SERVICE_UUID = "0000180d-0000-1000-8000-00805f9b34fb";
const REAL_CHAR_UUID = "00002a37-0000-1000-8000-00805f9b34fb";
const CONFIGURED_PROFILE = { serviceUuid: REAL_SERVICE_UUID, notifyCharacteristicUuid: REAL_CHAR_UUID, deviceNamePrefix: "QZ1LE", configured: true, reason: null };
const UNCONFIGURED_PROFILE = { serviceUuid: null, notifyCharacteristicUuid: null, deviceNamePrefix: "QZ1LE", configured: false, reason: "service" };

function makeWorkingStack() {
  const characteristic = new FakeCharacteristic();
  const service = new FakeService({ characteristic, characteristicUuid: REAL_CHAR_UUID });
  const gatt = new FakeGatt({ service, serviceUuid: REAL_SERVICE_UUID });
  const device = new FakeDevice(gatt);
  const bluetooth = new FakeBluetooth(device);
  return { characteristic, service, gatt, device, bluetooth };
}

// ---------------------------------------------------------------------------
// isWebBluetoothSupported
// ---------------------------------------------------------------------------

test("isWebBluetoothSupported requires both navigator.bluetooth and a secure context", () => {
  assert.equal(isWebBluetoothSupported({ bluetooth: {}, isSecureContext: true }), true);
  assert.equal(isWebBluetoothSupported({ bluetooth: undefined, isSecureContext: true }), false);
  assert.equal(isWebBluetoothSupported({ bluetooth: {}, isSecureContext: false }), false);
});

// ---------------------------------------------------------------------------
// Qz1LeBluetoothTransport -- the critical "never guess a UUID" guard
// ---------------------------------------------------------------------------

test("connect() refuses outright when the BLE profile is not configured, and never calls requestDevice()", async () => {
  const bluetooth = new FakeBluetooth(new FakeDevice(new FakeGatt({ service: new FakeService({}), serviceUuid: "irrelevant" })));
  const states = [];
  const errors = [];
  const transport = new Qz1LeBluetoothTransport({
    bluetooth, isSecureContext: true, profile: UNCONFIGURED_PROFILE,
    onStateChange: (s) => states.push(s), onError: (e) => errors.push(e)
  });

  await assert.rejects(() => transport.connect(), Qz1LeBluetoothError);
  assert.equal(bluetooth.requestCalls.length, 0, "no device picker was ever opened with a guessed UUID");
  assert.equal(states.at(-1), "not-configured");
  assert.equal(errors[0].reason, "not-configured");
});

test("connect() refuses when Web Bluetooth is unsupported, without touching requestDevice", async () => {
  const transport = new Qz1LeBluetoothTransport({ bluetooth: undefined, isSecureContext: true, profile: CONFIGURED_PROFILE });
  await assert.rejects(() => transport.connect(), (error) => {
    assert.equal(error.reason, "unsupported");
    return true;
  });
});

test("connect() refuses on an insecure context even with bluetooth present and a configured profile", async () => {
  const { bluetooth } = makeWorkingStack();
  const transport = new Qz1LeBluetoothTransport({ bluetooth, isSecureContext: false, profile: CONFIGURED_PROFILE });
  await assert.rejects(() => transport.connect(), (error) => {
    assert.equal(error.reason, "unsupported");
    return true;
  });
  assert.equal(bluetooth.requestCalls.length, 0);
});

test("a configured profile drives requestDevice() with the real service filter, not a guess", async () => {
  const { bluetooth } = makeWorkingStack();
  const transport = new Qz1LeBluetoothTransport({ bluetooth, isSecureContext: true, profile: CONFIGURED_PROFILE });
  await transport.connect();
  assert.equal(bluetooth.requestCalls.length, 1);
  const [options] = bluetooth.requestCalls;
  assert.deepEqual(options.filters, [{ services: [REAL_SERVICE_UUID], namePrefix: "QZ1LE" }]);
  assert.deepEqual(options.optionalServices, [REAL_SERVICE_UUID]);
});

test("a full successful connect reaches 'connected' and streams notified lines to onLine, in order", async () => {
  const { characteristic } = makeWorkingStack();
  const bluetooth = new FakeBluetooth(new FakeDevice(new FakeGatt({
    service: new FakeService({ characteristic, characteristicUuid: REAL_CHAR_UUID }),
    serviceUuid: REAL_SERVICE_UUID
  })));
  const states = [];
  const lines = [];
  const transport = new Qz1LeBluetoothTransport({
    bluetooth, isSecureContext: true, profile: CONFIGURED_PROFILE,
    onStateChange: (s) => states.push(s), onLine: (l) => lines.push(l)
  });

  await transport.connect();
  assert.deepEqual(states, ["requesting", "connecting", "connected"]);
  assert.equal(transport.state, "connected");

  characteristic.notifyText("$GNGGA,1*00\r\n$GNRMC,2");
  characteristic.notifyText("*00\r\n");
  assert.deepEqual(lines, ["$GNGGA,1*00", "$GNRMC,2*00"]);
});

test("a missing characteristic (wrong/guessed UUID) fails the connect and tears the device back down", async () => {
  const service = new FakeService({ characteristic: new FakeCharacteristic(), characteristicUuid: "some-other-uuid" });
  const gatt = new FakeGatt({ service, serviceUuid: REAL_SERVICE_UUID });
  const device = new FakeDevice(gatt);
  const bluetooth = new FakeBluetooth(device);
  const errors = [];
  const transport = new Qz1LeBluetoothTransport({
    bluetooth, isSecureContext: true, profile: CONFIGURED_PROFILE, onError: (e) => errors.push(e)
  });

  await assert.rejects(() => transport.connect());
  assert.equal(transport.state, "error");
  assert.equal(gatt.disconnectCalls, 1, "the half-open GATT connection is cleaned up, not leaked");
  assert.equal(errors.length, 1);
});

test("the user cancelling the device chooser is reported as an error, not left hanging", async () => {
  const device = new FakeDevice(new FakeGatt({ service: new FakeService({}), serviceUuid: REAL_SERVICE_UUID }));
  const bluetooth = new FakeBluetooth(device, { rejectPicker: true });
  const states = [];
  const transport = new Qz1LeBluetoothTransport({ bluetooth, isSecureContext: true, profile: CONFIGURED_PROFILE, onStateChange: (s) => states.push(s) });

  await assert.rejects(() => transport.connect());
  assert.equal(states.at(-1), "error");
});

test("disconnect() cleanly stops notifications, disconnects gatt and removes listeners", async () => {
  const { characteristic, gatt, bluetooth } = makeWorkingStack();
  const states = [];
  const transport = new Qz1LeBluetoothTransport({ bluetooth, isSecureContext: true, profile: CONFIGURED_PROFILE, onStateChange: (s) => states.push(s) });
  await transport.connect();

  await transport.disconnect();
  assert.equal(characteristic.stopCalls, 1);
  assert.equal(gatt.disconnectCalls, 1);
  assert.equal(states.at(-1), "disconnected");
  assert.equal(transport.characteristic, null);
  assert.equal(transport.device, null);
});

test("disconnect() before ever connecting is a safe no-op", async () => {
  const { bluetooth } = makeWorkingStack();
  const transport = new Qz1LeBluetoothTransport({ bluetooth, isSecureContext: true, profile: CONFIGURED_PROFILE });
  await transport.disconnect();
  assert.equal(transport.state, "idle");
});

test("an unsolicited gattserverdisconnected (device powered off / out of range) is handled without calling disconnect() explicitly", async () => {
  const { device, bluetooth } = makeWorkingStack();
  const states = [];
  const transport = new Qz1LeBluetoothTransport({ bluetooth, isSecureContext: true, profile: CONFIGURED_PROFILE, onStateChange: (s) => states.push(s) });
  await transport.connect();

  device.dispatch("gattserverdisconnected", {});
  // Teardown runs a microtask chain (await stopNotifications); flush it.
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(states.at(-1), "disconnected");
  assert.equal(transport.characteristic, null);
});

test("a stale gattserverdisconnected listener from an already-torn-down device is ignored", async () => {
  const { device, bluetooth } = makeWorkingStack();
  const transport = new Qz1LeBluetoothTransport({ bluetooth, isSecureContext: true, profile: CONFIGURED_PROFILE });
  await transport.connect();
  await transport.disconnect();
  const stateAfterDisconnect = transport.state;

  // A duplicate/late event firing after a clean disconnect must not re-fire teardown.
  device.dispatch("gattserverdisconnected", {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(transport.state, stateAfterDisconnect);
});

test("a line arriving mid-stream after a buffer overflow still calls onError once, not silently", async () => {
  const { characteristic, bluetooth } = makeWorkingStack();
  const errors = [];
  const transport = new Qz1LeBluetoothTransport({ bluetooth, isSecureContext: true, profile: CONFIGURED_PROFILE, onError: (e) => errors.push(e) });
  await transport.connect();
  transport.splitter.bufferLimit = 8;

  characteristic.notifyText("no-newline-data-that-keeps-growing-and-growing");
  assert.ok(errors.some((e) => e.reason === "buffer-overflow"));
});
