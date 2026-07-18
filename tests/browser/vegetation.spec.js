import { test, expect } from "@playwright/test";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(new URL("../fixtures/vegetation-import.json", import.meta.url));

function datetimeLocal(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function openAnalysisWorkspace(page) {
  await page.goto("/#analysis");
  await expect(page.locator("#vegFormCellSelect option").nth(1)).toBeAttached({ timeout: 15_000 });
  // Expand the collapsible vegetation cards like a user opening them.
  await page.evaluate(() => {
    document.querySelectorAll("details[data-workspace='analysis']").forEach((card) => { card.open = true; });
  });
}

async function pickCell(page, index = 5) {
  const value = await page.locator("#vegFormCellSelect option").nth(index).getAttribute("value");
  await page.locator("#vegFormCellSelect").selectOption(value);
  return value;
}

test("vegetation observations can be recorded, compared and prioritised per grid cell", async ({ page }) => {
  await openAnalysisWorkspace(page);
  const cellId = await pickCell(page);
  await expect(page.locator("#vegSelectedCell")).toHaveText(cellId);
  await expect(page.locator("#vegAddButton")).toBeEnabled();

  const earlier = new Date(Date.now() - 14 * 86400000);
  await page.locator("#vegTimestampInput").fill(datetimeLocal(earlier));
  await page.locator("#vegWeedInput").fill("8.1");
  await page.locator("#vegCropInput").fill("84.9");
  await page.locator("#vegBareInput").fill("3");
  await page.locator("#vegWaterInput").fill("4");
  await page.locator("#vegConfidenceInput").fill("0.9");
  await page.locator("#vegSeveritySelect").selectOption("low");
  await page.locator("#vegAddButton").click();
  await expect(page.locator("#vegSummaryTotal")).toHaveText("1");
  await expect(page.locator("#vegSummaryCellsWith")).toHaveText("1");

  await page.locator("#vegTimestampInput").fill(datetimeLocal(new Date()));
  await page.locator("#vegWeedInput").fill("18.2");
  await page.locator("#vegCropInput").fill("74.8");
  await page.locator("#vegSeveritySelect").selectOption("high");
  await page.locator("#vegAddButton").click();
  await expect(page.locator("#vegSummaryTotal")).toHaveText("2");

  await expect(page.locator("#vegCellSummary")).toContainText("増加 / Increasing");
  await expect(page.locator("#vegCellSummary")).toContainText("+10.1pt");
  await expect(page.locator("#vegComparisonWarnings")).toContainText("Weed coverage increased by 10.1pt");
  await expect(page.locator("#vegPriorityScore")).toContainText("/100");
  await expect(page.locator("#vegPriorityReasons li").first()).toBeVisible();
  await expect(page.locator("#vegHistoryTable tr")).toHaveCount(2);
  await expect(page.locator("#vegHistoryChart")).toBeVisible();

  // Percent-sum warning is non-blocking: values are kept and add stays possible.
  await page.locator("#vegWeedInput").fill("10");
  await page.locator("#vegCropInput").fill("10");
  await expect(page.locator("#vegFormWarnings")).toContainText("合計");
  await expect(page.locator("#vegAddButton")).toBeEnabled();

  // Update the selected (newest) observation from the history table.
  await page.locator("#vegHistoryTable tr").first().click();
  await page.locator("#vegWeedInput").fill("25");
  await page.locator("#vegUpdateButton").click();
  await expect(page.locator("#vegHistoryTable tr").first()).toContainText("25.0%");

  // Delete it again (confirm dialog accepted).
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#vegHistoryTable tr").first().click();
  await page.locator("#vegDeleteButton").click();
  await expect(page.locator("#vegSummaryTotal")).toHaveText("1");
  await expect(page.locator("#vegHistoryTable tr")).toHaveCount(1);
});

test("AI import validates rows, reports counts and routes ambiguous positions to review", async ({ page }) => {
  await openAnalysisWorkspace(page);
  await page.locator("#vegImportInput").setInputFiles(FIXTURE);
  await expect(page.locator("#vegImportMessage")).toContainText("取込 3 件");
  await expect(page.locator("#vegImportMessage")).toContainText("失敗 1 件");
  await expect(page.locator("#vegImportMessage")).toContainText("必須フィールドがありません");
  await expect(page.locator("#vegSummaryTotal")).toHaveText("3");

  // Re-importing the same file must not create duplicates.
  await page.locator("#vegImportInput").setInputFiles(FIXTURE);
  await expect(page.locator("#vegImportMessage")).toContainText("重複スキップ 3 件");
  await expect(page.locator("#vegSummaryTotal")).toHaveText("3");

  // The near-boundary record must sit in the review queue, not be silently assigned.
  const reviewCount = Number(await page.locator("#vegSummaryReview").textContent());
  expect(reviewCount).toBeGreaterThanOrEqual(1);
  const reviewOption = page.locator("#vegReviewSelect option").nth(1);
  await expect(reviewOption).toBeAttached();
  await page.locator("#vegReviewSelect").selectOption(await reviewOption.getAttribute("value"));
  await expect(page.locator("#vegReviewDetail")).toContainText("元の座標");
  await expect(page.locator("#vegOverrideAssociationButton")).toBeEnabled();
  await page.locator("#vegOverrideAssociationButton").click();
  await expect(page.locator("#vegReviewMessage")).toContainText("割り当てました");
  const reviewAfter = Number(await page.locator("#vegSummaryReview").textContent());
  expect(reviewAfter).toBeLessThan(reviewCount);

  // Overlay legend always explains the no-data state.
  await expect(page.locator("#vegLegend")).toContainText("No data");
});

test("project export carries vegetation data and older project files still load", async ({ page }) => {
  await openAnalysisWorkspace(page);
  await pickCell(page);
  await page.locator("#vegWeedInput").fill("9");
  await page.locator("#vegCropInput").fill("85");
  await page.locator("#vegBareInput").fill("3");
  await page.locator("#vegWaterInput").fill("3");
  await page.locator("#vegAddButton").click();
  await expect(page.locator("#vegSummaryTotal")).toHaveText("1");

  const downloadPromise = page.waitForEvent("download");
  await page.locator("#exportAnalysisButton").click();
  const download = await downloadPromise;
  const dir = await mkdtemp(path.join(tmpdir(), "veg-export-"));
  const exportPath = path.join(dir, "export.json");
  await download.saveAs(exportPath);
  const exported = JSON.parse(await readFile(exportPath, "utf8"));
  expect(exported.schemaVersion).toBe("paddy-intelligence.v1");
  expect(exported.vegetationObservations).toHaveLength(1);
  expect(exported.vegetationObservations[0].gridCellId).toBeTruthy();
  expect(exported.vegetationSettings.confidenceThreshold).toBeDefined();
  expect(exported.vegetationSummary.totalObservations).toBe(1);
  expect(Array.isArray(exported.field.boundary)).toBe(true);

  // Simulate an older project file (no vegetation keys) → must load cleanly.
  const legacy = { ...exported };
  delete legacy.vegetationObservations;
  delete legacy.vegetationSettings;
  delete legacy.vegetationSummary;
  const legacyPath = path.join(dir, "legacy.json");
  await writeFile(legacyPath, JSON.stringify(legacy));
  await page.locator("#paddyImportInput").setInputFiles(legacyPath);
  await expect(page.locator("#vegSummaryTotal")).toHaveText("0");
  await expect(page.locator("#paddyAreaMetric")).not.toHaveText("—");

  // Round trip: re-import the new-format export restores the observation.
  await page.locator("#paddyImportInput").setInputFiles(exportPath);
  await expect(page.locator("#vegSummaryTotal")).toHaveText("1");
});
