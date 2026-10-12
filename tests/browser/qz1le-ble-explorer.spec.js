import { test, expect } from "@playwright/test";

test("BLE explorer enumerates fake GATT and identifies valid NMEA after split notifications", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { Qz1LeBleExplorer } = await import("/js/recording/qz1le-ble-explorer.js");
    const characteristic = {
      uuid: "char-uart",
      properties: { notify: true, indicate: false },
      async startNotifications() {},
      addEventListener(_name, callback) { this.callback = callback; }
    };
    const service = { uuid: "service-uart", async getCharacteristics() { return [characteristic]; } };
    const device = { id: "fake-device", name: "fake-QZ1LE", gatt: { async connect() { return { async getPrimaryServices() { return [service]; } }; } } };
    const explorer = new Qz1LeBleExplorer({ bluetooth: { async requestDevice(options) { window.requestOptions = options; return device; } } });
    await explorer.discover();
    const profile = await explorer.subscribe("service-uart", "char-uart");
    const make = (body) => {
      let checksum = 0;
      for (const char of body) checksum ^= char.charCodeAt(0);
      return `$${body}*${checksum.toString(16).padStart(2, "0").toUpperCase()}\r\n`;
    };
    const text = make("GNGGA,123519,4807.038,N,01131.000,E,2,12,0.8,545.4,M,46.9,M,,") + make("GNRMC,123519,A,4807.038,N,01131.000,E,0.0,0.0,230394,,,A");
    const bytes = new TextEncoder().encode(text);
    for (let offset = 0; offset < bytes.length; offset += 20) {
      const chunk = bytes.slice(offset, offset + 20);
      const buffer = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
      characteristic.callback({ target: { value: new DataView(buffer) } });
    }
    return { options: window.requestOptions, profile, lines: explorer.receivedLines };
  });
  expect(result.options.acceptAllDevices).toBe(true);
  expect(result.options.optionalServices.length).toBeGreaterThan(0);
  expect(result.profile.serviceUuid).toBe("service-uart");
  expect(result.lines).toHaveLength(2);
  await expect(page.locator("#androidConnectionDiagnostics")).toBeAttached();
});
