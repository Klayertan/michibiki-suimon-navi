import { test, expect } from "@playwright/test";

// Real-user-data-first: the app must never auto-populate demo/placeholder
// field, grid, or paddy-intelligence sample content on a fresh load. Demo
// data must remain available, but only behind an explicit, clearly-labeled
// button click.

test("no demo field, grid, or paddy-intelligence sample content appears on a fresh load", async ({ page }) => {
  await page.goto("/#analysis");
  await expect(page.locator("#loadPaddyDemoButton")).toBeAttached({ timeout: 15_000 });
  await page.evaluate(() => {
    document.querySelectorAll("details[data-workspace='analysis']").forEach((card) => { card.open = true; });
  });

  // No field boundary/area, no grid cells, no demo water/plant/problem zones.
  await expect(page.locator("#paddyAreaMetric")).toHaveText("—");
  await expect(page.locator("#gridCellCountMetric")).toHaveText("0 セル");
  const state = await page.evaluate(() => ({
    fieldBoundaryLength: window.paddyIntelligence.analysis.fieldBoundary.length,
    waterPolygons: window.paddyIntelligence.analysis.waterPolygons.length,
    plantPolygons: window.paddyIntelligence.analysis.plantPolygons.length,
    problemZones: window.paddyIntelligence.analysis.problemZones.length,
    irrigationMarkers: window.paddyIntelligence.analysis.irrigationMarkers.length,
    gridCells: window.paddyIntelligence.gridCells.length
  }));
  expect(state).toEqual({
    fieldBoundaryLength: 0, waterPolygons: 0, plantPolygons: 0,
    problemZones: 0, irrigationMarkers: 0, gridCells: 0
  });

  // The field-annotation registered-list shows the exact requested empty state.
  await expect(page.locator("#registeredFieldsContainer")).toContainText(
    "まだ圃場データがありません。NMEAログをアップロードするか、地図上で圃場を登録してください。"
  );
  const fieldAnnotationState = await page.evaluate(() => ({
    fields: window.fieldAnnotationController.fields.length,
    tracks: window.fieldAnnotationController.boundaryTracks.length,
    points: window.fieldAnnotationController.waterControlPoints.length
  }));
  expect(fieldAnnotationState).toEqual({ fields: 0, tracks: 0, points: 0 });
});

test("the decision-demo field/gate info card shows empty state, not the placeholder field.json geometry, by default", async ({ page }) => {
  await page.goto("/#decision");
  await expect(page.locator("#fieldName")).toBeAttached({ timeout: 15_000 });
  await expect(page.locator("#fieldName")).toHaveText("—");
  await expect(page.locator("#fieldArea")).toHaveText("—");
  await expect(page.locator("#gateCoords")).toHaveText("—");
  await expect(page.locator("#gateSource")).toHaveText("未設定");
});

test("explicitly clicking デモを読み込む still loads the demo paddy sample on request", async ({ page }) => {
  await page.goto("/#analysis");
  await page.evaluate(() => {
    document.querySelectorAll("details[data-workspace='analysis']").forEach((card) => { card.open = true; });
  });
  await expect(page.locator("#paddyAreaMetric")).toHaveText("—");

  await page.locator("#loadPaddyDemoButton").click();
  await expect(page.locator("#paddyAreaMetric")).not.toHaveText("—");
  const state = await page.evaluate(() => ({
    fieldBoundaryLength: window.paddyIntelligence.analysis.fieldBoundary.length,
    waterPolygons: window.paddyIntelligence.analysis.waterPolygons.length
  }));
  expect(state.fieldBoundaryLength).toBeGreaterThan(0);
  expect(state.waterPolygons).toBeGreaterThan(0);
});

test("uploaded NMEA field data renders normally alongside the still-empty demo state", async ({ page }) => {
  const nmea = [
    "$GNGGA,120000.00,3439.2880,N,13549.7892,E,1,8,1.1,45.0,M,30.0,M,,*7A",
    "$GNGGA,120010.00,3439.2880,N,13549.8162,E,1,8,1.1,45.0,M,30.0,M,,*72",
    "$GNGGA,120020.00,3439.2664,N,13549.8162,E,1,8,1.1,45.0,M,30.0,M,,*75",
    "$GNGGA,120030.00,3439.2664,N,13549.7892,E,1,8,1.1,45.0,M,30.0,M,,*7D",
    "$GNGGA,120040.00,3439.2879,N,13549.7895,E,2,9,0.9,45.0,M,30.0,M,,*74"
  ].join("\r\n");

  await page.goto("/#survey");
  await expect(page.locator("#fieldRegDialog")).toBeAttached({ timeout: 15_000 });
  await page.evaluate(() => {
    document.querySelectorAll("details[data-workspace='survey']").forEach((card) => { card.open = true; });
  });
  await page.locator("#fileInput").setInputFiles({ name: "walk.txt", mimeType: "text/plain", buffer: Buffer.from(nmea) });
  await page.locator("#fieldRegConfirmButton").click();

  await expect(page.locator("#fieldAnnotationSummaryFields")).toHaveText("1");
  await expect(page.locator("#registeredFieldsContainer")).toContainText("圃場1 / paddy-001");
  await expect(page.locator(".field-annotation-label").first()).toContainText("圃場1");

  // The unrelated paddy-intelligence demo sample is still untouched/empty —
  // uploading real field-annotation data must not implicitly trigger it.
  const paddyState = await page.evaluate(() => window.paddyIntelligence.analysis.fieldBoundary.length);
  expect(paddyState).toBe(0);
});
