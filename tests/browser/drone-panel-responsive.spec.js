import { test, expect } from "@playwright/test";

// Responsive layout of the Drone / MAVLink panel.
//
// The panel lives in the right sidebar, which `main` sizes independently of the
// window, so a wide window does not imply a wide panel. These tests therefore
// assert on measured geometry rather than on viewport width: nothing may spill
// out of the panel, no two badges/labels may overlap, and every control must
// stay usable — at desktop widths and at phone widths alike.
//
// Regression guard for: `.kv span { white-space: nowrap }` in index.html is a
// descendant selector, so it also reached the `<span class="drone-chip">`
// badges nested inside `<strong>` and stopped them ever wrapping. A badge such
// as "モック（模擬）モード — 実機に接続していません" then rendered ~355px wide inside a
// ~175px column, overlapping its neighbour and forcing the panel to scroll
// sideways.

const BACKEND = "http://127.0.0.1:8787";

const CONFIG = {
  config: {
    mode: "mock",
    port: null,
    baud: null,
    allowSafeCommands: true,
    armSupported: false,
    takeoffSupported: false,
    allowedModes: ["STABILIZE", "ALT_HOLD"]
  },
  allowedModes: ["STABILIZE", "ALT_HOLD"],
  allowedStreams: ["ATTITUDE", "GLOBAL_POSITION_INT", "GPS_RAW_INT", "SYS_STATUS", "VFR_HUD"],
  disabledOperations: { arm: "not implemented", takeoff: "not implemented" }
};

/** Worst-case content: the longest badge strings the UI can actually produce. */
function status({ mode = "mock", allowSafeCommands = true, armed = false, connectionState = "connected" } = {}) {
  return {
    connectionState,
    connected: connectionState !== "disconnected",
    commandable: connectionState === "connected",
    mode,
    allowSafeCommands,
    armSupported: false,
    takeoffSupported: false,
    error: null,
    transport: {
      transport: mode,
      port: mode === "real" ? "COM10" : null,
      baud: mode === "real" ? 57600 : null
    },
    link: {
      stale: connectionState === "telemetry_stale",
      lastMessageAge: connectionState === "telemetry_stale" ? 8.4 : 0.2,
      lastMessageAt: 1785000000,
      lastHeartbeatAge: 0.3,
      lastHeartbeatAt: 1785000000,
      gcsHeartbeatsSent: 12,
      messageCounts: { HEARTBEAT: 12 },
      totalMessages: 120
    },
    vehicle: {
      armed,
      flightMode: "STABILIZE",
      vehicleTypeName: "QUADROTOR",
      autopilotName: "ARDUPILOTMEGA",
      systemId: 1,
      componentId: 1
    },
    battery: { voltage: 16.21, current: 1.42, remaining: 96, sensorsOk: true },
    // No fix: exercises the long "利用不可（屋内では測位できません）" badge.
    gps: { fixType: 1, fixTypeName: "NO_FIX", satellites: 4, lat: null, lon: null, altMsl: null },
    attitude: { roll: 1.2, pitch: -0.8, yaw: 137.0, yawNormalized: 137.0 },
    motion: { heading: 137, groundSpeed: 0.05, airSpeed: 0.0, altitude: 62.0, climbRate: -0.01 },
    position: { lat: null, lon: null, altAmsl: null, altRelative: null, available: false },
    version: { flightSwVersion: "4.5.7" },
    statusTexts: [
      { severity: 6, severityName: "INFO", text: "ArduCopter V4.5.7 (simulated)", receivedAt: 1785000000 },
      {
        severity: 4,
        severityName: "WARNING",
        text: "PreArm: GPS horiz error exceeds threshold, waiting for 3D fix",
        receivedAt: 1785000001
      }
    ]
  };
}

async function stubBackend(page, statusBody) {
  await page.routeWebSocket(`${BACKEND.replace("http", "ws")}/api/drone/telemetry/ws`, (ws) => ws.close());
  await page.route(`${BACKEND}/**`, async (route) => {
    const url = route.request().url();
    if (url.endsWith("/api/health")) {
      return route.fulfill({ json: { status: "ok", version: "0.1.0", mode: "mock", linkRunning: true } });
    }
    if (url.endsWith("/api/drone/config")) return route.fulfill({ json: CONFIG });
    if (url.endsWith("/api/drone/status")) return route.fulfill({ json: statusBody });
    return route.fulfill({ json: { ok: true, reason: "accepted", message: "ok", detail: {} } });
  });
}

async function openPanel(page, { width, height }, statusBody) {
  await page.setViewportSize({ width, height });
  await stubBackend(page, statusBody);
  await page.goto("/#survey");
  await expect(page.locator("#dronePanel")).toBeAttached({ timeout: 15_000 });
  await page.evaluate(() => {
    const panel = document.getElementById("dronePanel");
    panel.hidden = false;
    panel.open = true;
  });
  // Wait for the first telemetry render, so measurements run against populated
  // content rather than the em-dash placeholders.
  await expect(page.locator("#droneVoltage")).toHaveText("16.21 V");
}

/** Elements whose right edge extends past the panel's content box. */
function measureSpill(page) {
  return page.evaluate(() => {
    const panel = document.getElementById("dronePanel");
    const content = panel.querySelector(".details-content");
    const edge = content.getBoundingClientRect().right;
    const spills = [];
    panel.querySelectorAll("*").forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) return;
      // 1px tolerance absorbs sub-pixel rounding of fractional layout widths.
      if (rect.right - edge > 1) {
        spills.push({
          selector: el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}`,
          spill: Math.round(rect.right - edge),
          text: (el.textContent || "").trim().slice(0, 40)
        });
      }
    });
    return spills;
  });
}

/** Pairwise geometric intersection of every badge and every row label. */
function measureOverlaps(page) {
  return page.evaluate(() => {
    const panel = document.getElementById("dronePanel");
    const boxes = [];

    panel.querySelectorAll(".drone-chip").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width) boxes.push({ id: el.id || `chip:${el.textContent.trim().slice(0, 12)}`, r });
    });
    panel.querySelectorAll(".kv > span, .kv > strong").forEach((el, index) => {
      const r = el.getBoundingClientRect();
      if (r.width) boxes.push({ id: `${el.tagName}${index}:${el.textContent.trim().slice(0, 12)}`, r });
    });

    const hits = [];
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i];
        const b = boxes[j];
        // A chip nested inside its own <strong> legitimately intersects it.
        if (a.id.startsWith("STRONG") || b.id.startsWith("STRONG")) {
          const inner = a.id.startsWith("STRONG") ? b : a;
          const outer = a.id.startsWith("STRONG") ? a : b;
          if (
            inner.r.left >= outer.r.left - 1 &&
            inner.r.right <= outer.r.right + 1 &&
            inner.r.top >= outer.r.top - 1 &&
            inner.r.bottom <= outer.r.bottom + 1
          ) {
            continue;
          }
        }
        const ox = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const oy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (ox > 1 && oy > 1) {
          hits.push({ a: a.id, b: b.id, overlap: `${Math.round(ox)}x${Math.round(oy)}` });
        }
      }
    }
    return hits;
  });
}

const VIEWPORTS = [
  { label: "1714x927 desktop", width: 1714, height: 927 },
  { label: "1366x768 laptop", width: 1366, height: 768 },
  { label: "480x900 narrow", width: 480, height: 900 },
  { label: "390x844 phone", width: 390, height: 844 }
];

const SCENARIOS = [
  { label: "mock connected", state: {} },
  { label: "real connected", state: { mode: "real" } },
  { label: "real armed", state: { mode: "real", armed: true } },
  { label: "real read-only", state: { mode: "real", allowSafeCommands: false } },
  { label: "telemetry stale", state: { mode: "real", connectionState: "telemetry_stale" } }
];

for (const viewport of VIEWPORTS) {
  test(`no horizontal overflow at ${viewport.label}`, async ({ page }) => {
    await openPanel(page, viewport, status());

    const scroll = await page.evaluate(() => {
      const panel = document.getElementById("dronePanel");
      const content = panel.querySelector(".details-content");
      const list = panel.querySelector(".drone-message-list");
      return {
        panel: { scrollWidth: panel.scrollWidth, clientWidth: panel.clientWidth },
        content: { scrollWidth: content.scrollWidth, clientWidth: content.clientWidth },
        messages: { scrollWidth: list.scrollWidth, clientWidth: list.clientWidth }
      };
    });

    expect(scroll.panel.scrollWidth, "the panel must not scroll sideways").toBeLessThanOrEqual(
      scroll.panel.clientWidth + 1
    );
    expect(scroll.content.scrollWidth).toBeLessThanOrEqual(scroll.content.clientWidth + 1);
    expect(scroll.messages.scrollWidth).toBeLessThanOrEqual(scroll.messages.clientWidth + 1);

    expect(await measureSpill(page), "no element may extend past the panel content box").toEqual([]);
  });

  test(`badges and labels never overlap at ${viewport.label}`, async ({ page }) => {
    await openPanel(page, viewport, status());
    expect(await measureOverlaps(page), "badges must not cover labels or each other").toEqual([]);
  });

  test(`controls stay visible and usable at ${viewport.label}`, async ({ page }) => {
    await openPanel(page, viewport, status());

    const controls = [
      "#droneConnectButton",
      "#droneDisconnectButton",
      "#droneRequestVersionButton",
      "#droneModeSelect",
      "#droneApplyModeButton"
    ];

    const panelBox = await page.locator("#dronePanel .details-content").boundingBox();
    for (const selector of controls) {
      const locator = page.locator(selector);
      await expect(locator, `${selector} must be visible`).toBeVisible();

      const box = await locator.boundingBox();
      expect(box.width, `${selector} must not collapse`).toBeGreaterThan(60);
      expect(box.height, `${selector} must stay tappable`).toBeGreaterThanOrEqual(30);
      expect(box.x, `${selector} must not sit left of the panel`).toBeGreaterThanOrEqual(panelBox.x - 1);
      expect(
        box.x + box.width,
        `${selector} must not extend past the panel`
      ).toBeLessThanOrEqual(panelBox.x + panelBox.width + 1);
    }

    // The mode select and its Apply button are the narrowest-squeezed pair.
    const select = await page.locator("#droneModeSelect").boundingBox();
    expect(select.width, "the mode dropdown must keep a usable width").toBeGreaterThan(120);
  });
}

for (const scenario of SCENARIOS) {
  test(`layout holds for "${scenario.label}" in a narrow panel`, async ({ page }) => {
    await openPanel(page, { width: 390, height: 844 }, status(scenario.state));

    expect(await measureSpill(page)).toEqual([]);
    expect(await measureOverlaps(page)).toEqual([]);

    const scroll = await page.evaluate(() => {
      const panel = document.getElementById("dronePanel");
      return { scrollWidth: panel.scrollWidth, clientWidth: panel.clientWidth };
    });
    expect(scroll.scrollWidth).toBeLessThanOrEqual(scroll.clientWidth + 1);
  });
}

test("the long mode badge wraps instead of overflowing its row", async ({ page }) => {
  await openPanel(page, { width: 390, height: 844 }, status());

  const geometry = await page.evaluate(() => {
    const badge = document.getElementById("droneModeBadge");
    const row = badge.closest(".kv");
    const badgeRect = badge.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    return {
      badgeWidth: badgeRect.width,
      rowWidth: rowRect.width,
      badgeHeight: badgeRect.height,
      // A single line of this chip is ~31px tall.
      wrapped: badgeRect.height > 40,
      whiteSpace: getComputedStyle(badge).whiteSpace
    };
  });

  expect(geometry.whiteSpace, "the badge must be allowed to wrap").not.toBe("nowrap");
  expect(geometry.badgeWidth).toBeLessThanOrEqual(geometry.rowWidth + 1);
  expect(geometry.wrapped, "this string is too long for 336px and should wrap").toBe(true);
});

test("the read-only note's environment variable name does not force a scrollbar", async ({ page }) => {
  await openPanel(page, { width: 390, height: 844 }, status({ mode: "real", allowSafeCommands: false }));

  const note = page.locator("#droneReadOnlyNote");
  await expect(note).toBeVisible();

  const fits = await page.evaluate(() => {
    const el = document.getElementById("droneReadOnlyNote");
    const code = el.querySelector("code");
    const contentRight = document.querySelector("#dronePanel .details-content").getBoundingClientRect().right;
    return {
      codeRight: code.getBoundingClientRect().right,
      contentRight,
      scrolls: el.scrollWidth > el.clientWidth + 1
    };
  });

  expect(fits.scrolls, "SUISUI_MAVLINK_ALLOW_SAFE_COMMANDS must wrap inside the note").toBe(false);
  expect(fits.codeRight).toBeLessThanOrEqual(fits.contentRight + 1);
});

test("telemetry metrics stay two-up and readable in a narrow panel", async ({ page }) => {
  await openPanel(page, { width: 390, height: 844 }, status());

  const metrics = page.locator("#dronePanel .metric");
  await expect(metrics).toHaveCount(6);

  const boxes = await metrics.evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { x: Math.round(rect.x), width: Math.round(rect.width), height: Math.round(rect.height) };
    })
  );

  for (const box of boxes) {
    expect(box.width, "a metric tile must not collapse").toBeGreaterThan(100);
    expect(box.height).toBeGreaterThan(30);
  }
  // Two columns: the tiles occupy exactly two distinct x positions.
  expect(new Set(boxes.map((box) => box.x)).size).toBe(2);
});

test("no status is conveyed by colour alone after the layout changes", async ({ page }) => {
  await openPanel(page, { width: 390, height: 844 }, status({ mode: "real", armed: true }));

  // Every toned chip must still carry text, at every width.
  const chips = await page.locator("#dronePanel .drone-chip").evaluateAll((nodes) =>
    nodes.map((node) => ({ tone: node.dataset.tone || "", text: (node.textContent || "").trim() }))
  );
  expect(chips.length).toBeGreaterThan(5);
  for (const chip of chips) {
    expect(chip.text.length, `a ${chip.tone} chip rendered with no text`).toBeGreaterThan(0);
  }

  await expect(page.locator("#droneArmedWarning")).toBeVisible();
  await expect(page.locator("#droneArmedWarning")).toContainText("ARMED");
});
