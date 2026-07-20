import { test, expect } from "@playwright/test";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// A small square walked loop near the demo field. The last point is close
// to the first (~1m) so the loop should auto-close.
const TIGHT_LOOP = [
  { lat: 34.65480, lon: 135.82982, fixQuality: 1, satelliteCount: 8, hdop: 1.1, timestamp: "120000.00" },
  { lat: 34.65480, lon: 135.83027, fixQuality: 1, satelliteCount: 8, hdop: 1.1, timestamp: "120010.00" },
  { lat: 34.65444, lon: 135.83027, fixQuality: 1, satelliteCount: 8, hdop: 1.1, timestamp: "120020.00" },
  { lat: 34.65444, lon: 135.82982, fixQuality: 1, satelliteCount: 8, hdop: 1.1, timestamp: "120030.00" },
  { lat: 34.654799, lon: 135.829825, fixQuality: 2, satelliteCount: 9, hdop: 0.9, timestamp: "120040.00" }
];

// Same walk, but the last point is left ~50m away from the start.
const OPEN_LOOP = [
  { lat: 34.65480, lon: 135.82982, fixQuality: 1, satelliteCount: 8, hdop: 1.1 },
  { lat: 34.65480, lon: 135.83027, fixQuality: 1, satelliteCount: 8, hdop: 1.1 },
  { lat: 34.65444, lon: 135.83027, fixQuality: 1, satelliteCount: 8, hdop: 1.1 },
  { lat: 34.65500, lon: 135.83100, fixQuality: 1, satelliteCount: 8, hdop: 1.1 }
];

async function openAnalysisWorkspace(page) {
  // A hash-only URL change on an already-loaded page is a same-document
  // navigation (no reload), so it never re-runs the app's one-time
  // switchWorkspace(location.hash) init. Tests that first visit another
  // workspace (e.g. #survey, to import measurement JSON) must switch tabs
  // by clicking the actual tab button, not by navigating to a new hash.
  await page.getByRole("button", { name: "詳細解析" }).click();
  await expect(page.locator("#fieldCreateButton")).toBeAttached({ timeout: 15_000 });
  await page.evaluate(() => {
    document.querySelectorAll("details[data-workspace='analysis']").forEach((card) => { card.open = true; });
  });
}

async function importMeasurementJson(page, records) {
  await page.goto("/#survey");
  await page.locator("#importInput").setInputFiles({
    name: "walk.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(records))
  });
  await expect(page.locator("#totalPoints")).toHaveText(String(records.length));
}

test("a tight walked loop auto-closes into a field polygon with default name/id", async ({ page }) => {
  await importMeasurementJson(page, TIGHT_LOOP);
  await openAnalysisWorkspace(page);

  await page.locator("#fieldCreateButton").click();
  await expect(page.locator("#fieldCreateMessage")).toContainText("圃場1");
  await expect(page.locator("#fieldCloseWarning")).toBeHidden();
  await expect(page.locator("#fieldAnnotationSummaryFields")).toHaveText("1");

  // Newly created field is auto-selected in the editor.
  await expect(page.locator("#selFeatureForm")).toBeVisible();
  await expect(page.locator("#selFeatureNameInput")).toHaveValue("圃場1");
  await expect(page.locator("#selFeatureIdInput")).toHaveValue("paddy-001");
  await expect(page.locator("#selFeatureTypeSelect")).toBeDisabled();
  await expect(page.locator("#selFeatureTypeSelect")).toHaveValue("field");
  await expect(page.locator("#selFeatureRelatedFieldSelect")).toBeDisabled();

  // The polygon label is on the map.
  await expect(page.locator(".field-annotation-label").first()).toContainText("圃場1");
});

test("an open loop shows the exact confirmation message and only closes on explicit confirm", async ({ page }) => {
  await importMeasurementJson(page, OPEN_LOOP);
  await openAnalysisWorkspace(page);

  await page.locator("#fieldCreateButton").click();
  await expect(page.locator("#fieldCloseWarning")).toBeVisible();
  await expect(page.locator("#fieldCloseWarningText")).toContainText("始点と終点が離れています。圃場ポリゴンを閉じますか？");
  await expect(page.locator("#fieldAnnotationSummaryFields")).toHaveText("0");

  // Cancel: nothing is created.
  await page.locator("#fieldCloseCancelButton").click();
  await expect(page.locator("#fieldCloseWarning")).toBeHidden();
  await expect(page.locator("#fieldAnnotationSummaryFields")).toHaveText("0");

  // Retry and confirm this time.
  await page.locator("#fieldCreateButton").click();
  await page.locator("#fieldCloseConfirmButton").click();
  await expect(page.locator("#fieldAnnotationSummaryFields")).toHaveText("1");
  await expect(page.locator("#selFeatureNameInput")).toHaveValue("圃場1");
});

test("a second field gets sequential defaults, and water control points can be added and linked to a field", async ({ page }) => {
  await importMeasurementJson(page, TIGHT_LOOP);
  await openAnalysisWorkspace(page);
  await page.locator("#fieldCreateButton").click();
  await expect(page.locator("#fieldAnnotationSummaryFields")).toHaveText("1");

  // Create a second field from the same points to check sequential defaults.
  await page.locator("#fieldCreateButton").click();
  await expect(page.locator("#fieldAnnotationSummaryFields")).toHaveText("2");
  await expect(page.locator("#selFeatureNameInput")).toHaveValue("圃場2");
  await expect(page.locator("#selFeatureIdInput")).toHaveValue("paddy-002");

  // Add a water control point at the current (latest) QZ1 position.
  await page.locator("#wcpAddTypeSelect").selectOption("inlet");
  await page.locator("#wcpAddCurrentPositionButton").click();
  await expect(page.locator("#fieldAnnotationSummaryPoints")).toHaveText("1");
  await expect(page.locator("#selFeatureTypeSelect")).toBeEnabled();
  await expect(page.locator("#selFeatureTypeSelect")).toHaveValue("inlet");
  await expect(page.locator("#selFeatureRelatedFieldSelect")).toBeEnabled();

  // Link it to 圃場1 and change its type to 排水口, then save.
  const options = await page.locator("#selFeatureRelatedFieldSelect option").allTextContents();
  expect(options.some((label) => label.includes("圃場1"))).toBe(true);
  await page.locator("#selFeatureRelatedFieldSelect").selectOption({ label: options.find((l) => l.includes("圃場1")) });
  await page.locator("#selFeatureTypeSelect").selectOption("outlet");
  await page.locator("#selFeatureNameInput").fill("北側排水口");
  await page.locator("#selFeatureMemoInput").fill("テストメモ");
  await page.locator("#selFeatureSaveButton").click();
  await expect(page.locator("#selFeatureMessage")).toContainText("保存しました");
});

test("saving a duplicate ID is rejected without changing the existing feature", async ({ page }) => {
  await importMeasurementJson(page, TIGHT_LOOP);
  await openAnalysisWorkspace(page);
  await page.locator("#fieldCreateButton").click(); // paddy-001
  await page.locator("#fieldCreateButton").click(); // paddy-002, currently selected

  await page.locator("#selFeatureIdInput").fill("paddy-001");
  await page.locator("#selFeatureSaveButton").click();
  await expect(page.locator("#selFeatureMessage")).toContainText("既に使用されています");
  // The field list must still show two distinct fields.
  await expect(page.locator("#fieldAnnotationSummaryFields")).toHaveText("2");
});

test("clicking on the map places a water control point of the selected type", async ({ page }) => {
  await importMeasurementJson(page, TIGHT_LOOP);
  await openAnalysisWorkspace(page);

  await page.locator("#wcpAddTypeSelect").selectOption("gate");
  await page.locator("#wcpAddMapClickButton").click();
  await expect(page.locator("#wcpAddMapClickButton")).toHaveClass(/active/);
  await page.locator("#map").click({ position: { x: 300, y: 200 } });
  await expect(page.locator("#fieldAnnotationSummaryPoints")).toHaveText("1");
  await expect(page.locator("#selFeatureTypeSelect")).toHaveValue("gate");
  await expect(page.locator("#wcpAddMapClickButton")).not.toHaveClass(/active/);
});

test("deleting a selected water control point removes it after confirmation", async ({ page }) => {
  await importMeasurementJson(page, TIGHT_LOOP);
  await openAnalysisWorkspace(page);
  await page.locator("#wcpAddTypeSelect").selectOption("sensor");
  await page.locator("#wcpAddCurrentPositionButton").click();
  await expect(page.locator("#fieldAnnotationSummaryPoints")).toHaveText("1");

  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#selFeatureDeleteButton").click();
  await expect(page.locator("#fieldAnnotationSummaryPoints")).toHaveText("0");
  await expect(page.locator("#selFeatureForm")).toBeHidden();
});

test("export includes fields, waterControlPoints, measurements and metadata; older files still load", async ({ page }) => {
  await importMeasurementJson(page, TIGHT_LOOP);
  await openAnalysisWorkspace(page);
  await page.locator("#fieldCreateButton").click();
  await page.locator("#wcpAddTypeSelect").selectOption("photo");
  await page.locator("#wcpAddCurrentPositionButton").click();

  const downloadPromise = page.waitForEvent("download");
  await page.locator("#exportAnalysisButton").click();
  const download = await downloadPromise;
  const dir = await mkdtemp(path.join(tmpdir(), "field-annotation-"));
  const exportPath = path.join(dir, "export.json");
  await download.saveAs(exportPath);
  const exported = JSON.parse(await readFile(exportPath, "utf8"));

  expect(exported.fields).toHaveLength(1);
  expect(exported.fields[0].name).toBe("圃場1");
  expect(exported.fields[0].id).toBe("paddy-001");
  expect(exported.waterControlPoints).toHaveLength(1);
  expect(exported.waterControlPoints[0].type).toBe("photo");
  expect(exported.measurements).toHaveLength(TIGHT_LOOP.length);
  // The app's existing JSON-import path labels the source as "測量JSON"
  // rather than threading through the literal filename — metadata.sourceFileName
  // just surfaces whatever label the app already tracks (activePointSource).
  expect(exported.metadata.sourceFileName).toBe("測量JSON");
  expect(exported.metadata.fixQualitySummary.total).toBe(TIGHT_LOOP.length);
  expect(exported.metadata.fixQualitySummary.byFixQuality["1"]).toBe(4);
  expect(exported.metadata.fixQualitySummary.byFixQuality["2"]).toBe(1);

  // Simulate an older project file with no field-annotation keys at all.
  const legacy = { ...exported };
  delete legacy.fields;
  delete legacy.waterControlPoints;
  delete legacy.measurements;
  delete legacy.metadata;
  const legacyPath = path.join(dir, "legacy.json");
  await writeFile(legacyPath, JSON.stringify(legacy));
  await page.locator("#paddyImportInput").setInputFiles(legacyPath);
  await expect(page.locator("#fieldAnnotationSummaryFields")).toHaveText("0");
  await expect(page.locator("#fieldAnnotationSummaryPoints")).toHaveText("0");
  await expect(page.locator("#paddyAreaMetric")).not.toHaveText("—");

  // Round trip: re-importing the full export restores both records.
  await page.locator("#paddyImportInput").setInputFiles(exportPath);
  await expect(page.locator("#fieldAnnotationSummaryFields")).toHaveText("1");
  await expect(page.locator("#fieldAnnotationSummaryPoints")).toHaveText("1");
});
