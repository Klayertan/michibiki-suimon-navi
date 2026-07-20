import { test, expect } from "@playwright/test";

const TIGHT_LOOP_NMEA = [
  "$GNGGA,120000.00,3439.2880,N,13549.7892,E,1,8,1.1,45.0,M,30.0,M,,*7A",
  "$GNGGA,120010.00,3439.2880,N,13549.8162,E,1,8,1.1,45.0,M,30.0,M,,*72",
  "$GNGGA,120020.00,3439.2664,N,13549.8162,E,1,8,1.1,45.0,M,30.0,M,,*75",
  "$GNGGA,120030.00,3439.2664,N,13549.7892,E,1,8,1.1,45.0,M,30.0,M,,*7D",
  "$GNGGA,120040.00,3439.2879,N,13549.7895,E,2,9,0.9,45.0,M,30.0,M,,*74"
].join("\r\n");

async function openSurveyWorkspace(page) {
  await page.goto("/#survey");
  await expect(page.locator("#fieldRegDialog")).toBeAttached({ timeout: 15_000 });
  await page.evaluate(() => {
    document.querySelectorAll("details[data-workspace='survey']").forEach((card) => { card.open = true; });
  });
}

async function registerField(page, { fileName = "walk.txt" } = {}) {
  await page.locator("#fileInput").setInputFiles({ name: fileName, mimeType: "text/plain", buffer: Buffer.from(TIGHT_LOOP_NMEA) });
  await page.locator("#fieldRegConfirmButton").click();
}

async function openDecisionWorkspace(page) {
  await page.getByRole("button", { name: "判断デモ" }).click();
}

test("判断デモ shows the 対象圃場/使用データ selector, and the empty-state message when no registered field data exists", async ({ page }) => {
  await page.goto("/#decision");
  await expect(page.locator("#decisionFieldSelect")).toBeAttached({ timeout: 15_000 });
  await expect(page.locator("#decisionFieldCard")).toContainText("対象圃場 / 使用データ");
  await expect(page.locator("#decisionFieldEmptyState")).toBeVisible();
  await expect(page.locator("#decisionFieldEmptyState")).toHaveText(
    "まだ実測圃場データがありません。QZ1測量でNMEAログをアップロードし、圃場を登録してください。"
  );
  await expect(page.locator("#decisionFieldSummary")).toBeHidden();

  // The bundled sample and demo options are still selectable even with no registered data.
  const optionTexts = await page.locator("#decisionFieldSelect option").allTextContents();
  expect(optionTexts).toContain("校内実測サンプル");
  expect(optionTexts.some((text) => text.includes("デモ"))).toBe(true);
});

test("registered fields appear in the selector, and a real registered field is the default (over the bundled sample)", async ({ page }) => {
  await openSurveyWorkspace(page);
  await registerField(page);
  await openDecisionWorkspace(page);

  await expect(page.locator("#decisionFieldSelect")).toHaveValue("paddy-001");
  const optionTexts = await page.locator("#decisionFieldSelect option").allTextContents();
  expect(optionTexts.some((text) => text.includes("圃場1") && text.includes("paddy-001"))).toBe(true);
  await expect(page.locator("#decisionFieldSummary")).toBeVisible();
  await expect(page.locator("#decisionFieldEmptyState")).toBeHidden();
});

test("selecting 圃場1 updates the decision card with real survey data, and empty water-point/observation notices show correctly", async ({ page }) => {
  await openSurveyWorkspace(page);
  await registerField(page);
  await openDecisionWorkspace(page);

  await expect(page.locator("#decisionFieldLabel")).toHaveText("圃場1 / paddy-001");
  await expect(page.locator("#decisionSourceFile")).toHaveText("walk.txt");
  await expect(page.locator("#decisionValidPoints")).toHaveText("5点");
  await expect(page.locator("#decisionGpsBreakdown")).toHaveText("4点 / 1点");
  await expect(page.locator("#decisionReliability")).not.toHaveText("—");
  await expect(page.locator("#decisionWaterPointsNote")).toHaveText("この圃場には水門・給水口・排水口がまだ登録されていません。");
  await expect(page.locator("#decisionObservationsNote")).toHaveText("現地観察メモはまだ登録されていません。");
});

test("データ種別 and 判断プロファイル are clearly separate fields, and データ種別 reflects the selected data source", async ({ page }) => {
  await openSurveyWorkspace(page);
  await registerField(page);
  await openDecisionWorkspace(page);

  await expect(page.locator("#decisionDataKind")).toHaveText("実測QZ1ログ");
  await expect(page.locator("#decisionProfileLabel")).toHaveText("一般水田管理");

  await page.locator("#decisionProfileSelect").selectOption("heavy_rain");
  await expect(page.locator("#decisionProfileLabel")).toHaveText("大雨前");
  // Changing the profile must never change the data-source label.
  await expect(page.locator("#decisionDataKind")).toHaveText("実測QZ1ログ");

  await page.locator("#decisionFieldSelect").selectOption("__demo__");
  await expect(page.locator("#decisionDataKind")).toHaveText("デモ");
  // Changing the data source must never change the already-chosen profile.
  await expect(page.locator("#decisionProfileLabel")).toHaveText("大雨前");
});

test("水管理ポイント and 現地観察メモ counts are reflected once registered, replacing the empty-state notices", async ({ page }) => {
  await openSurveyWorkspace(page);
  await registerField(page);
  await page.locator("#wcpTargetFieldSelect").selectOption("paddy-001");
  await page.locator("#wcpAddGateButton").click();
  await page.locator("#wcpPositionCurrentButton").click();
  await page.locator("#obsTargetFieldSelect").selectOption("paddy-001");
  await page.locator("#obsAddWeedButton").click();
  await page.locator("#obsPositionQz1Button").click();
  await page.locator("#selFeatureSaveButton").click();

  await openDecisionWorkspace(page);
  await expect(page.locator("#decisionWaterPointsNote")).toHaveText("水管理ポイント: 1件登録済み");
  await expect(page.locator("#decisionObservationsNote")).toHaveText("現地観察メモ: 1件登録済み");
});

test("校内実測サンプル stays selectable and optional — choosing it loads the bundled sample and labels it as サンプル, not forced by default", async ({ page }) => {
  await openSurveyWorkspace(page);
  await registerField(page);
  await openDecisionWorkspace(page);

  // A registered field is the default, not the sample.
  await expect(page.locator("#decisionFieldSelect")).not.toHaveValue("__sample__");

  await page.locator("#decisionFieldSelect").selectOption("__sample__");
  await expect(page.locator("#decisionDataKind")).toHaveText("サンプル");
  await expect(page.locator("#decisionFieldLabel")).toHaveText("校内実測サンプル");
  await expect(page.locator("#decisionValidPoints")).not.toHaveText("—");
  await expect(page.locator("#proofTotal")).not.toHaveText("—"); // the bundled proof was actually loaded, not just labeled
});

test("with no registered fields, the built-in sample can still be selected manually and shows correct data", async ({ page }) => {
  await page.goto("/#decision");
  await expect(page.locator("#decisionFieldSelect")).toBeAttached({ timeout: 15_000 });
  await page.locator("#decisionFieldSelect").selectOption("__sample__");
  await expect(page.locator("#decisionFieldEmptyState")).toBeHidden();
  await expect(page.locator("#decisionFieldSummary")).toBeVisible();
  await expect(page.locator("#decisionDataKind")).toHaveText("サンプル");
});
