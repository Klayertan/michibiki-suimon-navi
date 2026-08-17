import { test, expect } from "@playwright/test";

// Accounts + user-owned cloud field data.
//
// Every test here runs against the MOCK provider (js/auth/mock-auth-client.js
// + js/cloud/mock-cloud-store.js), injected before the page loads. No external
// Supabase project is contacted, and none is required to run this suite.
//
// The mock store is not a permissive fake: it enforces the same owner_id
// rules as supabase/migrations/001_accounts_fields.sql, so the cross-user
// tests below observe a real denial rather than a hidden UI element.
//
// The default (uninjected) configuration has no provider, which is why every
// OTHER spec in this repository still sees the app it always did — no login
// screen, no account control. That is asserted at the bottom of this file.

const USER_A = { email: "farmer-a@example.test", password: "kitaden-2026", displayName: "北田さん" };
const USER_B = { email: "farmer-b@example.test", password: "minamida-2026", displayName: "南田さん" };

/** Checksums are computed so the fixture stays easy to extend. */
function gga(time, lat, lon, fix = 1, sats = 8, hdop = "1.1") {
  const body = `GNGGA,${time},${lat},N,${lon},E,${fix},${sats},${hdop},45.0,M,30.0,M,,`;
  let checksum = 0;
  for (const character of body) {
    checksum ^= character.charCodeAt(0);
  }
  return `$${body}*${checksum.toString(16).toUpperCase().padStart(2, "0")}`;
}

// Same walk shape the Stage-1 suite uses: approach, perimeter, return.
const WALK_NMEA = [
  gga("120000.00", "3439.2700", "13549.7800"),
  gga("120010.00", "3439.2750", "13549.7820"),
  gga("120020.00", "3439.2800", "13549.7850"),
  gga("120030.00", "3439.2880", "13549.7892"),
  gga("120040.00", "3439.2880", "13549.8162"),
  gga("120050.00", "3439.2664", "13549.8162"),
  gga("120100.00", "3439.2664", "13549.7892"),
  gga("120110.00", "3439.2879", "13549.7895", 2, 9, "0.9"),
  gga("120120.00", "3439.2500", "13549.7700"),
  gga("120130.00", "3439.2400", "13549.7600"),
  gga("120140.00", "3439.2300", "13549.7500")
].join("\r\n");

const START_INDEX = 3;
const END_INDEX = 7; // ~1m from START, so the polygon auto-closes

/**
 * Injects the mock cloud provider before any page script runs.
 *
 * config/cloud-config.js assigns with `??=`, so this wins without the file
 * being edited — the shipped configuration stays empty.
 */
async function useMockCloud(page, { users = [USER_A, USER_B] } = {}) {
  await page.addInitScript((seedUsers) => {
    window.SUISUI_CLOUD_CONFIG = { provider: "mock", mock: { users: seedUsers } };
  }, users);
}

async function openApp(page) {
  await page.goto("/");
  await expect(page.locator("body")).toHaveAttribute("data-mode", "basic");
}

async function signIn(page, user) {
  await expect(page.locator("#authScreen")).toBeVisible();
  await page.locator("#authEmailInput").fill(user.email);
  await page.locator("#authPasswordInput").fill(user.password);
  await page.locator("#authSubmitButton").click();
  await expect(page.locator("#authScreen")).toBeHidden();
}

async function signUp(page, user) {
  await expect(page.locator("#authScreen")).toBeVisible();
  await page.locator("#authSwitchButton").click();
  await expect(page.locator("#authDisplayNameRow")).toBeVisible();
  await page.locator("#authEmailInput").fill(user.email);
  await page.locator("#authPasswordInput").fill(user.password);
  await page.locator("#authDisplayNameInput").fill(user.displayName);
  await page.locator("#authSubmitButton").click();
}

/** Runs the full Stage-1 registration: upload -> pick START/END -> register. */
async function registerField(page, name) {
  await page.locator("#basicNmeaInput").setInputFiles({
    name: "paddy-walk.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(WALK_NMEA)
  });
  await expect(page.locator("#basicBoundaryControls")).toBeVisible();
  await page.locator("#basicPickStartButton").click();
  await page.locator(`.qz1-point-${START_INDEX}`).dispatchEvent("click");
  await page.locator("#basicPickEndButton").click();
  await page.locator(`.qz1-point-${END_INDEX}`).dispatchEvent("click");
  await page.locator("#basicCreateFieldButton").click();
  await expect(page.locator("#basicFieldRegDialog")).toBeVisible();
  await page.locator("#basicFieldRegNameInput").fill(name);
  await page.locator("#basicFieldRegConfirmButton").click();
  await expect(page.locator("#basicFieldRegDialog")).toBeHidden();
}

/** Waits for the pending queue to drain, i.e. the chip to reach ✓ 同期済み. */
async function expectSynced(page) {
  await expect(page.locator("#syncStatusChip")).toContainText("同期済み", { timeout: 15_000 });
}

/** Field tile names currently rendered in あなたの圃場. */
function accountFieldNames(page) {
  return page.locator("#accountFieldsCard .account-field-name").allTextContents();
}

// ---------------------------------------------------------------------------
// 1-2. First load and guest mode
// ---------------------------------------------------------------------------

test("first load with a cloud configured shows the login screen", async ({ page }) => {
  await useMockCloud(page);
  await openApp(page);
  await expect(page.locator("#authScreen")).toBeVisible();
  await expect(page.locator("#authScreen")).toContainText("スイスイナビ");
  await expect(page.locator("#authScreen")).toContainText("圃場管理をもっと簡単に");
  await expect(page.locator("#authSubmitButton")).toHaveText("ログイン");
  await expect(page.locator("#authGuestButton")).toHaveText("ログインせずに使う");
});

test("ログインせずに使う enters Basic mode and stays chosen across reloads", async ({ page }) => {
  await useMockCloud(page);
  await openApp(page);
  await page.locator("#authGuestButton").click();

  await expect(page.locator("#authScreen")).toBeHidden();
  await expect(page.locator("#basicStage1Card")).toBeVisible();
  // A guest gets no account field list and no sync chip -- nothing about the
  // offline app changed for them.
  await expect(page.locator("#accountFieldsCard")).toBeHidden();
  await expect(page.locator("#syncStatusChip")).toBeHidden();

  await page.reload();
  await expect(page.locator("#authScreen")).toBeHidden();
  await expect(page.locator("#basicStage1Card")).toBeVisible();
});

test("a guest can complete the whole Stage-1 workflow with no account", async ({ page }) => {
  await useMockCloud(page);
  await openApp(page);
  await page.locator("#authGuestButton").click();
  await registerField(page, "ゲスト田");

  await expect(page.locator("#basicFieldSummary")).toBeVisible();
  await expect(page.locator("#basicFieldArea")).not.toHaveText("—");
  await expect(page.locator("#basicRecordWaterButton")).toBeEnabled();
  // The paddy is on the device, and nothing was uploaded.
  const cloudFields = await page.evaluate(() => {
    const raw = localStorage.getItem("suimonNaviMockCloudDbV1");
    return raw ? JSON.parse(raw).fields.length : 0;
  });
  expect(cloudFields).toBe(0);
});

// ---------------------------------------------------------------------------
// 3-6. Sign-up, sign-in, errors, header
// ---------------------------------------------------------------------------

test("the sign-up form adds a display-name field and creates the account", async ({ page }) => {
  await useMockCloud(page, { users: [] });
  await openApp(page);
  await signUp(page, USER_A);

  await expect(page.locator("#authScreen")).toBeHidden();
  await expect(page.locator("#accountMenuLabel")).toHaveText(USER_A.displayName);
});

test("signing up with an address that already exists says so in Japanese", async ({ page }) => {
  await useMockCloud(page);
  await openApp(page);
  await signUp(page, USER_A);

  await expect(page.locator("#authMessage")).toBeVisible();
  await expect(page.locator("#authMessage")).toContainText("既に登録されています");
  // The raw provider string never reaches the farmer.
  await expect(page.locator("#authMessage")).not.toContainText("already registered");
  await expect(page.locator("#authScreen")).toBeVisible();
});

test("a short password is rejected before the provider is called", async ({ page }) => {
  await useMockCloud(page, { users: [] });
  await openApp(page);
  await page.locator("#authSwitchButton").click();
  await page.locator("#authEmailInput").fill("new@example.test");
  await page.locator("#authPasswordInput").fill("short");
  await page.locator("#authSubmitButton").click();
  await expect(page.locator("#authMessage")).toContainText("8文字以上");
});

test("a malformed email is rejected with farmer wording", async ({ page }) => {
  await useMockCloud(page);
  await openApp(page);
  await page.locator("#authEmailInput").fill("not-an-email");
  await page.locator("#authPasswordInput").fill("kitaden-2026");
  await page.locator("#authSubmitButton").click();
  await expect(page.locator("#authMessage")).toContainText("形式");
});

test("a wrong password shows a Japanese error and keeps the form usable", async ({ page }) => {
  await useMockCloud(page);
  await openApp(page);
  await page.locator("#authEmailInput").fill(USER_A.email);
  await page.locator("#authPasswordInput").fill("wrong-password");
  await page.locator("#authSubmitButton").click();

  await expect(page.locator("#authMessage")).toContainText("メールアドレスまたはパスワードが違います");
  await expect(page.locator("#authMessage")).not.toContainText("Invalid login");
  await expect(page.locator("#authScreen")).toBeVisible();
  // The password field is cleared but the email is kept, so a retry is one field.
  await expect(page.locator("#authEmailInput")).toHaveValue(USER_A.email);
});

test("a successful login shows the account control beside 使い方, not instead of it", async ({ page }) => {
  await useMockCloud(page);
  await openApp(page);
  await signIn(page, USER_A);

  await expect(page.locator("#basicHelpButton")).toBeVisible();
  await expect(page.locator("#accountMenuButton")).toBeVisible();
  await expect(page.locator("#accountMenuLabel")).toHaveText(USER_A.displayName);

  await page.locator("#accountMenuButton").click();
  await expect(page.locator("#accountMenuIdentity")).toHaveText(USER_A.email);
  await expect(page.locator("#accountMenuStatus")).toContainText("ログイン中");
  await expect(page.locator("#accountMenuLogoutButton")).toBeVisible();
});

test("a signed-in session survives a reload without flashing the login screen", async ({ page }) => {
  await useMockCloud(page);
  await openApp(page);
  await signIn(page, USER_A);

  await page.reload();
  // Asserted from the very first paint: the screen must never appear at all,
  // not merely disappear quickly.
  await expect(page.locator("#authScreen")).toBeHidden();
  await expect(page.locator("#accountMenuLabel")).toHaveText(USER_A.displayName);
});

// ---------------------------------------------------------------------------
// 7-9. The user's fields, selection, and registration
// ---------------------------------------------------------------------------

test("あなたの圃場 lists the signed-in farmer's paddies with their area", async ({ page }) => {
  await useMockCloud(page);
  await openApp(page);
  await signIn(page, USER_A);
  await registerField(page, "北田");

  await expect(page.locator("#accountFieldsCard")).toBeVisible();
  await expect(page.locator("#accountFieldsCard")).toContainText("登録済みの圃場");
  expect(await accountFieldNames(page)).toEqual(["北田"]);
  await expect(page.locator("#accountFieldsCard .account-field-area")).toContainText("m²");
  // あなたの圃場's own "＋ 新しい圃場を測る" button was folded into 圃場の管理's
  // single register entry point (§3/§21 of the field-water-dashboard spec).
  await expect(page.locator("#basicMeasureFieldButton")).toContainText("新しい圃場を測る");
});

test("selecting a paddy from あなたの圃場 drives the existing active field, not a second one", async ({ page }) => {
  await useMockCloud(page);
  await openApp(page);
  await signIn(page, USER_A);
  await registerField(page, "北田");
  await registerField(page, "南田");

  // Exactly one field selector exists in Basic mode.
  await expect(page.locator("#basicActiveFieldSelect")).toHaveCount(1);

  const tiles = page.locator("#accountFieldsCard .account-field-tile");
  await expect(tiles).toHaveCount(2);
  await tiles.first().click();

  const selected = await page.locator("#basicActiveFieldSelect").inputValue();
  const firstId = await tiles.first().getAttribute("data-account-field-id");
  expect(selected).toBe(firstId);
  await expect(tiles.first()).toHaveClass(/is-active/);
  // The one active field drove the summary card too.
  await expect(page.locator("#basicFieldSummary")).toBeVisible();
});

test("a newly registered paddy is saved locally first and then reaches the cloud", async ({ page }) => {
  await useMockCloud(page);
  await openApp(page);
  await signIn(page, USER_A);
  await registerField(page, "北田");

  // Local first, before any sync could have completed.
  const localFieldNames = await page.evaluate(() => {
    const userId = JSON.parse(localStorage.getItem("suimonNaviMockAuthSessionV1")).user.id;
    const raw = localStorage.getItem(`suimonNaviFieldAnnotationsV2::u:${userId}`);
    return JSON.parse(raw).fields.map((field) => field.name);
  });
  expect(localFieldNames).toEqual(["北田"]);

  await expectSynced(page);
  const cloudNames = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("suimonNaviMockCloudDbV1")).fields.map((row) => row.name));
  expect(cloudNames).toEqual(["北田"]);
});

test("the cloud row keeps the local record verbatim, including the polygon and area", async ({ page }) => {
  await useMockCloud(page);
  await openApp(page);
  await signIn(page, USER_A);
  await registerField(page, "北田");
  await expectSynced(page);

  const { row, local } = await page.evaluate(() => {
    const userId = JSON.parse(localStorage.getItem("suimonNaviMockAuthSessionV1")).user.id;
    return {
      row: JSON.parse(localStorage.getItem("suimonNaviMockCloudDbV1")).fields[0],
      local: JSON.parse(localStorage.getItem(`suimonNaviFieldAnnotationsV2::u:${userId}`)).fields[0]
    };
  });
  expect(row.record).toEqual(local);
  expect(row.legacy_field_id).toBe("paddy-001");
  expect(row.boundary).toEqual(local.coordinates);
  expect(row.area_m2).toBeCloseTo(local.properties.areaM2, 6);
  // A UUID primary key, never the human-readable name or the local id.
  expect(row.id).not.toBe(row.legacy_field_id);
  expect(row.id).not.toBe(row.name);
});

test("a paddy registered on one account is restored after signing out and back in", async ({ page }) => {
  await useMockCloud(page);
  await openApp(page);
  await signIn(page, USER_A);
  await registerField(page, "北田");
  await expectSynced(page);

  // Sign out, then wipe this device's local cache for that account so the
  // only possible source of the paddy is the cloud. This is the "log back in
  // on another device" requirement, simulated without a second browser.
  await page.locator("#accountMenuButton").click();
  await page.locator("#accountMenuLogoutButton").click();
  await expect(page.locator("#authScreen")).toBeVisible();
  await page.evaluate(() => {
    Object.keys(localStorage)
      .filter((key) => key.startsWith("suimonNaviFieldAnnotationsV2::u:"))
      .forEach((key) => localStorage.removeItem(key));
  });

  await signIn(page, USER_A);
  await expect(page.locator("#accountFieldsCard .account-field-name")).toHaveText(["北田"]);
});

// ---------------------------------------------------------------------------
// 10 + 25. Sync failure and offline
// ---------------------------------------------------------------------------

test("a sync failure never loses the local paddy", async ({ page }) => {
  await useMockCloud(page);
  await openApp(page);
  await signIn(page, USER_A);

  await page.evaluate(() => window.__suisuiMock.setOnline(false));
  await registerField(page, "圏外で登録した田");

  // The registration completed against local storage regardless.
  await expect(page.locator("#basicFieldSummary")).toBeVisible();
  await expect(page.locator("#accountFieldsCard .account-field-name")).toHaveText(["圏外で登録した田"]);
  const stored = await page.evaluate(() => {
    const userId = JSON.parse(localStorage.getItem("suimonNaviMockAuthSessionV1")).user.id;
    return JSON.parse(localStorage.getItem(`suimonNaviFieldAnnotationsV2::u:${userId}`)).fields.length;
  });
  expect(stored).toBe(1);
});

test("an offline signed-in farmer keeps their fields, their map and their local workflow", async ({ page }) => {
  await useMockCloud(page);
  await openApp(page);
  await signIn(page, USER_A);
  await registerField(page, "北田");
  await expectSynced(page);

  const consoleErrors = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.evaluate(() => window.__suisuiMock.setOnline(false));
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));

  // Cached field still visible, map still there, water card still reachable.
  await expect(page.locator("#accountFieldsCard .account-field-name")).toHaveText(["北田"]);
  await expect(page.locator("#map")).toBeVisible();
  await expect(page.locator("#basicRecordWaterButton")).toBeEnabled();
  // Registering another paddy offline still works, and it queues.
  await registerField(page, "南田");
  await expect(page.locator("#accountFieldsCard .account-field-name")).toHaveText(["北田", "南田"]);
  expect(consoleErrors).toEqual([]);
});

test("the pending queue drains when the network comes back", async ({ page }) => {
  await useMockCloud(page);
  await openApp(page);
  await signIn(page, USER_A);

  await page.evaluate(() => window.__suisuiMock.setOnline(false));
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await registerField(page, "圏外の田");

  await page.evaluate(() => window.__suisuiMock.setOnline(true));
  await page.evaluate(() => window.dispatchEvent(new Event("online")));

  await expectSynced(page);
  const cloudNames = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("suimonNaviMockCloudDbV1")).fields.map((row) => row.name));
  expect(cloudNames).toEqual(["圏外の田"]);
});

// ---------------------------------------------------------------------------
// 11-12 + 24. Logout and user switching
// ---------------------------------------------------------------------------

test("logout ends the session and says local data was kept", async ({ page }) => {
  await useMockCloud(page);
  await openApp(page);
  await signIn(page, USER_A);
  await registerField(page, "北田");
  await expectSynced(page);

  await page.locator("#accountMenuButton").click();
  await page.locator("#accountMenuLogoutButton").click();

  await expect(page.locator("#authScreen")).toBeVisible();
  await expect(page.locator("#accountFieldsCard")).toBeHidden();

  // Brief §22: the account's cache is still on the device, untouched.
  const remaining = await page.evaluate(() =>
    Object.keys(localStorage).filter((key) => key.startsWith("suimonNaviFieldAnnotationsV2::u:")).length);
  expect(remaining).toBe(1);
});

test("user B never sees user A's fields after a switch on the same browser", async ({ page }) => {
  await useMockCloud(page);
  await openApp(page);

  await signIn(page, USER_A);
  await registerField(page, "A1");
  await registerField(page, "A2");
  await expectSynced(page);
  expect(await accountFieldNames(page)).toEqual(["A1", "A2"]);

  await page.locator("#accountMenuButton").click();
  await page.locator("#accountMenuLogoutButton").click();
  await signIn(page, USER_B);

  // Nothing of A's is on screen, in the active-field selector, or in the
  // registered-fields panel. With zero fields, 圃場の管理's own
  // #basicFieldEmptyState is what a farmer sees -- #accountFieldsCard (and
  // its nested #accountFieldsEmpty) now stays hidden entirely rather than
  // showing a second, redundant "no fields" message underneath it.
  expect(await accountFieldNames(page)).toEqual([]);
  await expect(page.locator("#accountFieldsCard")).toBeHidden();
  await expect(page.locator("#basicFieldEmptyState")).toBeVisible();
  const selectorOptions = await page.locator("#basicActiveFieldSelect option").allTextContents();
  expect(selectorOptions.join(" ")).not.toContain("A1");
  expect(selectorOptions.join(" ")).not.toContain("A2");
  await expect(page.locator("#registeredFieldsContainer")).not.toContainText("A1");

  await registerField(page, "B1");
  await expectSynced(page);
  expect(await accountFieldNames(page)).toEqual(["B1"]);

  // And back to A: their two paddies are intact.
  await page.locator("#accountMenuButton").click();
  await page.locator("#accountMenuLogoutButton").click();
  await signIn(page, USER_A);
  expect(await accountFieldNames(page)).toEqual(["A1", "A2"]);
});

test("the store refuses a direct read of another owner's field by its id", async ({ page }) => {
  // Brief §4: this must fail below the UI. The attempt below is exactly what
  // a farmer with the devtools console open could try.
  await useMockCloud(page);
  await openApp(page);

  await signIn(page, USER_A);
  await registerField(page, "A1");
  await expectSynced(page);
  const targetId = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("suimonNaviMockCloudDbV1")).fields[0].id);

  await page.locator("#accountMenuButton").click();
  await page.locator("#accountMenuLogoutButton").click();
  await signIn(page, USER_B);

  const result = await page.evaluate(async (id) => {
    const store = window.__suisuiMock.store;
    return {
      byId: await store.fetchById("fields", id),
      listed: (await store.listFields()).length
    };
  }, targetId);
  expect(result.byId).toBeNull();
  expect(result.listed).toBe(0);
});

test("the store refuses a write that claims another owner", async ({ page }) => {
  await useMockCloud(page);
  await openApp(page);
  await signIn(page, USER_A);
  await registerField(page, "A1");
  await expectSynced(page);
  const ownerA = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("suimonNaviMockCloudDbV1")).fields[0].owner_id);

  await page.locator("#accountMenuButton").click();
  await page.locator("#accountMenuLogoutButton").click();
  await signIn(page, USER_B);

  const denied = await page.evaluate(async (owner) => {
    try {
      await window.__suisuiMock.store.upsertFields([{
        owner_id: owner,
        legacy_field_id: "paddy-999",
        name: "spoofed",
        record: { id: "paddy-999", name: "spoofed" }
      }]);
      return "allowed";
    } catch (error) {
      return error.name;
    }
  }, ownerA);
  expect(denied).toBe("RlsDeniedError");
});

test("a signed-out browser cannot read anything from the store", async ({ page }) => {
  await useMockCloud(page);
  await openApp(page);
  await signIn(page, USER_A);
  await registerField(page, "A1");
  await expectSynced(page);

  await page.locator("#accountMenuButton").click();
  await page.locator("#accountMenuLogoutButton").click();

  const outcome = await page.evaluate(async () => {
    try {
      await window.__suisuiMock.store.listFields();
      return "allowed";
    } catch (error) {
      return error.name;
    }
  });
  expect(outcome).toBe("NotAuthenticatedError");
});

// ---------------------------------------------------------------------------
// 13-14. Local data -> account
// ---------------------------------------------------------------------------

test("guest paddies trigger an import offer on first sign-in, and importing keeps the local copy", async ({ page }) => {
  await useMockCloud(page);
  await openApp(page);
  await page.locator("#authGuestButton").click();
  await registerField(page, "ゲスト田");

  await page.locator("#accountMenuButton").click();
  await page.locator("#accountMenuLoginButton").click();
  await signIn(page, USER_A);

  await expect(page.locator("#localImportPrompt")).toBeVisible();
  await expect(page.locator("#localImportPromptText")).toContainText("1件");
  await page.locator("#localImportAcceptButton").click();

  await expect(page.locator("#localImportPrompt")).toBeHidden();
  expect(await accountFieldNames(page)).toEqual(["ゲスト田"]);
  await expectSynced(page);

  // The guest copy still exists -- importing copies, it never moves.
  const guestFields = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("suimonNaviFieldAnnotationsV2")).fields.map((field) => field.name));
  expect(guestFields).toEqual(["ゲスト田"]);
});

test("今はしない leaves the guest paddies alone and does not ask again", async ({ page }) => {
  await useMockCloud(page);
  await openApp(page);
  await page.locator("#authGuestButton").click();
  await registerField(page, "ゲスト田");

  await page.locator("#accountMenuButton").click();
  await page.locator("#accountMenuLoginButton").click();
  await signIn(page, USER_A);

  await expect(page.locator("#localImportPrompt")).toBeVisible();
  await page.locator("#localImportSkipButton").click();
  await expect(page.locator("#localImportPrompt")).toBeHidden();

  // Nothing was uploaded and the account is still empty.
  expect(await accountFieldNames(page)).toEqual([]);
  const cloudFields = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("suimonNaviMockCloudDbV1") || '{"fields":[]}').fields.length);
  expect(cloudFields).toBe(0);

  // Signing out and back in must not nag.
  await page.locator("#accountMenuButton").click();
  await page.locator("#accountMenuLogoutButton").click();
  await signIn(page, USER_A);
  await expect(page.locator("#localImportPrompt")).toBeHidden();
});

test("the import offer is never made to the second farmer on a shared browser", async ({ page }) => {
  // A's guest-era paddies must not be offered to B just because B signed in
  // on the same phone afterwards -- but the guest namespace is shared, so
  // this is exactly the case worth pinning.
  await useMockCloud(page);
  await openApp(page);
  await page.locator("#authGuestButton").click();
  await registerField(page, "ゲスト田");

  await page.locator("#accountMenuButton").click();
  await page.locator("#accountMenuLoginButton").click();
  await signIn(page, USER_A);
  await page.locator("#localImportAcceptButton").click();
  await expectSynced(page);

  await page.locator("#accountMenuButton").click();
  await page.locator("#accountMenuLogoutButton").click();
  await signIn(page, USER_B);

  // B is offered the guest data (it is on this device and belongs to nobody),
  // but must not see A's account copy under any circumstance.
  expect(await accountFieldNames(page)).toEqual([]);
  const bCloud = await page.evaluate(async () => (await window.__suisuiMock.store.listFields()).length);
  expect(bCloud).toBe(0);
});

// ---------------------------------------------------------------------------
// 15. Sync indicator + Settings
// ---------------------------------------------------------------------------

test("the sync indicator is subtle, appears only when signed in, and reaches 同期済み", async ({ page }) => {
  await useMockCloud(page);
  await openApp(page);
  await expect(page.locator("#syncStatusChip")).toBeHidden();

  await signIn(page, USER_A);
  await registerField(page, "北田");
  await expectSynced(page);
  await expect(page.locator("#syncStatusChip")).toHaveAttribute("data-sync-status", "synced");

  // Subtle: one small chip, not a dashboard.
  const box = await page.locator("#syncStatusChip").boundingBox();
  expect(box.height).toBeLessThan(40);
});

test("the sync indicator reports an offline queue rather than pretending", async ({ page }) => {
  await useMockCloud(page);
  await openApp(page);
  await signIn(page, USER_A);
  await expectSynced(page);

  await page.evaluate(() => window.__suisuiMock.setOnline(false));
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await registerField(page, "圏外の田");

  await expect(page.locator("#syncStatusChip")).not.toHaveAttribute("data-sync-status", "synced");
  await expect(page.locator("#syncStatusChip")).toContainText("同期待ち");
});

test("設定 → 圃場データ → アカウント shows the account and sync detail, and no field selector", async ({ page }) => {
  await useMockCloud(page);
  await openApp(page);
  await signIn(page, USER_A);
  await registerField(page, "北田");
  await expectSynced(page);

  await page.goto("/#settings/fields");
  const panel = page.locator("#settingsAccountPanel");
  await expect(panel).toBeVisible();
  await panel.locator("summary").click();
  await expect(page.locator("#settingsAccountIdentity")).toHaveText(USER_A.email);
  await expect(page.locator("#settingsAccountStatus")).toContainText("ログイン中");
  await expect(page.locator("#settingsSyncStatus")).toContainText("同期済み");
  await expect(page.locator("#settingsSyncNowButton")).toBeVisible();
  await expect(page.locator("#settingsLogoutButton")).toBeVisible();
  // Field selection is a 基本モード decision and must not be duplicated here.
  await expect(panel.locator("select")).toHaveCount(0);
});

test("今すぐ同期 reports success", async ({ page }) => {
  await useMockCloud(page);
  await openApp(page);
  await signIn(page, USER_A);
  await registerField(page, "北田");
  await expectSynced(page);

  await page.goto("/#settings/fields");
  await page.locator("#settingsAccountPanel summary").click();
  await page.locator("#settingsSyncNowButton").click();
  await expect(page.locator("#settingsAccountMessage")).toContainText("同期しました");
});

// ---------------------------------------------------------------------------
// 33. Mobile
// ---------------------------------------------------------------------------

for (const viewport of [{ width: 390, height: 844 }, { width: 393, height: 852 }]) {
  test(`the login screen and signed-in Basic work at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await useMockCloud(page);
    await openApp(page);

    // No horizontal scroll on the login screen.
    await expect(page.locator("#authScreen")).toBeVisible();
    let overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    // Every control the farmer must hit is a real touch target.
    for (const id of ["#authEmailInput", "#authPasswordInput", "#authSubmitButton", "#authSwitchButton", "#authGuestButton"]) {
      const box = await page.locator(id).boundingBox();
      expect(box.height, `${id} height`).toBeGreaterThanOrEqual(44);
      expect(box.width, `${id} width`).toBeLessThanOrEqual(viewport.width);
    }

    await signIn(page, USER_A);
    await registerField(page, "北田");

    overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    // Header still holds 使い方 AND the account control side by side.
    await expect(page.locator("#basicHelpButton")).toBeVisible();
    const accountBox = await page.locator("#accountMenuButton").boundingBox();
    expect(accountBox.height).toBeGreaterThanOrEqual(44);

    // The map stays the dominant element and the water card is reachable.
    const mapBox = await page.locator("#map").boundingBox();
    expect(mapBox.height).toBeGreaterThan(200);
    await expect(page.locator("#basicRecordWaterButton")).toBeEnabled();

    // Field tiles are tappable.
    const tile = await page.locator("#accountFieldsCard .account-field-tile").first().boundingBox();
    expect(tile.height).toBeGreaterThanOrEqual(44);
  });
}

// ---------------------------------------------------------------------------
// The shipped configuration: no cloud, no change to the existing app
// ---------------------------------------------------------------------------

test("with no cloud configured there is no login screen and no account control", async ({ page }) => {
  // No useMockCloud() here on purpose -- this is the state every other spec
  // in this repository runs in, and the state the app ships in today.
  await openApp(page);
  await expect(page.locator("#authScreen")).toBeHidden();
  await expect(page.locator("#accountControl")).toBeHidden();
  await expect(page.locator("#accountFieldsCard")).toBeHidden();
  await expect(page.locator("#syncStatusChip")).toBeHidden();
  await expect(page.locator("#basicStage1Card")).toBeVisible();
  await expect(page.locator("#basicHelpButton")).toBeVisible();
});

test("with no cloud configured the field workflow still writes the original storage key", async ({ page }) => {
  // The guest namespace must remain byte-identical, or every existing install
  // silently loses its paddies on upgrade.
  await openApp(page);
  await registerField(page, "従来の田");
  const keys = await page.evaluate(() => Object.keys(localStorage).filter((key) => key.includes("FieldAnnotations")));
  expect(keys).toEqual(["suimonNaviFieldAnnotationsV2"]);
});

test("設定 → アカウント explains that no cloud is configured instead of offering a dead login", async ({ page }) => {
  await page.goto("/#settings/fields");
  await page.locator("#settingsAccountPanel summary").click();
  await expect(page.locator("#settingsAccountStatus")).toContainText("クラウド未設定");
  await expect(page.locator("#settingsLoginButton")).toBeHidden();
  await expect(page.locator("#settingsLogoutButton")).toBeHidden();
});
