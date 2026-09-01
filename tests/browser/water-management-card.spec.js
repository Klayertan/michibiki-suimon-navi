import { test, expect } from "@playwright/test";

// 水管理 / Water Management card: the evidence-based, growth-stage-driven
// water recommendation for the selected registered field.
//
// What this file is protecting, beyond "the card renders":
//   - area never changes the target depth (the central scientific claim);
//   - the drainage stages never produce a fill-to-X volume;
//   - a missing stage / missing measurement asks, rather than fabricating;
//   - the mm card and the pre-existing cm input are two views of ONE stored
//     value, and a field saved in the old cm-only shape still loads.
// The arithmetic itself is unit-tested in tests/unit/water-recommendation.test.js.

function gga(time, lat, lon, fix = 1, sats = 8, hdop = "1.1") {
  const body = `GNGGA,${time},${lat},N,${lon},E,${fix},${sats},${hdop},45.0,M,30.0,M,,`;
  let checksum = 0;
  for (const character of body) {
    checksum ^= character.charCodeAt(0);
  }
  return `$${body}*${checksum.toString(16).toUpperCase().padStart(2, "0")}`;
}

/**
 * `scale` widens/narrows the walked perimeter without changing its shape, so a
 * test can register two paddies of genuinely different AREA -- shifting the
 * base coordinate alone would move the field but keep its size, which is
 * precisely the distinction the area-vs-depth test exists to prove.
 */
function walkNmea({ latBase = "3439.2880", lonBase = "13549.7892", timePrefix = "12", scale = 1 } = {}) {
  const lat = parseFloat(latBase);
  const lon = parseFloat(lonBase);
  const shift = (v, d) => (v + d * scale).toFixed(4);
  return [
    gga(`${timePrefix}0000.00`, shift(lat, -0.02), shift(lon, -0.01)),
    gga(`${timePrefix}0010.00`, shift(lat, -0.01), shift(lon, -0.005)),
    gga(`${timePrefix}0020.00`, latBase, lonBase),
    gga(`${timePrefix}0030.00`, shift(lat, 0.008), shift(lon, 0.005)),
    gga(`${timePrefix}0040.00`, shift(lat, 0.008), shift(lon, 0.032)),
    gga(`${timePrefix}0050.00`, shift(lat, -0.021), shift(lon, 0.032)),
    gga(`${timePrefix}0100.00`, shift(lat, -0.021), shift(lon, 0.005)),
    gga(`${timePrefix}0110.00`, shift(lat, 0.0079), shift(lon, 0.0053), 2, 9, "0.9"),
    gga(`${timePrefix}0120.00`, shift(lat, -0.05), shift(lon, -0.02)),
    gga(`${timePrefix}0130.00`, shift(lat, -0.06), shift(lon, -0.03))
  ].join("\r\n");
}

const START_INDEX = 3;
const END_INDEX = 7;

function mockOpenMeteoResponse() {
  const hours = [];
  const precip = [];
  const prob = [];
  const start = new Date("2026-08-10T00:00:00Z");
  for (let h = 0; h < 24 * 11; h += 1) {
    hours.push(new Date(start.getTime() + h * 3600000).toISOString().slice(0, 13) + ":00");
    precip.push(0);
    prob.push(5);
  }
  return { hourly: { time: hours, precipitation: precip, precipitation_probability: prob } };
}

async function openBasic(page) {
  await page.route("**/api.open-meteo.com/**", (route) => {
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockOpenMeteoResponse()) });
  });
  await page.goto("/");
  await expect(page.locator("body")).toHaveAttribute("data-mode", "basic");
}

async function registerField(page, name, walkOptions) {
  await page.locator("#basicNmeaInput").setInputFiles({
    name: `${name}.txt`,
    mimeType: "text/plain",
    buffer: Buffer.from(walkNmea(walkOptions))
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

/**
 * Selects a registered field by name through the app's ONE active-field
 * selector. Registering a second field deliberately does not steal the active
 * field (renderFieldTargetOptions only auto-selects a lone field), so tests
 * that work across two paddies switch explicitly, exactly as a farmer does.
 */
async function selectFieldByName(page, name) {
  const select = page.locator("#basicActiveFieldSelect");
  const value = await select.evaluate((element, fieldName) => {
    const option = [...element.options].find((candidate) => candidate.textContent.startsWith(`${fieldName}（`));
    return option ? option.value : "";
  }, name);
  expect(value).not.toBe("");
  await select.selectOption(value);
  return value;
}

/** The registered field's measured area, read from the app's own summary. */
async function readAreaM2(page) {
  const areaText = await page.locator("#basicFieldArea").textContent();
  return Number(areaText.match(/([\d,]+)\s*m²/)[1].replace(/,/g, ""));
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

test("with no fields the card asks for a field and shows no numbers", async ({ page }) => {
  await openBasic(page);
  await expect(page.locator("#waterMgmtEmptyState")).toContainText("圃場を登録すると");
  await expect(page.locator("#waterMgmtContent")).toBeHidden();
});

// ---------------------------------------------------------------------------
// Unknown stage / missing measurement
// ---------------------------------------------------------------------------

test("a newly registered field gets a calendar-estimated stage, clearly marked as an estimate", async ({ page }) => {
  await openBasic(page);
  await registerField(page, "圃場1");

  await expect(page.locator("#waterMgmtContent")).toBeVisible();

  // The stage is now pre-filled from the regional cultivation calendar rather
  // than left blank, so the card can recommend a depth without the farmer
  // picking from an empty dropdown first. It must NEVER be presented as an
  // observation, so the estimate note is visible and says 推定.
  await expect(page.locator("#waterMgmtStageSelect")).not.toHaveValue("unknown");
  await expect(page.locator("#waterMgmtStageEstimateNote")).toBeVisible();
  await expect(page.locator("#waterMgmtStageEstimateNote")).toContainText("推定");

  // No measurement yet, so no deficit volume is invented -- only the per-10mm
  // conversion rate, which needs the area alone.
  await expect(page.locator("#waterMgmtVolumeBlock")).toBeHidden();
  await expect(page.locator("#waterMgmtRateBlock")).toBeVisible();
  await expect(page.locator("#waterMgmtRateBlock")).toContainText("水深10mmあたり");

  // The measured area is still shown -- it is a fact about the field.
  await expect(page.locator("#waterMgmtArea")).toContainText("m²");
});

test("a manually chosen stage overrides the calendar and drops the 推定 marker", async ({ page }) => {
  await openBasic(page);
  await registerField(page, "圃場1");
  await expect(page.locator("#waterMgmtStageEstimateNote")).toBeVisible();

  await page.locator("#waterMgmtStageSelect").selectOption("tillering");
  await expect(page.locator("#waterMgmtStageEstimateNote")).toBeHidden();
  await expect(page.locator("#waterMgmtStageSelect")).toHaveValue("tillering");

  // And it survives a reload: a farmer's correction must not be silently
  // reverted by the next calendar evaluation.
  await page.reload();
  await expect(page.locator("#waterMgmtStageSelect")).toHaveValue("tillering");
  await expect(page.locator("#waterMgmtStageEstimateNote")).toBeHidden();
});

test("選択した中干し flips the gate verdict to 閉める, so the two cards never contradict", async ({ page }) => {
  await openBasic(page);
  await registerField(page, "圃場1");

  await page.locator("#waterMgmtStageSelect").selectOption("midseason_drainage");

  // The regression this guards: the old rainfall-only gate said 開ける during
  // 中干し after a few dry days -- telling the farmer to flood a paddy that is
  // deliberately being dried.
  await expect(page.locator(".gate-card .verdict")).toContainText("閉める");
  await expect(page.locator("#verdictReason")).toContainText("中干し");
  await expect(page.locator("#waterMgmtVolumeBlock")).toBeHidden();
});

test("stage chosen but nothing measured -> the range is shown, no volume is invented", async ({ page }) => {
  await openBasic(page);
  await registerField(page, "圃場1");
  await page.locator("#waterMgmtStageSelect").selectOption("tillering");

  await expect(page.locator("#waterMgmtTarget")).toHaveText("25〜35 mm");
  await expect(page.locator("#waterMgmtMode")).toContainText("浅水管理");
  await expect(page.locator("#waterMgmtStatus")).toHaveText("水位未記録");
  await expect(page.locator("#waterMgmtDepthReadout")).toContainText("まだ計測されていません");
  await expect(page.locator("#waterMgmtVolumeBlock")).toBeHidden();
});

// ---------------------------------------------------------------------------
// The core calculation, end to end through the UI
// ---------------------------------------------------------------------------

test("below the range: deficit in mm and the theoretical volume from the field's own area", async ({ page }) => {
  await openBasic(page);
  await registerField(page, "圃場1");
  const areaM2 = await readAreaM2(page);

  await page.locator("#waterMgmtStageSelect").selectOption("after_transplanting"); // 30-50mm
  await page.locator("#waterMgmtDepthInput").fill("18");

  await expect(page.locator("#waterMgmtStatus")).toHaveText("参考範囲より 12〜32 mm 低い");
  await expect(page.locator("#waterMgmtDepthReadout")).toContainText("18 mm (1.8 cm)");
  await expect(page.locator("#waterMgmtDepthReadout")).toContainText("手入力");

  // area x depth, computed here independently of the app.
  const minM3 = (areaM2 * 12) / 1000;
  const maxM3 = (areaM2 * 32) / 1000;
  const fmt = (v) => Number(v.toFixed(1)).toLocaleString("ja-JP", { maximumFractionDigits: 1 });
  await expect(page.locator("#waterMgmtVolumeBlock")).toBeVisible();
  await expect(page.locator("#waterMgmtVolumeM3")).toHaveText(`${fmt(minM3)}〜${fmt(maxM3)} m³`);
  await expect(page.locator("#waterMgmtVolumeLiters")).toContainText("L");
  await expect(page.locator("#waterMgmtVolumeDirection")).toContainText("実際の必要用水量とは異なります");
});

test("area changes the volume but never the target depth", async ({ page }) => {
  await openBasic(page);
  await registerField(page, "圃場1");
  await page.locator("#waterMgmtStageSelect").selectOption("tillering");
  await page.locator("#waterMgmtDepthInput").fill("10");
  const firstTarget = await page.locator("#waterMgmtTarget").textContent();
  const firstVolume = await page.locator("#waterMgmtVolumeM3").textContent();

  // A visibly larger paddy, same stage, same measured depth.
  await registerField(page, "圃場2", { latBase: "3439.1880", lonBase: "13549.5892", timePrefix: "13", scale: 2 });
  await selectFieldByName(page, "圃場2");
  await page.locator("#waterMgmtStageSelect").selectOption("tillering");
  await page.locator("#waterMgmtDepthInput").fill("10");

  await expect(page.locator("#waterMgmtTarget")).toHaveText(firstTarget);
  await expect(page.locator("#waterMgmtStatus")).toHaveText("参考範囲より 15〜25 mm 低い");
  expect(await page.locator("#waterMgmtVolumeM3").textContent()).not.toBe(firstVolume);
});

test("within the range: no additional water, and no volume block", async ({ page }) => {
  await openBasic(page);
  await registerField(page, "圃場1");
  await page.locator("#waterMgmtStageSelect").selectOption("after_transplanting");
  await page.locator("#waterMgmtDepthInput").fill("40");

  await expect(page.locator("#waterMgmtStatus")).toHaveText("参考範囲内");
  await expect(page.locator("#waterMgmtRecommendation")).toContainText("現在の水位は推奨範囲内です。");
  await expect(page.locator("#waterMgmtVolumeBlock")).toBeHidden();
});

test("above the range: the excess is shown, but no drainage is ordered", async ({ page }) => {
  await openBasic(page);
  await registerField(page, "圃場1");
  await page.locator("#waterMgmtStageSelect").selectOption("after_transplanting");
  await page.locator("#waterMgmtDepthInput").fill("65");

  await expect(page.locator("#waterMgmtStatus")).toHaveText("参考範囲より 15 mm 高い");
  await expect(page.locator("#waterMgmtRecommendation")).toContainText("入水は不要");
  await expect(page.locator("#waterMgmtRecommendation")).toContainText("人が判断");
  await expect(page.locator("#waterMgmtVolumeDirection")).toContainText("落水の指示ではありません");
});

// ---------------------------------------------------------------------------
// Drainage stages
// ---------------------------------------------------------------------------

test("中干し shows the management state and refuses to compute a fill volume", async ({ page }) => {
  await openBasic(page);
  await registerField(page, "圃場1");
  await page.locator("#waterMgmtDepthInput").fill("5");
  await page.locator("#waterMgmtStageSelect").selectOption("midseason_drainage");

  await expect(page.locator("#waterMgmtTarget")).toHaveText("数値目標なし");
  await expect(page.locator("#waterMgmtMode")).toHaveText("落水・干し");
  await expect(page.locator("#waterMgmtStatus")).toHaveText("落水・干し期間");
  await expect(page.locator("#waterMgmtRecommendation")).toContainText("入水量の推奨は行いません");
  await expect(page.locator("#waterMgmtVolumeBlock")).toBeHidden();
  // The reference-target bridge is meaningless without a numeric range.
  await expect(page.locator("#waterMgmtApplyTargetButton")).toBeHidden();
});

// ---------------------------------------------------------------------------
// Evidence / provenance
// ---------------------------------------------------------------------------

test("every recommendation carries organization, URL, support and caveat", async ({ page }) => {
  await openBasic(page);
  await registerField(page, "圃場1");
  await page.locator("#waterMgmtStageSelect").selectOption("tillering");

  const evidence = page.locator("#waterMgmtEvidence");
  await evidence.locator("summary").click();
  const sources = evidence.locator(".water-mgmt-source");
  await expect(sources.first().locator(".water-mgmt-source-org")).toContainText("農研機構");
  await expect(evidence).toContainText("agrimet.tarc.naro.go.jp");
  await expect(evidence).toContainText("この根拠が支持する内容");
  await expect(evidence).toContainText("留意点");
  // The research水量 range is shown as research evidence, not as a default.
  await expect(page.locator("#waterMgmtRequirementNote")).toContainText("11");
  await expect(page.locator("#waterMgmtRequirementNote")).toContainText("17.5");
  await expect(page.locator("#waterMgmtCaveat")).toContainText("浸透");
  // The low-temperature alternative is declared, not silently applied.
  await expect(page.locator("#waterMgmtConditional")).toContainText("低温");
});

// ---------------------------------------------------------------------------
// One shared value, and persistence
// ---------------------------------------------------------------------------

test("the mm card and the cm input are two views of one stored measurement", async ({ page }) => {
  await openBasic(page);
  await registerField(page, "圃場1");
  await page.locator("#waterMgmtStageSelect").selectOption("tillering");
  await page.locator("#waterMgmtDepthInput").fill("35");

  await expect(page.locator("#recObsWaterLevelInput")).toHaveValue("3.5");

  // ...and back the other way. #recObsWaterLevelInput lives inside
  // #basicWaterRecordCard, which is no longer permanently visible on
  // desktop -- open it first (see that card's own CSS comment).
  await page.locator("#basicRecordWaterButton").click();
  await expect(page.locator("#recObsWaterLevelInput")).toBeVisible();
  await page.locator("#recObsWaterLevelInput").fill("1.8");
  await expect(page.locator("#waterMgmtDepthInput")).toHaveValue("18");
  await expect(page.locator("#waterMgmtStatus")).toHaveText("参考範囲より 7〜17 mm 低い");
});

test("stage and measurement survive a reload", async ({ page }) => {
  await openBasic(page);
  await registerField(page, "圃場1");
  await page.locator("#waterMgmtStageSelect").selectOption("tillering");
  await page.locator("#waterMgmtDepthInput").fill("18");
  await page.locator("#waterMgmtUpdateButton").click();

  await page.reload();

  await expect(page.locator("#waterMgmtStageSelect")).toHaveValue("tillering");
  await expect(page.locator("#waterMgmtDepthInput")).toHaveValue("18");
  await expect(page.locator("#waterMgmtStatus")).toHaveText("参考範囲より 7〜17 mm 低い");
});

test("a field saved in the old cm-only shape still loads and is recommended on", async ({ page }) => {
  await openBasic(page);
  await registerField(page, "圃場1");
  const fieldId = await page.locator("#basicActiveFieldSelect").inputValue();

  // Exactly what this app persisted before the 水管理 card existed: cm only,
  // no valueMm, no source, no measuredAt.
  await page.evaluate((id) => {
    const key = "suimonNaviCurrentWaterLevelV1";
    const all = JSON.parse(localStorage.getItem(key) || "{}");
    all[id] = { valueCm: 1.8, recordedAt: Date.now() };
    localStorage.setItem(key, JSON.stringify(all));
  }, fieldId);
  await page.reload();

  await page.locator("#waterMgmtStageSelect").selectOption("tillering");
  await expect(page.locator("#waterMgmtDepthInput")).toHaveValue("18");
  await expect(page.locator("#waterMgmtDepthReadout")).toContainText("18 mm (1.8 cm)");
  await expect(page.locator("#waterMgmtStatus")).toHaveText("参考範囲より 7〜17 mm 低い");
});

test("a stale reading is flagged rather than trusted", async ({ page }) => {
  await openBasic(page);
  await registerField(page, "圃場1");
  await page.locator("#waterMgmtStageSelect").selectOption("tillering");
  await page.locator("#waterMgmtDepthInput").fill("18");
  const fieldId = await page.locator("#basicActiveFieldSelect").inputValue();

  await page.evaluate((id) => {
    const key = "suimonNaviCurrentWaterLevelV1";
    const all = JSON.parse(localStorage.getItem(key) || "{}");
    all[id] = { ...all[id], recordedAt: Date.now() - 4 * 86400000, measuredAt: Date.now() - 4 * 86400000 };
    localStorage.setItem(key, JSON.stringify(all));
  }, fieldId);
  await page.reload();

  await expect(page.locator("#waterMgmtStaleWarning")).toBeVisible();
  await expect(page.locator("#waterMgmtStaleWarning")).toContainText("4日前");
});

// ---------------------------------------------------------------------------
// Per-field state and the bridge into the existing 目標水位
// ---------------------------------------------------------------------------

test("stage and measurement are per field, and follow the one active-field selector", async ({ page }) => {
  await openBasic(page);
  await registerField(page, "圃場1");
  await page.locator("#waterMgmtStageSelect").selectOption("tillering");
  await page.locator("#waterMgmtDepthInput").fill("18");
  const firstId = await page.locator("#basicActiveFieldSelect").inputValue();

  await registerField(page, "圃場2", { latBase: "3439.1880", lonBase: "13549.6892", timePrefix: "13" });
  await selectFieldByName(page, "圃場2");
  // 圃場2 has no manual stage, so it falls back to the calendar estimate --
  // which must NOT be 圃場1's manually-chosen tillering, and must be marked
  // as an estimate. The measurement is still per-field and still empty.
  await expect(page.locator("#waterMgmtStageEstimateNote")).toBeVisible();
  await expect(page.locator("#waterMgmtDepthInput")).toHaveValue("");

  await page.locator("#basicActiveFieldSelect").selectOption(firstId);
  await expect(page.locator("#waterMgmtStageSelect")).toHaveValue("tillering");
  await expect(page.locator("#waterMgmtDepthInput")).toHaveValue("18");
});

test("the reference range can be applied to 目標水位, but only on request", async ({ page }) => {
  await openBasic(page);
  await registerField(page, "圃場1");
  await page.locator("#waterMgmtStageSelect").selectOption("after_transplanting"); // 30-50mm -> 4.0cm midpoint

  // Nothing was written just by picking the stage.
  await expect(page.locator("#recTargetWaterLevelInput")).toHaveValue("");

  const applyButton = page.locator("#waterMgmtApplyTargetButton");
  await expect(applyButton).toContainText("4 cm");
  await applyButton.click();

  await expect(page.locator("#recTargetWaterLevelInput")).toHaveValue("4");
  await expect(page.locator("#waterMgmtApplyTargetMessage")).toContainText("目標水位を 4 cm に設定しました");
});

// ---------------------------------------------------------------------------
// Nothing else moved
// ---------------------------------------------------------------------------

test("今日の水門判断 keeps working alongside the new card", async ({ page }) => {
  await openBasic(page);
  await registerField(page, "圃場1");
  // The exact "水を 2.3 cm 入れてください" message below only exists for a
  // numeric-target stage -- pin one so this does not depend on which growth
  // stage today's real date happens to calendar-estimate.
  await page.locator("#waterMgmtStageSelect").selectOption("tillering");
  // #recObsWaterLevelInput lives inside #basicWaterRecordCard, which is no
  // longer permanently visible on desktop -- open it first.
  await page.locator("#basicRecordWaterButton").click();
  await expect(page.locator("#recObsWaterLevelInput")).toBeVisible();
  await page.locator("#recObsWaterLevelInput").fill("3.2");
  await page.locator("#recTargetWaterLevelInput").fill("5.5");

  await expect(page.locator("#waterHeroPrimary")).toHaveText("水を 2.3 cm 入れてください");
  // #verdictBadge lives inside .gate-card, which is likewise no longer
  // permanently visible -- a measurement now exists, so the map summary's
  // button is in its "詳細を見る" state and opens it (see .gate-card's own
  // CSS comment).
  await expect(page.locator("#mapWaterSummaryButton")).toHaveText("詳細を見る");
  await page.locator("#mapWaterSummaryButton").click();
  await expect(page.locator("#verdictBadge")).toBeVisible();
  await expect(page.locator("#waterManagementCard")).toHaveCount(1);
});
