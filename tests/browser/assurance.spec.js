import { test, expect } from "@playwright/test";

test("bundled QZ1 proof flows into the Satellite Assurance workspace", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "実測QZ1データを表示" }).first().click();
  await expect(page.locator("#proofTotal")).toHaveText("206点");
  await page.getByRole("button", { name: "信頼性マップ" }).click();
  await expect(page.locator("#assuranceQz1Session option")).toHaveCount(2);
  await expect(page.locator("#assuranceSessionSummary")).toContainText("206/426 有効fix");
  await page.locator("#assuranceSimulateReference").click();
  await expect(page.locator("#assuranceReferenceSession")).toContainText("SIMULATED");
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
  for (const name of ["QZ1測量", "信頼性マップ", "詳細解析", "判断デモ"]) {
    await page.getByRole("button", { name }).click();
    await expect(map).toBeVisible();
    await expect(map.locator(".leaflet-tile-pane")).toBeAttached();
  }
  await expect(map).toHaveAttribute("data-test-identity", "mounted-once");
});
