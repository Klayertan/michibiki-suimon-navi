import { test, expect } from "@playwright/test";

test("開発ツールで雷雨の安全確認を記録し、端末内のログに残せる", async ({ page }) => {
  await page.goto("/#settings/devtools");

  await expect(page.locator("#weatherIncidentPanel")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#weatherIncidentGuidance")).toContainText("屋外作業・ドローン飛行・水門操作を中止");
  await page.locator("#weatherIncidentNoteInput").fill("雷鳴を確認。作業を中止して屋内へ退避。");
  await page.locator("#weatherIncidentRecordButton").click();

  await expect(page.locator("#weatherIncidentMessage")).toHaveText("雷雨・雷の安全確認を記録しました。");
  await expect(page.locator("#weatherIncidentLog")).toContainText("雷鳴を確認。作業を中止して屋内へ退避。");

  await page.reload();
  await expect(page.locator("#weatherIncidentLog")).toContainText("雷鳴を確認。作業を中止して屋内へ退避。");
});
