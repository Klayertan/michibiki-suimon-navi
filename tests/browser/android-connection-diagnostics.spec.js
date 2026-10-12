import { test, expect } from "@playwright/test";

test("Android diagnostics panel reports feature state and can copy text", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/#survey");
  await page.getByRole("button", { name: "QZ1測量" }).click();
  await page.evaluate(() => document.querySelectorAll("details[data-workspace='survey']").forEach((node) => { node.open = true; }));
  const panel = page.locator("#androidConnectionDiagnostics");
  await panel.locator("summary").click();
  await expect(page.locator("#androidDiagnosticsOutput")).toContainText("userAgent:");
  await page.locator("#copyAndroidDiagnostics").click();
  await expect(page.locator("#androidDiagnosticsCopyStatus")).toContainText("コピーしました");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("acquisition decision:");
});
