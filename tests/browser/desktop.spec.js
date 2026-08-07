import { test, expect } from "@playwright/test";

// Desktop shell frontend behaviour: the desktop indicator, keyboard preview,
// input-source switching, and the disconnected-input semantics.
//
// These run against the frontend the desktop application actually serves. By
// default that is the dev server (so they work in CI with no build); set
// SUISUI_DESKTOP_URL to a running SuisuiNavi.exe's backend to run the very
// same assertions against the packaged bundle:
//
//   $env:SUISUI_DESKTOP_URL="http://127.0.0.1:62788"; npx playwright test tests/browser/desktop.spec.js
//
// window.SUISUI_DESKTOP is injected by the backend in the real desktop app
// (see backend/app/desktop_assets.py). Against the dev server we inject the
// same shape with addInitScript so the desktop code paths are exercised
// identically.

const PACKAGED_URL = process.env.SUISUI_DESKTOP_URL || null;

const DESKTOP_CONTEXT = {
  mode: "preview",
  modeLabel: "Preview",
  allowsSerial: false,
  desktopVersion: "0.1.0",
  appName: "SuisuiNavi",
  development: false
};

/** Open the survey workspace with the gamepad panel expanded. */
async function openGamepadPanel(page, { desktop = true } = {}) {
  if (desktop && !PACKAGED_URL) {
    // The packaged app injects this itself; the dev server does not.
    await page.addInitScript((context) => {
      window.SUISUI_DESKTOP = Object.freeze(context);
    }, DESKTOP_CONTEXT);
  }

  const target = PACKAGED_URL ? `${PACKAGED_URL}/#survey` : "/#survey";
  await page.goto(target);
  await expect(page.locator("#gamepadPanel")).toBeAttached({ timeout: 20_000 });
  await page.evaluate(() => {
    const panel = document.getElementById("gamepadPanel");
    panel.hidden = false;
    panel.open = true;
  });
  await expect(page.locator("#gpSource")).toBeVisible({ timeout: 10_000 });
}

async function selectSource(page, source) {
  await page.selectOption("#gpSource", source);
  await expect(page.locator("#gpSource")).toHaveValue(source);
}

// ----------------------------------------------------------------------
// Desktop indicator and default mode
// ----------------------------------------------------------------------

test("the desktop build shows a desktop indicator and reports Preview mode", async ({ page }) => {
  await openGamepadPanel(page);

  const badge = page.locator(".gp-desktop-badge");
  await expect(badge).toBeVisible();
  await expect(badge).toContainText("デスクトップ版");
  await expect(badge).toContainText("Desktop");
  await expect(badge).toContainText("Preview");
});

test("Preview is the default runtime mode reported to the frontend", async ({ page }) => {
  await openGamepadPanel(page);
  const mode = await page.evaluate(() => window.SUISUI_DESKTOP?.mode);
  expect(mode).toBe("preview");
  const allowsSerial = await page.evaluate(() => window.SUISUI_DESKTOP?.allowsSerial);
  expect(allowsSerial).toBe(false);
});

test("the browser build shows no desktop indicator", async ({ page }) => {
  test.skip(Boolean(PACKAGED_URL), "the packaged app always injects the desktop context");
  await page.goto("/#survey");
  await expect(page.locator("#gamepadPanel")).toBeAttached({ timeout: 20_000 });
  await page.evaluate(() => {
    const panel = document.getElementById("gamepadPanel");
    panel.hidden = false;
    panel.open = true;
  });
  await expect(page.locator(".gp-desktop-badge")).toHaveCount(0);
});

// ----------------------------------------------------------------------
// Disconnected input semantics (the required wording)
// ----------------------------------------------------------------------

test("no input source selected reports unavailable, never 'Neutral: active'", async ({ page }) => {
  await openGamepadPanel(page);
  await selectSource(page, "none");

  await expect(page.locator("#gpController")).toContainText("No source selected");
  await expect(page.locator("#gpNeutral")).toHaveText(/利用不可 \/ unavailable/);
  await expect(page.locator("#gpInputActive")).toHaveText(/いいえ \/ no/);
  await expect(page.locator("#gpDeadmanState")).toContainText("source unavailable");

  // The specific regression: a missing controller must never read as active.
  await expect(page.locator("#gpNeutral")).not.toContainText("非中立");
  await expect(page.locator("#gpNeutral")).not.toContainText("active");
});

test("a selected but absent controller reports Not detected and unavailable", async ({ page }) => {
  await openGamepadPanel(page);
  await selectSource(page, "browser"); // no physical pad attached in CI

  await expect(page.locator("#gpController")).toContainText("Not detected");
  await expect(page.locator("#gpNeutral")).toHaveText(/利用不可 \/ unavailable/);
  await expect(page.locator("#gpInputActive")).toHaveText(/いいえ \/ no/);
  await expect(page.locator("#gpDeadmanState")).toContainText("source unavailable");
});

// ----------------------------------------------------------------------
// Keyboard preview
// ----------------------------------------------------------------------

test("keyboard capture is explicit and off until requested", async ({ page }) => {
  await openGamepadPanel(page);
  await selectSource(page, "keyboard");

  const button = page.locator("#gpKeyCapture");
  await expect(button).toBeVisible();
  await expect(button).toContainText("キャプチャ");

  // Before capture, keys must do nothing at all.
  await page.keyboard.down("KeyW");
  await expect(page.locator("#gpInputActive")).toHaveText(/いいえ \/ no/);
  await page.keyboard.up("KeyW");
});

test("W/A/S/D and arrow keys drive the preview only while the dead-man is held", async ({ page }) => {
  await openGamepadPanel(page);
  await selectSource(page, "keyboard");
  await page.locator("#gpKeyCapture").click();

  // Keys without the dead-man: gated to zero.
  await page.keyboard.down("KeyW");
  await expect(page.locator("#gpDeadmanState")).toContainText("deadman-released");
  const gatedOutputs = await page.locator(".gp-preview output").allInnerTexts();
  for (const text of gatedOutputs) {
    expect(text.split("→")[1].trim()).toMatch(/^-?0\.000$/);
  }

  // Hold the dead-man: the preview becomes active and pitch moves.
  await page.keyboard.down("ShiftLeft");
  await expect(page.locator("#gpDeadmanState")).toContainText("有効 / active");
  await expect(page.locator("#gpInputActive")).toHaveText(/はい \/ yes/);

  const pitch = await page.locator(".gp-preview div", { hasText: "pitch" }).locator("output").innerText();
  expect(parseFloat(pitch.split("→")[1])).toBeLessThan(0); // W = pitch forward = negative

  // Releasing the dead-man zeroes everything immediately.
  await page.keyboard.up("ShiftLeft");
  await expect(page.locator("#gpDeadmanState")).toContainText("deadman-released");
  const released = await page.locator(".gp-preview output").allInnerTexts();
  for (const text of released) {
    expect(text.split("→")[1].trim()).toMatch(/^-?0\.000$/);
  }
  await page.keyboard.up("KeyW");
});

test("each mapped key moves its own axis", async ({ page }) => {
  await openGamepadPanel(page);
  await selectSource(page, "keyboard");
  await page.locator("#gpKeyCapture").click();
  await page.keyboard.down("ShiftLeft");

  const axisValue = async (name) => {
    const text = await page.locator(".gp-preview div", { hasText: name }).locator("output").first().innerText();
    return parseFloat(text.split("→")[1]);
  };

  for (const [key, axis, sign] of [
    ["KeyS", "pitch", 1],
    ["KeyA", "roll", -1],
    ["KeyD", "roll", 1],
    ["ArrowLeft", "yaw", -1],
    ["ArrowRight", "yaw", 1]
  ]) {
    await page.keyboard.down(key);
    const value = await axisValue(axis);
    expect(Math.sign(value), `${key} should move ${axis} ${sign > 0 ? "positive" : "negative"}`).toBe(sign);
    await page.keyboard.up(key);
  }
  await page.keyboard.up("ShiftLeft");
});

test("Escape immediately neutralises and stops keyboard capture", async ({ page }) => {
  await openGamepadPanel(page);
  await selectSource(page, "keyboard");
  await page.locator("#gpKeyCapture").click();

  await page.keyboard.down("ShiftLeft");
  await page.keyboard.down("KeyD");
  await expect(page.locator("#gpInputActive")).toHaveText(/はい \/ yes/);

  await page.keyboard.press("Escape");

  await expect(page.locator("#gpKeyCapture")).toContainText("キーボードをキャプチャ");
  await expect(page.locator("#gpInputActive")).toHaveText(/いいえ \/ no/);
  await page.keyboard.up("KeyD");
  await page.keyboard.up("ShiftLeft");
});

test("keyboard flight keys are ignored while typing in a text field", async ({ page }) => {
  await openGamepadPanel(page);
  await selectSource(page, "keyboard");
  await page.locator("#gpKeyCapture").click();

  // Type into a real text input elsewhere in the app.
  const field = page.locator("#recFieldNameInput");
  await field.scrollIntoViewIfNeeded();
  await field.click();
  await field.type("wasd");

  await expect(field).toHaveValue("wasd");
  await expect(page.locator("#gpInputActive")).toHaveText(/いいえ \/ no/);
});

test("the native window losing focus zeroes held keyboard input", async ({ page }) => {
  await openGamepadPanel(page);
  await selectSource(page, "keyboard");
  await page.locator("#gpKeyCapture").click();
  await page.keyboard.down("ShiftLeft");
  await page.keyboard.down("KeyW");
  await expect(page.locator("#gpInputActive")).toHaveText(/はい \/ yes/);

  // The desktop shell calls this from the native window's focus-loss event;
  // the page itself never sees that, so it is the shell's job to notify.
  await page.evaluate(() => window.suisuiDesktopBlur && window.suisuiDesktopBlur());

  await expect(page.locator("#gpInputActive")).toHaveText(/いいえ \/ no/);
  await page.keyboard.up("KeyW");
  await page.keyboard.up("ShiftLeft");
});

// ----------------------------------------------------------------------
// Simulated gamepad and input-source exclusivity
// ----------------------------------------------------------------------

test("the simulated gamepad is available in the desktop build and drives the preview", async ({ page }) => {
  await openGamepadPanel(page);
  await selectSource(page, "mock");

  await page.locator("#gpMockConnect").click();
  await expect(page.locator("#gpController")).toContainText("Simulated DualSense");
  await expect(page.locator(".gp-sim").first()).toBeVisible();

  await expect(page.locator("#gpNeutral")).toContainText("中立");
  await expect(page.locator("#gpNeutral")).not.toContainText("利用不可");
});

test("an abruptly disconnected simulated controller reverts to unavailable", async ({ page }) => {
  await openGamepadPanel(page);
  await selectSource(page, "mock");
  await page.locator("#gpMockConnect").click();
  await expect(page.locator("#gpController")).toContainText("Simulated DualSense");

  await page.locator("#gpMockDisconnect").click();

  await expect(page.locator("#gpController")).toContainText("Not detected");
  await expect(page.locator("#gpNeutral")).toHaveText(/利用不可 \/ unavailable/);
  await expect(page.locator("#gpDeadmanState")).toContainText("source unavailable");
});

test("switching input source zeroes output and only one source is ever active", async ({ page }) => {
  await openGamepadPanel(page);

  await selectSource(page, "keyboard");
  await page.locator("#gpKeyCapture").click();
  await page.keyboard.down("ShiftLeft");
  await page.keyboard.down("KeyW");
  await expect(page.locator("#gpInputActive")).toHaveText(/はい \/ yes/);

  // Switching away must immediately drop the held keyboard state.
  await selectSource(page, "mock");
  await expect(page.locator("#gpInputActive")).toHaveText(/いいえ \/ no/);
  await expect(page.locator("#gpKeyCapture")).toHaveCount(0); // keyboard UI gone

  await page.keyboard.up("KeyW");
  await page.keyboard.up("ShiftLeft");
});

// ----------------------------------------------------------------------
// Safety: nothing here transmits to an aircraft
// ----------------------------------------------------------------------

test("driving the keyboard preview sends no command request to the backend", async ({ page }) => {
  const commandRequests = [];
  await page.route("**/api/drone/**", async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    // Reads are fine; anything that could change vehicle state is not.
    if (method !== "GET") commandRequests.push(`${method} ${url}`);
    await route.continue();
  });

  await openGamepadPanel(page);
  await selectSource(page, "keyboard");
  await page.locator("#gpKeyCapture").click();
  await page.keyboard.down("ShiftLeft");
  for (const key of ["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowLeft"]) {
    await page.keyboard.down(key);
    await page.keyboard.up(key);
  }
  await page.keyboard.up("ShiftLeft");
  await page.waitForTimeout(400);

  expect(commandRequests, `unexpected command traffic: ${commandRequests.join(", ")}`).toEqual([]);
});

test("the panel states plainly that no aircraft commands are transmitted", async ({ page }) => {
  await openGamepadPanel(page);
  const notice = page.locator(".gamepad-safety");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("No aircraft commands are being transmitted");
});
