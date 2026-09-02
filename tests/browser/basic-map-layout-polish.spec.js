import { test, expect } from "@playwright/test";

// Desktop-only Basic-Mode layout polish: the main map's Leaflet zoom
// control sits top-right, directly under the 地図/航空写真 toggle it
// shares that corner with, and the freed upper-left corner gets a
// compact 今日の水門判断 read (sharing the SAME active-field state and
// computeWaterNeed() calculation as the full hero -- see
// renderMapWaterSummary() in index.html), and the right panel/mini-card
// carousel no longer forces the page to scroll or drag horizontally.
//
// Mobile (<=980px) is a regression-protected surface here, not a redesign
// target: the map summary stays hidden, the zoom control stays top-left,
// and the mini-card carousel stays the same horizontally-scrolling flex
// row it always was. Every mobile assertion below exists to prove nothing
// changed, not to describe new behavior.

function gga(time, lat, lon, fix = 1, sats = 8, hdop = "1.1") {
  const body = `GNGGA,${time},${lat},N,${lon},E,${fix},${sats},${hdop},45.0,M,30.0,M,,`;
  let checksum = 0;
  for (const character of body) {
    checksum ^= character.charCodeAt(0);
  }
  return `$${body}*${checksum.toString(16).toUpperCase().padStart(2, "0")}`;
}

function walkNmea({ latBase = "3439.2880", lonBase = "13549.7892", timePrefix = "12" } = {}) {
  const lat = parseFloat(latBase);
  const lon = parseFloat(lonBase);
  const shift = (v, d) => (v + d).toFixed(4);
  return [
    gga(`${timePrefix}0000.00`, shift(lat, -0.02), shift(lon, -0.01)),
    gga(`${timePrefix}0010.00`, shift(lat, -0.01), shift(lon, -0.005)),
    gga(`${timePrefix}0020.00`, latBase, lonBase),
    gga(`${timePrefix}0030.00`, shift(lat, 0.008), shift(lon, 0.005)),
    gga(`${timePrefix}0040.00`, shift(lat, 0.008), shift(lon, 0.032)),
    gga(`${timePrefix}0050.00`, shift(lat, -0.021), shift(lon, 0.032)),
    gga(`${timePrefix}0100.00`, shift(lat, -0.021), shift(lon, 0.005)),
    gga(`${timePrefix}0110.00`, shift(lat, 0.0079), shift(lon, 0.0053), 2, 9, "0.9"),
    gga(`${timePrefix}0120.00`, shift(lat, -0.05), shift(lon, -0.02)),
    gga(`${timePrefix}0130.00`, shift(lat, -0.06), shift(lon, -0.03))
  ].join("\r\n");
}

const START_INDEX = 3;
const END_INDEX = 7; // ~1m from START -> auto-closes

function mockOpenMeteoResponse() {
  const hours = [];
  const precip = [];
  const prob = [];
  const start = new Date("2026-08-10T00:00:00Z");
  for (let h = 0; h < 24 * 11; h += 1) {
    const t = new Date(start.getTime() + h * 3600000);
    hours.push(t.toISOString().slice(0, 13) + ":00");
    const dayIndex = Math.floor(h / 24);
    if (dayIndex === 9) { precip.push(2.5); prob.push(70); }
    else if (dayIndex === 10) { precip.push(0.5); prob.push(30); }
    else { precip.push(0); prob.push(5); }
  }
  return { hourly: { time: hours, precipitation: precip, precipitation_probability: prob } };
}

async function openBasic(page) {
  await page.route("**/api.open-meteo.com/**", (route) => {
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockOpenMeteoResponse()) });
  });
  await page.goto("/");
  await expect(page.locator("body")).toHaveAttribute("data-mode", "basic");
}

async function registerField(page, name, walkOptions) {
  await page.locator("#basicNmeaInput").setInputFiles({
    name: `${name}.txt`,
    mimeType: "text/plain",
    buffer: Buffer.from(walkNmea(walkOptions))
  });
  await expect(page.locator("#basicBoundaryControls")).toBeVisible();
  await page.locator("#basicPickStartButton").click();
  await page.locator(`.qz1-point-${START_INDEX}`).dispatchEvent("click");
  await page.locator("#basicPickEndButton").click();
  await page.locator(`.qz1-point-${END_INDEX}`).dispatchEvent("click");
  await page.locator("#basicCreateFieldButton").click();
  await expect(page.locator("#basicFieldRegDialog")).toBeVisible();
  await page.locator("#basicFieldRegNameInput").fill(name);
  await page.locator("#basicFieldRegConfirmButton").click();
  await expect(page.locator("#basicFieldRegDialog")).toBeHidden();
}

/** Real geometry, not CSS-string checks. */
async function overflowMetrics(page) {
  return page.evaluate(() => {
    const panel = document.querySelector(".panel");
    return {
      pageScrollWidth: document.documentElement.scrollWidth,
      pageClientWidth: document.documentElement.clientWidth,
      panelScrollWidth: panel.scrollWidth,
      panelClientWidth: panel.clientWidth
    };
  });
}

const DESKTOP_VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 1280, height: 900 }
];
const MOBILE_VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 393, height: 852 }
];

// ---------------------------------------------------------------------------
// 1-2. Zoom control: top-right on desktop, exactly one, no duplicate
// ---------------------------------------------------------------------------

for (const viewport of DESKTOP_VIEWPORTS) {
  test(`zoom control is top-right and singular at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openBasic(page);

    const controls = page.locator("#map .leaflet-control-zoom");
    await expect(controls).toHaveCount(1);

    const corner = await page.locator("#map .leaflet-control-zoom").evaluate((el) => {
      const parent = el.closest(".leaflet-top, .leaflet-bottom");
      return parent.className;
    });
    expect(corner).toContain("leaflet-top");
    expect(corner).toContain("leaflet-right");

    // The thumbnail map (once a field exists) must not grow its own zoom control.
    await registerField(page, "圃場1");
    await expect(page.locator("#basicFieldThumbnail .leaflet-control-zoom")).toHaveCount(0);
  });
}

test("zoom control stays top-left on mobile, unchanged", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openBasic(page);

  const controls = page.locator("#map .leaflet-control-zoom");
  await expect(controls).toHaveCount(1);
  const corner = await controls.evaluate((el) => el.closest(".leaflet-top, .leaflet-bottom").className);
  expect(corner).toContain("leaflet-top");
  expect(corner).toContain("leaflet-left");
});

// ---------------------------------------------------------------------------
// 3-8. Map water-summary card: renders, reflects the field, shares state
// ---------------------------------------------------------------------------

test("map summary renders, reflects the selected field, and matches the missing-water-level state", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await openBasic(page);
  await registerField(page, "圃場3");

  const card = page.locator("#mapWaterSummary");
  await expect(card).toBeVisible();
  await expect(card).toContainText("今日の水門判断");
  await expect(card).toContainText("圃場3");
  // With NO water level recorded the summary leads with the growth stage's
  // reference depth (or its management state), never with a request for input:
  // the recommendation needs only the surveyed area and the stage.
  await expect(page.locator("#mapWaterSummaryState")).not.toHaveText("水位未記録");
  await expect(page.locator("#mapWaterSummaryPrimary")).not.toContainText("現在の水位を記録すると");
  await expect(page.locator("#mapWaterSummaryPrimary")).toHaveText(/目標水深\s\d+〜\d+\s?mm|：/);
  await expect(page.locator("#mapWaterSummaryButton")).toHaveText("水位を記録");

  // Does not obscure the field polygon.
  const cardRect = await card.boundingBox();
  const polyRect = await page.locator("#map path.leaflet-interactive").first().boundingBox();
  const overlaps = !(cardRect.x + cardRect.width < polyRect.x || cardRect.x > polyRect.x + polyRect.width
    || cardRect.y + cardRect.height < polyRect.y || cardRect.y > polyRect.y + polyRect.height);
  expect(overlaps).toBe(false);
});

test("changing the active field updates the map summary, and it matches the full dashboard's calculation exactly", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await openBasic(page);
  await registerField(page, "圃場2", { latBase: "3439.2880", lonBase: "13549.7892", timePrefix: "12" });
  await page.waitForTimeout(1100); // session-id-per-second collision guard, see basic-field-water-dashboard.spec.js
  await registerField(page, "圃場1", { latBase: "3439.1880", lonBase: "13549.6892", timePrefix: "13" });

  const ids = await page.evaluate(() => window.fieldAnnotationController.fields.map((f) => f.id));

  await page.locator("#basicActiveFieldSelect").selectOption(ids[0]);
  await expect(page.locator("#mapWaterSummaryField")).toHaveText("圃場2");

  await page.locator("#recObsWaterLevelInput").fill("3.2");
  await page.locator("#recTargetWaterLevelInput").fill("5.5");

  const [mapPrimary, heroPrimary, mapVolumeText, heroVolumeText] = await Promise.all([
    page.locator("#mapWaterSummaryPrimary").textContent(),
    page.locator("#waterHeroPrimary").textContent(),
    page.locator("#mapWaterSummaryDetail").textContent(),
    page.locator("#waterHeroVolume").textContent()
  ]);
  expect(mapPrimary).toBe(heroPrimary);
  expect(mapPrimary).toBe("水を 2.3 cm 入れてください");
  expect(mapVolumeText).toContain(heroVolumeText.replace("約 ", "").replace(" m³", ""));

  // Switching field updates BOTH surfaces from the one active-field state.
  await page.locator("#basicActiveFieldSelect").selectOption(ids[1]);
  await expect(page.locator("#mapWaterSummaryField")).toHaveText("圃場1");
  // Unmeasured field: shows its target/management state, not "水位未記録".
  await expect(page.locator("#mapWaterSummaryState")).not.toHaveText("水位未記録");
  await expect(page.locator("#waterHeroFieldLabel")).toContainText("圃場1");
});

test("map summary disappears with zero fields and never fabricates a value", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await openBasic(page);
  await expect(page.locator("#mapWaterSummary")).toBeHidden();
});

test("the map summary's own button stays clickable (card is pointer-events:none except its button)", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await openBasic(page);
  await registerField(page, "圃場3");

  // Missing-data state -> button routes to 水位を記録する.
  await page.locator("#mapWaterSummaryButton").click();
  await expect(page.locator("#recObsWaterLevelInput")).toBeFocused();

  // Populated state -> button expands .gate-card in place, attached below
  // the summary (it no longer lives in the left rail on desktop -- see
  // .gate-card's own CSS comment).
  await page.locator("#recObsWaterLevelInput").fill("3.2");
  await page.locator("#recTargetWaterLevelInput").fill("5.5");
  await expect(page.locator("#mapWaterSummaryButton")).toHaveText("詳細を見る");
  await page.locator("#mapWaterSummaryButton").click();
  await expect(page.locator(".gate-card")).toBeInViewport();
});

test("the map summary does not block clicks on what is underneath it (pointer-events:none passthrough)", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await openBasic(page);
  await registerField(page, "圃場3");

  const summaryBox = await page.locator("#mapWaterSummary").boundingBox();
  // A point inside the card's own box, away from its button, must
  // hit-test to something on the map underneath (e.g. a Leaflet pane),
  // never the card itself -- that was the exact regression this test
  // guards against (a marker popup losing its clicks to this card).
  const hitId = await page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return el ? (el.id || el.className) : null;
    },
    [summaryBox.x + 4, summaryBox.y + 4]
  );
  expect(hitId).not.toBe("mapWaterSummary");
  expect(String(hitId)).not.toContain("map-water-summary");
});

// ---------------------------------------------------------------------------
// 9-12. No horizontal overflow, desktop field-selector grid, long filenames
// ---------------------------------------------------------------------------

async function registerFourFieldsWithLongName(page) {
  await registerField(page, "圃場3", { latBase: "3439.2880", lonBase: "13549.7892", timePrefix: "12" });
  await page.waitForTimeout(1100);
  await registerField(page, "圃場4", { latBase: "3439.1880", lonBase: "13549.6892", timePrefix: "13" });
  await page.waitForTimeout(1100);
  await registerField(page, "圃場5", { latBase: "3439.0880", lonBase: "13549.5892", timePrefix: "14" });
  await page.waitForTimeout(1100);
  await registerField(
    page,
    "圃場1_とても長いフィールド名のテストサンプル_overflow_check",
    { latBase: "3438.9880", lonBase: "13549.4892", timePrefix: "15" }
  );
}

for (const viewport of DESKTOP_VIEWPORTS) {
  test(`no horizontal overflow at ${viewport.width}x${viewport.height} with 4 fields and a long name/filename`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openBasic(page);
    await registerFourFieldsWithLongName(page);

    const metrics = await overflowMetrics(page);
    expect(metrics.pageScrollWidth).toBeLessThanOrEqual(metrics.pageClientWidth);
    expect(metrics.panelScrollWidth).toBeLessThanOrEqual(metrics.panelClientWidth);

    // Field selector is a wrapping grid, not a horizontal-scroll carousel.
    const carousel = page.locator("#waterHeroCarousel");
    await expect(carousel).toHaveCSS("display", "grid");
    const carouselBox = await carousel.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
    expect(carouselBox.scrollWidth).toBeLessThanOrEqual(carouselBox.clientWidth + 1);

    // Long filename is visible somewhere without stretching its row.
    const sourceFileRow = page.locator("#basicFieldSourceFile");
    const rowBox = await sourceFileRow.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.parentElement.clientWidth }));
    expect(rowBox.scrollWidth).toBeLessThanOrEqual(rowBox.clientWidth + 4);
  });
}

// ---------------------------------------------------------------------------
// 13-16 (mobile regression protection): overflow fixed, but carousel/zoom
// UX and appearance stay exactly as they were.
// ---------------------------------------------------------------------------

for (const viewport of MOBILE_VIEWPORTS) {
  test(`mobile ${viewport.width}x${viewport.height}: no page overflow, but the field-selector carousel and map summary are unchanged`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openBasic(page);
    await registerFourFieldsWithLongName(page);

    const metrics = await overflowMetrics(page);
    expect(metrics.pageScrollWidth).toBeLessThanOrEqual(metrics.pageClientWidth);
    expect(metrics.panelScrollWidth).toBeLessThanOrEqual(metrics.panelClientWidth);

    // Still the original horizontally-scrolling carousel -- not converted
    // to the desktop wrapping grid.
    const carousel = page.locator("#waterHeroCarousel");
    await expect(carousel).toHaveCSS("display", "flex");
    const carouselBox = await carousel.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
    expect(carouselBox.scrollWidth).toBeGreaterThan(carouselBox.clientWidth);

    // The desktop-only map summary must not appear on mobile.
    await expect(page.locator("#mapWaterSummary")).toBeHidden();
  });
}
