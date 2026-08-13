import { test, expect } from "@playwright/test";
import { openManualPanel, pilotAxis } from "./manual-control-helpers.js";

const DESKTOP_CONTEXT = {
  mode: "preview",
  modeLabel: "Preview",
  allowsSerial: false,
  desktopVersion: "0.1.0",
  appName: "SuisuiNavi",
  development: false
};

async function openDesktopManualPanel(page) {
  await page.addInitScript((context) => {
    window.SUISUI_DESKTOP = Object.freeze(context);
  }, DESKTOP_CONTEXT);
  return openManualPanel(page);
}

test("desktop runtime identity remains visible inside the unified Manual Control panel", async ({ page }) => {
  await openDesktopManualPanel(page);
  await expect(page.locator("#gamepadPanel")).toHaveCount(0);
  const badge = page.locator("#manualInputRoot .gp-desktop-badge");
  await expect(badge).toBeVisible();
  await expect(badge).toContainText("デスクトップ版 / Desktop");
  await expect(badge).toContainText("Preview");
  expect(await page.evaluate(() => window.SUISUI_DESKTOP?.allowsSerial)).toBe(false);
});

test("ordinary browser runtime does not claim to be the desktop app", async ({ page }) => {
  await openManualPanel(page);
  await expect(page.locator(".gp-desktop-badge")).toHaveCount(0);
});

test("desktop-native focus loss zeroes held keyboard preview", async ({ page }) => {
  const backend = await openDesktopManualPanel(page);
  await page.locator("#gpKeyCapture").click();
  await page.keyboard.down("ShiftLeft");
  await page.keyboard.down("KeyW");
  await expect(pilotAxis(page, "throttle")).toHaveText("0.25");

  await page.evaluate(() => window.suisuiDesktopBlur?.());
  await expect(pilotAxis(page, "throttle")).toHaveText("0.00");
  await expect(page.locator(".gp-gate")).toHaveText("focus-lost");
  expect(backend.inputs()).toEqual([]);
  await page.keyboard.up("KeyW");
  await page.keyboard.up("ShiftLeft");
});

test("desktop mock PS5 stays available under the PS5 option", async ({ page }) => {
  await openDesktopManualPanel(page);
  await page.locator("#gpSource").selectOption("ps5");
  await expect(page.locator("[data-input-simulator]")).toBeAttached();
  await page.evaluate(() => window.gamepadController.mock.connect());
  await expect(page.locator("[data-input-connection]")).toContainText("Simulated DualSense Controller");
  await expect(page.locator(".gp-sim").first()).toContainText("SIMULATION");
});

test("switching desktop input source drops held keyboard state before PS5 becomes authoritative", async ({ page }) => {
  await openDesktopManualPanel(page);
  await page.locator("#gpKeyCapture").click();
  await page.keyboard.down("ShiftLeft");
  await page.keyboard.down("ArrowRight");
  await expect(pilotAxis(page, "roll")).toHaveText("0.25");

  await page.locator("#gpSource").selectOption("ps5");
  await expect(pilotAxis(page, "roll")).toHaveText("0.00");
  await expect(page.locator("#gpKeyCapture")).toHaveCount(0);
  expect(await page.evaluate(() => window.gamepadController.getState().source)).toBe("ps5");
  await page.keyboard.up("ArrowRight");
  await page.keyboard.up("ShiftLeft");
});
