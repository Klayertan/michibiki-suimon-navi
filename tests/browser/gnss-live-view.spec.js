import { test, expect } from "@playwright/test";

// Fake QZ1 stream through a fake navigator.serial: GGA fixes of three
// different quality grades, GSV/GSA satellite data and an RMC course, then the
// signal badge, quality-coloured points and the facing marker are checked.

const STREAM = [
  "$GPGSV,2,1,06,07,45,120,38,08,30,200,27,10,60,010,41,13,15,300,",
  "$GPGSV,2,2,06,193,70,180,44,194,12,045,20",
  "$GNGSA,A,3,07,10,193,,,,,,,,,,1.2,0.9,0.8",
  "$GNGGA,012345.00,3439.2705,N,13549.8410,E,2,14,0.9,45.0,M,30.0,M,,*5C",
  "$GNRMC,012345.00,A,3439.2705,N,13549.8410,E,3.00,90.0,120726,,,D",
  "$GNGGA,012346.00,3439.2706,N,13549.8412,E,1,09,1.4,45.1,M,30.0,M,,*5D",
  "$GNGGA,012347.00,3439.2707,N,13549.8414,E,1,04,6.5,45.2,M,30.0,M,,*5E"
];

async function installFakeSerial(page, sentences) {
  await page.addInitScript((lines) => {
    const port = {
      getInfo: () => ({}),
      async open() {
        const encoder = new TextEncoder();
        this.readable = new ReadableStream({
          start(controller) {
            // Keep the stream open: a closed stream would read as a disconnect.
            controller.enqueue(encoder.encode(`${lines.join("\r\n")}\r\n`));
          }
        });
      },
      async close() {
        await this.readable?.cancel().catch(() => {});
      }
    };
    const serial = { async getPorts() { return []; }, async requestPort() { return port; }, addEventListener() {} };
    Object.defineProperty(Navigator.prototype, "serial", { configurable: true, get: () => serial });
  }, sentences);
}

async function openSurvey(page) {
  await page.goto("/#survey");
  await page.getByRole("button", { name: "QZ1測量" }).click();
  await page.evaluate(() => {
    document.querySelectorAll("details[data-workspace='survey']").forEach((card) => { card.open = true; });
  });
}

// The locate button lives with the map controls of another workspace, so it is
// triggered through the DOM (a real click handler run) instead of being
// clicked while hidden behind the survey card.
async function toggleLocate(page) {
  await page.locator("#locateButton").evaluate((button) => button.click());
}

test("signal panel shows a green badge, satellites and a sky plot for a good DGNSS fix", async ({ page }) => {
  await installFakeSerial(page, STREAM.slice(0, 5));
  await openSurvey(page);
  await expect(page.locator("#gnssSignalPanel .gnss-badge")).toHaveClass(/gnss-badge--none/);

  await page.locator("#serialConnectButton").click();
  await expect(page.locator("#gnssSignalPanel .gnss-badge")).toHaveClass(/gnss-badge--good/, { timeout: 10_000 });
  await expect(page.locator("#gnssSignalPanel .gnss-badge-label")).toContainText("良好");
  await expect(page.locator("#gnssSignalPanel .gnss-badge-detail")).toContainText("DGNSS");
  await expect(page.locator("#gnssSignalPanel .gnss-summary")).toContainText("視野内 6");
  await expect(page.locator("#gnssSignalPanel .gnss-sat")).toHaveCount(6);
  await expect(page.locator("#gnssSignalPanel .gnss-bar-row")).toHaveCount(6);
});

test("recorded points are coloured by fix quality (green, orange, red)", async ({ page }) => {
  await installFakeSerial(page, [STREAM[3], STREAM[5], STREAM[6]]);
  await openSurvey(page);
  await page.locator("#serialConnectButton").click();
  await expect(page.locator("path.qz1-point")).toHaveCount(3, { timeout: 15_000 });
  const fills = await page.locator("path.qz1-point").evaluateAll((paths) => paths.map((path) => path.getAttribute("fill")));
  expect(new Set(fills)).toEqual(new Set(["#15803d", "#d97706", "#b91c1c"]));
});

test("the blue current-location marker follows the QZ1 fix and faces its course", async ({ page, context }) => {
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 34.0, longitude: 135.0 });
  await installFakeSerial(page, STREAM.slice(0, 5));
  await openSurvey(page);

  await toggleLocate(page);
  await expect(page.locator(".loc-marker")).toHaveCount(1, { timeout: 10_000 });

  await page.locator("#serialConnectButton").click();
  // RMC says 90 degrees at 3 knots (about 1.5 m/s): moving, so the cone follows the course.
  await expect(page.locator(".loc-cone")).toHaveAttribute("style", /rotate\(90(\.0)?deg\)/, { timeout: 10_000 });
  await expect(page.locator(".loc-marker")).not.toHaveClass(/loc-marker--no-heading/);

  // Turning the location off removes the marker.
  await toggleLocate(page);
  await expect(page.locator(".loc-marker")).toHaveCount(0);
});

test("compass events rotate the cone when standing still", async ({ page, context }) => {
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 34.0, longitude: 135.0 });
  // Modern Chromium and iOS Safari both gate motion events behind
  // requestPermission(); the headless default would deny it.
  await page.addInitScript(() => {
    DeviceOrientationEvent.requestPermission = async () => "granted";
  });
  await openSurvey(page);
  await toggleLocate(page);
  await expect(page.locator(".loc-marker")).toHaveCount(1, { timeout: 10_000 });
  await expect(page.locator(".loc-marker")).toHaveClass(/loc-marker--no-heading/);

  await page.evaluate(() => {
    const event = new Event("deviceorientationabsolute");
    Object.assign(event, { absolute: true, alpha: 270 });
    window.dispatchEvent(event);
  });
  // alpha 270 (counter-clockwise from north) is a heading of 90 degrees.
  await expect(page.locator(".loc-cone")).toHaveAttribute("style", /rotate\(90(\.0)?deg\)/);
  await expect(page.locator(".loc-marker")).not.toHaveClass(/loc-marker--no-heading/);
});
