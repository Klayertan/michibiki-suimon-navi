import { test, expect } from "@playwright/test";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const TIGHT_LOOP_NMEA = [
  "$GNGGA,120000.00,3439.2880,N,13549.7892,E,1,8,1.1,45.0,M,30.0,M,,*7A",
  "$GNGGA,120010.00,3439.2880,N,13549.8162,E,1,8,1.1,45.0,M,30.0,M,,*72",
  "$GNGGA,120020.00,3439.2664,N,13549.8162,E,1,8,1.1,45.0,M,30.0,M,,*75",
  "$GNGGA,120030.00,3439.2664,N,13549.7892,E,1,8,1.1,45.0,M,30.0,M,,*7D",
  "$GNGGA,120040.00,3439.2879,N,13549.7895,E,2,9,0.9,45.0,M,30.0,M,,*74"
].join("\r\n");

const OPEN_L_SHAPE_NMEA = [
  "$GNGGA,193852.00,3439.2880,N,13549.7892,E,1,8,1.1,45.0,M,30.0,M,,*7D",
  "$GNGGA,193902.00,3439.2880,N,13549.8162,E,1,8,1.1,45.0,M,30.0,M,,*70",
  "$GNGGA,193912.00,3439.2664,N,13549.8162,E,1,8,1.1,45.0,M,30.0,M,,*75"
].join("\r\n");

async function openAnalysisWorkspace(page) {
  await page.getByRole("button", { name: "詳細解析" }).click();
  await page.evaluate(() => {
    document.querySelectorAll("details[data-workspace='analysis']").forEach((card) => { card.open = true; });
  });
}

/** Registers a field in QZ1測量 with one water-control point and one observation, then opens 詳細解析. */
async function registerFieldWithData(page) {
  await page.goto("/#survey");
  await expect(page.locator("#fieldRegDialog")).toBeAttached({ timeout: 15_000 });
  await page.evaluate(() => {
    document.querySelectorAll("details[data-workspace='survey']").forEach((card) => { card.open = true; });
  });
  await page.locator("#fileInput").setInputFiles({ name: "walk.txt", mimeType: "text/plain", buffer: Buffer.from(TIGHT_LOOP_NMEA) });
  await page.locator("#fieldRegConfirmButton").click();

  await page.locator("#wcpTargetFieldSelect").selectOption("paddy-001");
  await page.locator("#wcpAddGateButton").click();
  await page.locator("#wcpPositionCurrentButton").click();

  await page.locator("#obsTargetFieldSelect").selectOption("paddy-001");
  await page.locator("#obsAddWeedButton").click();
  await page.locator("#obsPositionQz1Button").click();
  await page.locator("#selFeatureSeveritySelect").selectOption("high");
  await page.locator("#selFeatureMemoInput").fill("畦道側に雑草が多い");
  await page.locator("#selFeatureSaveButton").click();

  await openAnalysisWorkspace(page);
}

test("圃場レポート panel appears with an empty state when no fields exist", async ({ page }) => {
  await page.goto("/#analysis");
  await expect(page.locator("#fieldReportPanel")).toBeAttached({ timeout: 15_000 });
  await page.evaluate(() => {
    document.querySelectorAll("details[data-workspace='analysis']").forEach((card) => { card.open = true; });
  });
  await expect(page.locator("#fieldReportPanel .details-title")).toContainText("圃場レポート");
  await expect(page.locator("#reportEmptyState")).toBeVisible();
  await expect(page.locator("#reportEmptyState")).toHaveText(
    "まだ圃場データがありません。QZ1測量でNMEAログをアップロードし、圃場を登録してください。"
  );
  await expect(page.locator("#reportGenerateButton")).toBeDisabled();
});

test("registered fields appear in the 対象圃場 selector, and レポートを生成 produces a full preview", async ({ page }) => {
  await registerFieldWithData(page);

  await expect(page.locator("#reportFieldSelect")).toContainText("圃場1");
  await expect(page.locator("#reportEmptyState")).toBeHidden();
  await expect(page.locator("#reportGenerateButton")).toBeEnabled();

  await page.locator("#reportGenerateButton").click();
  const preview = page.locator("#reportPreview");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("圃場レポート: 圃場1");
  await expect(preview.locator(".field-report-status-badge")).toContainText("総合判定:");

  // Basic info.
  await expect(preview).toContainText("圃場名");
  await expect(preview).toContainText("圃場1");
  await expect(preview).toContainText("paddy-001");
  await expect(preview).toContainText("データ種別");
  await expect(preview).toContainText("実測");

  // QZ1測量ログ: source filename, raw NMEA status, and point counts.
  await expect(preview).toContainText("walk.txt");
  await expect(preview).toContainText("元NMEA保存状態");
  await expect(preview).toContainText("保存済み");
  await expect(preview).toContainText("有効測位点");
  await expect(preview).toContainText("GPS単独");
  await expect(preview).toContainText("DGPS/補強あり");

  // 測量チェック結果 falls back to the QZ1-only check and is never blank.
  await expect(preview).toContainText("測量チェック結果");
  const status = await page.evaluate(() => window.fieldReportController.currentReport.summary.overallLabel);
  expect(["使用可能", "要確認", "再測量推奨", "証拠不足"]).toContain(status);
  expect(await page.evaluate(() => window.fieldReportController.currentReport.reliabilityCheck.source)).toBe("qz1_only_fallback");

  // 圃場形状・面積: registered as a closed polygon.
  await expect(preview).toContainText("形状タイプ");
  await expect(preview).toContainText("Polygon");

  // 水管理ポイント / 現地観察メモ.
  await expect(preview).toContainText("水門");
  await expect(preview).toContainText("雑草");
  await expect(preview).toContainText("畦道側に雑草が多い");
  await expect(preview).toContainText("観察メモ合計: 1件");
  await expect(preview).toContainText("緊急: 0件");

  // 次にやること — everything is registered, so the "all good" line should appear.
  await expect(preview).toContainText("次にやること");
});

test("a boundary-track-only registration is reported as LineString with the exact 境界トラック note", async ({ page }) => {
  await page.goto("/#survey");
  await expect(page.locator("#fieldRegDialog")).toBeAttached({ timeout: 15_000 });
  await page.evaluate(() => {
    document.querySelectorAll("details[data-workspace='survey']").forEach((card) => { card.open = true; });
  });
  await page.locator("#fileInput").setInputFiles({ name: "open-walk.txt", mimeType: "text/plain", buffer: Buffer.from(OPEN_L_SHAPE_NMEA) });
  await page.locator("#fieldRegTypeTrack").check();
  await page.locator("#fieldRegConfirmButton").click();

  await openAnalysisWorkspace(page);
  await page.locator("#reportFieldSelect").selectOption("paddy-001");
  await page.locator("#reportGenerateButton").click();

  const preview = page.locator("#reportPreview");
  await expect(preview).toContainText("LineString");
  await expect(preview).toContainText("このデータは境界トラックです。圃場全体の面積は確定していません。");
  await expect(preview).toContainText("境界トラックであり、圃場面積は未確定です。");
});

test("レポートJSONを書き出し and レポートHTMLを書き出し both produce well-formed, non-empty files", async ({ page }) => {
  await registerFieldWithData(page);
  await page.locator("#reportGenerateButton").click();

  const dir = await mkdtemp(path.join(tmpdir(), "field-report-export-"));

  const jsonDownloadPromise = page.waitForEvent("download");
  await page.locator("#reportExportJsonButton").click();
  const jsonDownload = await jsonDownloadPromise;
  expect(jsonDownload.suggestedFilename()).toMatch(/^suisui-report-paddy-001-\d{8}\.json$/);
  const jsonPath = path.join(dir, "report.json");
  await jsonDownload.saveAs(jsonPath);
  const exported = JSON.parse(await readFile(jsonPath, "utf8"));
  expect(exported.metadata.appName).toBe("スイスイナビ");
  expect(exported.metadata.reportType).toBe("field_report");
  expect(exported.metadata.dataMode).toBe("real_user_data");
  expect(exported.report.fieldId).toBe("paddy-001");
  expect(exported.report.observations).toHaveLength(1);

  const htmlDownloadPromise = page.waitForEvent("download");
  await page.locator("#reportExportHtmlButton").click();
  const htmlDownload = await htmlDownloadPromise;
  expect(htmlDownload.suggestedFilename()).toMatch(/^suisui-report-paddy-001-\d{8}\.html$/);
  const htmlPath = path.join(dir, "report.html");
  await htmlDownload.saveAs(htmlPath);
  const html = await readFile(htmlPath, "utf8");
  expect(html).toContain("<title>圃場レポート: 圃場1</title>");
  expect(html).toContain("次にやること");
  expect(html).not.toContain("unpkg.com");
});

test("印刷用表示 opens a print-ready window without crashing the app", async ({ page }) => {
  await registerFieldWithData(page);
  await page.locator("#reportGenerateButton").click();

  const popupPromise = page.waitForEvent("popup");
  await page.locator("#reportPrintButton").click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  await expect(popup.locator("h1")).toContainText("圃場レポート: 圃場1");

  // The main app is still alive and responsive after the print window opened.
  await expect(page.locator("#fieldReportPanel")).toBeVisible();
});
