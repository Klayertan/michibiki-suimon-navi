import { test, expect } from "@playwright/test";

// Four Basic-mode UX defects, and the invariants that keep them fixed:
//
//  1. 開発ツール rendered as a full-height blank page with the map pushed to
//     the bottom.
//  2. A raw 今日の水門判断 / verdict / reason strip sat above the map, giving
//     the farmer two verdict surfaces that could disagree.
//  3. 現在の田圃 and 対象圃場 / 使用データ were two field selectors for one
//     field.
//  4. みちびき活用の実証 / QZ1-DGNSS 測位品質 sat in Basic, where it is not a
//     farmer action.

function gga(time, lat, lon, fix = 1, sats = 8, hdop = "1.1") {
  const body = `GNGGA,${time},${lat},N,${lon},E,${fix},${sats},${hdop},45.0,M,30.0,M,,`;
  let checksum = 0;
  for (const character of body) {
    checksum ^= character.charCodeAt(0);
  }
  return `$${body}*${checksum.toString(16).toUpperCase().padStart(2, "0")}`;
}

/** Two distinct square loops, so field A and field B have different areas. */
const LOOP_A = [
  gga("120000.00", "3439.2880", "13549.7892"),
  gga("120010.00", "3439.2880", "13549.8162"),
  gga("120020.00", "3439.2664", "13549.8162"),
  gga("120030.00", "3439.2664", "13549.7892"),
  gga("120040.00", "3439.2879", "13549.7895", 2, 9, "0.9")
].join("\r\n");

const LOOP_B = [
  gga("130000.00", "3439.4880", "13549.9892"),
  gga("130010.00", "3439.4880", "13550.0432"),
  gga("130020.00", "3439.4448", "13550.0432"),
  gga("130030.00", "3439.4448", "13549.9892"),
  gga("130040.00", "3439.4879", "13549.9895", 2, 9, "0.9")
].join("\r\n");

async function openSettingsFields(page) {
  await page.goto("/#settings/fields");
  await expect(page.locator("#fieldRegDialog")).toBeAttached({ timeout: 15_000 });
}

/** Registers one field through the Settings path (fastest route to test data). */
async function registerField(page, { nmea, fileName }) {
  // #fileInput lives under 開発ツール now, not 圃場データ -- #fieldRegDialog's
  // own visibility is upload-triggered, not workspace-gated, so hopping over
  // to 開発ツール for the upload and straight back doesn't disturb it.
  await page.evaluate(() => switchWorkspace("devtools"));
  await page.locator("#fileInput").setInputFiles({ name: fileName, mimeType: "", buffer: Buffer.from(nmea) });
  await page.evaluate(() => switchWorkspace("fields"));
  await expect(page.locator("#fieldRegDialog")).toBeVisible();
  await page.locator("#fieldRegConfirmButton").click();
}

/**
 * Registers two fields with a deliberate gap between them.
 *
 * makeSurveySessionId() stamps ids to the second with no uniqueness guard, so
 * two registrations inside one second share an id and every field then
 * resolves to the FIRST session's NMEA metadata. That is a pre-existing
 * storage-level defect tracked separately; these tests are about which card
 * shows the metadata, so they step around it rather than asserting on it.
 * Once session ids are unique, this wait can go.
 */
async function registerTwoFields(page) {
  await registerField(page, { nmea: LOOP_A, fileName: "field-a.nmea" });
  await page.waitForTimeout(1100);
  await registerField(page, { nmea: LOOP_B, fileName: "field-b.nmea" });
}

// ---------------------------------------------------------------------------
// 1. 開発ツール layout
// ---------------------------------------------------------------------------

test("開発ツール lays out like every other Settings workspace -- no giant blank gap", async ({ page }) => {
  await page.goto("/#settings/devtools");
  await expect(page.locator("body")).toHaveAttribute("data-workspace", "devtools");

  const metrics = await page.evaluate(() => {
    const rect = (selector) => {
      const box = document.querySelector(selector).getBoundingClientRect();
      return { top: box.top, height: box.height };
    };
    return {
      viewport: window.innerHeight,
      header: rect("header"),
      map: rect(".map-wrap"),
      panel: rect(".panel"),
      firstCard: rect("#dronePanel")
    };
  });

  // main starts right under the header: nothing sits between them any more.
  expect(metrics.map.top).toBeLessThan(metrics.header.height + 4);
  // The map keeps essentially the whole remaining viewport, as in every
  // other workspace — it used to collapse to its content height.
  expect(metrics.map.height).toBeGreaterThan(metrics.viewport - metrics.header.height - 8);
  // Developer cards start at the top of the right panel.
  expect(metrics.firstCard.top - metrics.panel.top).toBeLessThan(40);
});

test("開発ツール shows the developer cards and no farmer decision strip", async ({ page }) => {
  await page.goto("/#settings/devtools");

  await expect(page.locator("#dronePanel")).toBeVisible();
  await expect(page.locator("#dronePanel")).toContainText("ドローン / MAVLink");
  // The removed strip: no element in the document renders the verdict twice.
  await expect(page.locator(".mobile-decision")).toHaveCount(0);
  await expect(page.locator("#mobileVerdictBadge")).toHaveCount(0);
  await expect(page.locator(".gate-card")).toBeHidden();
});

test("switching away from 開発ツール and back stays stable, and a refresh restores it", async ({ page }) => {
  await page.goto("/#settings/devtools");
  const devtoolsMapHeight = () => page.evaluate(() => document.querySelector(".map-wrap").getBoundingClientRect().height);
  const first = await devtoolsMapHeight();

  await page.locator('[data-workspace-target="fields"]').click();
  await expect(page.locator("body")).toHaveAttribute("data-workspace", "fields");
  await page.locator('[data-workspace-target="devtools"]').click();
  await expect(page.locator("body")).toHaveAttribute("data-workspace", "devtools");
  expect(await devtoolsMapHeight()).toBeCloseTo(first, 0);

  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-workspace", "devtools");
  await expect(page.locator("#dronePanel")).toBeVisible();
  expect(await devtoolsMapHeight()).toBeCloseTo(first, 0);
});

test("no workspace leaves the document scrolled or overflowing sideways on desktop", async ({ page }) => {
  for (const route of ["/#basic", "/#drone", "/#settings", "/#settings/assurance", "/#settings/fields", "/#settings/devtools"]) {
    await page.goto(route);
    const state = await page.evaluate(() => ({
      // .panel is the only thing meant to scroll on desktop. The document
      // itself must stay pinned: a drifting documentElement.scrollTop is
      // exactly what a blank strip above the map looks like.
      documentScrollTop: document.documentElement.scrollTop,
      windowScrollY: window.scrollY,
      htmlOverflow: getComputedStyle(document.documentElement).overflow,
      horizontal: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      // main must start immediately under the header — nothing between them.
      gapAboveMain: Math.round(
        document.querySelector("main").getBoundingClientRect().top
        - document.querySelector("header").getBoundingClientRect().bottom
      )
    }));
    expect(state.documentScrollTop, `${route} document must stay pinned`).toBe(0);
    expect(state.windowScrollY, `${route} window must stay pinned`).toBe(0);
    expect(state.htmlOverflow, `${route} html overflow`).toBe("hidden");
    expect(state.horizontal, `${route} must not overflow horizontally`).toBeLessThanOrEqual(1);
    expect(state.gapAboveMain, `${route} must have nothing between header and main`).toBeLessThanOrEqual(1);
  }
});

// ---------------------------------------------------------------------------
// 2. One verdict card
// ---------------------------------------------------------------------------

test("Basic has exactly one farmer verdict, in the polished card", async ({ page }) => {
  // #verdictBadge sits inside the quantitative hero's content, shown only
  // with an active field (spec §24: zero fields shows the "圃場を登録する
  // と..." prompt instead of a meaningless 様子見), so this needs one first.
  await openSettingsFields(page);
  await registerField(page, { nmea: LOOP_A, fileName: "one-verdict.nmea" });
  await page.goto("/");

  // .gate-card no longer sits permanently in the left rail on desktop -- it
  // only appears attached below #mapWaterSummary once the map's own button
  // opens it (see .gate-card's own CSS comment). Recording a level first
  // guarantees the button is in its "詳細を見る" state rather than "水位を
  // 記録", regardless of what growth stage this field defaulted to.
  await page.locator("#mapWaterSummaryButton").click();
  await page.locator("#recObsWaterLevelInput").fill("3.2");
  await page.locator("#recTargetWaterLevelInput").fill("5.5");
  await expect(page.locator("#mapWaterSummaryButton")).toHaveText("詳細を見る");
  await page.locator("#mapWaterSummaryButton").click();

  const card = page.locator(".gate-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("今日の水門判断");
  await expect(card).toContainText("気象と圃場の状況からの推奨");
  await expect(card.locator("#verdictBadge")).toBeVisible();
  await expect(card.locator("#verdictReason")).not.toBeEmpty();
  await expect(card.locator(".disclaimer")).toContainText("最終判断と水門の操作は必ず人が行ってください");

  // One verdict element, one reason element, in the whole document -- the
  // desktop map-corner summary (#mapWaterSummary) intentionally repeats the
  // "今日の水門判断" heading as a compact READ of this same card's data (see
  // docs/STAGE1_BASIC_MAP_LAYOUT_POLISH.md), so the heading text itself can
  // legitimately appear twice; what must stay singular is the actual
  // verdict badge/reason, which live only in .gate-card.
  await expect(page.locator(".verdict")).toHaveCount(1);
  await expect(page.locator(".verdict-reason")).toHaveCount(1);
  await expect(page.locator(".gate-card").locator("text=今日の水門判断")).toHaveCount(1);
});

test("the verdict class and reason follow the decision state through open/hold/close", async ({ page }) => {
  await page.goto("/#settings");

  for (const { scenario, className, label } of [
    { scenario: "open", className: "verdict open", label: "開ける" },
    { scenario: "close", className: "verdict close", label: "閉める" },
    { scenario: "hold", className: "verdict hold", label: "様子見" }
  ]) {
    await page.locator(`[data-weather-scenario="${scenario}"]`).click();
    await expect(page.locator("#verdictBadge")).toHaveClass(className);
    await expect(page.locator("#verdictBadge")).toHaveText(label);
    await expect(page.locator("#verdictReason")).not.toBeEmpty();
  }

  // And the single card carried it all the way back to Basic.
  await page.locator('[data-mode-target="basic"]').click();
  await expect(page.locator("#verdictBadge")).toHaveClass("verdict hold");
});

test("threshold tuning stays out of Basic", async ({ page }) => {
  await page.goto("/");
  for (const id of ["rain24hInput", "daysSinceRainInput", "forecastProbInput", "decisionProfileSelect"]) {
    await expect(page.locator(`#${id}`)).toBeHidden();
  }

  await page.goto("/#settings");
  for (const id of ["rain24hInput", "daysSinceRainInput", "forecastProbInput", "decisionProfileSelect"]) {
    await expect(page.locator(`#${id}`)).toBeVisible();
  }
});

test("the verdict is compact in the desktop panel and large on an iPhone", async ({ page }) => {
  // #verdictBadge now lives inside the quantitative hero's content, which
  // (per the field-water-dashboard spec §24) only renders with an active
  // field -- a farmer with zero fields sees the "圃場を登録すると..." prompt
  // instead of a meaningless 様子見, so this needs a registered field first.
  await openSettingsFields(page);
  await registerField(page, { nmea: LOOP_A, fileName: "verdict-size.nmea" });
  await page.goto("/");
  const badge = page.locator("#verdictBadge");
  const desktopFont = await badge.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(badge).toBeVisible();
  const phoneFont = await badge.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

  expect(phoneFont).toBeGreaterThan(desktopFont);
  // Still one card, still the focal point — not a strip.
  await expect(page.locator(".verdict")).toHaveCount(1);
});

// ---------------------------------------------------------------------------
// 3. One authoritative active field
// ---------------------------------------------------------------------------

test("Basic shows one field selector and no second field card", async ({ page }) => {
  await openSettingsFields(page);
  await registerField(page, { nmea: LOOP_A, fileName: "4th.nmea" });
  await page.goto("/#basic");

  await expect(page.locator("#basicFieldManagementCard")).toBeVisible();
  await expect(page.locator("#basicActiveFieldSelect")).toBeVisible();
  // The old second selector is Settings-only now.
  await expect(page.locator("#decisionFieldCard")).toBeHidden();
  await expect(page.locator("#decisionFieldSelect")).toBeHidden();
  await expect(page.locator("#reportFieldSelect")).toBeHidden();

  // Exactly one visible field-picking control in the Basic panel. The water
  // and observation panels have their own target selectors, but those are
  // sub-tool targets driven BY the active field, and with a single field they
  // are not even shown.
  for (const id of ["decisionFieldSelect", "reportFieldSelect", "assuranceActiveField"]) {
    await expect(page.locator(`#${id}`)).toBeHidden();
  }
  await expect(page.locator("#basicActiveFieldSelect")).toBeVisible();
  // ...and no second card offering the same choice.
  await expect(page.getByText("対象圃場 / 使用データ", { exact: true })).toBeHidden();
  await expect(page.getByText("使用する圃場データを選ぶ", { exact: true })).toBeHidden();
});

test("現在の田圃 carries the metadata 対象圃場 / 使用データ used to duplicate", async ({ page }) => {
  await openSettingsFields(page);
  await registerField(page, { nmea: LOOP_A, fileName: "4th.nmea" });
  await page.goto("/#basic");

  const card = page.locator("#basicFieldManagementCard");
  await expect(card).toContainText("現在の圃場");
  await expect(card.locator("#basicFieldArea")).toContainText("m²");
  await expect(card.locator("#basicFieldSourceFile")).toHaveText("4th.nmea");
  await expect(card.locator("#basicFieldReliability")).not.toHaveText("—");
  await expect(card.locator("#basicFieldValidPoints")).toHaveText("5点");
  await expect(card.locator("#basicFieldWaterPoints")).toHaveText("0件");
  await expect(card.locator("#basicFieldObservations")).toHaveText("0件");
  await expect(card.locator("#basicAddWaterPointButton")).toBeEnabled();
});

test("changing the active field moves everything together -- area, metadata, map and decision context", async ({ page }) => {
  await openSettingsFields(page);
  await registerTwoFields(page);
  await page.goto("/#basic");

  const ids = await page.evaluate(() => window.fieldAnnotationController.fields.map((field) => field.id));
  expect(ids.length).toBe(2);

  const snapshot = () => page.evaluate(() => ({
    area: document.getElementById("basicFieldArea").textContent,
    source: document.getElementById("basicFieldSourceFile").textContent,
    points: document.getElementById("basicFieldValidPoints").textContent,
    decisionField: document.getElementById("decisionFieldSelect").value,
    decisionLabel: document.getElementById("decisionFieldLabel").textContent,
    decisionSource: document.getElementById("decisionSourceFile").textContent,
    // The map's own "which paddy am I working on" label.
    mapField: document.getElementById("waterQuickActiveField").textContent,
    waterTarget: document.getElementById("wcpTargetFieldSelect").value,
    reportTarget: document.getElementById("reportFieldSelect").value
  }));

  await page.locator("#basicActiveFieldSelect").selectOption(ids[0]);
  const first = await snapshot();
  expect(first.decisionField).toBe(ids[0]);
  expect(first.waterTarget).toBe(ids[0]);
  expect(first.reportTarget).toBe(ids[0]);
  expect(first.source).toBe("field-a.nmea");
  expect(first.decisionSource).toBe("field-a.nmea");
  expect(first.decisionLabel).toContain(ids[0]);
  expect(first.mapField).toContain(ids[0]);

  await page.locator("#basicActiveFieldSelect").selectOption(ids[1]);
  const second = await snapshot();
  expect(second.decisionField).toBe(ids[1]);
  expect(second.waterTarget).toBe(ids[1]);
  expect(second.reportTarget).toBe(ids[1]);
  expect(second.source).toBe("field-b.nmea");
  expect(second.decisionSource).toBe("field-b.nmea");
  expect(second.decisionLabel).toContain(ids[1]);
  expect(second.mapField).toContain(ids[1]);
  expect(second.area).not.toBe(first.area);
});

test("the active field, and the data behind it, survive a reload", async ({ page }) => {
  await openSettingsFields(page);
  await registerTwoFields(page);
  await page.goto("/#basic");

  const ids = await page.evaluate(() => window.fieldAnnotationController.fields.map((field) => field.id));
  await page.locator("#basicActiveFieldSelect").selectOption(ids[1]);
  const area = await page.locator("#basicFieldArea").textContent();

  await page.reload();
  await expect(page.locator("#basicActiveFieldSelect")).toHaveValue(ids[1]);
  await expect(page.locator("#basicFieldArea")).toHaveText(area);
  await expect(page.locator("#basicFieldSourceFile")).toHaveText("field-b.nmea");
  await expect(page.locator("#decisionFieldSelect")).toHaveValue(ids[1]);
});

test("with fields registered, Basic never opens on an empty 現在の田圃", async ({ page }) => {
  await openSettingsFields(page);
  await registerTwoFields(page);

  // No prior choice at all: the card still has to name a field rather than
  // telling a farmer with two paddies that nothing is registered.
  await page.evaluate(() => localStorage.removeItem("suimonNaviActiveFieldV1"));
  await page.goto("/#basic");

  await expect(page.locator("#basicFieldEmptyState")).toBeHidden();
  await expect(page.locator("#basicFieldSummary")).toBeVisible();
  await expect(page.locator("#basicActiveFieldSelect")).toHaveValue("paddy-001");
  await expect(page.locator("#decisionFieldSelect")).toHaveValue("paddy-001");
});

// ---------------------------------------------------------------------------
// 4. QZ1 / DGNSS assurance card ownership
// ---------------------------------------------------------------------------

test("Basic no longer shows みちびき活用の実証 / QZ1-DGNSS 測位品質", async ({ page }) => {
  await openSettingsFields(page);
  await registerField(page, { nmea: LOOP_A, fileName: "4th.nmea" });
  await page.goto("/#basic");

  await expect(page.locator(".proof-card")).toBeHidden();
  for (const id of ["proofTotal", "proofSlasRate", "proofSatellites", "proofHdop", "loadProofButton"]) {
    await expect(page.locator(`#${id}`)).toBeHidden();
  }
  await expect(page.locator("text=みちびき活用の実証")).toBeHidden();
});

test("設定 → 測量チェック owns the assurance card, and it exists exactly once", async ({ page }) => {
  await openSettingsFields(page);
  await registerField(page, { nmea: LOOP_A, fileName: "4th.nmea" });

  await page.locator('[data-workspace-target="assurance"]').click();
  await expect(page.locator("body")).toHaveAttribute("data-workspace", "assurance");

  const card = page.locator(".proof-card");
  await expect(card).toHaveCount(1); // moved, not duplicated
  await expect(card).toBeVisible();
  await expect(card).toContainText("みちびき活用の実証");
  await expect(card).toContainText("QZ1 / DGNSS 測位品質");
  // Sits alongside the rest of the measurement-check tooling.
  await expect(page.locator(".assurance-lead")).toBeVisible();
});

test("the assurance calculation and the map point-display action are unchanged", async ({ page }) => {
  await openSettingsFields(page);
  await registerField(page, { nmea: LOOP_A, fileName: "4th.nmea" });
  await page.locator('[data-workspace-target="assurance"]').click();

  // Same numbers the card always produced for this dataset: 5 fixes, 1 of
  // them fix quality 2.
  await expect(page.locator("#proofSourceBadge")).toHaveText("実測QZ1ログ");
  await expect(page.locator("#proofTotal")).toHaveText("5点");
  await expect(page.locator("#proofSlasRate")).toHaveText("20%");

  await expect(page.locator("#loadProofButton")).toBeEnabled();
  await page.locator("#loadProofButton").click();
  await expect(page.locator(".qz1-point")).toHaveCount(5);
});

// ---------------------------------------------------------------------------
// Structure that must not have moved
// ---------------------------------------------------------------------------

test("the three top-level modes and the Settings workspaces are unchanged", async ({ page }) => {
  await page.goto("/");

  const modes = await page.locator("[data-mode-target]").allTextContents();
  expect(modes.length).toBe(3);
  expect(modes[0]).toContain("基本モード");
  expect(modes[1]).toContain("ドローンモード"); // still the SECOND top-level mode
  expect(modes[2]).toContain("そのほか");

  await page.goto("/#settings");
  const workspaces = await page.locator("[data-workspace-target]").allTextContents();
  expect(workspaces).toEqual(["判断デモ", "QZ1測量", "測量チェック", "圃場データ", "詳細解析", "開発ツール"]);
});

test("there is exactly one help control, in the header, at a 44px target", async ({ page }) => {
  for (const size of [{ width: 1366, height: 768 }, { width: 390, height: 844 }, { width: 393, height: 852 }]) {
    await page.setViewportSize(size);
    await page.goto("/");

    const help = page.locator("#basicHelpButton");
    await expect(help).toHaveCount(1);
    await expect(help).toBeVisible();
    const box = await help.boundingBox();
    expect(box.width, `${size.width}px width`).toBeGreaterThanOrEqual(44);
    expect(box.height, `${size.width}px height`).toBeGreaterThanOrEqual(44);
    // In the header, not inside the Stage-1 card.
    await expect(page.locator("header #basicHelpButton")).toHaveCount(1);
    await expect(page.locator("#basicStage1Card #basicHelpButton")).toHaveCount(0);

    // Still a real dialog with all three exits.
    await help.click();
    await expect(page.locator("#basicHelpDialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#basicHelpDialog")).toBeHidden();
  }
});
