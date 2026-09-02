import { test, expect } from "@playwright/test";

// Checksums are computed rather than hard-coded so the fixture stays easy to
// extend — a wrong checksum would otherwise silently drop a fix and shift
// every boundary index in this file.
function gga(time, lat, lon, fix = 1, sats = 8, hdop = "1.1") {
  const body = `GNGGA,${time},${lat},N,${lon},E,${fix},${sats},${hdop},45.0,M,30.0,M,,`;
  let checksum = 0;
  for (const character of body) {
    checksum ^= character.charCodeAt(0);
  }
  return `$${body}*${checksum.toString(16).toUpperCase().padStart(2, "0")}`;
}

// The real Stage-1 shape: walk up to the paddy, walk its perimeter, walk away.
// Registering the whole recording would close a polygon across the approach
// and the return leg; only indexes 3-7 are the actual field boundary.
//
//   0,1,2  approach
//   3,4,5,6,7  perimeter loop (7 lands ~1m from 3, so it auto-closes)
//   8,9,10 return
const APPROACH = [
  gga("120000.00", "3439.2700", "13549.7800"),
  gga("120010.00", "3439.2750", "13549.7820"),
  gga("120020.00", "3439.2800", "13549.7850")
];
const PERIMETER = [
  gga("120030.00", "3439.2880", "13549.7892"),
  gga("120040.00", "3439.2880", "13549.8162"),
  gga("120050.00", "3439.2664", "13549.8162"),
  gga("120100.00", "3439.2664", "13549.7892"),
  gga("120110.00", "3439.2879", "13549.7895", 2, 9, "0.9")
];
const RETURN = [
  gga("120120.00", "3439.2500", "13549.7700"),
  gga("120130.00", "3439.2400", "13549.7600"),
  gga("120140.00", "3439.2300", "13549.7500")
];
const WALK_NMEA = [...APPROACH, ...PERIMETER, ...RETURN].join("\r\n");

const START_INDEX = 3;
const END_CLOSED_INDEX = 7; // ~1m from START -> auto-closes
const END_OPEN_INDEX = 6; // ~40m from START -> closure warning

async function openBasic(page) {
  await page.goto("/");
  await expect(page.locator("body")).toHaveAttribute("data-mode", "basic");
  await expect(page.locator("#basicStage1Card")).toBeVisible();
}

async function uploadWalk(page) {
  await page.locator("#basicNmeaInput").setInputFiles({
    name: "paddy-walk.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(WALK_NMEA)
  });
  await expect(page.locator("#basicBoundaryControls")).toBeVisible();
}

/**
 * Chooses a measured point by its index in the walk.
 *
 * Dispatches the click straight at the marker rather than tapping its screen
 * position: the loop closes with P7 about half a metre from P3, and at the
 * map's max zoom (~0.5 m/px) those two fixes render as overlapping circles,
 * so a coordinate-based tap cannot say which of them was meant. The realistic
 * hit-tested tap is covered on its own by the test below.
 */
async function pickBoundaryPoint(page, kind, index) {
  await page.locator(kind === "start" ? "#basicPickStartButton" : "#basicPickEndButton").click();
  await page.locator(`.qz1-point-${index}`).dispatchEvent("click");
}

async function selectedRange(page) {
  return page.evaluate(() => document.getElementById("basicBoundaryCount").textContent);
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

test("Basic mode offers a small ? help control instead of the 現地調査ワークフロー card", async ({ page }) => {
  await openBasic(page);

  const help = page.locator("#basicHelpButton");
  await expect(help).toBeVisible();
  await expect(help).toContainText("使い方");
  const box = await help.boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);
  // Small: an affordance, not a panel.
  expect(box.height).toBeLessThan(80);

  // The five-step checklist is gone from Basic mode entirely...
  await expect(page.locator("#workflowGuidePanel")).toBeHidden();
  await expect(page.locator("#workflowStepsContainer")).toBeHidden();
  await expect(page.locator("text=現地調査ワークフロー")).toBeHidden();

  // ...but is still built and available under Settings (開発ツール, moved
  // there from 圃場データ alongside #fileInput -- see 開発者モード).
  await page.goto("/#settings/devtools");
  await expect(page.locator("#workflowGuidePanel")).toBeVisible();
  await expect(page.locator("#workflowStepsContainer")).toContainText("NMEAログをアップロード");
});

test("help opens, teaches the Stage-1 flow, and closes three ways without touching the map", async ({ page }) => {
  await openBasic(page);
  const dialog = page.locator("#basicHelpDialog");
  const mapState = () => page.evaluate(() => {
    const center = window.map.getCenter();
    return { center: [center.lat, center.lng], zoom: window.map.getZoom() };
  });
  const before = await mapState();

  await page.locator("#basicHelpButton").click();
  await expect(dialog).toBeVisible();

  // Farmer-oriented Stage-1 content, in order.
  await expect(dialog).toContainText("QZ1/NMEAデータを読み込む");
  await expect(dialog).toContainText("圃場の外周を歩いて記録したデータを読み込みます。");
  await expect(dialog).toContainText("境界を確認する");
  await expect(dialog).toContainText("圃場として使う開始点と終了点を選びます。");
  await expect(dialog).toContainText("圃場を登録する");
  await expect(dialog).toContainText("水位を記録する");
  await expect(dialog).toContainText("詳しい機能は「開発者モード」から利用できます。");

  // No developer vocabulary anywhere in the help.
  const helpText = await dialog.innerText();
  for (const jargon of ["IndexedDB", "schema", "parser", "WebSerial", "JSON", "sequence"]) {
    expect(helpText).not.toContain(jargon);
  }

  // Close button.
  await page.locator("#basicHelpCloseButton").click();
  await expect(dialog).toBeHidden();

  // Escape.
  await page.locator("#basicHelpButton").click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // Tapping outside.
  await page.locator("#basicHelpButton").click();
  await expect(dialog).toBeVisible();
  await page.locator(".basic-help-backdrop").click({ position: { x: 5, y: 5 } });
  await expect(dialog).toBeHidden();

  // The map never moved and the page never reloaded.
  expect(await mapState()).toEqual(before);
});

// ---------------------------------------------------------------------------
// Boundary selection
// ---------------------------------------------------------------------------

test("an uploaded walk arms boundary trimming and defaults to the whole track", async ({ page }) => {
  await openBasic(page);
  await uploadWalk(page);

  await expect(page.locator("#basicTrackPointCount")).toHaveText("11");
  await expect(page.locator("#basicBoundaryStartValue")).toHaveText("測位点1");
  await expect(page.locator("#basicBoundaryEndValue")).toHaveText("測位点11");
  expect(await selectedRange(page)).toBe("11点（測位点1 〜 測位点11）");

  // Basic mode does not open the legacy whole-recording dialog.
  await expect(page.locator("#fieldRegDialog")).toBeHidden();
  await expect(page.locator("#basicFieldRegDialog")).toBeHidden();
});

test("a real tap on a marker selects it, even under the candidate boundary line", async ({ page }) => {
  await openBasic(page);
  await uploadWalk(page);

  // P4 is an isolated corner with no other fix drawn on top of it, and the
  // default whole-track boundary line runs straight through it — so this
  // also proves the overlay does not swallow taps meant for the points.
  await page.locator("#basicPickStartButton").click();
  await expect(page.locator("#basicPickStartButton")).toHaveAttribute("aria-pressed", "true");
  await page.locator(".qz1-point-4").click();

  await expect(page.locator("#basicBoundaryStartValue")).toHaveText("測位点5");
  await expect(page.locator("#basicPickStartButton")).toHaveAttribute("aria-pressed", "false");
});

test("tapping measured points sets START and END and trims the candidate boundary", async ({ page }) => {
  await openBasic(page);
  await uploadWalk(page);

  await pickBoundaryPoint(page, "start", START_INDEX);
  await expect(page.locator("#basicBoundaryStartValue")).toHaveText("測位点4");

  await pickBoundaryPoint(page, "end", END_CLOSED_INDEX);
  await expect(page.locator("#basicBoundaryEndValue")).toHaveText("測位点8");
  expect(await selectedRange(page)).toBe("5点（測位点4 〜 測位点8）");

  // START and END are visually distinguished; the rest of the walk is not hidden.
  await expect(page.locator(".qz1-point--start")).toHaveCount(1);
  await expect(page.locator(".qz1-point--end")).toHaveCount(1);
  await expect(page.locator(".qz1-point--inside")).toHaveCount(3);
  await expect(page.locator(".qz1-point--outside")).toHaveCount(6);
  await expect(page.locator(".qz1-point")).toHaveCount(11);
});

test("a reversed pick relabels to measurement order rather than guessing or wrapping", async ({ page }) => {
  await openBasic(page);
  await uploadWalk(page);

  // Choose the LATER point as START and the EARLIER one as END.
  await pickBoundaryPoint(page, "start", END_CLOSED_INDEX);
  await pickBoundaryPoint(page, "end", START_INDEX);

  await expect(page.locator("#basicBoundaryHint")).toContainText("開始点と終了点を入れ替えました");
  await expect(page.locator("#basicBoundaryStartValue")).toHaveText("測位点4");
  await expect(page.locator("#basicBoundaryEndValue")).toHaveText("測位点8");
  // 5 points, not the 7 a wrap-around would have produced.
  expect(await selectedRange(page)).toBe("5点（測位点4 〜 測位点8）");
});

test("a range shorter than a triangle is rejected and cannot be registered", async ({ page }) => {
  await openBasic(page);
  await uploadWalk(page);

  await pickBoundaryPoint(page, "start", 4);
  await pickBoundaryPoint(page, "end", 5);

  await expect(page.locator("#basicBoundaryHint")).toContainText("3点以上必要です");
  await expect(page.locator("#basicCreateFieldButton")).toBeDisabled();
  expect(await page.evaluate(() => window.fieldAnnotationController.fields.length)).toBe(0);
});

test("圃場を作る uses only the selected range, closing END back to START", async ({ page }) => {
  await openBasic(page);
  await uploadWalk(page);
  await pickBoundaryPoint(page, "start", START_INDEX);
  await pickBoundaryPoint(page, "end", END_CLOSED_INDEX);
  await page.locator("#basicCreateFieldButton").click();
  await page.locator("#basicFieldRegConfirmButton").click();

  await expect(page.locator("#fieldAnnotationSummaryFields")).toHaveText("1");
  const field = await page.evaluate(() => window.fieldAnnotationController.fields[0]);

  // Exactly the 5 perimeter fixes — no approach point, no return point.
  expect(field.coordinates).toHaveLength(5);
  expect(field.properties.sourcePointCount).toBe(5);
  const lats = field.coordinates.map(([lat]) => lat);
  // Walk order preserved: not sorted, not hulled.
  expect(lats[0]).toBeCloseTo(34.654800, 5);
  expect(lats[1]).toBeCloseTo(34.654800, 5);
  expect(lats[2]).toBeCloseTo(34.654440, 5);
  expect(lats[3]).toBeCloseTo(34.654440, 5);
  // The ring is stored open; END -> START closure is implicit in the polygon.
  expect(field.coordinates[0]).not.toEqual(field.coordinates[4]);
  // The excluded approach/return legs are far south — none of them leaked in.
  expect(Math.min(...lats)).toBeGreaterThan(34.6540);

  // Area comes from the existing geometry helper, on the trimmed ring only.
  const areas = await page.evaluate(async (coordinates) => {
    const core = await import("/js/fields/field-annotation-core.js");
    return { expected: core.polygonAreaSquareMeters(coordinates) };
  }, field.coordinates);
  expect(field.properties.areaM2).toBeCloseTo(areas.expected, 6);
  expect(field.properties.areaM2).toBeGreaterThan(1000);
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test("Basic registration is field-only: no measurement type, no 境界トラック option", async ({ page }) => {
  await openBasic(page);
  await uploadWalk(page);
  await pickBoundaryPoint(page, "start", START_INDEX);
  await pickBoundaryPoint(page, "end", END_CLOSED_INDEX);
  await page.locator("#basicCreateFieldButton").click();

  const dialog = page.locator("#basicFieldRegDialog");
  await expect(dialog).toBeVisible();
  await expect(page.locator("#basicFieldRegNameInput")).toBeVisible();
  await expect(page.locator("#basicFieldRegMemoInput")).toBeVisible();

  // None of the three measurement-type choices exist on this dialog.
  await expect(dialog.locator("input[name='fieldRegType']")).toHaveCount(0);
  const dialogText = await dialog.innerText();
  expect(dialogText).not.toContain("測量タイプ");
  expect(dialogText).not.toContain("境界トラック");
  expect(dialogText).not.toContain("水門・給水口・排水口ポイントとして登録");

  // The legacy dialog keeps all three, under Settings (圃場データ).
  await page.goto("/#settings/fields");
  await expect(page.locator("#fieldRegTypePolygon")).toBeAttached();
  await expect(page.locator("#fieldRegTypeTrack")).toBeAttached();
  await expect(page.locator("#fieldRegTypeWater")).toBeAttached();
  await expect(page.locator("#fieldRegSaveAsTrackButton")).toBeAttached();
});

test("the farmer names the field; the id is generated, unique and read-only", async ({ page }) => {
  await openBasic(page);
  await uploadWalk(page);
  await pickBoundaryPoint(page, "start", START_INDEX);
  await pickBoundaryPoint(page, "end", END_CLOSED_INDEX);
  await page.locator("#basicCreateFieldButton").click();

  await expect(page.locator("#basicFieldRegNameInput")).toHaveValue("田圃1");
  const idInput = page.locator("#basicFieldRegIdInput");
  await expect(idInput).toHaveValue("paddy-001");
  await expect(idInput).toHaveAttribute("readonly", "");
  // Tucked behind 詳細 rather than asked for.
  await expect(idInput).toBeHidden();

  await page.locator("#basicFieldRegNameInput").fill("北の田圃");
  await page.locator("#basicFieldRegConfirmButton").click();
  await expect(page.locator("#fieldAnnotationSummaryFields")).toHaveText("1");

  const field = await page.evaluate(() => window.fieldAnnotationController.fields[0]);
  expect(field.name).toBe("北の田圃");
  expect(field.id).toBe("paddy-001");
  // No collision error is ever shown to the farmer.
  await expect(page.locator("#basicFieldRegMessage")).toHaveText("");
});

test("the simplified closure warning offers only 作る / 選び直す", async ({ page }) => {
  await openBasic(page);
  await uploadWalk(page);
  await pickBoundaryPoint(page, "start", START_INDEX);
  await pickBoundaryPoint(page, "end", END_OPEN_INDEX);
  await page.locator("#basicCreateFieldButton").click();
  await page.locator("#basicFieldRegConfirmButton").click();

  const warning = page.locator("#basicFieldRegCloseWarning");
  await expect(warning).toBeVisible();
  await expect(page.locator("#basicFieldRegCloseWarningText")).toContainText("開始点と終了点は約");
  await expect(page.locator("#basicFieldRegCloseWarningText")).toContainText("この2点を結んで圃場を作りますか？");
  await expect(warning.locator("button")).toHaveCount(2);
  expect(await warning.innerText()).not.toContain("境界トラック");
  expect(await page.evaluate(() => window.fieldAnnotationController.fields.length)).toBe(0);

  // 選び直す creates nothing and hands the map back with the picks intact.
  await page.locator("#basicFieldRegReselectButton").click();
  await expect(page.locator("#basicFieldRegDialog")).toBeHidden();
  await expect(page.locator("#basicBoundaryControls")).toBeVisible();
  await expect(page.locator("#basicBoundaryStartValue")).toHaveText("測位点4");
  expect(await page.evaluate(() => window.fieldAnnotationController.fields.length)).toBe(0);
  expect(await page.evaluate(() => window.fieldAnnotationController.boundaryTracks.length)).toBe(0);

  // Confirming instead force-closes into a polygon.
  await page.locator("#basicCreateFieldButton").click();
  await page.locator("#basicFieldRegConfirmButton").click();
  await page.locator("#basicFieldRegForceCloseButton").click();
  await expect(page.locator("#fieldAnnotationSummaryFields")).toHaveText("1");
  const field = await page.evaluate(() => window.fieldAnnotationController.fields[0]);
  expect(field.properties.closedManually).toBe(true);
  expect(field.geometryType).toBe("Polygon");
});

test("a registered field survives a reload with its area and geometry intact", async ({ page }) => {
  await openBasic(page);
  await uploadWalk(page);
  await pickBoundaryPoint(page, "start", START_INDEX);
  await pickBoundaryPoint(page, "end", END_CLOSED_INDEX);
  await page.locator("#basicCreateFieldButton").click();
  await page.locator("#basicFieldRegConfirmButton").click();
  await expect(page.locator("#fieldAnnotationSummaryFields")).toHaveText("1");
  const before = await page.evaluate(() => window.fieldAnnotationController.fields[0]);

  await page.reload();
  await expect(page.locator("#fieldAnnotationSummaryFields")).toHaveText("1");
  const after = await page.evaluate(() => window.fieldAnnotationController.fields[0]);
  expect(after.id).toBe(before.id);
  expect(after.coordinates).toEqual(before.coordinates);
  expect(after.properties.areaM2).toBeCloseTo(before.properties.areaM2, 6);
  await expect(page.locator("#basicFieldArea")).toContainText("m²");
  await expect(page.locator("#basicFieldArea")).toContainText("反");
});

// ---------------------------------------------------------------------------
// UI cleanup / water / multiple fields
// ---------------------------------------------------------------------------

test("the technical Field Recording card is gone from Basic but intact in Settings", async ({ page }) => {
  await openBasic(page);
  for (const id of ["recPanel", "serialConnectButton", "deviceSourceSelect", "baudSelect",
                    "recStartButton", "recSessionIdLabel", "recHdopLabel", "serialStatus"]) {
    await expect(page.locator(`#${id}`)).toBeHidden();
  }

  await page.goto("/#settings/survey");
  await page.evaluate(() => {
    document.querySelectorAll("details[data-workspace='survey']").forEach((card) => { card.open = true; });
  });
  for (const id of ["recPanel", "serialConnectButton", "deviceSourceSelect", "baudSelect",
                    "recStartButton", "recSessionIdLabel", "recHdopLabel", "serialStatus"]) {
    await expect(page.locator(`#${id}`)).toBeVisible();
  }
});

test("water management still works in Basic mode after the cleanup", async ({ page }) => {
  await openBasic(page);
  await uploadWalk(page);
  await pickBoundaryPoint(page, "start", START_INDEX);
  await pickBoundaryPoint(page, "end", END_CLOSED_INDEX);
  await page.locator("#basicCreateFieldButton").click();
  await page.locator("#basicFieldRegConfirmButton").click();
  await expect(page.locator("#fieldAnnotationSummaryFields")).toHaveText("1");

  // The water-level inputs stayed in Basic mode when the recording card left,
  // but the card itself is no longer parked in the right rail on desktop --
  // it only appears once summoned (by this button or the map summary's own
  // 水位を記録 button), then slides down attached to the map corner.
  await expect(page.locator("#basicWaterRecordCard")).toBeHidden();
  await page.locator("#basicRecordWaterButton").click();
  await expect(page.locator("#basicWaterRecordCard")).toBeVisible();
  await expect(page.locator("#recObsWaterLevelInput")).toBeVisible();
  await page.locator("#recTargetWaterLevelInput").fill("50");
  await page.locator("#recObsWaterLevelInput").fill("20");
  await expect(page.locator("#recWaterLevelVerdict")).toContainText("水位が低めです");
  await page.locator("#recObsWaterLevelInput").fill("55");
  await expect(page.locator("#recWaterLevelVerdict")).toContainText("適正");

  // Close the slide-down panel before returning to the map -- attached, it
  // floats over part of the map (by design, so its own controls are
  // reachable), which would otherwise intercept the click below.
  await page.locator("#basicWaterRecordCloseButton").click();

  // Water-management points still register against the field, via the
  // on-map quick toolbar -- the only placement path now (the right-rail
  // #waterControlPanel duplicate was removed; see its comment in index.html).
  const fieldId = await page.evaluate(() => window.fieldAnnotationController.fields[0].id);
  await page.locator('#waterQuickToolbar button[data-water-quick-type="gate"]').click();
  // Basic mode's desktop map is full-bleed under the floating rails, so a
  // click position that works in Settings mode's narrower map column (e.g.
  // x:300,y:200) can land on the left rail here instead -- x:600 clears
  // both rails at this test's 1280px default viewport.
  await page.locator("#map").click({ position: { x: 600, y: 400 } });
  const points = await page.evaluate(() => window.fieldAnnotationController.waterControlPoints);
  expect(points).toHaveLength(1);
  expect(points[0].relatedFieldId).toBe(fieldId);
});

test("結果を見る opens the field report where it now lives, and generates it", async ({ page }) => {
  await openBasic(page);
  await uploadWalk(page);
  await pickBoundaryPoint(page, "start", START_INDEX);
  await pickBoundaryPoint(page, "end", END_CLOSED_INDEX);
  await page.locator("#basicCreateFieldButton").click();
  await page.locator("#basicFieldRegConfirmButton").click();
  await expect(page.locator("#fieldAnnotationSummaryFields")).toHaveText("1");

  // 圃場レポート is owned by 設定 → 圃場データ. The button has to take the
  // farmer there: switching workspace alone would leave a data-mode="settings"
  // panel hidden, and the button would silently do nothing.
  const viewResults = page.locator("#basicViewResultsButton");
  await expect(viewResults).toBeEnabled();
  await viewResults.click();

  await expect(page.locator("body")).toHaveAttribute("data-mode", "settings");
  await expect(page.locator("body")).toHaveAttribute("data-workspace", "fields");
  const panel = page.locator("#fieldReportPanel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("圃場レポート: 田圃1");
  await expect(panel).toContainText("paddy-001");
});

test("registering 田圃1/2/3 adds no repeated workflow clutter", async ({ page }) => {
  await openBasic(page);
  for (const expectedName of ["田圃1", "田圃2", "田圃3"]) {
    await uploadWalk(page);
    await pickBoundaryPoint(page, "start", START_INDEX);
    await pickBoundaryPoint(page, "end", END_CLOSED_INDEX);
    await page.locator("#basicCreateFieldButton").click();
    await expect(page.locator("#basicFieldRegNameInput")).toHaveValue(expectedName);
    await page.locator("#basicFieldRegConfirmButton").click();
  }

  await expect(page.locator("#fieldAnnotationSummaryFields")).toHaveText("3");
  const ids = await page.evaluate(() => window.fieldAnnotationController.fields.map((field) => field.id));
  expect(ids).toEqual(["paddy-001", "paddy-002", "paddy-003"]);

  // One help control, one Stage-1 card, no per-field checklist — whatever the
  // field count.
  await expect(page.locator("#basicHelpButton")).toHaveCount(1);
  await expect(page.locator("#basicStage1Card")).toHaveCount(1);
  await expect(page.locator("#workflowGuidePanel")).toBeHidden();
  // The checklist is still built (Settings renders it); what matters is that
  // none of it reaches 基本モード, and that it does not grow per field.
  await expect(page.locator("#workflowStepsContainer")).toBeHidden();
  await expect(page.locator(".workflow-step:visible")).toHaveCount(0);
});

test("a second NMEA upload shows its own GNSS points, even though registering the first one hid them", async ({ page }) => {
  await openBasic(page);

  // Registering 田圃1 hides the QZ1 point layer (see onFieldRegistered in
  // index.html) so the map isn't cluttered with a track that is now a
  // polygon. That hide is global checkbox state, not scoped to those specific
  // points -- without the fix, it would silently also hide 田圃2's brand-new
  // upload, which the farmer needs to see to pick START/END for it.
  await uploadWalk(page);
  await pickBoundaryPoint(page, "start", START_INDEX);
  await pickBoundaryPoint(page, "end", END_CLOSED_INDEX);
  await page.locator("#basicCreateFieldButton").click();
  await page.locator("#basicFieldRegConfirmButton").click();
  await expect(page.locator("#fieldAnnotationSummaryFields")).toHaveText("1");
  await expect(page.locator("#showQz1Layer")).not.toBeChecked();

  await uploadWalk(page);
  await expect(page.locator("#showQz1Layer")).toBeChecked();
  await expect(page.locator(".qz1-point")).toHaveCount(11);
});

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

test("START/END markers and the candidate boundary survive a 地図 <-> 航空写真 switch", async ({ page }) => {
  await openBasic(page);
  await uploadWalk(page);
  await pickBoundaryPoint(page, "start", START_INDEX);
  await pickBoundaryPoint(page, "end", END_CLOSED_INDEX);

  const boundaryLines = () => page.evaluate(() => {
    let count = 0;
    window.map.eachLayer((layer) => {
      if (layer instanceof L.Polyline && !(layer instanceof L.Polygon)) count += 1;
    });
    return count;
  });
  const before = await boundaryLines();
  expect(before).toBeGreaterThanOrEqual(2); // walked segment + dashed closing segment

  await page.locator("#basemapAerialButton").click();
  await expect(page.locator("#basemapAerialButton")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".qz1-point--start")).toHaveCount(1);
  await expect(page.locator(".qz1-point--end")).toHaveCount(1);
  await expect(page.locator(".qz1-point")).toHaveCount(11);
  expect(await boundaryLines()).toBe(before);
  expect(await selectedRange(page)).toBe("5点（測位点4 〜 測位点8）");

  await page.locator("#basemapMapButton").click();
  await expect(page.locator(".qz1-point--start")).toHaveCount(1);
  await expect(page.locator(".qz1-point--end")).toHaveCount(1);
  expect(await boundaryLines()).toBe(before);
});

test("ordinary points stay readable over aerial imagery without being removed", async ({ page }) => {
  await openBasic(page);
  await uploadWalk(page);
  await pickBoundaryPoint(page, "start", START_INDEX);
  await pickBoundaryPoint(page, "end", END_CLOSED_INDEX);

  const styles = await page.evaluate(() => {
    // Leaflet draws circleMarkers as <path> arcs, so there is no `r`
    // attribute to read — the rendered box is the honest measure anyway.
    const read = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return { size: Math.max(box.width, box.height), fillOpacity: Number(el.getAttribute("fill-opacity")) };
    };
    return { start: read(".qz1-point--start"), inside: read(".qz1-point--inside"), outside: read(".qz1-point--outside") };
  });

  // START is a prominent pin; unselected track points are small and translucent
  // so the GSI aerial photo stays visible underneath.
  expect(styles.start.size).toBeGreaterThan(styles.inside.size);
  expect(styles.inside.size).toBeGreaterThan(styles.outside.size);
  expect(styles.outside.fillOpacity).toBeLessThan(0.5);
  expect(styles.inside.fillOpacity).toBeGreaterThan(styles.outside.fillOpacity);
  // Every measured fix is still drawn — nothing was thinned away.
  await expect(page.locator(".qz1-point")).toHaveCount(11);
});

// ---------------------------------------------------------------------------
// Mobile
// ---------------------------------------------------------------------------

for (const viewport of [{ width: 390, height: 844 }, { width: 393, height: 852 }]) {
  test(`the whole Stage-1 flow is reachable at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openBasic(page);
    await uploadWalk(page);
    await pickBoundaryPoint(page, "start", START_INDEX);
    await pickBoundaryPoint(page, "end", END_CLOSED_INDEX);
    await page.locator("#basicCreateFieldButton").click();
    await page.locator("#basicFieldRegConfirmButton").click();
    await expect(page.locator("#fieldAnnotationSummaryFields")).toHaveText("1");

    const layout = await page.evaluate(() => {
      const box = (selector) => {
        const el = document.querySelector(selector);
        return el ? el.getBoundingClientRect() : null;
      };
      return {
        noHorizontalScroll: document.documentElement.scrollWidth <= window.innerWidth,
        mapHeight: box("#map").height,
        help: box("#basicHelpButton").height,
        // On phones the NMEA upload lives in the header, immediately left of
        // 使い方, and the card's own button stands down -- so the touch
        // target to measure is the header one. Still asserted at >=44px.
        upload: box("#headerNmeaUploadButton").height,
        recordWater: box("#basicRecordWaterButton").height
      };
    });
    expect(layout.noHorizontalScroll).toBe(true);
    expect(layout.mapHeight).toBeGreaterThanOrEqual(300);
    expect(layout.help).toBeGreaterThanOrEqual(44);
    expect(layout.upload).toBeGreaterThanOrEqual(44);
    expect(layout.recordWater).toBeGreaterThanOrEqual(38);

    await page.locator("#basicRecordWaterButton").click();
    await expect(page.locator("#recObsWaterLevelInput")).toBeVisible();
  });
}
