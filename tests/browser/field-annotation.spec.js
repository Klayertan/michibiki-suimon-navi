import { test, expect } from "@playwright/test";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Valid GGA sentences (correct checksums) for a small square walked loop
// near the demo field. The last point is ~1m from the first, so this
// should auto-close into a field polygon.
const TIGHT_LOOP_NMEA = [
  "$GNGGA,120000.00,3439.2880,N,13549.7892,E,1,8,1.1,45.0,M,30.0,M,,*7A",
  "$GNGGA,120010.00,3439.2880,N,13549.8162,E,1,8,1.1,45.0,M,30.0,M,,*72",
  "$GNGGA,120020.00,3439.2664,N,13549.8162,E,1,8,1.1,45.0,M,30.0,M,,*75",
  "$GNGGA,120030.00,3439.2664,N,13549.7892,E,1,8,1.1,45.0,M,30.0,M,,*7D",
  "$GNGGA,120040.00,3439.2879,N,13549.7895,E,2,9,0.9,45.0,M,30.0,M,,*74"
].join("\r\n");

// Same walk, but stopping ~45m short of the start point — the user's real
// incomplete L-shaped walking track.
const OPEN_L_SHAPE_NMEA = [
  "$GNGGA,193852.00,3439.2880,N,13549.7892,E,1,8,1.1,45.0,M,30.0,M,,*7D",
  "$GNGGA,193902.00,3439.2880,N,13549.8162,E,1,8,1.1,45.0,M,30.0,M,,*70",
  "$GNGGA,193912.00,3439.2664,N,13549.8162,E,1,8,1.1,45.0,M,30.0,M,,*75"
].join("\r\n");

const REAL_DATA_MEMO = "2026/07/19 QZ1徒歩測量。圃場境界の一部を測定。次回、全周測量予定。";

// TIGHT_LOOP_NMEA plus enough padding (non-GGA, safely ignored by the
// parser) to push the raw file text past MAX_RAW_NMEA_STORAGE_BYTES
// (2,000,000 bytes) while keeping parsedPoints at exactly 5, so the upload
// still registers a valid field polygon quickly.
const PADDING_LINE = "NOOP padding line to inflate file size for the large-file storage test\r\n";
const OVERSIZED_NMEA = TIGHT_LOOP_NMEA + "\r\n" + PADDING_LINE.repeat(Math.ceil(2_100_000 / PADDING_LINE.length));

async function openSurveyWorkspace(page) {
  await page.goto("/#survey");
  await expect(page.locator("#fieldRegDialog")).toBeAttached({ timeout: 15_000 });
  await page.evaluate(() => {
    document.querySelectorAll("details[data-workspace='survey']").forEach((card) => { card.open = true; });
  });
}

async function uploadNmea(page, nmeaText, fileName = "walk.txt") {
  await page.locator("#fileInput").setInputFiles({
    name: fileName,
    mimeType: "text/plain",
    buffer: Buffer.from(nmeaText)
  });
}

test("uploading an NMEA file opens the registration dialog with sequential defaults", async ({ page }) => {
  await openSurveyWorkspace(page);
  await uploadNmea(page, TIGHT_LOOP_NMEA, "walk-1.txt");

  await expect(page.locator("#fieldRegDialog")).toBeVisible();
  await expect(page.locator("#fieldRegNameInput")).toHaveValue("圃場1");
  await expect(page.locator("#fieldRegIdInput")).toHaveValue("paddy-001");
  await expect(page.locator("#fieldRegSummary")).toContainText("有効な測位点: 5点");
  await expect(page.locator("#fieldRegTypePolygon")).toBeChecked();

  // Confirming creates a persistent survey session and a field polygon
  // (closed loop -> auto-close, no warning).
  await page.locator("#fieldRegConfirmButton").click();
  await expect(page.locator("#fieldRegCloseWarning")).toBeHidden();
  await expect(page.locator("#fieldAnnotationSummaryFields")).toHaveText("1");
  const state = await page.evaluate(() => ({
    sessionCount: window.fieldAnnotationController.surveySessions.length,
    fieldCount: window.fieldAnnotationController.fields.length,
    sessionMeasurementType: window.fieldAnnotationController.surveySessions[0]?.measurementType,
    fieldSourceSessionId: window.fieldAnnotationController.fields[0]?.sourceSessionId
  }));
  expect(state.sessionCount).toBe(1);
  expect(state.fieldCount).toBe(1);
  expect(state.sessionMeasurementType).toBe("field_polygon");
  expect(state.fieldSourceSessionId).toBeTruthy();

  // Uploading a second log offers 圃場2 / paddy-002.
  await uploadNmea(page, TIGHT_LOOP_NMEA, "walk-2.txt");
  await expect(page.locator("#fieldRegNameInput")).toHaveValue("圃場2");
  await expect(page.locator("#fieldRegIdInput")).toHaveValue("paddy-002");
});

test("an open path shows the exact upload warning; force-close creates a polygon", async ({ page }) => {
  await openSurveyWorkspace(page);
  await uploadNmea(page, OPEN_L_SHAPE_NMEA);
  await page.locator("#fieldRegConfirmButton").click();

  await expect(page.locator("#fieldRegCloseWarning")).toBeVisible();
  await expect(page.locator("#fieldRegCloseWarningText")).toContainText("始点と終点が離れています。このログを圃場ポリゴンとして閉じますか？");
  await expect(page.locator("#fieldAnnotationSummaryFields")).toHaveText("0");

  await page.locator("#fieldRegForceCloseButton").click();
  await expect(page.locator("#fieldAnnotationSummaryFields")).toHaveText("1");
  await expect(page.locator("#fieldRegDialog")).toBeHidden();
  const field = await page.evaluate(() => window.fieldAnnotationController.fields[0]);
  expect(field.properties.closedManually).toBe(true);
});

test("real incomplete L-shaped data saves as a boundary track without being rejected", async ({ page }) => {
  await openSurveyWorkspace(page);
  await uploadNmea(page, OPEN_L_SHAPE_NMEA, "Serial Bluetooth Terminal 20260719-193852.txt");
  await page.locator("#fieldRegMemoInput").fill(REAL_DATA_MEMO);
  await page.locator("#fieldRegTypeTrack").check();
  await page.locator("#fieldRegConfirmButton").click();

  // Choosing 境界トラックとして登録 skips the closure warning entirely — an
  // unclosed path must never be rejected on this path.
  await expect(page.locator("#fieldRegCloseWarning")).toBeHidden();
  await expect(page.locator("#fieldAnnotationSummaryTracks")).toHaveText("1");
  await expect(page.locator("#fieldAnnotationSummaryFields")).toHaveText("0");

  const track = await page.evaluate(() => window.fieldAnnotationController.boundaryTracks[0]);
  expect(track.name).toBe("圃場1 下見測定");
  expect(track.type).toBe("field_boundary_track");
  expect(track.geometryType).toBe("LineString");
  expect(track.fieldId).toBe("paddy-001");
  expect(track.properties.memo).toBe(REAL_DATA_MEMO);
  expect(track.properties.sourceFileName).toBe("Serial Bluetooth Terminal 20260719-193852.txt");
});

test("choosing to save as a track from the closure warning works for a polygon-intent upload", async ({ page }) => {
  await openSurveyWorkspace(page);
  await uploadNmea(page, OPEN_L_SHAPE_NMEA);
  await page.locator("#fieldRegConfirmButton").click();
  await expect(page.locator("#fieldRegCloseWarning")).toBeVisible();

  await page.locator("#fieldRegSaveAsTrackButton").click();
  await expect(page.locator("#fieldAnnotationSummaryTracks")).toHaveText("1");
  await expect(page.locator("#fieldAnnotationSummaryFields")).toHaveText("0");
  await expect(page.locator("#fieldRegDialog")).toBeHidden();
});

test("cancelling the closure warning discards the whole registration", async ({ page }) => {
  await openSurveyWorkspace(page);
  await uploadNmea(page, OPEN_L_SHAPE_NMEA);
  await page.locator("#fieldRegConfirmButton").click();
  await page.locator("#fieldRegCancelCloseButton").click();

  await expect(page.locator("#fieldRegCloseWarning")).toBeHidden();
  await expect(page.locator("#fieldRegDialog")).toBeHidden();
  const state = await page.evaluate(() => ({
    fields: window.fieldAnnotationController.fields.length,
    tracks: window.fieldAnnotationController.boundaryTracks.length,
    sessions: window.fieldAnnotationController.surveySessions.length
  }));
  expect(state).toEqual({ fields: 0, tracks: 0, sessions: 0 });
});

test("plain キャンセル on the registration dialog creates nothing", async ({ page }) => {
  await openSurveyWorkspace(page);
  await uploadNmea(page, TIGHT_LOOP_NMEA);
  await page.locator("#fieldRegCancelButton").click();
  await expect(page.locator("#fieldRegDialog")).toBeHidden();
  await expect(page.locator("#fieldAnnotationSummaryFields")).toHaveText("0");
});

test("registered fields are visible in QZ1測量, survive a tab switch, and survive a page reload", async ({ page }) => {
  await openSurveyWorkspace(page);
  await uploadNmea(page, TIGHT_LOOP_NMEA);
  await page.locator("#fieldRegConfirmButton").click();
  await expect(page.locator(".rec-recovery-card")).toHaveCount(1);
  await expect(page.locator("#registeredFieldsContainer")).toContainText("圃場1 / paddy-001");
  await expect(page.locator("#registeredFieldsContainer")).toContainText("圃場ポリゴン");

  // Tab switching never unmounts the controller or its map layers.
  await page.getByRole("button", { name: "詳細解析" }).click();
  const stillOnMap = await page.evaluate(() => window.map.hasLayer(window.fieldAnnotationController.layers.fields));
  expect(stillOnMap).toBe(true);
  await page.getByRole("button", { name: "QZ1測量" }).click();
  await expect(page.locator("#registeredFieldsContainer")).toContainText("圃場1 / paddy-001");

  // A full reload must restore state from localStorage.
  await page.reload();
  await expect(page.locator("#fieldRegDialog")).toBeAttached({ timeout: 15_000 });
  await page.evaluate(() => {
    document.querySelectorAll("details[data-workspace='survey']").forEach((card) => { card.open = true; });
  });
  await expect(page.locator("#fieldAnnotationSummaryFields")).toHaveText("1");
  await expect(page.locator("#registeredFieldsContainer")).toContainText("圃場1 / paddy-001");
});

test("editing name/ID/memo and deleting a field shows the exact confirmation and cascades", async ({ page }) => {
  await openSurveyWorkspace(page);
  await uploadNmea(page, TIGHT_LOOP_NMEA);
  await page.locator("#fieldRegConfirmButton").click();
  await expect(page.locator("#selFeatureForm")).toBeVisible();

  await page.locator("#selFeatureNameInput").fill("北田");
  await page.locator("#selFeatureIdInput").fill("paddy-kita");
  await page.locator("#selFeatureMemoInput").fill("編集テスト");
  await page.locator("#selFeatureSaveButton").click();
  await expect(page.locator("#selFeatureMessage")).toContainText("保存しました");
  await expect(page.locator("#registeredFieldsContainer")).toContainText("北田 / paddy-kita");

  let confirmMessage = null;
  page.once("dialog", (dialog) => {
    confirmMessage = dialog.message();
    dialog.accept();
  });
  await page.locator("#selFeatureDeleteButton").click();
  expect(confirmMessage).toBe("この圃場と関連する測量ログを削除しますか？");
  await expect(page.locator("#fieldAnnotationSummaryFields")).toHaveText("0");
  const sessionsLeft = await page.evaluate(() => window.fieldAnnotationController.surveySessions.length);
  expect(sessionsLeft).toBe(0);
});

test("水門・給水口・排水口 can each be added and linked to a specific field", async ({ page }) => {
  await openSurveyWorkspace(page);
  await uploadNmea(page, TIGHT_LOOP_NMEA);
  await page.locator("#fieldRegConfirmButton").click();
  await expect(page.locator("#fieldAnnotationSummaryFields")).toHaveText("1");

  await page.locator("#wcpTargetFieldSelect").selectOption("paddy-001");
  await expect(page.locator("#wcpAddGateButton")).toBeEnabled();

  for (const [button, label] of [
    ["#wcpAddGateButton", "水門"],
    ["#wcpAddInletButton", "給水口"],
    ["#wcpAddOutletButton", "排水口"]
  ]) {
    await page.locator(button).click();
    await expect(page.locator("#wcpPositionCurrentButton")).toBeEnabled();
    await page.locator("#wcpPositionCurrentButton").click();
    await expect(page.locator("#selFeatureMemoInput")).toBeVisible();
    const last = await page.evaluate(() => window.fieldAnnotationController.waterControlPoints.at(-1));
    expect(last.relatedFieldId).toBe("paddy-001");
    await expect(page.locator("#wcpAddMessage")).toContainText(label);
  }

  await expect(page.locator("#fieldAnnotationSummaryPoints")).toHaveText("3");
});

test("map-click placement works for 水位センサ and 撮影地点", async ({ page }) => {
  await openSurveyWorkspace(page);
  await uploadNmea(page, TIGHT_LOOP_NMEA);
  await page.locator("#fieldRegConfirmButton").click();
  await page.locator("#wcpTargetFieldSelect").selectOption("paddy-001");

  await page.locator("#wcpAddSensorButton").click();
  await page.locator("#wcpPositionMapClickButton").click();
  await expect(page.locator("#wcpPositionMapClickButton")).toHaveClass(/active/);
  await page.locator("#map").click({ position: { x: 300, y: 200 } });
  await expect(page.locator("#fieldAnnotationSummaryPoints")).toHaveText("1");
  const sensor = await page.evaluate(() => window.fieldAnnotationController.waterControlPoints[0]);
  expect(sensor.type).toBe("water_level_sensor");

  await page.locator("#wcpAddPhotoButton").click();
  await page.locator("#wcpPositionMapClickButton").click();
  await page.locator("#map").click({ position: { x: 320, y: 220 } });
  await expect(page.locator("#fieldAnnotationSummaryPoints")).toHaveText("2");
});

test("water-management buttons stay disabled until a field exists and a target is chosen", async ({ page }) => {
  await openSurveyWorkspace(page);
  await expect(page.locator("#wcpAddGateButton")).toBeDisabled();

  await uploadNmea(page, TIGHT_LOOP_NMEA);
  await page.locator("#fieldRegConfirmButton").click();
  // A field exists now, but no target field has been chosen yet.
  await expect(page.locator("#wcpAddGateButton")).toBeDisabled();
  await page.locator("#wcpTargetFieldSelect").selectOption("paddy-001");
  await expect(page.locator("#wcpAddGateButton")).toBeEnabled();
});

test("export JSON includes fields, boundaryTracks, waterControlPoints, surveySessions, measurements and metadata", async ({ page }) => {
  await openSurveyWorkspace(page);
  await uploadNmea(page, TIGHT_LOOP_NMEA);
  await page.locator("#fieldRegConfirmButton").click();
  await page.locator("#wcpTargetFieldSelect").selectOption("paddy-001");
  await page.locator("#wcpAddGateButton").click();
  await page.locator("#wcpPositionCurrentButton").click();

  await page.getByRole("button", { name: "詳細解析" }).click();
  await page.evaluate(() => {
    document.querySelectorAll("details[data-workspace='analysis']").forEach((card) => { card.open = true; });
  });
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#exportAnalysisButton").click();
  const download = await downloadPromise;
  const dir = await mkdtemp(path.join(tmpdir(), "field-annotation-v2-"));
  const exportPath = path.join(dir, "export.json");
  await download.saveAs(exportPath);
  const exported = JSON.parse(await readFile(exportPath, "utf8"));

  expect(exported.fields).toHaveLength(1);
  expect(exported.fields[0].id).toBe("paddy-001");
  expect(exported.fields[0].geometryType).toBe("Polygon");
  expect(exported.fields[0].properties.sourceFileName).toBe("walk.txt");
  expect(exported.fields[0].properties.fixQualitySummary.total).toBe(5);
  expect(Array.isArray(exported.boundaryTracks)).toBe(true);
  expect(exported.waterControlPoints).toHaveLength(1);
  expect(exported.waterControlPoints[0].type).toBe("water_gate");
  expect(exported.waterControlPoints[0].relatedFieldId).toBe("paddy-001");
  expect(exported.surveySessions).toHaveLength(1);
  expect(exported.surveySessions[0].rawPoints).toHaveLength(5);
  expect(exported.metadata.appName).toBe("スイスイナビ");
  expect(exported.metadata.exportedAt).toBeTruthy();
});

test("saving a duplicate ID in the feature editor is rejected without changing the existing record", async ({ page }) => {
  await openSurveyWorkspace(page);
  await uploadNmea(page, TIGHT_LOOP_NMEA, "a.txt");
  await page.locator("#fieldRegConfirmButton").click();
  await uploadNmea(page, TIGHT_LOOP_NMEA, "b.txt");
  await page.locator("#fieldRegConfirmButton").click();
  await expect(page.locator("#fieldAnnotationSummaryFields")).toHaveText("2");

  // The second field (圃場2/paddy-002) is currently selected.
  await page.locator("#selFeatureIdInput").fill("paddy-001");
  await page.locator("#selFeatureSaveButton").click();
  await expect(page.locator("#selFeatureMessage")).toContainText("既に使用されています");
  await expect(page.locator("#fieldAnnotationSummaryFields")).toHaveText("2");
});

test("雑草・害虫・病気・水不足・水が多すぎる observations can each be added and linked to a specific field", async ({ page }) => {
  await openSurveyWorkspace(page);
  await uploadNmea(page, TIGHT_LOOP_NMEA);
  await page.locator("#fieldRegConfirmButton").click();
  await expect(page.locator("#fieldAnnotationSummaryFields")).toHaveText("1");

  await page.locator("#obsTargetFieldSelect").selectOption("paddy-001");
  await expect(page.locator("#obsAddWeedButton")).toBeEnabled();

  for (const [button, type, label] of [
    ["#obsAddWeedButton", "weed", "雑草"],
    ["#obsAddInsectButton", "insect", "害虫"],
    ["#obsAddDiseaseButton", "disease", "病気"],
    ["#obsAddWaterShortageButton", "water_shortage", "水不足"],
    ["#obsAddExcessWaterButton", "excess_water", "水が多すぎる"]
  ]) {
    await page.locator(button).click();
    await expect(page.locator("#obsPositionQz1Button")).toBeEnabled();
    await page.locator("#obsPositionQz1Button").click();
    await expect(page.locator("#selFeatureMemoInput")).toBeVisible();
    const last = await page.evaluate(() => window.fieldAnnotationController.fieldObservations.at(-1));
    expect(last.fieldId).toBe("paddy-001");
    expect(last.type).toBe(type);
    expect(last.label).toBe(label);
    expect(last.properties.severity).toBe("medium");
    await expect(page.locator("#obsAddMessage")).toContainText(label);
  }

  await expect(page.locator("#fieldAnnotationSummaryObservations")).toHaveText("5");
});

test("map-click placement works for an observation, and スマホGPS位置を使用 uses the mocked browser geolocation", async ({ page, context }) => {
  await openSurveyWorkspace(page);
  await uploadNmea(page, TIGHT_LOOP_NMEA);
  await page.locator("#fieldRegConfirmButton").click();
  await page.locator("#obsTargetFieldSelect").selectOption("paddy-001");

  await page.locator("#obsAddLodgingButton").click();
  await page.locator("#obsPositionMapClickButton").click();
  await expect(page.locator("#obsPositionMapClickButton")).toHaveClass(/active/);
  await page.locator("#map").click({ position: { x: 300, y: 200 } });
  await expect(page.locator("#fieldAnnotationSummaryObservations")).toHaveText("1");
  const lodging = await page.evaluate(() => window.fieldAnnotationController.fieldObservations[0]);
  expect(lodging.type).toBe("lodging");

  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 34.6555, longitude: 135.8310 });
  await page.locator("#obsAddGateProblemButton").click();
  await page.locator("#obsPositionGpsButton").click();
  await expect(page.locator("#fieldAnnotationSummaryObservations")).toHaveText("2");
  const gateProblem = await page.evaluate(() => window.fieldAnnotationController.fieldObservations[1]);
  expect(gateProblem.type).toBe("gate_problem");
  expect(gateProblem.properties.sourceType).toBe("phone_gps");
  expect(gateProblem.coordinates[0]).toBeCloseTo(34.6555, 3);
  expect(gateProblem.coordinates[1]).toBeCloseTo(135.831, 3);
});

test("observation buttons stay disabled until a field exists and a target is chosen", async ({ page }) => {
  await openSurveyWorkspace(page);
  await expect(page.locator("#obsAddWeedButton")).toBeDisabled();

  await uploadNmea(page, TIGHT_LOOP_NMEA);
  await page.locator("#fieldRegConfirmButton").click();
  await expect(page.locator("#obsAddWeedButton")).toBeDisabled();
  await page.locator("#obsTargetFieldSelect").selectOption("paddy-001");
  await expect(page.locator("#obsAddWeedButton")).toBeEnabled();
});

test("editing an observation's title/severity/memo and deleting it shows the exact confirmation", async ({ page }) => {
  await openSurveyWorkspace(page);
  await uploadNmea(page, TIGHT_LOOP_NMEA);
  await page.locator("#fieldRegConfirmButton").click();
  await page.locator("#obsTargetFieldSelect").selectOption("paddy-001");
  await page.locator("#obsAddWeedButton").click();
  await page.locator("#obsPositionQz1Button").click();
  await expect(page.locator("#selFeatureForm")).toBeVisible();
  await expect(page.locator("#selFeatureObsTypeRow")).toBeVisible();
  await expect(page.locator("#selFeatureSeverityRow")).toBeVisible();
  await expect(page.locator("#selFeatureTypeRow")).toBeHidden();

  await page.locator("#selFeatureNameInput").fill("畦道の雑草");
  await page.locator("#selFeatureSeveritySelect").selectOption("urgent");
  await page.locator("#selFeatureMemoInput").fill("畦道側に雑草が多い");
  await page.locator("#selFeatureSaveButton").click();
  await expect(page.locator("#selFeatureMessage")).toContainText("保存しました");
  const saved = await page.evaluate(() => window.fieldAnnotationController.fieldObservations[0]);
  expect(saved.name).toBe("畦道の雑草");
  expect(saved.properties.severity).toBe("urgent");
  expect(saved.properties.memo).toBe("畦道側に雑草が多い");

  let confirmMessage = null;
  page.once("dialog", (dialog) => {
    confirmMessage = dialog.message();
    dialog.accept();
  });
  await page.locator("#selFeatureDeleteButton").click();
  expect(confirmMessage).toBe("畦道の雑草 を削除しますか？");
  await expect(page.locator("#fieldAnnotationSummaryObservations")).toHaveText("0");
});

test("observation markers persist after tab switching and after a page reload", async ({ page }) => {
  await openSurveyWorkspace(page);
  await uploadNmea(page, TIGHT_LOOP_NMEA);
  await page.locator("#fieldRegConfirmButton").click();
  await page.locator("#obsTargetFieldSelect").selectOption("paddy-001");
  await page.locator("#obsAddDiseaseButton").click();
  await page.locator("#obsPositionQz1Button").click();
  await expect(page.locator("#fieldAnnotationSummaryObservations")).toHaveText("1");

  await page.getByRole("button", { name: "詳細解析" }).click();
  const stillOnMap = await page.evaluate(() => window.map.hasLayer(window.fieldAnnotationController.layers.observations));
  expect(stillOnMap).toBe(true);
  await page.getByRole("button", { name: "QZ1測量" }).click();
  await expect(page.locator("#fieldAnnotationSummaryObservations")).toHaveText("1");

  await page.reload();
  await expect(page.locator("#fieldRegDialog")).toBeAttached({ timeout: 15_000 });
  await page.evaluate(() => {
    document.querySelectorAll("details[data-workspace='survey']").forEach((card) => { card.open = true; });
  });
  await expect(page.locator("#fieldAnnotationSummaryObservations")).toHaveText("1");
  const observation = await page.evaluate(() => window.fieldAnnotationController.fieldObservations[0]);
  expect(observation.type).toBe("disease");
});

test("export JSON includes fieldObservations with type/severity/memo/fieldId preserved", async ({ page }) => {
  await openSurveyWorkspace(page);
  await uploadNmea(page, TIGHT_LOOP_NMEA);
  await page.locator("#fieldRegConfirmButton").click();
  await page.locator("#obsTargetFieldSelect").selectOption("paddy-001");
  await page.locator("#obsAddWeedButton").click();
  await page.locator("#obsPositionQz1Button").click();
  await page.locator("#selFeatureSeveritySelect").selectOption("high");
  await page.locator("#selFeatureMemoInput").fill("畦道側に雑草が多い");
  await page.locator("#selFeatureSaveButton").click();

  await page.getByRole("button", { name: "詳細解析" }).click();
  await page.evaluate(() => {
    document.querySelectorAll("details[data-workspace='analysis']").forEach((card) => { card.open = true; });
  });
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#exportAnalysisButton").click();
  const download = await downloadPromise;
  const dir = await mkdtemp(path.join(tmpdir(), "field-annotation-obs-"));
  const exportPath = path.join(dir, "export.json");
  await download.saveAs(exportPath);
  const exported = JSON.parse(await readFile(exportPath, "utf8"));

  expect(exported.fieldObservations).toHaveLength(1);
  const obs = exported.fieldObservations[0];
  expect(obs.fieldId).toBe("paddy-001");
  expect(obs.type).toBe("weed");
  expect(obs.label).toBe("雑草");
  expect(obs.geometryType).toBe("Point");
  expect(obs.properties.severity).toBe("high");
  expect(obs.properties.memo).toBe("畦道側に雑草が多い");
  expect(obs.properties.createdAt).toBeTruthy();
  expect(exported.metadata.dataMode).toBe("real_user_data");
});

test("a small NMEA upload stores rawNmeaText, and the registered card shows 保存済み and the line count", async ({ page }) => {
  await openSurveyWorkspace(page);
  await uploadNmea(page, TIGHT_LOOP_NMEA, "walk.txt");
  await page.locator("#fieldRegConfirmButton").click();

  const session = await page.evaluate(() => window.fieldAnnotationController.surveySessions[0]);
  expect(session.rawNmeaStored).toBe(true);
  expect(session.rawNmeaText).toContain("$GNGGA,120000.00");
  expect(session.rawNmeaLineCount).toBe(5);
  expect(session.rawNmeaStorageReason).toBeNull();
  expect(session.uploadedAt).toBeTruthy();

  await expect(page.locator("#registeredFieldsContainer")).toContainText("元NMEA");
  await expect(page.locator("#registeredFieldsContainer")).toContainText("保存済み");
  await expect(page.locator("#registeredFieldsContainer")).toContainText("行数");
  await expect(page.locator("#registeredFieldsContainer")).toContainText("5");
  await expect(page.locator("button", { hasText: "元NMEAを書き出し" })).toBeVisible();
});

test("an oversized NMEA upload does not store rawNmeaText, shows the exact size warning, and the card shows 未保存（サイズ超過）", async ({ page }) => {
  await openSurveyWorkspace(page);
  await uploadNmea(page, OVERSIZED_NMEA, "big-walk.txt");
  await page.locator("#fieldRegConfirmButton").click({ timeout: 30_000 });

  const session = await page.evaluate(() => window.fieldAnnotationController.surveySessions[0]);
  expect(session.rawNmeaStored).toBe(false);
  expect(session.rawNmeaText).toBeNull();
  expect(session.rawNmeaStorageReason).toBe("size_limit");
  expect(session.rawNmeaLineCount).toBeGreaterThan(5);

  await expect(page.locator("#registeredListMessage")).toContainText(
    "NMEAログが大きいため、元ファイル全文は保存せず、解析済みデータのみ保存しました。"
  );
  await expect(page.locator("#registeredFieldsContainer")).toContainText("未保存（サイズ超過）");
  await expect(page.locator("button", { hasText: "元NMEAを書き出し" })).toHaveCount(0);
});

test("元NMEAを書き出し downloads the exact original NMEA text when it was stored", async ({ page }) => {
  await openSurveyWorkspace(page);
  await uploadNmea(page, TIGHT_LOOP_NMEA, "walk.txt");
  await page.locator("#fieldRegConfirmButton").click();

  const downloadPromise = page.waitForEvent("download");
  await page.locator("button", { hasText: "元NMEAを書き出し" }).click();
  const download = await downloadPromise;
  const dir = await mkdtemp(path.join(tmpdir(), "field-annotation-raw-nmea-"));
  const savedPath = path.join(dir, "raw.txt");
  await download.saveAs(savedPath);
  const savedText = await readFile(savedPath, "utf8");
  expect(savedText).toBe(TIGHT_LOOP_NMEA);
  expect(download.suggestedFilename()).toBe("walk.txt");
});

test("export JSON includes rawNmeaText for a stored session, and import restores it", async ({ page }) => {
  await openSurveyWorkspace(page);
  await uploadNmea(page, TIGHT_LOOP_NMEA, "walk.txt");
  await page.locator("#fieldRegConfirmButton").click();

  await page.getByRole("button", { name: "詳細解析" }).click();
  await page.evaluate(() => {
    document.querySelectorAll("details[data-workspace='analysis']").forEach((card) => { card.open = true; });
  });
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#exportAnalysisButton").click();
  const download = await downloadPromise;
  const dir = await mkdtemp(path.join(tmpdir(), "field-annotation-raw-nmea-export-"));
  const exportPath = path.join(dir, "export.json");
  await download.saveAs(exportPath);
  const exported = JSON.parse(await readFile(exportPath, "utf8"));

  expect(exported.surveySessions).toHaveLength(1);
  const exportedSession = exported.surveySessions[0];
  expect(exportedSession.rawNmeaText).toBe(TIGHT_LOOP_NMEA);
  expect(exportedSession.rawNmeaStored).toBe(true);
  expect(exportedSession.rawNmeaLineCount).toBe(5);

  // A fresh reload (empty localStorage) followed by re-importing the same
  // export file must restore rawNmeaText, not just the parsed points.
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "詳細解析" }).click();
  await page.evaluate(() => {
    document.querySelectorAll("details[data-workspace='analysis']").forEach((card) => { card.open = true; });
  });
  await page.locator("#paddyImportInput").setInputFiles(exportPath);
  const reimportedSession = await page.evaluate(() => window.fieldAnnotationController.surveySessions[0]);
  expect(reimportedSession.rawNmeaText).toBe(TIGHT_LOOP_NMEA);
  expect(reimportedSession.rawNmeaStored).toBe(true);
});

function workflowStep(page, id) {
  return page.locator(`.workflow-step:has(button[data-workflow-step="${id}"])`);
}

test("現地調査ワークフロー panel appears in QZ1測量 with 0/5 progress and step 1 as the next task on a fresh load", async ({ page }) => {
  await openSurveyWorkspace(page);
  await expect(page.locator("#workflowGuidePanel")).toBeVisible();
  await expect(page.locator("#workflowGuidePanel h2")).toHaveText("現地調査ワークフロー");
  await expect(page.locator("#workflowProgressLabel")).toHaveText("進捗: 0 / 5 完了");
  await expect(page.locator("#workflowNextTask")).toHaveText("次の作業: NMEAログをアップロードしてください。");
  await expect(page.locator(".workflow-step")).toHaveCount(5);
  await expect(workflowStep(page, 1)).toContainText("⬜");
  await expect(workflowStep(page, 5).locator("button")).toBeDisabled();
  await expect(workflowStep(page, 5)).toContainText("書き出す圃場データがありません。");
});

test("step 3 and step 4 buttons are disabled with 先に圃場を登録してください until a field exists", async ({ page }) => {
  await openSurveyWorkspace(page);
  await expect(workflowStep(page, 3).locator("button")).toBeDisabled();
  await expect(workflowStep(page, 3)).toContainText("先に圃場を登録してください。");
  await expect(workflowStep(page, 4).locator("button")).toBeDisabled();
  await expect(workflowStep(page, 4)).toContainText("先に圃場を登録してください。");
});

test("step 3 button opens and scrolls to 水管理ポイント once a field exists", async ({ page }) => {
  await openSurveyWorkspace(page);
  await uploadNmea(page, TIGHT_LOOP_NMEA);
  await page.locator("#fieldRegConfirmButton").click();

  await expect(workflowStep(page, 3).locator("button")).toBeEnabled();
  await workflowStep(page, 3).locator("button").click();
  await expect(page.locator("#waterControlPanel")).toHaveJSProperty("open", true);
  await expect(page.locator("#waterControlPanel")).toBeInViewport();
});

test("step 4 button opens and scrolls to 現地観察メモ once a field exists", async ({ page }) => {
  await openSurveyWorkspace(page);
  await uploadNmea(page, TIGHT_LOOP_NMEA);
  await page.locator("#fieldRegConfirmButton").click();

  await workflowStep(page, 4).locator("button").click();
  await expect(page.locator("#fieldObservationsPanel")).toHaveJSProperty("open", true);
  await expect(page.locator("#fieldObservationsPanel")).toBeInViewport();
});

test("uploading and registering a field marks steps 1-2 done, and the next task points at step 3", async ({ page }) => {
  await openSurveyWorkspace(page);
  await uploadNmea(page, TIGHT_LOOP_NMEA);
  await page.locator("#fieldRegConfirmButton").click();

  await expect(page.locator("#workflowProgressLabel")).toHaveText("進捗: 2 / 5 完了");
  await expect(page.locator("#workflowNextTask")).toHaveText("次の作業: 水門・給水口・排水口を登録してください。");
  await expect(workflowStep(page, 1)).toContainText("✅");
  await expect(workflowStep(page, 2)).toContainText("✅");
  await expect(workflowStep(page, 3)).toContainText("⬜");
});

test("adding a water-control point marks step 3 done, and adding an observation marks step 4 done", async ({ page }) => {
  await openSurveyWorkspace(page);
  await uploadNmea(page, TIGHT_LOOP_NMEA);
  await page.locator("#fieldRegConfirmButton").click();

  await page.locator("#wcpTargetFieldSelect").selectOption("paddy-001");
  await page.locator("#wcpAddGateButton").click();
  await page.locator("#wcpPositionCurrentButton").click();
  await expect(page.locator("#workflowProgressLabel")).toHaveText("進捗: 3 / 5 完了");
  await expect(workflowStep(page, 3)).toContainText("✅");
  await expect(page.locator("#workflowNextTask")).toHaveText("次の作業: 雑草・害虫・病気などの観察メモを記録してください。");

  await page.locator("#obsTargetFieldSelect").selectOption("paddy-001");
  await page.locator("#obsAddWeedButton").click();
  await page.locator("#obsPositionQz1Button").click();
  await page.locator("#selFeatureSaveButton").click();
  await expect(page.locator("#workflowProgressLabel")).toHaveText("進捗: 4 / 5 完了");
  await expect(workflowStep(page, 4)).toContainText("✅");
  await expect(page.locator("#workflowNextTask")).toHaveText("次の作業: 測量JSONを書き出してください。");
});

test("exporting marks step 5 done, shows the completion message, persists lastExportedAt, and the export JSON metadata carries workflow progress", async ({ page }) => {
  await openSurveyWorkspace(page);
  await uploadNmea(page, TIGHT_LOOP_NMEA);
  await page.locator("#fieldRegConfirmButton").click();
  await page.locator("#wcpTargetFieldSelect").selectOption("paddy-001");
  await page.locator("#wcpAddGateButton").click();
  await page.locator("#wcpPositionCurrentButton").click();
  await page.locator("#obsTargetFieldSelect").selectOption("paddy-001");
  await page.locator("#obsAddWeedButton").click();
  await page.locator("#obsPositionQz1Button").click();
  await page.locator("#selFeatureSaveButton").click();

  const downloadPromise = page.waitForEvent("download");
  await workflowStep(page, 5).locator("button").click(); // forwards to #exportAnalysisButton
  const download = await downloadPromise;
  const dir = await mkdtemp(path.join(tmpdir(), "field-annotation-workflow-"));
  const exportPath = path.join(dir, "export.json");
  await download.saveAs(exportPath);
  const exported = JSON.parse(await readFile(exportPath, "utf8"));
  expect(exported.metadata.workflowCompletedSteps).toBe(5);
  expect(exported.metadata.workflowLastExportedAt).toBeTruthy();

  await expect(page.locator("#workflowProgressLabel")).toHaveText("進捗: 5 / 5 完了");
  await expect(page.locator("#workflowNextTask")).toHaveText("現地調査ワークフローは完了しています。");
  await expect(workflowStep(page, 5)).toContainText("✅");

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("suimonNaviFieldAnnotationsV2")).workflowState);
  expect(stored.lastExportedAt).toBeTruthy();
});

test("the advanced manual card in 詳細解析 still works and offers the same three-way closure choice", async ({ page }) => {
  await openSurveyWorkspace(page);
  await uploadNmea(page, OPEN_L_SHAPE_NMEA);
  await page.locator("#fieldRegCancelButton").click();

  await page.getByRole("button", { name: "詳細解析" }).click();
  await page.evaluate(() => {
    document.querySelectorAll("details[data-workspace='analysis']").forEach((card) => { card.open = true; });
  });
  await page.locator("#fieldUseAllPointsCheckbox").check();
  await page.locator("#fieldCreateButton").click();
  await expect(page.locator("#fieldCloseWarning")).toBeVisible();
  await expect(page.locator("#fieldCloseForceCloseButton")).toBeVisible();
  await expect(page.locator("#fieldCloseSaveAsTrackButton")).toBeVisible();
  await expect(page.locator("#fieldCloseCancelButton")).toBeVisible();

  await page.locator("#fieldCloseSaveAsTrackButton").click();
  await expect(page.locator("#fieldAnnotationSummaryTracks")).toHaveText("1");
});
