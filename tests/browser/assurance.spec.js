import { test, expect } from "@playwright/test";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Valid GGA sentences (correct checksums) for a small closed-loop walk,
// reused from field-annotation.spec.js's fixture so a registered QZ1測量
// field/session exists for the 測量チェック integration tests.
const TIGHT_LOOP_NMEA = [
  "$GNGGA,120000.00,3439.2880,N,13549.7892,E,1,8,1.1,45.0,M,30.0,M,,*7A",
  "$GNGGA,120010.00,3439.2880,N,13549.8162,E,1,8,1.1,45.0,M,30.0,M,,*72",
  "$GNGGA,120020.00,3439.2664,N,13549.8162,E,1,8,1.1,45.0,M,30.0,M,,*75",
  "$GNGGA,120030.00,3439.2664,N,13549.7892,E,1,8,1.1,45.0,M,30.0,M,,*7D",
  "$GNGGA,120040.00,3439.2879,N,13549.7895,E,2,9,0.9,45.0,M,30.0,M,,*74"
].join("\r\n");

async function openAssuranceWorkspace(page) {
  await page.goto("/#assurance");
  await expect(page.locator("#assuranceQz1Session")).toBeAttached({ timeout: 15_000 });
  await page.evaluate(() => {
    document.querySelectorAll("details[data-workspace='assurance']").forEach((card) => { card.open = true; });
  });
}

/** Registers a field in QZ1測量 (the primary workflow) without ever touching 測量チェック. */
async function registerFieldInSurveyTab(page) {
  await page.goto("/#survey");
  await expect(page.locator("#fieldRegDialog")).toBeAttached({ timeout: 15_000 });
  await page.evaluate(() => {
    document.querySelectorAll("details[data-workspace='survey']").forEach((card) => { card.open = true; });
  });
  await page.locator("#fileInput").setInputFiles({ name: "walk.txt", mimeType: "text/plain", buffer: Buffer.from(TIGHT_LOOP_NMEA) });
  await page.locator("#fieldRegConfirmButton").click();
}

test("bundled QZ1 proof flows into the 測量チェック workspace", async ({ page }) => {
  await page.goto("/");
  await page.locator("#decisionFieldSelect").selectOption("__sample__");
  await page.getByRole("button", { name: "選択中データの測位点を表示" }).first().click();
  await expect(page.locator("#proofTotal")).toHaveText("206点");
  await page.getByRole("button", { name: "測量チェック" }).click();
  await expect(page.locator("#assuranceQz1Session option")).toHaveCount(2);
  await expect(page.locator("#assuranceSessionSummary")).toContainText("206/426 有効fix");
  await page.locator(".assurance-dev-tools").evaluate((element) => { element.open = true; });
  await page.locator("#assuranceSimulateReference").click();
  await expect(page.locator("#assuranceReferenceSession")).toContainText("テスト用");
  await page.locator("#assuranceSaveField").click();
  await expect(page.locator("#assuranceFieldMessage")).toContainText("点");
  await page.locator("#assuranceRecalculate").click();
  await expect(page.locator("#assurancePairedCount")).toHaveText("206組");
  await expect(page.locator("#assuranceWarnings")).toContainText("SIMULATED");
});

test("workspace navigation keeps the Leaflet map mounted and responsive", async ({ page }) => {
  await page.goto("/#decision");
  const map = page.locator("#map");
  await expect(map).toBeVisible();
  await map.evaluate((element) => { element.dataset.testIdentity = "mounted-once"; });
  for (const name of ["QZ1測量", "測量チェック", "詳細解析", "判断デモ"]) {
    await page.getByRole("button", { name }).click();
    await expect(map).toBeVisible();
    await expect(map.locator(".leaflet-tile-pane")).toBeAttached();
  }
  await expect(map).toHaveAttribute("data-test-identity", "mounted-once");
});

test("the guide card explains the 5-step usage flow, and the legend uses the simplified vocabulary", async ({ page }) => {
  await openAssuranceWorkspace(page);
  const guide = page.locator(".assurance-guide");
  await expect(guide).toContainText("測量チェックの使い方");
  await expect(guide).toContainText("QZ1ログを追加します。");
  await expect(guide).toContainText("比較用GPSログがあれば追加します。ない場合はQZ1単独でも簡易チェックできます。");
  await expect(guide).toContainText("測量した点の範囲を選び、圃場範囲を作ります。");
  await expect(guide).toContainText("「測量チェックを実行」を押します。");
  await expect(guide).toContainText("緑は使用可能、黄は要確認、赤は再測量推奨、灰は証拠不足です。");

  const legend = page.locator(".assurance-legend");
  await expect(legend).toContainText("使用可能");
  await expect(legend).toContainText("要確認");
  await expect(legend).toContainText("再測量推奨");
  await expect(legend).toContainText("証拠不足");
  await expect(legend).toContainText("テスト用");
});

test("advanced settings and the SIMULATED dev-tools box are both collapsed by default", async ({ page }) => {
  await page.goto("/#assurance");
  await expect(page.locator("#assuranceQz1Session")).toBeAttached({ timeout: 15_000 });
  // Deliberately do NOT force-open every <details> here — this test is
  // about the actual default collapsed state.
  await expect(page.locator(".assurance-advanced-settings")).not.toHaveJSProperty("open", true);
  await expect(page.locator(".assurance-dev-tools")).not.toHaveJSProperty("open", true);
  await expect(page.locator("#assuranceTolerance")).toBeHidden();
  await expect(page.locator("#assuranceSimulateReference")).toBeHidden();
  await expect(page.locator(".assurance-dev-tools")).toContainText("開発・テスト用");
  await expect(page.locator(".assurance-dev-warning")).toHaveText("これは実測データではありません。デモや動作確認用です。");
});

test("QZ1-only mode: without a comparison GPS log, the result is never blank and shows the exact Mode A notice", async ({ page }) => {
  await registerFieldInSurveyTab(page);
  await page.getByRole("button", { name: "測量チェック" }).click();
  await page.evaluate(() => {
    document.querySelectorAll("details[data-workspace='assurance']").forEach((card) => { card.open = true; });
  });

  // QZ1データセット already has the registered session selected by default
  // (populateSessionSelect keeps the most recent one); leave 比較用GPS empty.
  await expect(page.locator("#assuranceReferenceSession")).toHaveValue("");
  await page.locator("#assuranceSaveField").click();
  await page.locator("#assuranceRecalculate").click();

  await expect(page.locator("#assuranceQz1OnlyNotice")).toBeVisible();
  await expect(page.locator("#assuranceQz1OnlyNotice")).toHaveText(
    "比較用GPSログがないため、QZ1単独の簡易チェックを行います。絶対精度や受信機間誤差は評価できません。"
  );
  await expect(page.locator("#assuranceWarnings")).toContainText(
    "比較用GPSログがないため、QZ1単独の簡易チェックを行います。"
  );

  // Never blank: an overall verdict and at least one reason are always shown.
  const status = await page.locator("#assuranceOverallStatus").textContent();
  expect(["使用可能", "要確認", "再測量推奨", "証拠不足"]).toContain(status?.trim());
  await expect(page.locator("#assuranceOverallReasons li").first()).toBeVisible();
  await expect(page.locator("#assuranceOverallReasons")).toContainText("有効な測位点は5点あります");
  await expect(page.locator("#assuranceOverallReasons")).toContainText("比較用GPSログがありません");

  // Comparison-only metrics are explicitly marked absent, not left blank.
  await expect(page.locator("#assurancePairedCount")).toHaveText("比較用GPSなし");
  await expect(page.locator("#assuranceMedianSeparation")).toHaveText("比較用GPSなし");
});

test("registered QZ1測量 survey sessions and fields are available in 測量チェック without re-uploading", async ({ page }) => {
  await registerFieldInSurveyTab(page);
  await page.getByRole("button", { name: "測量チェック" }).click();
  await page.evaluate(() => {
    document.querySelectorAll("details[data-workspace='assurance']").forEach((card) => { card.open = true; });
  });

  await expect(page.locator("#assuranceQz1Session")).toContainText("圃場1");
  await expect(page.locator("#assuranceActiveField")).toContainText("圃場1");
});

test("測量チェックを実行 updates the summary cards, and 詳細設定/開発・テスト用 stay out of the way", async ({ page }) => {
  await registerFieldInSurveyTab(page);
  await page.getByRole("button", { name: "測量チェック" }).click();
  await page.evaluate(() => {
    document.querySelectorAll("details[data-workspace='assurance']").forEach((card) => { card.open = true; });
    // Advanced settings/dev-tools were force-opened above only for the
    // parent <details data-workspace> cards, not these nested ones —
    // confirm they're still untouched (collapsed) even mid-flow.
  });
  await expect(page.locator(".assurance-advanced-settings")).not.toHaveJSProperty("open", true);

  await expect(page.locator("#assuranceOverallStatus")).toHaveText("—");
  await page.locator("#assuranceSaveField").click();
  await page.locator("#assuranceRecalculate").click();
  await expect(page.locator("#assuranceOverallStatus")).not.toHaveText("—");
});

test("なぜこの判定？ panel shows farmer-friendly 判定/理由/おすすめ text for a selected cell", async ({ page }) => {
  await page.goto("/");
  await page.locator("#decisionFieldSelect").selectOption("__sample__");
  await page.getByRole("button", { name: "選択中データの測位点を表示" }).first().click();
  await expect(page.locator("#proofTotal")).toHaveText("206点");
  await page.getByRole("button", { name: "測量チェック" }).click();
  await page.evaluate(() => {
    document.querySelectorAll("details[data-workspace='assurance']").forEach((card) => { card.open = true; });
  });
  await page.locator(".assurance-dev-tools").evaluate((element) => { element.open = true; });
  await page.locator("#assuranceSimulateReference").click();
  await page.locator("#assuranceSaveField").click();
  await page.locator("#assuranceRecalculate").click();

  const detail = await page.evaluate(() => {
    const controller = window.assuranceController;
    const cell = controller.result.cells.find((candidate) => candidate.pairs.length > 0);
    controller.inspectCell(cell);
    return document.getElementById("assuranceSelectedDetail").textContent;
  });
  expect(detail).toContain("この場所の判定:");
  expect(detail).toContain("理由:");
  expect(detail).toContain("おすすめ:");
  expect(detail).not.toContain("依存しない");
  expect(detail).not.toContain("監視・低速");

  await expect(page.locator("h2", { hasText: "なぜこの判定？" })).toBeVisible();
});

test("測量チェックJSONを書き出す still works for both QZ1-only and comparison results", async ({ page }) => {
  await registerFieldInSurveyTab(page);
  await page.getByRole("button", { name: "測量チェック" }).click();
  await page.evaluate(() => {
    document.querySelectorAll("details[data-workspace='assurance']").forEach((card) => { card.open = true; });
  });
  await page.locator("#assuranceSaveField").click();
  await page.locator("#assuranceRecalculate").click();

  const dir = await mkdtemp(path.join(tmpdir(), "assurance-export-"));

  const downloadPromise1 = page.waitForEvent("download");
  await page.getByRole("button", { name: "測量チェックJSONを書き出す" }).click();
  const download1 = await downloadPromise1;
  const qz1OnlyPath = path.join(dir, "qz1-only.json");
  await download1.saveAs(qz1OnlyPath);
  const qz1OnlyExported = JSON.parse(await readFile(qz1OnlyPath, "utf8"));
  expect(qz1OnlyExported.assurance.lastRun.mode).toBe("qz1_only");
  expect(qz1OnlyExported.assurance.lastRun.classification).toBeTruthy();
  expect(Array.isArray(qz1OnlyExported.assurance.lastRun.reasons)).toBe(true);

  await page.locator(".assurance-dev-tools").evaluate((element) => { element.open = true; });
  await page.locator("#assuranceSimulateReference").click();
  await page.locator("#assuranceRecalculate").click();

  const downloadPromise2 = page.waitForEvent("download");
  await page.getByRole("button", { name: "測量チェックJSONを書き出す" }).click();
  const download2 = await downloadPromise2;
  const comparisonPath = path.join(dir, "comparison.json");
  await download2.saveAs(comparisonPath);
  const comparisonExported = JSON.parse(await readFile(comparisonPath, "utf8"));
  expect(comparisonExported.assurance.lastRun.mode).toBe("comparison");
  expect(comparisonExported.assurance.lastRun.summary.pairedCount).toBeGreaterThan(0);
});
