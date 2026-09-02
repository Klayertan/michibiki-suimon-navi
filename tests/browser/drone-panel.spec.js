import { test, expect } from "@playwright/test";

// Drone / MAVLink panel.
//
// The real Python backend is not started for these tests: every request to
// 127.0.0.1:8787 is intercepted, so the panel is exercised against known
// states (disconnected, connected-disarmed, armed, read-only, backend down)
// with no serial port and no aircraft anywhere in the loop.

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

function status({ connectionState = "connected", armed = false, allowSafeCommands = true, mode = "mock" } = {}) {
  const connected = connectionState !== "disconnected";
  return {
    connectionState,
    connected,
    commandable: connectionState === "connected",
    mode,
    allowSafeCommands,
    armSupported: false,
    takeoffSupported: false,
    error: null,
    transport: { transport: mode, port: mode === "real" ? "COM10" : null, baud: mode === "real" ? 57600 : null },
    link: {
      stale: false,
      lastMessageAge: 0.2,
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
    gps: { fixType: 3, fixTypeName: "3D_FIX", satellites: 14, lat: 34.54, lon: 135.735, altMsl: 62.0 },
    attitude: { roll: 1.2, pitch: -0.8, yaw: 137.0, yawNormalized: 137.0 },
    motion: { heading: 137, groundSpeed: 0.05, airSpeed: 0.0, altitude: 62.0, climbRate: -0.01 },
    position: { lat: 34.54, lon: 135.735, altAmsl: 62.0, altRelative: 0.1, available: true },
    version: { flightSwVersion: "4.5.7" },
    statusTexts: [
      { severity: 6, severityName: "INFO", text: "ArduCopter V4.5.7 (simulated)", receivedAt: 1785000000 },
      { severity: 4, severityName: "WARNING", text: "PreArm: GPS horiz error", receivedAt: 1785000001 }
    ]
  };
}

/** Intercept the backend. `statusBody = null` simulates the backend being down. */
async function stubBackend(page, statusBody) {
  // The telemetry socket is never allowed to reach a real server; the panel
  // falls back to polling /api/drone/status, which is what we stub.
  await page.routeWebSocket(`${BACKEND.replace("http", "ws")}/api/drone/telemetry/ws`, (ws) => ws.close());

  await page.route(`${BACKEND}/**`, async (route) => {
    const url = route.request().url();
    if (statusBody === null) {
      await route.abort("connectionrefused");
      return;
    }
    if (url.endsWith("/api/health")) {
      await route.fulfill({ json: { status: "ok", version: "0.1.0", mode: "mock", linkRunning: true } });
      return;
    }
    if (url.endsWith("/api/drone/config")) {
      await route.fulfill({ json: CONFIG });
      return;
    }
    if (url.endsWith("/api/drone/status")) {
      await route.fulfill({ json: statusBody });
      return;
    }
    await route.fulfill({ json: { ok: true, reason: "accepted", message: "ok", detail: {} } });
  });
}

async function openDronePanel(page) {
  await page.goto("/#survey");
  await expect(page.locator("#dronePanel")).toBeAttached({ timeout: 15_000 });
  await page.evaluate(() => {
    const panel = document.getElementById("dronePanel");
    panel.hidden = false;
    panel.open = true;
  });
}

test("the panel offers no arm, takeoff, throttle or manual-flight control anywhere", async ({ page }) => {
  await stubBackend(page, status());
  await openDronePanel(page);

  // Nothing in the whole document may expose these affordances.
  for (const id of ["droneArmButton", "droneTakeoffButton", "droneLandButton", "droneRtlButton", "droneThrottle", "droneMotorTest"]) {
    await expect(page.locator(`#${id}`)).toHaveCount(0);
  }

  const buttonLabels = await page.locator("#dronePanel button").allInnerTexts();
  const forbidden = /arm|アーム|takeoff|離陸|throttle|スロットル|motor|モーター|rtl|land|着陸/i;
  for (const label of buttonLabels) {
    expect(label, `unsafe control found: ${label}`).not.toMatch(forbidden);
  }

  // The mode <select> may only ever contain the two allow-listed modes.
  await expect(page.locator("#droneModeSelect option")).toHaveText(["STABILIZE", "ALT_HOLD"]);
});

test("a connected disarmed vehicle renders its telemetry and enables mode controls", async ({ page }) => {
  await stubBackend(page, status());
  await openDronePanel(page);

  await expect(page.locator("#droneBackendStatus")).toHaveText("応答あり");
  await expect(page.locator("#droneConnectionState")).toContainText("接続済み");
  await expect(page.locator("#droneModeBadge")).toContainText("モック");

  await expect(page.locator("#droneFlightMode")).toHaveText("STABILIZE");
  await expect(page.locator("#droneArmedState")).toContainText("DISARMED");
  await expect(page.locator("#droneVoltage")).toHaveText("16.21 V");
  await expect(page.locator("#droneCurrent")).toHaveText("1.42 A");
  await expect(page.locator("#droneBatteryPercent")).toHaveText("96%");
  await expect(page.locator("#droneFixType")).toHaveText("3D測位");
  await expect(page.locator("#droneSatellites")).toHaveText("14");
  await expect(page.locator("#droneLat")).toHaveText("34.5400000");
  await expect(page.locator("#droneHeading")).toHaveText("137°");
  await expect(page.locator("#droneFirmware")).toContainText("4.5.7");

  await expect(page.locator("#droneArmedWarning")).toBeHidden();
  await expect(page.locator("#droneModeSelect")).toBeEnabled();
  await expect(page.locator("#droneApplyModeButton")).toBeEnabled();
  await expect(page.locator("#droneDisconnectButton")).toBeEnabled();
  await expect(page.locator("#droneConnectButton")).toBeDisabled();
});

// GNSS position availability -- regression coverage for a defect where the
// panel showed 測位可否: 利用可能 on real hardware reporting no GPS fix at
// all (fix type NO_FIX, 0 satellites, lat/lon 0.0000000). Two independent
// bugs stacked: the backend computed `position.available` from
// GLOBAL_POSITION_INT lat/lon alone (ArduPilot reports those as a literal 0,
// not null, while it has no fix), and the frontend *separately* re-derived
// availability as `position.available || (gps.lat !== null ...)`, which
// would still show 利用可能 even once the backend was fixed. These tests
// stub exactly the corrected backend payload for the bad-fix case (as
// TelemetryState now computes it) and prove the frontend no longer
// second-guesses that with its own OR against the raw GPS fields.

test("a vehicle with no GPS fix shows 利用不可（GPS Fixなし）even though the raw coordinate is a non-null zero", async ({ page }) => {
  const noFix = status();
  // The exact real-hardware shape: fix type NO_FIX, 0 satellites, lat/lon
  // reported as literal 0 (not null) by both GPS_RAW_INT and the fused
  // GLOBAL_POSITION_INT -- and the backend now correctly says unavailable.
  noFix.gps = { fixType: 1, fixTypeName: "NO_FIX", satellites: 0, lat: 0, lon: 0, altMsl: 0 };
  noFix.position = { lat: 0, lon: 0, altAmsl: 0, altRelative: 0, available: false };

  await stubBackend(page, noFix);
  await openDronePanel(page);

  await expect(page.locator("#droneFixType")).toHaveText("測位なし");
  await expect(page.locator("#droneSatellites")).toHaveText("0");
  await expect(page.locator("#dronePositionAvailable")).toHaveText("利用不可（GPS Fixなし）");
  await expect(page.locator("#dronePositionAvailable")).toHaveAttribute("data-tone", "warn");
  // The label must not mention "indoors" -- that fact is not actually known.
  await expect(page.locator("#dronePositionAvailable")).not.toContainText("屋内");
});

test("a null GPS fix type shows unavailable, not available", async ({ page }) => {
  const noFixType = status();
  noFixType.gps = { fixType: null, fixTypeName: null, satellites: null, lat: null, lon: null, altMsl: null };
  noFixType.position = { lat: null, lon: null, altAmsl: null, altRelative: null, available: false };

  await stubBackend(page, noFixType);
  await openDronePanel(page);

  await expect(page.locator("#dronePositionAvailable")).toHaveText("利用不可（GPS Fixなし）");
});

test("a valid 3D fix continues to show 利用可能, including in mock mode", async ({ page }) => {
  await stubBackend(page, status()); // default fixture: fixType 3, mock mode
  await openDronePanel(page);

  await expect(page.locator("#dronePositionAvailable")).toHaveText("利用可能");
  await expect(page.locator("#dronePositionAvailable")).toHaveAttribute("data-tone", "ok");
});

test("a real, valid (0, 0) coordinate with a good fix is shown as available, not rejected for being zero", async ({ page }) => {
  const nullIsland = status();
  nullIsland.gps = { fixType: 3, fixTypeName: "3D_FIX", satellites: 12, lat: 0, lon: 0, altMsl: 0 };
  nullIsland.position = { lat: 0, lon: 0, altAmsl: 0, altRelative: 0, available: true };

  await stubBackend(page, nullIsland);
  await openDronePanel(page);

  await expect(page.locator("#dronePositionAvailable")).toHaveText("利用可能");
  await expect(page.locator("#droneLat")).toHaveText("0.0000000");
  await expect(page.locator("#droneLon")).toHaveText("0.0000000");
});

test("the frontend trusts the backend's availability verdict and does not re-derive it from a raw GPS coordinate", async ({ page }) => {
  // Directly targets the removed `position.available || gps.lat !== null`
  // bug: the backend says unavailable, but gps.lat is a non-null (nonzero,
  // even) value. Pre-fix, the OR would have shown 利用可能 anyway.
  const inconsistent = status();
  inconsistent.gps = { fixType: 1, fixTypeName: "NO_FIX", satellites: 3, lat: 12.3456789, lon: 98.7654321, altMsl: 10 };
  inconsistent.position = { lat: null, lon: null, altAmsl: null, altRelative: null, available: false };

  await stubBackend(page, inconsistent);
  await openDronePanel(page);

  await expect(page.locator("#dronePositionAvailable")).toHaveText("利用不可（GPS Fixなし）");
});

test("an armed vehicle shows a strong warning and disables every mode control", async ({ page }) => {
  await stubBackend(page, status({ armed: true }));
  await openDronePanel(page);

  const warning = page.locator("#droneArmedWarning");
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("ARMED");
  await expect(warning).toHaveAttribute("role", "alert");

  await expect(page.locator("#droneArmedState")).toContainText("ARMED");
  await expect(page.locator("#droneModeSelect")).toBeDisabled();
  await expect(page.locator("#droneApplyModeButton")).toBeDisabled();
  await expect(page.locator("#droneControlsNote")).toContainText("ARMED");
});

test("a disconnected link disables mode controls but allows connecting", async ({ page }) => {
  await stubBackend(page, status({ connectionState: "disconnected" }));
  await openDronePanel(page);

  await expect(page.locator("#droneConnectionState")).toContainText("未接続");
  await expect(page.locator("#droneConnectButton")).toBeEnabled();
  await expect(page.locator("#droneDisconnectButton")).toBeDisabled();
  await expect(page.locator("#droneModeSelect")).toBeDisabled();
  await expect(page.locator("#droneApplyModeButton")).toBeDisabled();
});

test("stale telemetry is reported in words and blocks commands", async ({ page }) => {
  const stale = status({ connectionState: "telemetry_stale" });
  stale.commandable = false;
  stale.link.stale = true;
  stale.link.lastMessageAge = 8.4;
  await stubBackend(page, stale);
  await openDronePanel(page);

  await expect(page.locator("#droneConnectionState")).toContainText("テレメトリ途絶");
  await expect(page.locator("#droneFreshness")).toContainText("途絶");
  await expect(page.locator("#droneApplyModeButton")).toBeDisabled();
});

test("a read-only backend explains why commands are unavailable", async ({ page }) => {
  await stubBackend(page, status({ allowSafeCommands: false }));
  await openDronePanel(page);

  await expect(page.locator("#droneReadOnlyNote")).toBeVisible();
  await expect(page.locator("#droneReadOnlyNote")).toContainText("SUISUI_MAVLINK_ALLOW_SAFE_COMMANDS");
  await expect(page.locator("#droneApplyModeButton")).toBeDisabled();
  await expect(page.locator("#droneRequestVersionButton")).toBeDisabled();
});

test("real mode requires the propellers-removed confirmation and shows the serial port", async ({ page }) => {
  await stubBackend(page, status({ mode: "real" }));
  await openDronePanel(page);

  await expect(page.locator("#droneModeBadge")).toContainText("実機モード");
  await expect(page.locator("#dronePort")).toHaveText("COM10");
  await expect(page.locator("#droneBaud")).toHaveText("57600");
  await expect(page.locator("#dronePropsConfirmRow")).toBeVisible();
  await expect(page.locator("#dronePropsConfirm")).not.toBeChecked();
});

test("an unreachable backend is reported plainly and disables the controls", async ({ page }) => {
  await stubBackend(page, null);
  await openDronePanel(page);

  await expect(page.locator("#droneBackendStatus")).toContainText("応答なし");
  await expect(page.locator("#droneConnectButton")).toBeDisabled();
  await expect(page.locator("#droneApplyModeButton")).toBeDisabled();
  await expect(page.locator("#droneControlsNote")).toContainText("バックエンド");
});

test("vehicle messages are listed with severity and time", async ({ page }) => {
  await stubBackend(page, status());
  await openDronePanel(page);

  const messages = page.locator("#droneMessageList .drone-message");
  await expect(messages).toHaveCount(2);
  await expect(messages.first()).toContainText("PreArm: GPS horiz error");
  await expect(messages.first()).toContainText("警告");
  await expect(messages.first()).toHaveAttribute("data-tone", "warn");
});

test("status is announced through an ARIA live region, not colour alone", async ({ page }) => {
  await stubBackend(page, status());
  await openDronePanel(page);

  const live = page.locator("#droneStatusMessage");
  await expect(live).toHaveAttribute("aria-live", "polite");
  await expect(live).toHaveAttribute("role", "status");
  await expect(live).toContainText("接続済み");

  // Every tone chip must carry text; a tone with an empty label would be a
  // colour-only signal.
  const chips = await page.locator("#dronePanel .drone-chip").allInnerTexts();
  for (const chip of chips) {
    expect(chip.trim().length).toBeGreaterThan(0);
  }
});

test("the mode select is labelled and reachable by keyboard", async ({ page }) => {
  await stubBackend(page, status());
  await openDronePanel(page);

  await expect(page.locator("label[for='droneModeSelect']")).toHaveCount(1);
  // The control starts disabled and is enabled once the first status arrives;
  // focusing before that would silently do nothing.
  await expect(page.locator("#droneModeSelect")).toBeEnabled();
  await page.locator("#droneModeSelect").focus();
  await expect(page.locator("#droneModeSelect")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#droneApplyModeButton")).toBeFocused();
});

test("the existing survey workflow still works with the drone panel present", async ({ page }) => {
  await stubBackend(page, status());
  await page.goto("/#survey");
  await expect(page.locator("#dronePanel")).toBeAttached({ timeout: 15_000 });

  // The pre-existing recording panel and its controls are untouched.
  await expect(page.locator("#serialConnectButton")).toBeAttached();
  await expect(page.locator("#recStartButton")).toBeAttached();
  await expect(page.locator("#deviceSourceSelect")).toBeAttached();
});

// Regression coverage: 開発ツール's header button ("バックエンド状態を確認")
// used to have no case of its own, so it fell into the generic else branch
// and clicked 詳細解析's demo-data loader instead -- a card that isn't even
// part of 開発ツール. It must re-check the drone/MAVLink backend instead.
test("開発ツール's 「バックエンド状態を確認」 header button re-checks the drone backend, not the demo loader", async ({ page }) => {
  await stubBackend(page, status());
  await page.goto("/#settings/devtools");
  await expect(page.locator("#dronePanel")).toBeVisible();
  await expect(page.locator("#workspacePrimaryAction")).toHaveText("バックエンド状態を確認");

  await page.waitForFunction(() => window.droneController);
  await page.evaluate(() => {
    window.__healthCalls = 0;
    const original = window.droneController.refreshHealthAndConfig.bind(window.droneController);
    window.droneController.refreshHealthAndConfig = (...args) => {
      window.__healthCalls += 1;
      return original(...args);
    };
    window.__demoClicked = false;
    document.getElementById("loadPaddyDemoButton").addEventListener("click", () => {
      window.__demoClicked = true;
    });
  });

  await page.locator("#workspacePrimaryAction").click();

  await expect.poll(() => page.evaluate(() => window.__healthCalls)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__demoClicked)).toBe(false);
});
