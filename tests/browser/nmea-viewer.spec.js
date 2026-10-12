import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

// The recorded-NMEA window: look at a saved recording, then download it, put it
// on the map, or delete it. Uses the same fake serial stream as recording.spec.js.

const VALID_GGA = "$GNGGA,012345.00,3439.2705,N,13549.8410,E,2,14,0.9,45.0,M,30.0,M,,*44";

async function installFakeSerialPort(page) {
  await page.addInitScript((sentence) => {
    class FakeSerialPort {
      getInfo() { return {}; }
      async open() {
        const encoder = new TextEncoder();
        this.readable = new ReadableStream({
          start: (controller) => {
            this._timer = setInterval(() => {
              try { controller.enqueue(encoder.encode(`${sentence}\r\n`)); } catch { clearInterval(this._timer); }
            }, 40);
          },
          cancel: () => clearInterval(this._timer)
        });
      }
      async close() { this.readable = null; }
    }
    const fakeSerial = {
      _granted: [],
      async getPorts() { return this._granted; },
      async requestPort() { const port = new FakeSerialPort(); this._granted.push(port); return port; },
      addEventListener() {}
    };
    Object.defineProperty(Navigator.prototype, "serial", { configurable: true, get: () => fakeSerial });
  }, VALID_GGA);
}

async function openRecordingCard(page) {
  await page.goto("/#survey");
  await page.getByRole("button", { name: "QZ1測量" }).click();
  await page.evaluate(() => {
    document.querySelectorAll("details[data-workspace='survey']").forEach((card) => { card.open = true; });
  });
  await expect(page.locator("#recStartButton")).toBeAttached({ timeout: 15_000 });
}

async function recordAndStop(page) {
  await page.locator("#serialConnectButton").click();
  await expect(page.locator("#serialStatus")).toHaveText("接続中");
  await page.locator("#recStartButton").click();
  await expect(page.locator("#recRecordingStateLabel")).toHaveText("記録中");
  await expect.poll(async () => Number(await page.locator("#recReceivedLineCount").textContent())).toBeGreaterThan(4);
  await page.locator("#recStopButton").click();
  await expect(page.locator("#recRecordingStateLabel")).toHaveText("終了");
  // Disconnect so no further live fixes arrive while checking the saved file.
  await page.locator("#serialConnectButton").click();
  await expect(page.locator("#serialStatus")).toHaveText("未接続");
}

async function sessionCount(page) {
  return page.evaluate(async () => {
    const { RecordingStore } = await import("/js/recording/recording-store.js");
    return (await new RecordingStore().listSessions()).length;
  });
}

test("with nothing recorded the button explains instead of opening an empty window", async ({ page }) => {
  await installFakeSerialPort(page);
  await openRecordingCard(page);
  await page.locator("#recViewNmeaButton").click();
  await expect(page.locator("#recNmeaDialog")).not.toHaveAttribute("open", "");
  await expect(page.locator("#recMessage")).toContainText("確認できる記録がまだありません");
});

test("after stopping, 記録を確認 shows the saved NMEA and a summary, and downloads it", async ({ page }) => {
  await installFakeSerialPort(page);
  await openRecordingCard(page);
  await recordAndStop(page);
  await expect(page.locator("#recMessage")).toContainText("記録を確認");

  await page.locator("#recViewNmeaButton").click();
  await expect(page.locator("#recNmeaDialog")).toHaveAttribute("open", "");
  await expect(page.locator("#recNmeaSessionSelect option")).toHaveCount(1);
  await expect(page.locator("#recNmeaPreview")).toContainText("$GNGGA,012345.00");
  await expect(page.locator("#recNmeaSummary")).toContainText("有効な測位");
  await expect(page.locator("#recNmeaSummary")).toContainText("良好");

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#recNmeaDownloadButton").click()
  ]);
  expect(download.suggestedFilename()).toMatch(/\.nmea$/);
  const text = await readFile(await download.path(), "utf8");
  const lines = text.trim().split(/\r\n/);
  expect(lines.length).toBeGreaterThan(4);
  expect(lines.every((line) => line === VALID_GGA)).toBe(true);
  await expect(page.locator("#recNmeaMessage")).toContainText("ダウンロードしました");
});

test("地図に反映 puts the saved recording's fixes on the map and closes the window", async ({ page }) => {
  await installFakeSerialPort(page);
  await openRecordingCard(page);
  await recordAndStop(page);

  // A reload empties the map (points live in memory); the recording survives in IndexedDB.
  await page.reload();
  await openRecordingCard(page);
  await expect(page.locator("#totalPoints")).toHaveText("0");

  await page.locator("#recViewNmeaButton").click();
  await expect(page.locator("#recNmeaDialog")).toHaveAttribute("open", "");
  await page.locator("#recNmeaApplyButton").click();

  await expect(page.locator("#recNmeaDialog")).not.toHaveAttribute("open", "");
  await expect(page.locator("#recMessage")).toContainText("地図に反映しました");
  await expect(page.locator("#totalPoints")).not.toHaveText("0");
});

test("削除 needs a second tap, then removes the recording from IndexedDB and closes the window", async ({ page }) => {
  await installFakeSerialPort(page);
  await openRecordingCard(page);
  await recordAndStop(page);
  expect(await sessionCount(page)).toBe(1);

  await page.locator("#recViewNmeaButton").click();
  await expect(page.locator("#recNmeaDialog")).toHaveAttribute("open", "");

  await page.locator("#recNmeaDeleteButton").click();
  await expect(page.locator("#recNmeaDeleteButton")).toContainText("本当に削除する");
  expect(await sessionCount(page)).toBe(1);

  await page.locator("#recNmeaDeleteButton").click();
  await expect(page.locator("#recNmeaDialog")).not.toHaveAttribute("open", "");
  await expect.poll(() => sessionCount(page)).toBe(0);
});

test("a recording that is still running cannot be deleted from the window", async ({ page }) => {
  await installFakeSerialPort(page);
  await openRecordingCard(page);
  await page.locator("#serialConnectButton").click();
  await expect(page.locator("#serialStatus")).toHaveText("接続中");
  await page.locator("#recStartButton").click();
  await expect(page.locator("#recRecordingStateLabel")).toHaveText("記録中");
  await expect.poll(async () => Number(await page.locator("#recReceivedLineCount").textContent())).toBeGreaterThan(2);

  await page.locator("#recViewNmeaButton").click();
  await expect(page.locator("#recNmeaDialog")).toHaveAttribute("open", "");
  await expect(page.locator("#recNmeaPreview")).toContainText("$GNGGA");
  await page.locator("#recNmeaDeleteButton").click();
  await expect(page.locator("#recNmeaMessage")).toContainText("記録終了");
  await expect(page.locator("#recNmeaDeleteButton")).toHaveText("削除");
  expect(await sessionCount(page)).toBe(1);
});
