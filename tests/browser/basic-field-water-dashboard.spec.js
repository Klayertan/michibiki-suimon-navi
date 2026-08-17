import { test, expect } from "@playwright/test";

// Basic Mode's field-water-management dashboard: one 圃場の管理 card (field
// selector + satellite thumbnail + registered-field list), one 今日の水門判断
// hero (multi-field mini-cards + quantitative water-need message), and the
// single active-field state that already existed continuing to drive all of
// it. See docs/STAGE1_FIELD_WATER_DASHBOARD.md.

function gga(time, lat, lon, fix = 1, sats = 8, hdop = "1.1") {
  const body = `GNGGA,${time},${lat},N,${lon},E,${fix},${sats},${hdop},45.0,M,30.0,M,,`;
  let checksum = 0;
  for (const character of body) {
    checksum ^= character.charCodeAt(0);
  }
  return `$${body}*${checksum.toString(16).toUpperCase().padStart(2, "0")}`;
}

/** A walk shaped like the real Stage-1 flow: approach, perimeter, return. */
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

/** Deterministic Open-Meteo response: dry today, then two rainy days. */
function mockOpenMeteoResponse() {
  const hours = [];
  const precip = [];
  const prob = [];
  const start = new Date("2026-08-10T00:00:00Z"); // 8 days before "today"
  for (let h = 0; h < 24 * 11; h += 1) {
    const t = new Date(start.getTime() + h * 3600000);
    hours.push(t.toISOString().slice(0, 13) + ":00");
    const dayIndex = Math.floor(h / 24); // 0-7 = past, 8 = today, 9-10 = forecast
    if (dayIndex === 9) {
      precip.push(2.5);
      prob.push(70);
    } else if (dayIndex === 10) {
      precip.push(0.5);
      prob.push(30);
    } else {
      precip.push(0);
      prob.push(5);
    }
  }
  return {
    hourly: { time: hours, precipitation: precip, precipitation_probability: prob }
  };
}

async function mockWeather(page) {
  await page.route("**/api.open-meteo.com/**", (route) => {
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockOpenMeteoResponse()) });
  });
}

async function openBasic(page) {
  await mockWeather(page);
  await page.goto("/");
  await expect(page.locator("body")).toHaveAttribute("data-mode", "basic");
}

/** Registers one field through Basic mode's own upload -> pick -> register flow. */
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

async function setWaterLevels(page, { current, target }) {
  if (current !== undefined) {
    await page.locator("#recObsWaterLevelInput").fill(String(current));
  }
  if (target !== undefined) {
    await page.locator("#recTargetWaterLevelInput").fill(String(target));
  }
}

// ---------------------------------------------------------------------------
// 1-2. Zero and one field
// ---------------------------------------------------------------------------

test("zero fields: 圃場の管理 and the hero both show the no-fields prompt, no meaningless 様子見", async ({ page }) => {
  await openBasic(page);

  await expect(page.locator("#basicFieldEmptyState")).toContainText("圃場はまだ登録されていません");
  await expect(page.locator("#basicFieldCurrentGroup")).toBeHidden();
  await expect(page.locator("#accountFieldsCard")).toBeHidden();

  await expect(page.locator("#waterHeroEmptyState")).toContainText("圃場を登録すると");
  await expect(page.locator("#waterHeroContent")).toBeHidden();
  await expect(page.locator("#waterHeroCarousel")).toBeHidden();
});

test("one field: satellite thumbnail, metadata and the missing-water-level hero prompt all render", async ({ page }) => {
  await openBasic(page);
  await registerField(page, "圃場2");

  // 圃場の管理: thumbnail + metadata.
  await expect(page.locator("#basicFieldCurrentGroup")).toBeVisible();
  const thumbnail = page.locator("#basicFieldThumbnail");
  await expect(thumbnail).toBeVisible();
  // L.map(container, ...) stamps leaflet-container on the container element
  // itself, not a descendant.
  await expect(thumbnail).toHaveClass(/leaflet-container/);
  await expect(thumbnail.locator(".leaflet-tile-pane")).toHaveCount(1);
  await expect(page.locator("#basicFieldArea")).toContainText("m²");
  await expect(page.locator("#basicFieldRegisteredDate")).not.toHaveText("—");
  await expect(page.locator("#basicFieldSourceFile")).toHaveText("圃場2.txt");

  // Registered-field list shows exactly the one field, marked active.
  await expect(page.locator("#accountFieldsCard")).toBeVisible();
  await expect(page.locator("#accountFieldsList .account-field-tile")).toHaveCount(1);
  await expect(page.locator("#accountFieldsList .account-field-tile").first()).toHaveClass(/is-active/);

  // Hero: no current/target level recorded yet -> missing-data message, not a
  // fabricated 0 cm / 0 m3, and the carousel stays hidden with only one field.
  await expect(page.locator("#waterHeroCarousel")).toBeHidden();
  await expect(page.locator("#waterHeroContent")).toBeVisible();
  await expect(page.locator("#waterHeroPrimary")).toContainText("現在の水位を記録すると");
  await expect(page.locator("#waterHeroVolume")).toHaveText("—");
  await expect(page.locator("#waterHeroConfidence")).toHaveText("—");
});

// ---------------------------------------------------------------------------
// 3. The quantitative message and volume arithmetic
// ---------------------------------------------------------------------------

test("recording current + target water level produces the exact quantitative hero message and volume", async ({ page }) => {
  await openBasic(page);
  await registerField(page, "圃場2");
  const areaText = await page.locator("#basicFieldArea").textContent();
  const areaM2 = Number(areaText.match(/([\d,]+)\s*m²/)[1].replace(/,/g, ""));

  await setWaterLevels(page, { current: 3.2, target: 5.5 });

  const expectedDepth = Math.round((5.5 - 3.2) * 10) / 10; // 2.3
  const volumeM3 = Math.round(((areaM2 * expectedDepth * 10) / 1000) * 10) / 10;

  await expect(page.locator("#waterHeroPrimary")).toHaveText(`水を ${expectedDepth.toFixed(1)} cm 入れてください`);
  await expect(page.locator("#waterHeroVolume")).toHaveText(`約 ${volumeM3.toFixed(1)} m³`);
  await expect(page.locator("#waterHeroConfidence")).toHaveText("高");
  // Secondary 推奨操作 badge is still present underneath, unremoved.
  await expect(page.locator("#verdictBadge")).toBeVisible();
});

test("current level above target -> remove message, still a non-negative volume", async ({ page }) => {
  await openBasic(page);
  await registerField(page, "圃場2");
  await setWaterLevels(page, { current: 9, target: 5 });

  await expect(page.locator("#waterHeroPrimary")).toHaveText("水位を約 4.0 cm 下げてください");
  const volumeText = await page.locator("#waterHeroVolume").textContent();
  expect(volumeText).not.toContain("-");
});

test("equal current and target -> hold, with 0 volume, not a missing-data prompt", async ({ page }) => {
  await openBasic(page);
  await registerField(page, "圃場2");
  await setWaterLevels(page, { current: 5, target: 5 });

  await expect(page.locator("#waterHeroPrimary")).toHaveText("現在の水位を維持してください");
  await expect(page.locator("#waterHeroVolume")).toHaveText("—");
});

// ---------------------------------------------------------------------------
// 4. Multiple fields: one active-field state, reached three ways
// ---------------------------------------------------------------------------

test("multiple fields: dropdown, registered-field row, and mini-card all drive the same active field", async ({ page }) => {
  await openBasic(page);
  await registerField(page, "圃場2", { latBase: "3439.2880", lonBase: "13549.7892", timePrefix: "12" });
  // makeSurveySessionId() stamps session ids to the second with no
  // uniqueness guard (see tests/browser/basic-ux-consolidation.spec.js's
  // registerTwoFields) -- two registrations inside one second collide and
  // both resolve to the first session's NMEA metadata. Pre-existing,
  // tracked separately; this test is about which field the selection
  // surfaces point at, so it steps around the collision rather than
  // asserting on it.
  await page.waitForTimeout(1100);
  await registerField(page, "圃場1", { latBase: "3439.1880", lonBase: "13549.6892", timePrefix: "13" });

  const select = page.locator("#basicActiveFieldSelect");
  const ids = await page.evaluate(() => window.fieldAnnotationController.fields.map((f) => f.id));
  expect(ids.length).toBe(2);

  // Carousel shows both, with volumes/deltas computed independently per field.
  await expect(page.locator("#waterHeroCarousel")).toBeVisible();
  await expect(page.locator("#waterHeroCarousel button[data-water-hero-field-id]")).toHaveCount(2);

  // 1. Select via the dropdown.
  await select.selectOption(ids[0]);
  await expect(page.locator("#basicFieldSourceFile")).toHaveText("圃場2.txt");

  // 2. Select via the registered-field list row.
  await page.locator(`#accountFieldsList button[data-account-field-id="${ids[1]}"]`).click();
  await expect(select).toHaveValue(ids[1]);
  await expect(page.locator("#basicFieldSourceFile")).toHaveText("圃場1.txt");

  // 3. Select via the hero's mini-card.
  await page.locator(`#waterHeroCarousel button[data-water-hero-field-id="${ids[0]}"]`).click();
  await expect(select).toHaveValue(ids[0]);
  await expect(page.locator("#basicFieldSourceFile")).toHaveText("圃場2.txt");
  await expect(page.locator(`#waterHeroCarousel button[data-water-hero-field-id="${ids[0]}"]`)).toHaveClass(/is-active/);

  // Field without a recorded level shows its mini-card as unrecorded, never a fake 0cm.
  await expect(page.locator(`#waterHeroCarousel button[data-water-hero-field-id="${ids[1]}"] .water-hero-mini-delta`))
    .toHaveText("水位未記録");
});

test("selecting a field re-fetches weather for that field's centroid", async ({ page }) => {
  const requestedCoords = [];
  await page.route("**/api.open-meteo.com/**", (route) => {
    const url = new URL(route.request().url());
    requestedCoords.push(`${url.searchParams.get("latitude")},${url.searchParams.get("longitude")}`);
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockOpenMeteoResponse()) });
  });
  await page.goto("/");
  await registerField(page, "圃場2", { latBase: "3439.2880", lonBase: "13549.7892", timePrefix: "12" });
  await registerField(page, "圃場1", { latBase: "3439.1880", lonBase: "13549.6892", timePrefix: "13" });

  const ids = await page.evaluate(() => window.fieldAnnotationController.fields.map((f) => f.id));
  await page.locator("#basicActiveFieldSelect").selectOption(ids[0]);
  await page.locator("#basicActiveFieldSelect").selectOption(ids[1]);

  // At least two distinct lat/lon pairs were requested -- weather followed
  // the field, it was not pinned to one fixed location throughout.
  const distinct = new Set(requestedCoords);
  expect(distinct.size).toBeGreaterThanOrEqual(2);
});

// ---------------------------------------------------------------------------
// 5. Weather forecast row (mocked, deterministic)
// ---------------------------------------------------------------------------

test("the 3-day forecast row renders today/tomorrow/day-after from the mocked response", async ({ page }) => {
  await openBasic(page);
  await registerField(page, "圃場2");

  const days = page.locator(".water-hero-forecast-day");
  await expect(days).toHaveCount(3);
  await expect(days.nth(0).locator(".water-hero-forecast-label")).toHaveText("今日");
  await expect(days.nth(1).locator(".water-hero-forecast-label")).toHaveText("明日");
  await expect(days.nth(2).locator(".water-hero-forecast-label")).toHaveText("明後日");
});

// ---------------------------------------------------------------------------
// 6. Staleness
// ---------------------------------------------------------------------------

test("a water level recorded 3+ days ago is flagged stale, and confidence drops", async ({ page }) => {
  await openBasic(page);
  await registerField(page, "圃場2");
  await setWaterLevels(page, { current: 3, target: 5 });

  const fieldId = await page.locator("#basicActiveFieldSelect").inputValue();
  await page.evaluate((id) => {
    const key = "suimonNaviCurrentWaterLevelV1";
    const all = JSON.parse(localStorage.getItem(key) || "{}");
    all[id] = { valueCm: 3, recordedAt: Date.now() - 4 * 86400000 };
    localStorage.setItem(key, JSON.stringify(all));
  }, fieldId);
  await page.reload();

  await expect(page.locator("#waterHeroStaleWarning")).toBeVisible();
  await expect(page.locator("#waterHeroStaleWarning")).toContainText("4日前");
  await expect(page.locator("#waterHeroConfidence")).toHaveText("低");
});

// ---------------------------------------------------------------------------
// 7. Persistence across reload
// ---------------------------------------------------------------------------

test("the active field and its recorded water levels survive a reload", async ({ page }) => {
  await openBasic(page);
  await registerField(page, "圃場2");
  await setWaterLevels(page, { current: 3.2, target: 5.5 });

  await page.reload();

  await expect(page.locator("#recObsWaterLevelInput")).toHaveValue("3.2");
  await expect(page.locator("#recTargetWaterLevelInput")).toHaveValue("5.5");
  await expect(page.locator("#waterHeroPrimary")).toHaveText("水を 2.3 cm 入れてください");
});

// ---------------------------------------------------------------------------
// 8. No duplication
// ---------------------------------------------------------------------------

test("exactly one active-field selector and exactly one full 今日の水門判断 hero", async ({ page }) => {
  await openBasic(page);
  await registerField(page, "圃場2");
  await registerField(page, "圃場1", { latBase: "3439.1880", lonBase: "13549.6892", timePrefix: "13" });

  await expect(page.locator("#basicActiveFieldSelect")).toHaveCount(1);
  await expect(page.locator(".gate-card")).toHaveCount(1);
  await expect(page.locator("#waterHeroContent")).toHaveCount(1);
  await expect(page.locator(".verdict")).toHaveCount(1);
  // The mini-card carousel is the one allowed compact per-field summary --
  // it must not duplicate into a second full 現在の田圃/管理 card.
  await expect(page.locator("#basicFieldManagementCard")).toHaveCount(1);
});
