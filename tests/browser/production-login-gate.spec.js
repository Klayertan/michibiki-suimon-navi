import { test, expect } from "@playwright/test";

// The production login gate (requireAuth: true) — see
// docs/AUTH_ARCHITECTURE.md "Production login gate". Runs against the MOCK
// provider (js/auth/mock-auth-client.js), injected before the page loads —
// no external backend is required or contacted.
//
// This is UX-layer verification only: the real access boundary is every
// cloud_backend/ API route's own session check (see
// cloud_backend/tests/test_security.py's unauthenticated-401 coverage and
// tests/test_multi_user_isolation.py), not anything this file can prove.
// What this file DOES prove: an unauthenticated visitor cannot reach the
// main application UI through any of the normal navigation paths this
// controller offers, and a signed-in farmer is unaffected.

const FARMER = { email: "judge@example.test", password: "kessai-2026", displayName: "審査員" };

async function useMockCloud(page, { requireAuth = true, users = [] } = {}) {
  await page.addInitScript(
    ({ requireAuth: ra, seedUsers }) => {
      window.SUISUI_CLOUD_CONFIG = { provider: "mock", requireAuth: ra, mock: { users: seedUsers } };
    },
    { requireAuth, seedUsers: users }
  );
}

async function openApp(page) {
  await page.goto("/");
}

test("an unauthenticated visitor sees only the auth screen, with no guest path", async ({ page }) => {
  await useMockCloud(page);
  await openApp(page);
  await expect(page.locator("#authScreen")).toBeVisible();
  // No guest button, no reassurance note, no way to close the screen.
  await expect(page.locator("#authGuestButton")).toBeHidden();
  await expect(page.locator("#authGuestNote")).toBeHidden();
  await expect(page.locator("#authCloseButton")).toBeHidden();
});

test("the main application is not reachable behind the overlay", async ({ page }) => {
  await useMockCloud(page);
  await openApp(page);
  await expect(page.locator("#authScreen")).toBeVisible();
  // The overlay is a fixed, full-viewport, high-z-index surface (css/auth.css)
  // — confirm the element actually under the pointer at a point over the
  // main map area is the auth screen (or something inside it), not the map
  // or any Basic-mode control.
  const topElement = await page.evaluate(() => {
    const el = document.elementFromPoint(Math.floor(window.innerWidth / 2), Math.floor(window.innerHeight / 2));
    return el ? el.closest("#authScreen") !== null : false;
  });
  expect(topElement).toBe(true);
});

test("pressing Escape does not fall through to guest access", async ({ page }) => {
  await useMockCloud(page);
  await openApp(page);
  await expect(page.locator("#authScreen")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#authScreen")).toBeVisible();
});

test("navigating with a hash fragment does not bypass the gate", async ({ page }) => {
  await useMockCloud(page);
  // Try a hash some other mode/workspace would normally honor.
  await page.goto("/#drone");
  await expect(page.locator("#authScreen")).toBeVisible();
});

test("a reload while unauthenticated still shows the auth screen, not a flash of the app", async ({ page }) => {
  await useMockCloud(page);
  await openApp(page);
  await expect(page.locator("#authScreen")).toBeVisible();
  await page.reload();
  await expect(page.locator("#authScreen")).toBeVisible();
});

test("signing up (limited-access note shown) and signing in reaches the app; logout returns to the gate", async ({ page }) => {
  await useMockCloud(page, { users: [] });
  await openApp(page);
  await expect(page.locator("#authScreen")).toBeVisible();
  await page.locator("#authSwitchButton").click();
  await expect(page.locator("#authLimitedAccessNote")).toBeVisible();
  await expect(page.locator("#authLimitedAccessNote")).toContainText("限定公開");
  await page.locator("#authEmailInput").fill(FARMER.email);
  await page.locator("#authPasswordInput").fill(FARMER.password);
  await page.locator("#authDisplayNameInput").fill(FARMER.displayName);
  await page.locator("#authSubmitButton").click();
  await expect(page.locator("#authScreen")).toBeHidden();
  await expect(page.locator("body")).not.toHaveClass(/auth-screen-open/);

  // Logout returns to the gate, not to a guest-usable state.
  await page.locator("#accountMenuButton").click();
  await page.locator("#accountMenuLogoutButton").click();
  await expect(page.locator("#authScreen")).toBeVisible();
  await expect(page.locator("#authGuestButton")).toBeHidden();
});

test("a previously-remembered guest choice does not bypass the gate once requireAuth is on", async ({ page }) => {
  // Simulate a farmer who chose guest mode before this deployment turned
  // requireAuth on — the stored choice must not still work.
  await page.addInitScript(() => {
    window.localStorage.setItem("suimonNaviAuthChoiceV1", "guest");
  });
  await useMockCloud(page);
  await openApp(page);
  await expect(page.locator("#authScreen")).toBeVisible();
});

test("development mode (requireAuth false) is unaffected — guest path still works", async ({ page }) => {
  await useMockCloud(page, { requireAuth: false });
  await openApp(page);
  await expect(page.locator("#authScreen")).toBeVisible();
  await expect(page.locator("#authGuestButton")).toBeVisible();
  await page.locator("#authGuestButton").click();
  await expect(page.locator("#authScreen")).toBeHidden();
});
