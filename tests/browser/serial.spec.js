import { test, expect } from "@playwright/test";

// The QZ1 live-capture card uses the Web Serial API for both USB serial and
// Bluetooth Classic SPP virtual ports. These tests exercise capability
// detection and the full read → line split → NMEA parse pipeline against a
// fake navigator.serial, since CI has no physical receiver.

async function openSurveySerialCard(page) {
  await page.goto("/#survey");
  await page.getByRole("button", { name: "QZ1測量" }).click();
  await page.evaluate(() => {
    document.querySelectorAll("details[data-workspace='survey']").forEach((card) => { card.open = true; });
  });
}

test("web serial unsupported browsers get a disabled button and desktop guidance", async ({ page }) => {
  await page.addInitScript(() => {
    delete Navigator.prototype.serial;
  });
  await openSurveySerialCard(page);
  await expect(page.locator("#serialStatus")).toHaveText("非対応");
  await expect(page.locator("#serialConnectButton")).toBeDisabled();
  await expect(page.locator("#serialMessage")).toContainText("Chrome / Edge");
  // Desktop browsers must not be shown the Android logger fallback steps.
  await expect(page.locator("#serialFallbackSteps")).toBeHidden();
});

test("a fake SPP-style serial port streams NMEA through the shared pipeline", async ({ page }) => {
  await page.addInitScript(() => {
    // Valid GGA sentences (fix quality 2 = DGNSS) near the demo field.
    const SENTENCES = [
      "$GNGGA,012345.00,3439.2705,N,13549.8410,E,2,14,0.9,45.0,M,30.0,M,,*5C",
      "$GNGGA,012346.00,3439.2706,N,13549.8412,E,2,14,0.9,45.1,M,30.0,M,,*5D",
      "$GNGGA,012347.00,3439.2707,N,13549.8414,E,1,09,1.4,45.2,M,30.0,M,,*5E"
    ];
    class FakeSerialPort {
      constructor() {
        this.readable = null;
        this._source = null;
      }
      // Bluetooth SPP virtual ports expose no USB vendor/product id.
      getInfo() {
        return {};
      }
      async open() {
        const encoder = new TextEncoder();
        this.readable = new ReadableStream({
          start(controller) {
            let index = 0;
            this._timer = setInterval(() => {
              const sentence = SENTENCES[index % SENTENCES.length];
              index += 1;
              try {
                controller.enqueue(encoder.encode(`${sentence}\r\n`));
              } catch {
                clearInterval(this._timer);
              }
            }, 40);
          },
          cancel() {
            clearInterval(this._timer);
          }
        });
      }
      async close() {
        this.readable = null;
      }
    }
    const fakeSerial = {
      _granted: [],
      async getPorts() {
        return this._granted;
      },
      async requestPort() {
        const port = new FakeSerialPort();
        this._granted.push(port);
        return port;
      },
      addEventListener() {}
    };
    Object.defineProperty(Navigator.prototype, "serial", {
      configurable: true,
      get: () => fakeSerial
    });
  });

  await openSurveySerialCard(page);
  await expect(page.locator("#serialStatus")).toHaveText("未接続");
  await expect(page.locator("#serialConnectButton")).toBeEnabled();
  await expect(page.locator("#serialConnectButton")).toHaveText("QZ1に接続");

  await page.locator("#serialConnectButton").click();
  await expect(page.locator("#serialStatus")).toHaveText("接続中");
  await expect(page.locator("#serialMessage")).toContainText("Bluetooth");
  await expect(page.locator("#serialConnectButton")).toHaveText("切断");

  // The shared pipeline turns GGA sentences into map points and raw log lines.
  await expect(page.locator("#serialPointCount")).not.toHaveText("0", { timeout: 10_000 });
  await expect(page.locator("#serialLastFix")).toContainText("2");
  await expect(page.locator("#serialDownloadButton")).toBeEnabled();
  const lineCount = Number(await page.locator("#serialLineCount").textContent());
  expect(lineCount).toBeGreaterThan(0);
  await expect(page.locator("#totalPoints")).not.toHaveText("0", { timeout: 10_000 });

  // Clean disconnect restores the reconnect-ready state (granted port kept).
  await page.locator("#serialConnectButton").click();
  await expect(page.locator("#serialStatus")).toHaveText("未接続");
  await expect(page.locator("#serialConnectButton")).toHaveText("QZ1に再接続");
  await expect(page.locator("#serialMessage")).toContainText("ログを保存");

  // Reconnect skips the picker by reusing the granted port.
  await page.locator("#serialConnectButton").click();
  await expect(page.locator("#serialStatus")).toHaveText("接続中");
  await page.locator("#serialConnectButton").click();
  await expect(page.locator("#serialStatus")).toHaveText("未接続");
});
