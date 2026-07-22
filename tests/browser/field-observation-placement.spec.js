import { test, expect } from "@playwright/test";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Same tight square loop used by field-annotation.spec.js: registers as
// field "paddy-001", a closed polygon roughly spanning
// lat [34.654440, 34.654800] / lon [135.829820, 135.830270].
const TIGHT_LOOP_NMEA = [
  "$GNGGA,120000.00,3439.2880,N,13549.7892,E,1,8,1.1,45.0,M,30.0,M,,*7A",
  "$GNGGA,120010.00,3439.2880,N,13549.8162,E,1,8,1.1,45.0,M,30.0,M,,*72",
  "$GNGGA,120020.00,3439.2664,N,13549.8162,E,1,8,1.1,45.0,M,30.0,M,,*75",
  "$GNGGA,120030.00,3439.2664,N,13549.7892,E,1,8,1.1,45.0,M,30.0,M,,*7D",
  "$GNGGA,120040.00,3439.2879,N,13549.7895,E,2,9,0.9,45.0,M,30.0,M,,*74"
].join("\r\n");

const INSIDE_FIELD_LATLNG = { lat: 34.65462, lng: 135.83005 };
const OUTSIDE_FIELD_LATLNG = { lat: 34.7, lng: 135.9 };

async function openSurveyWorkspace(page) {
  await page.goto("/#survey");
  await expect(page.locator("#fieldRegDialog")).toBeAttached({ timeout: 15_000 });
  await page.evaluate(() => {
    document.querySelectorAll("details[data-workspace='survey']").forEach((card) => { card.open = true; });
  });
}

async function registerField(page) {
  await page.locator("#fileInput").setInputFiles({ name: "walk.txt", mimeType: "text/plain", buffer: Buffer.from(TIGHT_LOOP_NMEA) });
  await page.locator("#fieldRegConfirmButton").click();
}

function workflowStep(page, id) {
  return page.locator(`.workflow-step:has(button[data-workflow-step="${id}"])`);
}

async function mapClick(page, latlng) {
  await page.evaluate((point) => {
    window.fieldAnnotationController.handleMapClick({ latlng: point });
  }, latlng);
}

test("Step 4 quick-start enters observation placement mode with a crosshair cursor and instruction, and clicking the button again exits cleanly", async ({ page }) => {
  await openSurveyWorkspace(page);
  await registerField(page);

  const step4Button = workflowStep(page, 4).locator("button");
  await expect(step4Button).toHaveText("地図上に観察メモを追加");
  await step4Button.click();

  await expect(page.locator("#fieldObservationsPanel")).toHaveJSProperty("open", true);
  await expect(page.locator("#map")).toHaveClass(/map-click-armed/);
  await expect(page.locator("#obsAddMessage")).toHaveText("地図上の観察位置をクリックしてください");
  await expect(step4Button).toHaveText("地図クリックをキャンセル");

  await step4Button.click();
  await expect(page.locator("#map")).not.toHaveClass(/map-click-armed/);
  await expect(page.locator("#obsAddMessage")).toHaveText("");
  await expect(step4Button).toHaveText("地図上に観察メモを追加");
});

test("pressing Escape exits observation placement mode cleanly", async ({ page }) => {
  await openSurveyWorkspace(page);
  await registerField(page);

  await workflowStep(page, 4).locator("button").click();
  await expect(page.locator("#map")).toHaveClass(/map-click-armed/);

  await page.keyboard.press("Escape");
  await expect(page.locator("#map")).not.toHaveClass(/map-click-armed/);
  await expect(workflowStep(page, 4).locator("button")).toHaveText("地図上に観察メモを追加");
});

test("clicking the map while armed saves an observation via the shared editor, and Step 4 is not marked done merely by opening placement mode", async ({ page }) => {
  await openSurveyWorkspace(page);
  await registerField(page);

  await expect(page.locator("#workflowProgressLabel")).toHaveText("進捗: 2 / 5 完了");
  await workflowStep(page, 4).locator("button").click();
  // Placement mode is now armed but nothing has been clicked yet.
  await expect(workflowStep(page, 4)).toContainText("⬜");
  await expect(page.locator("#workflowProgressLabel")).toHaveText("進捗: 2 / 5 完了");

  await mapClick(page, INSIDE_FIELD_LATLNG);

  await expect(page.locator("#fieldAnnotationSummaryObservations")).toHaveText("1");
  await expect(page.locator("#map")).not.toHaveClass(/map-click-armed/);
  await expect(page.locator("#selFeatureForm")).toBeVisible();
  await expect(page.locator("#selFeatureObsTypeSelect")).toBeVisible();

  const observation = await page.evaluate(() => window.fieldAnnotationController.fieldObservations[0]);
  expect(observation.fieldId).toBe("paddy-001");
  expect(observation.type).toBe("note");
  expect(observation.properties.sourceType).toBe("manual_map_click");
  expect(observation.coordinates[0]).toBeCloseTo(INSIDE_FIELD_LATLNG.lat, 4);
  expect(observation.coordinates[1]).toBeCloseTo(INSIDE_FIELD_LATLNG.lng, 4);

  // Refine type/severity/memo in the editor the click already opened.
  await page.locator("#selFeatureObsTypeSelect").selectOption("weed");
  await page.locator("#selFeatureSeveritySelect").selectOption("high");
  await page.locator("#selFeatureMemoInput").fill("畦道沿いに雑草");
  await page.locator("#selFeatureSaveButton").click();

  await expect(page.locator("#workflowProgressLabel")).toHaveText("進捗: 3 / 5 完了");
  await expect(workflowStep(page, 4)).toContainText("✅");
});

test("clicking outside the active field's boundary warns and lets the user continue anyway", async ({ page }) => {
  await openSurveyWorkspace(page);
  await registerField(page);
  await workflowStep(page, 4).locator("button").click();

  await mapClick(page, OUTSIDE_FIELD_LATLNG);

  await expect(page.locator("#obsOutsideFieldWarning")).toBeVisible();
  await expect(page.locator("#obsOutsideFieldWarningText")).toHaveText(
    "選択した地点は圃場の範囲外です。このまま記録しますか？"
  );
  await expect(page.locator("#fieldAnnotationSummaryObservations")).toHaveText("0");

  await page.locator("#obsOutsideFieldContinueButton").click();
  await expect(page.locator("#obsOutsideFieldWarning")).toBeHidden();
  await expect(page.locator("#fieldAnnotationSummaryObservations")).toHaveText("1");
  const observation = await page.evaluate(() => window.fieldAnnotationController.fieldObservations[0]);
  expect(observation.coordinates[0]).toBeCloseTo(OUTSIDE_FIELD_LATLNG.lat, 4);
  expect(observation.coordinates[1]).toBeCloseTo(OUTSIDE_FIELD_LATLNG.lng, 4);
});

test("cancelling the outside-field warning discards the point and exits placement mode without creating anything", async ({ page }) => {
  await openSurveyWorkspace(page);
  await registerField(page);
  await workflowStep(page, 4).locator("button").click();

  await mapClick(page, OUTSIDE_FIELD_LATLNG);
  await expect(page.locator("#obsOutsideFieldWarning")).toBeVisible();

  await page.locator("#obsOutsideFieldCancelButton").click();
  await expect(page.locator("#obsOutsideFieldWarning")).toBeHidden();
  await expect(page.locator("#fieldAnnotationSummaryObservations")).toHaveText("0");
  await expect(page.locator("#map")).not.toHaveClass(/map-click-armed/);
});

test("a point inside the field boundary never triggers the outside-field warning", async ({ page }) => {
  await openSurveyWorkspace(page);
  await registerField(page);
  await workflowStep(page, 4).locator("button").click();

  await mapClick(page, INSIDE_FIELD_LATLNG);
  await expect(page.locator("#obsOutsideFieldWarning")).toBeHidden();
  await expect(page.locator("#fieldAnnotationSummaryObservations")).toHaveText("1");
});

test("entering observation placement mode cancels an already-active water-management-point placement mode", async ({ page }) => {
  await openSurveyWorkspace(page);
  await registerField(page);

  await page.locator("#wcpTargetFieldSelect").selectOption("paddy-001");
  await page.locator("#wcpAddGateButton").click();
  await page.locator("#wcpPositionMapClickButton").click();
  await expect(page.locator("#wcpPositionMapClickButton")).toHaveClass(/active/);

  await workflowStep(page, 4).locator("button").click();
  await expect(page.locator("#wcpPositionMapClickButton")).not.toHaveClass(/active/);
  const state = await page.evaluate(() => ({
    water: window.fieldAnnotationController.mapClickAddActive,
    observation: window.fieldAnnotationController.mapClickAddActiveObservation
  }));
  expect(state.water).toBe(false);
  expect(state.observation).toBe(true);

  // The click now creates an observation, not a water-control point.
  await mapClick(page, INSIDE_FIELD_LATLNG);
  await expect(page.locator("#fieldAnnotationSummaryObservations")).toHaveText("1");
  await expect(page.locator("#fieldAnnotationSummaryPoints")).toHaveText("0");
});

test("entering observation placement mode cancels an active paddy-intelligence drawing mode", async ({ page }) => {
  await openSurveyWorkspace(page);
  await registerField(page);

  await page.evaluate(() => {
    window.paddyIntelligence.drawing = { mode: "noFlyZone", points: [[34.6546, 135.8300]] };
  });

  await workflowStep(page, 4).locator("button").click();

  const drawing = await page.evaluate(() => window.paddyIntelligence.drawing);
  expect(drawing).toBeNull();
});

test("no duplicate map click handlers accumulate — toggling placement mode repeatedly still creates exactly one observation per click", async ({ page }) => {
  await openSurveyWorkspace(page);
  await registerField(page);

  const step4Button = workflowStep(page, 4).locator("button");
  await step4Button.click(); // on
  await step4Button.click(); // off
  await step4Button.click(); // on
  await step4Button.click(); // off
  await step4Button.click(); // on

  await mapClick(page, INSIDE_FIELD_LATLNG);
  await expect(page.locator("#fieldAnnotationSummaryObservations")).toHaveText("1");
});

test("manually placed observations export with 手動配置 provenance and round-trip through JSON import", async ({ page }) => {
  await openSurveyWorkspace(page);
  await registerField(page);
  await workflowStep(page, 4).locator("button").click();
  await mapClick(page, INSIDE_FIELD_LATLNG);
  await page.locator("#selFeatureObsTypeSelect").selectOption("insect");
  await page.locator("#selFeatureSaveButton").click();

  await page.getByRole("button", { name: "詳細解析" }).click();
  await page.evaluate(() => {
    document.querySelectorAll("details[data-workspace='analysis']").forEach((card) => { card.open = true; });
  });
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#exportAnalysisButton").click();
  const download = await downloadPromise;
  const dir = await mkdtemp(path.join(tmpdir(), "field-observation-placement-"));
  const exportPath = path.join(dir, "export.json");
  await download.saveAs(exportPath);
  const exported = JSON.parse(await readFile(exportPath, "utf8"));

  expect(exported.fieldObservations).toHaveLength(1);
  const obs = exported.fieldObservations[0];
  expect(obs.properties.sourceType).toBe("manual_map_click");
  expect(obs.fieldId).toBe("paddy-001");

  // Fresh page, import the same export back, and it must reappear unchanged.
  await openSurveyWorkspace(page);
  await page.locator("#importInput").setInputFiles({ name: "import.json", mimeType: "application/json", buffer: await readFile(exportPath) });
  await expect(page.locator("#fieldAnnotationSummaryObservations")).toHaveText("1");
  const reimported = await page.evaluate(() => window.fieldAnnotationController.fieldObservations[0]);
  expect(reimported.properties.sourceType).toBe("manual_map_click");
  expect(reimported.fieldId).toBe("paddy-001");
});

test("field report shows 手動配置 as the observation's source, agreeing with the map popup", async ({ page }) => {
  await openSurveyWorkspace(page);
  await registerField(page);
  await workflowStep(page, 4).locator("button").click();
  await mapClick(page, INSIDE_FIELD_LATLNG);
  await page.locator("#selFeatureSaveButton").click();

  await page.getByRole("button", { name: "詳細解析" }).click();
  await page.evaluate(() => {
    document.querySelectorAll("details[data-workspace='analysis']").forEach((card) => { card.open = true; });
  });
  await page.locator("#reportFieldSelect").selectOption("paddy-001");
  await page.locator("#reportGenerateButton").click();
  await expect(page.locator("#reportPreview")).toContainText("手動配置");
});
