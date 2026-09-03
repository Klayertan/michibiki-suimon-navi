import { test, expect } from "@playwright/test";

const TIGHT_LOOP_NMEA = [
  "$GNGGA,120000.00,3439.2880,N,13549.7892,E,1,8,1.1,45.0,M,30.0,M,,*7A",
  "$GNGGA,120010.00,3439.2880,N,13549.8162,E,1,8,1.1,45.0,M,30.0,M,,*72",
  "$GNGGA,120020.00,3439.2664,N,13549.8162,E,1,8,1.1,45.0,M,30.0,M,,*75",
  "$GNGGA,120030.00,3439.2664,N,13549.7892,E,1,8,1.1,45.0,M,30.0,M,,*7D",
  "$GNGGA,120040.00,3439.2879,N,13549.7895,E,2,9,0.9,45.0,M,30.0,M,,*74"
].join("\r\n");

test("bare root is Basic and normal mode navigation owns the URL, refresh, and history", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("body")).toHaveAttribute("data-mode", "basic");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('[data-mode-target="basic"]')).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".engineering-nav")).toBeHidden();
  // Basic gets the compact Stage-1 card; .survey-tools is the Settings-only
  // power-user surface it replaced.
  await expect(page.locator("#basicStage1Card")).toBeVisible();
  await expect(page.locator(".survey-tools")).toBeHidden();
  await expect(page.locator("#basicFieldManagementCard")).toBeVisible();

  await page.locator('[data-mode-target="drone"]').click();
  await expect(page).toHaveURL(/#drone$/);
  await expect(page.locator("body")).toHaveAttribute("data-mode", "drone");
  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-mode", "drone");

  await page.locator('[data-mode-target="basic"]').click();
  await expect(page).toHaveURL(/#basic$/);
  await expect(page.locator("body")).toHaveAttribute("data-mode", "basic");

  await page.goBack();
  await expect(page).toHaveURL(/#drone$/);
  await expect(page.locator("body")).toHaveAttribute("data-mode", "drone");
  await page.goForward();
  await expect(page).toHaveURL(/#basic$/);
  await expect(page.locator("body")).toHaveAttribute("data-mode", "basic");
});

test("legacy workspaces remain compatible inside Settings and canonicalize after normal navigation", async ({ page }) => {
  await page.goto("/#survey");
  await expect(page.locator("body")).toHaveAttribute("data-mode", "settings");
  await expect(page.locator("body")).toHaveAttribute("data-workspace", "survey");
  await expect(page.locator('[data-mode-target="settings"]')).toHaveAttribute("aria-selected", "true");
  // The workspace tabs are always shown directly now -- no more click-to-
  // expand <details>/open state to check.
  await expect(page.locator(".engineering-nav")).toBeVisible();
  await expect(page.locator('[data-workspace-target="survey"]')).toHaveAttribute("aria-selected", "true");

  // ドローンモード's own 報告 tab reuses data-workspace-target="analysis"
  // too (see .drone-engineering-nav in index.html), so this needs to name
  // the Settings tab specifically by its own text.
  await page.getByRole("button", { name: "詳細解析" }).click();
  await expect(page).toHaveURL(/#settings\/analysis$/);
  await expect(page.locator("body")).toHaveAttribute("data-workspace", "analysis");

  await page.locator('[data-mode-target="basic"]').click();
  await expect(page).toHaveURL(/#basic$/);
  await expect(page.locator(".engineering-nav")).toBeHidden();

  await page.goto("/#unknown-route");
  await expect(page).toHaveURL(/#basic$/);
  await expect(page.locator("body")).toHaveAttribute("data-mode", "basic");
});

test("aerial basemap keeps center and every existing overlay while enforcing field-scale zoom", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#basemapMapButton")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".leaflet-control-attribution")).toContainText("OpenStreetMap");
  await expect(page.locator(".leaflet-control-attribution")).not.toContainText("国土地理院");

  // Register through Basic mode's own Stage-1 flow: the old shared
  // uploader was removed (see index.html); #fieldRegDialog is reachable
  // only via #typedSurveyUploadInput now, for the narrower 測量タイプ case.
  await page.locator("#basicNmeaInput").setInputFiles({
    name: "walk.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(TIGHT_LOOP_NMEA)
  });
  await expect(page.locator("#basicBoundaryControls")).toBeVisible();
  await page.locator("#basicCreateFieldButton").click();
  await page.locator("#basicFieldRegConfirmButton").click();
  await expect(page.locator("#fieldAnnotationSummaryFields")).toHaveText("1");

  const before = await page.evaluate(() => {
    window.map.setView([34.6545, 135.8302], 12, { animate: false });
    const baseLayers = Object.values(window.suisuiBasemap.layers);
    window.__stage1OverlayLayers = [];
    window.map.eachLayer((layer) => {
      if (!baseLayers.includes(layer)) window.__stage1OverlayLayers.push(layer);
    });
    const center = window.map.getCenter();
    return {
      center: [center.lat, center.lng],
      overlayCount: window.__stage1OverlayLayers.length,
      fieldCount: window.fieldAnnotationController.fields.length
    };
  });
  expect(before.overlayCount).toBeGreaterThan(0);
  expect(before.fieldCount).toBe(1);

  await page.locator("#basemapAerialButton").click();
  await expect(page.locator("#basemapAerialButton")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".leaflet-control-attribution")).toContainText("国土地理院");
  await expect(page.locator(".leaflet-control-attribution")).not.toContainText("OpenStreetMap");
  await expect.poll(() => page.evaluate(() => window.map.getZoom())).toBeGreaterThanOrEqual(14);

  const aerial = await page.evaluate(() => {
    const center = window.map.getCenter();
    return {
      active: window.suisuiBasemap.active,
      center: [center.lat, center.lng],
      overlaysIntact: window.__stage1OverlayLayers.every((layer) => window.map.hasLayer(layer)),
      fieldCount: window.fieldAnnotationController.fields.length,
      tileUrl: window.suisuiBasemap.layers.aerial._url
    };
  });
  expect(aerial.active).toBe("aerial");
  expect(aerial.tileUrl).toBe("https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg");
  expect(aerial.center[0]).toBeCloseTo(before.center[0], 5);
  expect(aerial.center[1]).toBeCloseTo(before.center[1], 5);
  expect(aerial.overlaysIntact).toBe(true);
  expect(aerial.fieldCount).toBe(1);

  await page.locator("#basemapMapButton").click();
  await expect(page.locator("#basemapMapButton")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".leaflet-control-attribution")).toContainText("OpenStreetMap");
  expect(await page.evaluate(() => window.__stage1OverlayLayers.every((layer) => window.map.hasLayer(layer)))).toBe(true);
  expect(await page.evaluate(() => window.fieldAnnotationController.fields.length)).toBe(1);
});

for (const viewport of [{ width: 390, height: 844 }, { width: 393, height: 852 }]) {
  test(`Stage-1 map and basemap toggle stay usable at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    const layout = await page.evaluate(() => {
      const header = document.querySelector(".app-header").getBoundingClientRect();
      const map = document.querySelector("#map").getBoundingClientRect();
      const emptyState = document.querySelector("#emptyState").getBoundingClientRect();
      const toggle = document.querySelector(".basemap-toggle").getBoundingClientRect();
      const zoom = document.querySelector(".leaflet-control-zoom").getBoundingClientRect();
      const buttons = [...document.querySelectorAll("[data-basemap]")].map((button) => button.getBoundingClientRect());
      const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      return {
        headerHeight: header.height,
        mapHeight: map.height,
        noHorizontalScroll: document.documentElement.scrollWidth <= window.innerWidth,
        toggleClearOfMessage: !overlaps(toggle, emptyState),
        toggleClearOfZoom: !overlaps(toggle, zoom),
        buttonHeights: buttons.map((box) => box.height),
        buttonWidths: buttons.map((box) => box.width)
      };
    });
    expect(layout.headerHeight).toBeLessThan(150);
    expect(layout.mapHeight).toBeGreaterThanOrEqual(330);
    expect(layout.noHorizontalScroll).toBe(true);
    expect(layout.toggleClearOfMessage).toBe(true);
    expect(layout.toggleClearOfZoom).toBe(true);
    expect(layout.buttonHeights.every((height) => height >= 44)).toBe(true);
    expect(layout.buttonWidths.every((width) => width >= 64)).toBe(true);
    await page.locator("#basemapAerialButton").click();
    await expect(page.locator("#basemapAerialButton")).toHaveAttribute("aria-pressed", "true");
  });
}
