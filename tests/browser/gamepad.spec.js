import { test, expect } from "@playwright/test";
import { openManualPanel, pilotAxis } from "./manual-control-helpers.js";

test("unified input selector exposes Keyboard and PS5 only", async ({ page }) => {
  await openManualPanel(page);
  await expect(page.locator("#gamepadPanel")).toHaveCount(0);
  await expect(page.locator("#gpSource option")).toHaveCount(2);
  expect(await page.locator("#gpSource option").allTextContents()).toEqual(["Keyboard", "PS5 Controller"]);
  await expect(page.locator("#gpSource")).toHaveValue("keyboard");
  await expect(page.locator(".gp-gate")).toHaveText("capture-inactive");
});

test("keyboard preview requires explicit capture and Shift, then Escape immediately zeros and stops it", async ({ page }) => {
  const backend = await openManualPanel(page);
  await page.locator("#gpKeyCapture").click();

  await page.keyboard.down("ArrowUp");
  await expect(page.locator(".gp-gate")).toHaveText("deadman-released");
  await expect(pilotAxis(page, "pitch")).toHaveText("0.00");

  await page.keyboard.down("ShiftLeft");
  await expect(page.locator(".gp-gate")).toHaveText("ready");
  await expect(pilotAxis(page, "pitch")).toHaveText("0.25");

  await page.keyboard.press("Escape");
  await expect(pilotAxis(page, "pitch")).toHaveText("0.00");
  await expect(page.locator("#gpKeyCapture")).toContainText("Preview keyboard input");
  await expect(page.locator(".gp-gate")).toHaveText("capture-inactive");
  expect(backend.inputs()).toEqual([]);
  await page.keyboard.up("ArrowUp");
  await page.keyboard.up("ShiftLeft");
});

test("PS5 calibration and raw diagnostics remain available and configured dead-man is authoritative", async ({ page }) => {
  await openManualPanel(page);
  await page.locator("#gpSource").selectOption("ps5");
  await expect(page.locator("[data-input-calibration]")).toBeAttached();
  await expect(page.locator("[data-input-raw]")).toBeAttached();
  await page.evaluate(() => window.gamepadController.mock.connect());
  await page.waitForFunction(() => Boolean(window.gamepadController?.calibration));

  await page.evaluate(() => {
    const controller = window.gamepadController;
    controller.setCalibration({
      ...controller.calibration,
      deadmanButtonIndex: 5,
      validationState: "valid"
    });
    controller.startCapture();
    controller.mock.setButton(4, 1);
    controller.mock.setAxis(0, 0.5);
  });
  await expect(page.locator(".gp-gate")).toHaveText("deadman-released");
  expect(await page.evaluate(() => window.gamepadController.getState().deadmanHeld)).toBe(false);

  await page.evaluate(() => window.gamepadController.mock.setButton(5, 1));
  await expect(page.locator(".gp-gate")).toHaveText("ready");
  const state = await page.evaluate(() => window.gamepadController.getState());
  expect(state.deadmanButtonIndex).toBe(5);
  expect(state.axes.yaw).toBeGreaterThan(0);
  expect(state.rawSample.axes).toHaveLength(4);
});

test("PS5 disconnect, stale input and source switch each zero the common axes", async ({ page }) => {
  await openManualPanel(page);
  await page.locator("#gpSource").selectOption("ps5");
  await page.evaluate(() => window.gamepadController.mock.connect());
  await page.waitForFunction(() => Boolean(window.gamepadController?.calibration));
  await page.evaluate(() => {
    const controller = window.gamepadController;
    controller.setCalibration({ ...controller.calibration, validationState: "valid" });
    controller.startCapture();
    controller.mock.setButton(4, 1);
    controller.mock.setAxis(2, 0.5);
  });
  await expect(page.locator(".gp-gate")).toHaveText("ready");
  expect((await page.evaluate(() => window.gamepadController.getState())).axes.roll).toBeGreaterThan(0);

  await page.evaluate(() => window.gamepadController.mock.setStale(true));
  await expect(page.locator(".gp-gate")).toHaveText("stale-input");
  expect(await page.evaluate(() => window.gamepadController.getState().axes)).toEqual({ pitch: 0, roll: 0, throttle: 0, yaw: 0 });

  await page.evaluate(() => {
    window.gamepadController.mock.setStale(false);
    window.gamepadController.mock.disconnect();
  });
  await expect(page.locator(".gp-gate")).toHaveText("controller-disconnected");
  expect(await page.evaluate(() => window.gamepadController.getState().axes)).toEqual({ pitch: 0, roll: 0, throttle: 0, yaw: 0 });

  await page.locator("#gpSource").selectOption("keyboard");
  await expect(page.locator("#gpSource")).toHaveValue("keyboard");
  await expect(pilotAxis(page, "roll")).toHaveText("0.00");
});

test("preview and calibration interactions issue no pilot/ARM/DISARM request", async ({ page }) => {
  const backend = await openManualPanel(page);
  await page.locator("#gpKeyCapture").click();
  await page.keyboard.down("ShiftLeft");
  for (const key of ["KeyW", "KeyA", "ArrowUp", "ArrowRight"]) {
    await page.keyboard.down(key);
    await page.keyboard.up(key);
  }
  await page.keyboard.up("ShiftLeft");
  await page.locator("#gpSource").selectOption("ps5");
  await page.evaluate(() => {
    window.gamepadController.mock.connect();
    window.gamepadController.mock.setAxis(0, 0.4);
  });
  expect(backend.posts).toEqual([]);
});
