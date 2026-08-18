import { test, expect } from "@playwright/test";

// Desktop 基本モード's floating map dashboard: the map is the full-bleed
// canvas and 圃場の管理/今日の水門判断 (left) + NMEAアップロード/測量ログ/
// 水管理/観察 (right) float ON TOP of it as translucent cards, with map
// imagery visible to the outside of, and between, both rails.
// See docs/STAGE1_BASIC_FLOATING_MAP_DASHBOARD.md.
//
// Every desktop assertion here is GEOMETRIC (measured rects), not a CSS
// string check, because the thing under test is "does the map actually run
// underneath the panels" -- a computed-style assertion cannot tell you that.
//
// Mobile / 設定 / ドローン assertions exist to prove the floating layout did
// NOT leak into them; they are regression guards, not new behavior.

function gga(time, lat, lon, fix = 1, sats = 8, hdop = "1.1") {
  const body = `GNGGA,${time},${lat},N,${lon},E,${fix},${sats},${hdop},45.0,M,30.0,M,,`;
  let checksum = 0;
  for (const character of body) {
    checksum ^= character.charCodeAt(0);
  }
  return `$${body}*${checksum.toString(16).toUpperCase().padStart(2, "0")}`;
}

function walkNmea({ latBase = "3439.2880", lonBase = "13549.7892", timePrefix = "12" } = {}) {
  const lat = parseFloat(latBase);
  const lon = parseFloat(lonBase);
  const shift = (v, d) => (v + d).toFixed(4);
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

async function openBasic(page) {
  await page.route("**/api.open-meteo.com/**", (route) => {
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.goto("/");
  await expect(page.locator("body")).toHaveAttribute("data-mode", "basic");
}

async function registerField(page, name, walkOptions, fileName) {
  await page.locator("#basicNmeaInput").setInputFiles({
    name: fileName || `${name}.txt`,
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

/** Measured layout facts, gathered in one round trip. */
async function layout(page) {
  return page.evaluate(() => {
    const rect = (el) => {
      const b = el.getBoundingClientRect();
      return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height };
    };
    const visible = (el) => !!el && getComputedStyle(el).display !== "none" && !el.hasAttribute("hidden");
    const leftRail = document.querySelector(".panel-left");
    const rightRail = document.querySelector(".panel-right");
    const chrome = {};
    for (const [name, selector] of Object.entries({
      basemapToggle: ".basemap-toggle",
      quickToolbar: ".map-quick-toolbar",
      waterSummary: "#mapWaterSummary",
      zoom: "#map .leaflet-control-zoom",
      attribution: "#map .leaflet-control-attribution",
      emptyState: "#emptyState"
    })) {
      const el = document.querySelector(selector);
      chrome[name] = visible(el) ? rect(el) : null;
    }
    return {
      main: rect(document.querySelector("main")),
      mapWrap: rect(document.querySelector(".map-wrap")),
      mapEl: rect(document.getElementById("map")),
      leftRail: rect(leftRail),
      rightRail: rect(rightRail),
      leftRailDisplay: getComputedStyle(leftRail).display,
      rightRailDisplay: getComputedStyle(rightRail).display,
      panelDisplay: getComputedStyle(document.querySelector("aside.panel")).display,
      chrome,
      pageScrollWidth: document.documentElement.scrollWidth,
      pageClientWidth: document.documentElement.clientWidth,
      pageScrollHeight: document.documentElement.scrollHeight,
      pageClientHeight: document.documentElement.clientHeight
    };
  });
}

function overlaps(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

const DESKTOP_VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 1280, height: 900 }
];
const MOBILE_VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 393, height: 852 }
];

// ---------------------------------------------------------------------------
// 1. The map is the canvas: full bleed, with both rails floating INSIDE it
// ---------------------------------------------------------------------------

for (const viewport of DESKTOP_VIEWPORTS) {
  test(`map runs full-bleed underneath both floating rails at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openBasic(page);
    const l = await layout(page);

    // The map spans the whole workspace -- it is NOT a middle column.
    expect(Math.round(l.mapWrap.left)).toBe(Math.round(l.main.left));
    expect(Math.round(l.mapWrap.right)).toBe(Math.round(l.main.right));
    expect(Math.round(l.mapWrap.width)).toBe(Math.round(l.main.width));
    expect(Math.round(l.mapEl.width)).toBe(Math.round(l.main.width));
    expect(l.mapWrap.height).toBeGreaterThan(0);
    expect(Math.round(l.mapEl.height)).toBe(Math.round(l.mapWrap.height));

    // Both rails sit strictly INSIDE the map's box on every side, which is
    // what "floating on top of the map" means geometrically.
    for (const rail of [l.leftRail, l.rightRail]) {
      expect(rail.left).toBeGreaterThan(l.mapWrap.left);
      expect(rail.right).toBeLessThan(l.mapWrap.right);
      expect(rail.top).toBeGreaterThan(l.mapWrap.top);
      expect(rail.bottom).toBeLessThan(l.mapWrap.bottom);
    }

    // Map imagery is visible to the left of, between, and to the right of
    // the rails -- no full-height opaque strip reaching a viewport edge.
    expect(l.leftRail.left - l.mapWrap.left).toBeGreaterThanOrEqual(12);
    expect(l.mapWrap.right - l.rightRail.right).toBeGreaterThanOrEqual(12);
    expect(l.rightRail.left - l.leftRail.right).toBeGreaterThan(200);

    // The rails never introduce page scroll in either axis.
    expect(l.pageScrollWidth).toBeLessThanOrEqual(l.pageClientWidth);
    expect(l.pageScrollHeight).toBeLessThanOrEqual(l.pageClientHeight);
  });
}

test("the map is genuinely behind the rails, not merely beside them", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openBasic(page);
  const l = await layout(page);

  // A point inside the left rail's box is still over #map in the hit-test
  // sense once you look past the rail's own (pointer-transparent) area:
  // the map element's rect must contain the rail's rect entirely.
  for (const rail of [l.leftRail, l.rightRail]) {
    expect(rail.left).toBeGreaterThanOrEqual(l.mapEl.left);
    expect(rail.right).toBeLessThanOrEqual(l.mapEl.right);
  }

  // Leaflet tiles are laid out across the full container width, so tiles
  // exist underneath both rails.
  const tilesUnderRails = await page.evaluate(() => {
    const railBoxes = [".panel-left", ".panel-right"].map((s) => document.querySelector(s).getBoundingClientRect());
    const tiles = [...document.querySelectorAll("#map .leaflet-tile")];
    return railBoxes.map((rb) =>
      tiles.some((t) => {
        const b = t.getBoundingClientRect();
        return b.left < rb.right && b.right > rb.left && b.top < rb.bottom && b.bottom > rb.top;
      })
    );
  });
  expect(tilesUnderRails).toEqual([true, true]);
});

// ---------------------------------------------------------------------------
// 2. Pointer events: cards intercept, the rail itself does not
// ---------------------------------------------------------------------------

test("the rail is pointer-transparent; only its cards intercept clicks", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openBasic(page);

  const probe = await page.evaluate(() => {
    const idOf = (x, y) => {
      const el = document.elementFromPoint(x, y);
      return el ? (el.closest("#map") ? "#map" : el.closest(".card") ? ".card" : el.tagName) : null;
    };
    const rail = document.querySelector(".panel-left");
    const railBox = rail.getBoundingClientRect();
    const cards = [...rail.children].filter((c) => getComputedStyle(c).display !== "none");
    const lastCard = cards[cards.length - 1].getBoundingClientRect();
    return {
      overCard: idOf(railBox.left + 150, railBox.top + 40),
      // Inside the rail's own box, but in the empty space below its last
      // card: this must fall through to the map.
      insideRailBelowCards: lastCard.bottom + 60 < railBox.bottom
        ? idOf(railBox.left + 150, lastCard.bottom + 60)
        : "#map",
      mapCentre: idOf(Math.round(innerWidth / 2), Math.round(innerHeight / 2))
    };
  });

  expect(probe.overCard).toBe(".card");
  expect(probe.insideRailBelowCards).toBe("#map");
  expect(probe.mapCentre).toBe("#map");
});

test("no invisible overlay covers the map: a map click still places a water point", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openBasic(page);
  await registerField(page, "圃場1");

  await page.locator('[data-water-quick-type="gate"]').click();
  // Armed: the toolbar prompts for a map click (it hides the prompt again
  // once the point lands, so this is only true BEFORE the click).
  await expect(page.locator("#waterQuickStatus")).toBeVisible();

  const box = await page.locator("#map").boundingBox();
  // Click the centre of the free canvas between the rails.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  // The click reached Leaflet, not some invisible overlay.
  await expect
    .poll(() => page.evaluate(() => window.fieldAnnotationController.waterControlPoints.length))
    .toBe(1);
});

test("a marker popup opens and its buttons stay clickable under the floating layout", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openBasic(page);
  await registerField(page, "圃場1");

  await page.locator('[data-water-quick-type="gate"]').click();
  const box = await page.locator("#map").boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect
    .poll(() => page.evaluate(() => window.fieldAnnotationController.waterControlPoints.length))
    .toBe(1);

  // Water points are Leaflet circleMarkers (SVG paths), so click the marker
  // at its real screen position with a real mouse event -- the whole point
  // is to prove the floating chrome does not swallow the hit.
  const markerPoint = await page.evaluate(() => {
    const point = window.fieldAnnotationController.waterControlPoints.at(-1);
    const p = window.map.latLngToContainerPoint(point.coordinates);
    const mapBox = document.getElementById("map").getBoundingClientRect();
    return { x: mapBox.left + p.x, y: mapBox.top + p.y };
  });
  await page.mouse.click(markerPoint.x, markerPoint.y);

  const popup = page.locator(".leaflet-popup");
  await expect(popup).toBeVisible();

  // The popup renders above the map chrome and clear of both rails.
  const popupBox = await popup.boundingBox();
  const railBoxes = await page.evaluate(() =>
    [".panel-left", ".panel-right"].map((sel) => {
      const b = document.querySelector(sel).getBoundingClientRect();
      return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
    })
  );
  for (const rail of railBoxes) {
    expect(overlaps(
      { left: popupBox.x, right: popupBox.x + popupBox.width, top: popupBox.y, bottom: popupBox.y + popupBox.height },
      rail
    )).toBe(false);
  }

  // Its buttons really are reachable: Playwright's click() fails outright if
  // any other element would receive the event instead.
  const deleteButton = page.locator(".leaflet-popup-content").getByRole("button", { name: "削除" });
  await expect(deleteButton).toBeVisible();
  let confirmed = null;
  page.once("dialog", (dialog) => {
    confirmed = dialog.message();
    dialog.accept();
  });
  await deleteButton.click();
  expect(confirmed).toBe("この水管理ポイントを削除しますか？");
  await expect
    .poll(() => page.evaluate(() => window.fieldAnnotationController.waterControlPoints.length))
    .toBe(0);
});

// ---------------------------------------------------------------------------
// 3. Map chrome steps clear of the rails
// ---------------------------------------------------------------------------

for (const viewport of DESKTOP_VIEWPORTS) {
  test(`map chrome never lands under a rail at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openBasic(page);
    await registerField(page, "圃場1");
    const l = await layout(page);

    for (const [name, box] of Object.entries(l.chrome)) {
      if (!box) continue;
      expect(overlaps(box, l.leftRail), `${name} overlaps the left rail`).toBe(false);
      expect(overlaps(box, l.rightRail), `${name} overlaps the right rail`).toBe(false);
    }

    // The 地図/航空写真 toggle and the zoom control in particular must stay
    // fully on-canvas and usable.
    await expect(page.locator("#basemapAerialButton")).toBeVisible();
    await page.locator("#basemapAerialButton").click();
    await expect(page.locator("#basemapAerialButton")).toHaveAttribute("aria-pressed", "true");
  });
}

test("zoom stays bottom-right but inset clear of the right rail", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openBasic(page);

  const corner = await page.locator("#map .leaflet-control-zoom").evaluate((el) => el.closest(".leaflet-top, .leaflet-bottom").className);
  expect(corner).toContain("leaflet-bottom");
  expect(corner).toContain("leaflet-right");

  const l = await layout(page);
  expect(l.chrome.zoom).not.toBeNull();
  expect(l.chrome.zoom.right).toBeLessThanOrEqual(l.rightRail.left);
  // Still bottom-anchored, not floated to the middle.
  expect(l.mapWrap.bottom - l.chrome.zoom.bottom).toBeLessThan(120);

  await page.locator("#map .leaflet-control-zoom-in").click();
});

// ---------------------------------------------------------------------------
// 4. NMEA upload stays on the RIGHT
// ---------------------------------------------------------------------------

for (const viewport of DESKTOP_VIEWPORTS) {
  test(`NMEAをアップロード is in the right rail at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openBasic(page);

    const placement = await page.evaluate(() => {
      const card = document.getElementById("basicStage1Card");
      const b = card.getBoundingClientRect();
      const right = document.querySelector(".panel-right").getBoundingClientRect();
      const left = document.querySelector(".panel-left").getBoundingClientRect();
      return {
        inRightRail: !!card.closest(".panel-right"),
        inLeftRail: !!card.closest(".panel-left"),
        withinRightRailBox: b.left >= right.left - 1 && b.right <= right.right + 1,
        leftOfRightRail: b.left > left.right
      };
    });
    expect(placement.inRightRail).toBe(true);
    expect(placement.inLeftRail).toBe(false);
    expect(placement.withinRightRailBox).toBe(true);
    expect(placement.leftOfRightRail).toBe(true);
  });
}

test("圃場の管理 and 今日の水門判断 are in the left rail", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openBasic(page);

  const placement = await page.evaluate(() => ({
    fieldManagement: !!document.getElementById("basicFieldManagementCard").closest(".panel-left"),
    gateCard: !!document.querySelector(".gate-card").closest(".panel-left")
  }));
  expect(placement).toEqual({ fieldManagement: true, gateCard: true });
});

// ---------------------------------------------------------------------------
// 5. Independent rail scrolling, and content that could blow the layout out
// ---------------------------------------------------------------------------

test("each rail scrolls on its own without scrolling the page", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await openBasic(page);
  await registerField(page, "圃場1");

  const scrolled = await page.evaluate(() => {
    const right = document.querySelector(".panel-right");
    right.scrollTop = 400;
    return {
      railScrollTop: right.scrollTop,
      railCanScroll: right.scrollHeight > right.clientHeight,
      pageScrollTop: document.documentElement.scrollTop,
      bodyScrollTop: document.body.scrollTop
    };
  });
  expect(scrolled.railCanScroll).toBe(true);
  expect(scrolled.railScrollTop).toBeGreaterThan(0);
  expect(scrolled.pageScrollTop).toBe(0);
  expect(scrolled.bodyScrollTop).toBe(0);
});

for (const viewport of DESKTOP_VIEWPORTS) {
  test(`four fields plus long names never break the floating layout at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openBasic(page);

    const longName = "非常に長い圃場名前テストデータ用の圃場名前です0123456789";
    const longFile = "とても長いNMEAファイル名前テスト用データ0123456789012345.txt";
    await registerField(page, longName, { timePrefix: "12" }, longFile);
    await page.waitForTimeout(1100); // session-id-per-second collision guard
    await registerField(page, "圃場2", { latBase: "3439.1880", lonBase: "13549.6892", timePrefix: "13" });
    await page.waitForTimeout(1100);
    await registerField(page, "圃場3", { latBase: "3439.0880", lonBase: "13549.5892", timePrefix: "14" });
    await page.waitForTimeout(1100);
    await registerField(page, "圃場4", { latBase: "3438.9880", lonBase: "13549.4892", timePrefix: "15" });

    const l = await layout(page);
    expect(l.pageScrollWidth).toBeLessThanOrEqual(l.pageClientWidth);
    expect(l.pageScrollHeight).toBeLessThanOrEqual(l.pageClientHeight);
    // Rails keep their declared widths -- long content scrolls/wraps inside.
    expect(l.leftRail.right).toBeLessThan(l.rightRail.left);
    expect(Math.round(l.mapWrap.width)).toBe(Math.round(l.main.width));
    for (const rail of [l.leftRail, l.rightRail]) {
      const scrollX = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el.scrollWidth - el.clientWidth;
      }, rail === l.leftRail ? ".panel-left" : ".panel-right");
      expect(scrollX).toBeLessThanOrEqual(1);
    }
  });
}

test("zero fields still yields the floating layout with no summary", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openBasic(page);
  const l = await layout(page);

  expect(l.chrome.waterSummary).toBeNull();
  expect(Math.round(l.mapWrap.width)).toBe(Math.round(l.main.width));
  expect(l.leftRail.left).toBeGreaterThan(l.mapWrap.left);
  expect(l.rightRail.right).toBeLessThan(l.mapWrap.right);
  expect(l.pageScrollWidth).toBeLessThanOrEqual(l.pageClientWidth);
});

// ---------------------------------------------------------------------------
// 5b. NMEA upload placement is viewport-dependent: right rail on desktop,
//     header (immediately left of 使い方) on phones -- exactly one either way
// ---------------------------------------------------------------------------

for (const viewport of DESKTOP_VIEWPORTS) {
  test(`the header NMEA control is absent on desktop at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openBasic(page);

    await expect(page.locator("#headerNmeaUploadButton")).toBeHidden();
    await expect(page.locator(".basic-upload-button")).toBeVisible();
  });
}

for (const viewport of MOBILE_VIEWPORTS) {
  test(`NMEA upload sits immediately left of 使い方 at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openBasic(page);

    const upload = page.locator("#headerNmeaUploadButton");
    const help = page.locator("#basicHelpButton");
    await expect(upload).toBeVisible();
    await expect(help).toBeVisible();

    // Exactly one upload affordance: the card's own button stands down.
    await expect(page.locator(".basic-upload-button")).toBeHidden();

    const [u, h] = [await upload.boundingBox(), await help.boundingBox()];
    // Immediately to the LEFT of 使い方, on the same row, with nothing between.
    expect(u.x + u.width).toBeLessThanOrEqual(h.x);
    expect(h.x - (u.x + u.width)).toBeLessThan(24);
    expect(Math.abs(u.y - h.y)).toBeLessThan(4);
    // Still a real touch target.
    expect(u.width).toBeGreaterThanOrEqual(44);
    expect(u.height).toBeGreaterThanOrEqual(44);

    // Both are in the header, and the single help control is untouched.
    await expect(page.locator("header #headerNmeaUploadButton")).toHaveCount(1);
    await expect(page.locator("#basicHelpButton")).toHaveCount(1);
  });
}

test("the header control drives the one real #basicNmeaInput, and upload still works on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openBasic(page);

  // It owns no <input> of its own -- there is still exactly one NMEA input,
  // and it keeps the deliberate absence of an accept filter (iOS picker).
  await expect(page.locator("#headerNmeaUploadButton input")).toHaveCount(0);
  await expect(page.locator("#basicNmeaInput")).toHaveCount(1);
  await expect(page.locator("#basicNmeaInput")).not.toHaveAttribute("accept", /.*/);

  // Clicking the header control forwards to that input.
  const forwarded = await page.evaluate(() => {
    const input = document.getElementById("basicNmeaInput");
    let hits = 0;
    const spy = (event) => { hits += 1; event.preventDefault(); };
    input.addEventListener("click", spy);
    document.getElementById("headerNmeaUploadButton").click();
    input.removeEventListener("click", spy);
    return hits;
  });
  expect(forwarded).toBe(1);

  // And the whole phone flow still completes through that input.
  await registerField(page, "\u5703\u58341");
  await expect(page.locator("#fieldAnnotationSummaryFields")).toHaveText("1");
});

test("the header control is Basic-mode only", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openBasic(page);
  await expect(page.locator("#headerNmeaUploadButton")).toBeVisible();

  for (const mode of ["drone", "settings"]) {
    await page.locator(`[data-mode-target="${mode}"]`).click();
    await expect(page.locator("body")).toHaveAttribute("data-mode", mode);
    await expect(page.locator("#headerNmeaUploadButton")).toBeHidden();
  }
});

// ---------------------------------------------------------------------------
// 6. Regression guards: mobile / 設定 / ドローン must NOT float
// ---------------------------------------------------------------------------

for (const viewport of MOBILE_VIEWPORTS) {
  test(`mobile ${viewport.width}x${viewport.height} keeps the stacked panel, with no floating leak`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openBasic(page);

    const mobile = await page.evaluate(() => {
      const left = document.querySelector(".panel-left");
      const right = document.querySelector(".panel-right");
      const csLeft = getComputedStyle(left);
      const card = left.querySelector(".card");
      const gate = document.querySelector(".gate-card").getBoundingClientRect();
      const fieldManagement = document.getElementById("basicFieldManagementCard").getBoundingClientRect();
      const nmea = document.getElementById("basicStage1Card").getBoundingClientRect();
      return {
        leftDisplay: csLeft.display,
        rightDisplay: getComputedStyle(right).display,
        leftPointerEvents: csLeft.pointerEvents,
        leftZIndex: csLeft.zIndex,
        leftBackdrop: csLeft.backdropFilter,
        cardBackdrop: getComputedStyle(card).backdropFilter,
        cardBackground: getComputedStyle(card).backgroundColor,
        mainColumns: getComputedStyle(document.querySelector("main")).gridTemplateColumns,
        gateBeforeFieldManagement: gate.top < fieldManagement.top,
        fieldManagementBeforeNmea: fieldManagement.top < nmea.top
      };
    });

    // The rails stay boxless, so the panel is the one flat stacked column.
    expect(mobile.leftDisplay).toBe("contents");
    expect(mobile.rightDisplay).toBe("contents");
    // None of the floating treatment reaches mobile.
    expect(mobile.leftPointerEvents).toBe("auto");
    expect(mobile.leftZIndex).toBe("auto");
    expect(mobile.leftBackdrop).toBe("none");
    expect(mobile.cardBackdrop).toBe("none");
    expect(mobile.cardBackground).toBe("rgb(251, 250, 245)");
    expect(mobile.mainColumns).toBe(`${viewport.width}px`);
    // Existing mobile ordering is preserved.
    expect(mobile.gateBeforeFieldManagement).toBe(true);
    expect(mobile.fieldManagementBeforeNmea).toBe(true);
  });
}

for (const mode of ["settings", "drone"]) {
  test(`${mode} mode keeps the side-by-side map + single panel shell`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openBasic(page);
    await page.locator(`[data-mode-target="${mode}"]`).click();
    await expect(page.locator("body")).toHaveAttribute("data-mode", mode);

    const shell = await page.evaluate(() => {
      const panel = document.querySelector("aside.panel");
      const mapWrap = document.querySelector(".map-wrap");
      const panelBox = panel.getBoundingClientRect();
      const mapBox = mapWrap.getBoundingClientRect();
      return {
        panelDisplay: getComputedStyle(panel).display,
        leftDisplay: getComputedStyle(document.querySelector(".panel-left")).display,
        rightDisplay: getComputedStyle(document.querySelector(".panel-right")).display,
        mapWrapZIndex: getComputedStyle(mapWrap).zIndex,
        panelBackground: getComputedStyle(panel).backgroundColor,
        sideBySide: mapBox.right <= panelBox.left + 1,
        mapIsNotFullBleed: mapBox.width < document.documentElement.clientWidth
      };
    });

    expect(shell.panelDisplay).toBe("grid");
    expect(shell.leftDisplay).toBe("contents");
    expect(shell.rightDisplay).toBe("contents");
    expect(shell.mapWrapZIndex).toBe("auto");
    expect(shell.panelBackground).toBe("rgb(244, 241, 232)");
    expect(shell.sideBySide).toBe(true);
    expect(shell.mapIsNotFullBleed).toBe(true);
  });
}
