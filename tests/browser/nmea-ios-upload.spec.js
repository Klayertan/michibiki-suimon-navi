import { test, expect } from "@playwright/test";

// iPhone Safari could not select .nmea files that a Mac could: the pickers
// carried accept=".nmea,.txt,.log,text/plain", and iOS hands that list to the
// native Files picker, which filters on UTType — a custom .nmea has none, so
// the farmer's own recording was greyed out. The fix is to stop filtering at
// the picker and validate after selection instead.
//
// WHAT THIS FILE CAN AND CANNOT PROVE
// -----------------------------------
// Playwright cannot drive the native iOS Files picker, so the greyed-out
// state itself is NOT reproducible here. What is proven here is everything
// downstream of it:
//   * the pickers carry no restrictive accept filter (the cause);
//   * a File object shaped exactly like the one iOS hands over — name
//     "field01.nmea", type "" or "application/octet-stream" — is read,
//     parsed by the existing parser, and drives the Basic workflow;
//   * an invalid file is rejected after selection, not at the picker.
// The one remaining step — that iOS Files now shows .nmea as selectable —
// needs one physical tap-test on an iPhone.

function gga(time, lat, lon, fix = 1, sats = 8, hdop = "1.1") {
  const body = `GNGGA,${time},${lat},N,${lon},E,${fix},${sats},${hdop},45.0,M,30.0,M,,`;
  let checksum = 0;
  for (const character of body) {
    checksum ^= character.charCodeAt(0);
  }
  return `$${body}*${checksum.toString(16).toUpperCase().padStart(2, "0")}`;
}

// A short walked loop: enough fixes for a polygon, so a successful intake is
// visible as a real Stage-1 START/END workflow rather than just a point count.
const WALK_NMEA = [
  gga("120000.00", "3439.2880", "13549.7892"),
  gga("120010.00", "3439.2880", "13549.8162"),
  gga("120020.00", "3439.2664", "13549.8162"),
  gga("120030.00", "3439.2664", "13549.7892"),
  gga("120040.00", "3439.2879", "13549.7895", 2, 9, "0.9")
].join("\r\n");

const NOT_NMEA = "これは写真の説明メモです。測量データではありません。\nline two\nline three\n";
const REJECTED_MESSAGE = "NMEAデータを確認できませんでした。QZ1から保存したNMEAログを選んでください。";

async function openBasic(page) {
  await page.goto("/");
  await expect(page.locator("body")).toHaveAttribute("data-mode", "basic");
  await expect(page.locator("#basicStage1Card")).toBeVisible();
}

// ---------------------------------------------------------------------------
// The cause: no picker-level filtering on NMEA inputs
// ---------------------------------------------------------------------------

test("no NMEA upload input carries an accept filter, and none uses the */* workaround", async ({ page }) => {
  await page.goto("/");

  for (const id of ["basicNmeaInput", "typedSurveyUploadInput", "assuranceQz1Input", "assuranceReferenceInput"]) {
    const accept = await page.locator(`#${id}`).getAttribute("accept");
    expect(accept, `#${id} must not filter at the picker`).toBeNull();
  }
});

test("JSON inputs keep their filter -- .json has a platform UTType, so nothing was broken there", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("#importInput")).toHaveAttribute("accept", ".json,application/json");
  await expect(page.locator("#assuranceImportProject")).toHaveAttribute("accept", ".json,application/json");
  await expect(page.locator("#paddyImportInput")).toHaveAttribute("accept", ".json,application/json");
});

// ---------------------------------------------------------------------------
// The iOS-shaped File objects
// ---------------------------------------------------------------------------

for (const { label, mimeType } of [
  { label: 'MIME "" (iOS Files, unknown UTType)', mimeType: "" },
  { label: 'MIME "application/octet-stream" (iOS Files, generic data)', mimeType: "application/octet-stream" }
]) {
  test(`an iPhone-shaped field01.nmea with ${label} loads and arms the Basic workflow`, async ({ page }) => {
    await openBasic(page);

    await page.locator("#basicNmeaInput").setInputFiles({
      name: "field01.nmea",
      mimeType,
      buffer: Buffer.from(WALK_NMEA)
    });

    // The existing parser ran and produced points...
    await expect(page.locator("#basicTrackPointCount")).toHaveText("5");
    // ...the map shows them...
    await expect(page.locator(".qz1-point")).toHaveCount(5);
    // ...and START/END became available.
    await expect(page.locator("#basicBoundaryControls")).toBeVisible();
    await expect(page.locator("#basicPickStartButton")).toBeEnabled();
    await expect(page.locator("#basicPickEndButton")).toBeEnabled();
    await expect(page.locator("#basicNmeaMessage")).toBeHidden();
  });
}

test("a .txt of valid NMEA still works -- the desktop/Mac path is unchanged", async ({ page }) => {
  await openBasic(page);

  await page.locator("#basicNmeaInput").setInputFiles({
    name: "paddy-walk.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(WALK_NMEA)
  });

  await expect(page.locator("#basicTrackPointCount")).toHaveText("5");
  await expect(page.locator("#basicBoundaryControls")).toBeVisible();
});

test("the Settings uploader shares the same intake path, including the iOS shape", async ({ page }) => {
  await page.goto("/#settings/fields");
  await expect(page.locator("#fieldRegDialog")).toBeAttached({ timeout: 15_000 });

  // The advanced Settings uploader changes to 圃場データ before it opens the
  // registration dialog, so the dialog is always visible.
  await page.evaluate(() => switchMode("settings", { workspace: "devtools" }));
  await page.locator("#typedSurveyUploadInput").setInputFiles({
    name: "field01.nmea",
    mimeType: "",
    buffer: Buffer.from(WALK_NMEA)
  });
  await page.evaluate(() => switchWorkspace("fields"));

  // Settings' own post-parse behaviour: the whole-recording registration
  // dialog. Reaching it at all proves the shared parse ran.
  await expect(page.locator("#fieldRegDialog")).toBeVisible();
  await expect(page.locator(".qz1-point")).toHaveCount(5);
});

// ---------------------------------------------------------------------------
// Rejection happens after selection, in farmer language
// ---------------------------------------------------------------------------

test("an arbitrary file is rejected after selection with a farmer-readable message", async ({ page }) => {
  await openBasic(page);

  await page.locator("#basicNmeaInput").setInputFiles({
    name: "memo.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(NOT_NMEA)
  });

  await expect(page.locator("#basicNmeaMessage")).toBeVisible();
  await expect(page.locator("#basicNmeaMessage")).toHaveText(REJECTED_MESSAGE);
  // Nothing was loaded, and nothing crashed.
  await expect(page.locator("#basicBoundaryControls")).toBeHidden();
  await expect(page.locator(".qz1-point")).toHaveCount(0);
  await expect(page.locator("#emptyStateTitle")).toHaveText("NMEAデータを確認できませんでした");
});

test("a wrong pick does not destroy the recording already loaded", async ({ page }) => {
  await openBasic(page);

  await page.locator("#basicNmeaInput").setInputFiles({
    name: "field01.nmea",
    mimeType: "",
    buffer: Buffer.from(WALK_NMEA)
  });
  await expect(page.locator("#basicTrackPointCount")).toHaveText("5");

  await page.locator("#basicNmeaInput").setInputFiles({
    name: "holiday.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
  });

  await expect(page.locator("#basicNmeaMessage")).toHaveText(REJECTED_MESSAGE);
  // The good track survived: validation runs before any parser state is touched.
  await expect(page.locator(".qz1-point")).toHaveCount(5);
  await expect(page.locator("#basicBoundaryControls")).toBeVisible();
});

test("a rejection clears once a real recording is chosen", async ({ page }) => {
  await openBasic(page);

  await page.locator("#basicNmeaInput").setInputFiles({
    name: "memo.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(NOT_NMEA)
  });
  await expect(page.locator("#basicNmeaMessage")).toBeVisible();

  await page.locator("#basicNmeaInput").setInputFiles({
    name: "field01.nmea",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(WALK_NMEA)
  });

  await expect(page.locator("#basicNmeaMessage")).toBeHidden();
  await expect(page.locator("#basicTrackPointCount")).toHaveText("5");
});

test("NMEA sentences that yield no usable fix are refused, not loaded as an empty field", async ({ page }) => {
  await openBasic(page);

  // Real GGA sentences, every one of them fix quality 0 (no fix).
  const noFix = [
    gga("120000.00", "3439.2880", "13549.7892", 0),
    gga("120010.00", "3439.2880", "13549.8162", 0)
  ].join("\r\n");

  await page.locator("#basicNmeaInput").setInputFiles({
    name: "indoors.nmea",
    mimeType: "",
    buffer: Buffer.from(noFix)
  });

  await expect(page.locator("#basicNmeaMessage")).toHaveText(REJECTED_MESSAGE);
  await expect(page.locator("#basicBoundaryControls")).toBeHidden();
});
