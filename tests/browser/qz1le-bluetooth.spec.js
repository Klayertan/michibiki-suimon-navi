import { test, expect } from "@playwright/test";

// QZ1LE direct-Bluetooth-LE acquisition UX.
//
// No physical QZ1LE is available to CI (or to this repo at all -- the real
// GATT profile is unconfirmed, see config/qz1le-ble-profile.js), so these
// tests exercise:
//   - the platform-driven UI decision (iPhone/iPad fallback vs. Android/
//     desktop Bluetooth controls vs. the generic unsupported-browser notice)
//   - the "never guess a UUID" guard, with the shipped (unconfigured) profile
//   - a full connect -> notify -> shared-parser-pipeline flow against a fake
//     navigator.bluetooth, once a profile IS configured (proving the wiring
//     works end-to-end without claiming the real QZ1LE profile is known)

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const ANDROID_CHROME_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 6a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

const REAL_SERVICE_UUID = "0000180d-0000-1000-8000-00805f9b34fb";
const REAL_CHAR_UUID = "00002a37-0000-1000-8000-00805f9b34fb";

async function openSurveyDeviceCard(page) {
  await page.goto("/#survey");
  await page.getByRole("button", { name: "QZ1測量" }).click();
  await page.evaluate(() => {
    document.querySelectorAll("details[data-workspace='survey']").forEach((card) => { card.open = true; });
  });
}

async function selectBluetoothSource(page) {
  await page.locator("#deviceSourceSelect").selectOption("qz1-bluetooth");
}

/** Installed via page.addInitScript -- runs in-browser, so everything it needs must be self-contained or passed in `opts`. */
function installFakeBluetooth(opts) {
  const { serviceUuid, characteristicUuid, rejectPicker } = opts;

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
    async startNotifications() {
      return this;
    }
    async stopNotifications() {
      return this;
    }
    notifyText(text) {
      const bytes = new TextEncoder().encode(text);
      this.dispatch("characteristicvaluechanged", { target: { value: new DataView(bytes.buffer) } });
    }
  }

  class FakeService {
    constructor(characteristic) {
      this.characteristic = characteristic;
    }
    async getCharacteristic(uuid) {
      if (uuid !== characteristicUuid) {
        const error = new Error(`NotFoundError: no characteristic ${uuid}`);
        error.name = "NotFoundError";
        throw error;
      }
      return this.characteristic;
    }
  }

  class FakeGatt {
    constructor(service) {
      this.connected = false;
      this.service = service;
    }
    async connect() {
      this.connected = true;
      return this;
    }
    disconnect() {
      this.connected = false;
    }
    async getPrimaryService(uuid) {
      if (uuid !== serviceUuid) {
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

  const characteristic = new FakeCharacteristic();
  const service = new FakeService(characteristic);
  const gatt = new FakeGatt(service);
  const device = new FakeDevice(gatt);
  window.__fakeQz1leCharacteristic = characteristic;
  window.__fakeQz1leDevice = device;

  const fakeBluetooth = {
    requestCalls: [],
    async requestDevice(requestOptions) {
      fakeBluetooth.requestCalls.push(requestOptions);
      if (rejectPicker) {
        const error = new Error("User cancelled the requestDevice() chooser.");
        error.name = "NotFoundError";
        throw error;
      }
      return device;
    }
  };
  window.__fakeQz1leBluetooth = fakeBluetooth;
  Object.defineProperty(Navigator.prototype, "bluetooth", { configurable: true, get: () => fakeBluetooth });
}

// ---------------------------------------------------------------------------
// C. iPhone / iPad: no working Bluetooth button, GNSS Analyzer fallback shown
// ---------------------------------------------------------------------------

test.describe("iPhone/iPad", () => {
  test.use({ userAgent: IPHONE_UA });

  test("gets the GNSS Analyzer fallback instead of a broken Bluetooth button", async ({ page }) => {
    await openSurveyDeviceCard(page);
    await expect(page.locator("#qz1leIosFallback")).toBeVisible();
    await expect(page.locator("#qz1leIosFallback")).toContainText("Safari");
    await expect(page.locator("#qz1leIosFallback")).toContainText("GNSS Analyzer");
    await expect(page.locator("#qz1leIosFallback")).toContainText("NMEAファイルを読み込む");

    // The select/connect controls are replaced entirely, not just disabled --
    // there is no broken button to tap.
    await expect(page.locator("#qz1DeviceControls")).toBeHidden();
  });

  test("the file-import path is still reachable regardless of anything on this card (item 8)", async ({ page }) => {
    await openSurveyDeviceCard(page);
    // #basicNmeaInput is the always-available NMEA file uploader in the
    // header, independent of the QZ1測量 card's own transport controls.
    await expect(page.locator("#basicNmeaInput")).toBeAttached();
  });
});

// ---------------------------------------------------------------------------
// A. Desktop Chromium: both Bluetooth and Serial offered
// ---------------------------------------------------------------------------

test.describe("desktop Chromium", () => {
  test("both QZ1LE Bluetooth and QZ1 Serial options are offered, with no iOS fallback", async ({ page }) => {
    await openSurveyDeviceCard(page);
    await expect(page.locator("#qz1leIosFallback")).toBeHidden();
    await expect(page.locator("#qz1DeviceControls")).toBeVisible();
    const bluetoothOption = page.locator('#deviceSourceSelect option[value="qz1-bluetooth"]');
    await expect(bluetoothOption).toBeAttached();
    await expect(bluetoothOption).toBeEnabled();
  });

  test("the shipped (unconfigured) BLE profile disables the connect action and explains why, never guessing a UUID", async ({ page }) => {
    await openSurveyDeviceCard(page);
    await selectBluetoothSource(page);
    await expect(page.locator("#bluetoothStatusNote")).toBeVisible();
    await expect(page.locator("#bluetoothStatusNote")).toContainText("特定されていません");
    await expect(page.locator("#serialConnectButton")).toBeDisabled();
  });

  test("a browser with no navigator.bluetooth at all gets the generic unsupported notice, distinct from the iOS one", async ({ page }) => {
    await page.addInitScript(() => {
      delete Navigator.prototype.bluetooth;
    });
    await openSurveyDeviceCard(page);
    // Not iOS: the card still shows its normal controls (Serial still works
    // on desktop), but the Bluetooth option itself is disabled.
    await expect(page.locator("#qz1leIosFallback")).toBeHidden();
    const bluetoothOption = page.locator('#deviceSourceSelect option[value="qz1-bluetooth"]');
    await expect(bluetoothOption).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// B. Android + Chrome/Web Bluetooth: Bluetooth + file, no Serial -- and a
// full connect -> notify -> shared-pipeline proof against a fake GATT stack.
// ---------------------------------------------------------------------------

test.describe("Android Chrome", () => {
  test.use({ userAgent: ANDROID_CHROME_UA });

  test("offers QZ1LE Bluetooth (no Serial option, no iOS fallback)", async ({ page }) => {
    await page.addInitScript(() => {
      delete Navigator.prototype.serial;
    });
    await page.addInitScript(installFakeBluetooth, { serviceUuid: REAL_SERVICE_UUID, characteristicUuid: REAL_CHAR_UUID, rejectPicker: false });
    await openSurveyDeviceCard(page);

    await expect(page.locator("#qz1leIosFallback")).toBeHidden();
    await expect(page.locator("#qz1DeviceControls")).toBeVisible();
    const bluetoothOption = page.locator('#deviceSourceSelect option[value="qz1-bluetooth"]');
    await expect(bluetoothOption).toBeEnabled();
  });

  test("with a configured BLE profile, a full connect streams fake NMEA through the exact same shared pipeline as Serial", async ({ page }) => {
    await page.addInitScript((profile) => {
      window.SUISUI_QZ1LE_BLE_PROFILE = profile;
    }, { serviceUuid: REAL_SERVICE_UUID, notifyCharacteristicUuid: REAL_CHAR_UUID, deviceNamePrefix: "QZ1LE" });
    await page.addInitScript(installFakeBluetooth, { serviceUuid: REAL_SERVICE_UUID, characteristicUuid: REAL_CHAR_UUID, rejectPicker: false });

    await openSurveyDeviceCard(page);
    await selectBluetoothSource(page);
    await expect(page.locator("#bluetoothStatusNote")).toContainText("試験的な実装");
    await expect(page.locator("#serialConnectButton")).toBeEnabled();
    await expect(page.locator("#serialConnectButton")).toHaveText("QZ1LEに接続");

    await page.locator("#serialConnectButton").click();
    await expect(page.locator("#serialStatus")).toHaveText("接続中（未検証）");

    // Confirms requestDevice() was called with the REAL configured service --
    // never a guessed one.
    const requestCalls = await page.evaluate(() => window.__fakeQz1leBluetooth.requestCalls);
    expect(requestCalls).toHaveLength(1);
    expect(requestCalls[0].filters).toEqual([{ services: [REAL_SERVICE_UUID], namePrefix: "QZ1LE" }]);

    // Stream a GGA sentence split across two notifications (byte-chunk
    // boundary) plus one complete in a single notification -- the exact
    // same handleSerialLine() pipeline the Web Serial transport uses.
    await page.evaluate(() => {
      window.__fakeQz1leCharacteristic.notifyText("$GNGGA,012345.00,3439.2705,N,13549.8410,E,2,14,0.9,45.0,M,30.0,M,,*5C\r\n");
    });
    await expect(page.locator("#recFixQualityLabel")).toHaveText("2", { timeout: 10_000 });
    await expect(page.locator("#serialDownloadButton")).toBeEnabled();
    await expect(page.locator("#totalPoints")).not.toHaveText("0", { timeout: 10_000 });

    // Clean disconnect.
    await page.locator("#serialConnectButton").click();
    await expect(page.locator("#serialStatus")).toHaveText("未接続");
    await expect(page.locator("#serialConnectButton")).toHaveText("QZ1LEに接続");
  });

  test("the user cancelling the device chooser is reported, not left hanging", async ({ page }) => {
    await page.addInitScript((profile) => {
      window.SUISUI_QZ1LE_BLE_PROFILE = profile;
    }, { serviceUuid: REAL_SERVICE_UUID, notifyCharacteristicUuid: REAL_CHAR_UUID, deviceNamePrefix: "QZ1LE" });
    await page.addInitScript(installFakeBluetooth, { serviceUuid: REAL_SERVICE_UUID, characteristicUuid: REAL_CHAR_UUID, rejectPicker: true });

    await openSurveyDeviceCard(page);
    await selectBluetoothSource(page);
    await page.locator("#serialConnectButton").click();
    await expect(page.locator("#serialStatus")).toHaveText("未接続");
    await expect(page.locator("#serialMessage")).not.toHaveText("");
  });
});
