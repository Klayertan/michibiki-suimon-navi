import { test, expect } from "@playwright/test";

// Pilot velocity control panel.
//
// No Python backend, no serial port and no aircraft are involved: every
// request to 127.0.0.1:8787 is intercepted and recorded, so these tests prove
// exactly *what the browser would transmit* for a given set of keypresses,
// which is the part of the system a first flight depends on.

const BACKEND = "http://127.0.0.1:8787";

const LIMITS = {
  maxHorizontalSpeed: 0.3,
  maxClimbSpeed: 0.3,
  maxDescentSpeed: 0.2,
  maxYawRateDeg: 12.0
};

function pilotSnapshot(overrides = {}) {
  return {
    available: true,
    enabled: false,
    outputActive: false,
    blockedReason: "not_enabled",
    requiredMode: "GUIDED",
    limits: LIMITS,
    setpoint: { vx: 0, vy: 0, vz: 0, yawRate: 0 },
    axes: { forward: 0, right: 0, up: 0, yaw: 0 },
    inputAgeSeconds: null,
    inputTimeoutSeconds: 0.5,
    setpointRateHz: 15.0,
    setpointsSent: 0,
    lastSentAt: null,
    sequence: 0,
    error: null,
    armSupported: false,
    takeoffSupported: false,
    ...overrides
  };
}

function status({ pilot = pilotSnapshot(), armed = false, flightMode = "STABILIZE" } = {}) {
  return {
    connectionState: "connected",
    connected: true,
    commandable: true,
    mode: "mock",
    allowSafeCommands: true,
    armSupported: false,
    takeoffSupported: false,
    error: null,
    transport: { transport: "mock", port: null, baud: null },
    link: { stale: false, lastMessageAge: 0.2, lastHeartbeatAge: 0.3, messageCounts: {}, totalMessages: 10 },
    vehicle: { armed, flightMode, vehicleTypeName: "QUADROTOR", autopilotName: "ARDUPILOTMEGA", systemId: 1, componentId: 1 },
    battery: { voltage: 16.2, current: 1.4, remaining: 96, sensorsOk: true },
    gps: { fixType: 3, fixTypeName: "3D_FIX", satellites: 14, lat: 34.54, lon: 135.735, altMsl: 62.0 },
    attitude: { roll: 0, pitch: 0, yaw: 0, yawNormalized: 0 },
    motion: { heading: 0, groundSpeed: 0, airSpeed: 0, altitude: 62, climbRate: 0 },
    position: { lat: 34.54, lon: 135.735, altAmsl: 62, altRelative: 0.1, available: true },
    version: { flightSwVersion: "4.5.7" },
    statusTexts: [],
    pilot
  };
}

/**
 * Intercept the backend and record every pilot request.
 * Returns the recorder; `posts` is filled as the page runs.
 */
async function stubBackend(page, statusBody) {
  const posts = [];
  await page.routeWebSocket(`${BACKEND.replace("http", "ws")}/api/drone/telemetry/ws`, (ws) => ws.close());

  await page.route(`${BACKEND}/**`, async (route) => {
    const request = route.request();
    const url = request.url();

    if (url.includes("/api/drone/pilot/")) {
      let body = null;
      try {
        body = request.postDataJSON();
      } catch {
        body = null;
      }
      posts.push({ path: url.replace(BACKEND, ""), body });
      const enabled = !url.endsWith("/disable");
      await route.fulfill({
        json: { ok: true, reason: "accepted", message: "", detail: { pilot: pilotSnapshot({ enabled }) } }
      });
      return;
    }
    if (url.endsWith("/api/health")) {
      await route.fulfill({ json: { status: "ok", version: "0.1.0", mode: "mock", linkRunning: true } });
      return;
    }
    if (url.endsWith("/api/drone/config")) {
      await route.fulfill({
        json: {
          config: { mode: "mock", port: null, baud: null, allowSafeCommands: true, armSupported: false, takeoffSupported: false, allowedModes: ["STABILIZE", "ALT_HOLD"] },
          allowedModes: ["STABILIZE", "ALT_HOLD"],
          allowedStreams: [],
          disabledOperations: {}
        }
      });
      return;
    }
    if (url.endsWith("/api/drone/status")) {
      await route.fulfill({ json: statusBody });
      return;
    }
    await route.fulfill({ json: { ok: true, reason: "accepted", message: "ok", detail: {} } });
  });

  const inputs = () => posts.filter((p) => p.path.endsWith("/input"));
  return {
    posts,
    inputs,
    paths: () => posts.map((p) => p.path),
    /**
     * Frames sent from `index` onwards. Used to assert that a stop really
     * stopped: after a neutral, the controller keeps refreshing at the
     * keepalive interval, and those refresh frames carry `neutral: false`
     * with zero axes. Checking only the *last* frame would therefore be a
     * race. What must hold is that a neutral was sent and nothing after it
     * commands movement.
     */
    since: (index) => inputs().slice(index),
    movement: (frames) =>
      frames.filter((p) => ["forward", "right", "up", "yaw"].some((k) => (p.body?.[k] ?? 0) !== 0))
  };
}

async function openPilotPanel(page, statusBody = status()) {
  const recorder = await stubBackend(page, statusBody);
  await page.goto("/#survey");
  await expect(page.locator("#pilotPanel")).toBeAttached({ timeout: 15_000 });
  return recorder;
}

async function reveal(page) {
  await page.waitForFunction(() => Boolean(window.pilotControlPanel));
  await page.evaluate(() => {
    const panel = document.getElementById("pilotPanel");
    panel.hidden = false;
    panel.open = true;
  });
}

/** Enable the control channel the way an operator would: by clicking. */
async function enableControl(page) {
  await page.locator("#pilotEnableButton").click();
  await expect(page.locator("#pilotEnabled")).toContainText("有効");
}

const axis = (page, name) => page.locator(`#pilotAxis-${name}`);

/**
 * Assert that a stop actually stopped: a neutral frame was sent after `from`,
 * and no frame from that neutral onwards commands movement.
 *
 * Checking only the newest frame would be a race — after a neutral the
 * controller keeps refreshing at its keepalive interval, and those refreshes
 * are ordinary zero frames with `neutral: false`.
 */
async function expectStopped(backend, from) {
  await expect.poll(() => backend.since(from).some((p) => p.body?.neutral === true)).toBe(true);
  const frames = backend.since(from);
  const neutralAt = frames.findIndex((p) => p.body?.neutral === true);
  expect(backend.movement(frames.slice(neutralAt))).toEqual([]);
}

// ----------------------------------------------------------------------
// Visibility and defaults
// ----------------------------------------------------------------------

test("the panel stays hidden and unmounted when the backend has not enabled pilot control", async ({ page }) => {
  await openPilotPanel(page, status({ pilot: pilotSnapshot({ available: false, blockedReason: "pilot_control_disabled" }) }));
  // Give the bootstrap the same time it would have had to mount.
  await page.waitForTimeout(1000);

  expect(await page.evaluate(() => Boolean(window.pilotControlPanel))).toBe(false);
  await expect(page.locator("#pilotPanel")).toBeHidden();
  await expect(page.locator("#pilotRoot")).toBeEmpty();
});

test("an available panel shows the source, mode, armed state and the configured limits", async ({ page }) => {
  await openPilotPanel(page);
  await reveal(page);

  await expect(page.locator("#pilotSource")).toContainText("None");
  await expect(page.locator("#pilotEnabled")).toContainText("無効");
  await expect(page.locator("#pilotOutput")).toContainText("停止");
  await expect(page.locator("#pilotMode")).toHaveText("STABILIZE");
  await expect(page.locator("#pilotArmed")).toContainText("DISARMED");

  await expect(page.locator("#pilotLimitH")).toHaveText("0.30 m/s");
  await expect(page.locator("#pilotLimitUp")).toHaveText("0.30 m/s");
  await expect(page.locator("#pilotLimitDown")).toHaveText("0.20 m/s");
  await expect(page.locator("#pilotLimitYaw")).toHaveText("12 °/s");
});

test("the panel says plainly that this is a low-speed test mode, not an RC replacement", async ({ page }) => {
  await openPilotPanel(page);
  await reveal(page);
  await expect(page.locator("#pilotPanel")).toContainText("not a replacement for an RC transmitter");
});

test("the panel exposes no arm, takeoff, land or motor control, and Space is not called a kill switch", async ({ page }) => {
  await openPilotPanel(page);
  await reveal(page);

  const labels = await page.locator("#pilotPanel button").allInnerTexts();
  for (const label of labels) {
    expect(label, `unsafe control found: ${label}`).not.toMatch(/arm|アーム|takeoff|離陸|land|着陸|rtl|throttle|スロットル|motor|モーター/i);
  }
  // textContent, not innerText: the key-mapping table is inside a collapsed
  // <details> and its wording matters just as much as the visible copy.
  const text = await page.locator("#pilotPanel").textContent();
  expect(text).not.toMatch(/緊急停止|モーター停止|emergency stop/i);
  // The one permitted use of the word is the disclaimer itself.
  expect(text).toMatch(/not a motor kill/i);
  expect(text.replace(/not a motor kill/gi, "")).not.toMatch(/kill/i);
});

// ----------------------------------------------------------------------
// Keys only work once the operator opts in
// ----------------------------------------------------------------------

test("arrow keys transmit nothing before the channel is enabled", async ({ page }) => {
  const backend = await openPilotPanel(page);
  await reveal(page);

  await page.keyboard.down("ArrowUp");
  await page.waitForTimeout(400);
  await page.keyboard.up("ArrowUp");

  expect(backend.inputs()).toEqual([]);
  await expect(axis(page, "forward")).toHaveText("0.00");
});

test("enabling opens the channel without arming anything", async ({ page }) => {
  const backend = await openPilotPanel(page);
  await reveal(page);
  await enableControl(page);

  expect(backend.paths()).toContain("/api/drone/pilot/enable");
  // Nothing that could arm, take off or move a servo may ever be requested.
  for (const path of backend.paths()) {
    expect(path).not.toMatch(/arm|takeoff|land|rtl|servo|motor/i);
  }
  await expect(page.locator("#pilotSource")).toContainText("Keyboard");
});

// ----------------------------------------------------------------------
// The mapping
// ----------------------------------------------------------------------

const MAPPING = [
  { key: "ArrowUp", name: "forward", value: "1.00" },
  { key: "ArrowDown", name: "forward", value: "-1.00" },
  { key: "ArrowRight", name: "right", value: "1.00" },
  { key: "ArrowLeft", name: "right", value: "-1.00" },
  { key: "KeyW", name: "up", value: "1.00" },
  { key: "KeyS", name: "up", value: "-1.00" },
  { key: "KeyD", name: "yaw", value: "1.00" },
  { key: "KeyA", name: "yaw", value: "-1.00" }
];

for (const { key, name, value } of MAPPING) {
  test(`holding ${key} drives the ${name} axis to ${value}`, async ({ page }) => {
    const backend = await openPilotPanel(page);
    await reveal(page);
    await enableControl(page);

    await page.keyboard.down(key);
    await expect(axis(page, name)).toHaveText(value);

    // And it actually reaches the backend, not just the display.
    await expect
      .poll(() => backend.inputs().at(-1)?.body?.[name])
      .toBe(Number(value));

    await page.keyboard.up(key);
    await expect(axis(page, name)).toHaveText("0.00");
  });
}

test("releasing a key returns the axis to neutral at the backend too", async ({ page }) => {
  const backend = await openPilotPanel(page);
  await reveal(page);
  await enableControl(page);

  await page.keyboard.down("ArrowUp");
  await expect.poll(() => backend.inputs().at(-1)?.body?.forward).toBe(1);
  await page.keyboard.up("ArrowUp");
  await expect.poll(() => backend.inputs().at(-1)?.body?.forward).toBe(0);
});

test("opposing keys held together cancel to zero", async ({ page }) => {
  await openPilotPanel(page);
  await reveal(page);
  await enableControl(page);

  await page.keyboard.down("ArrowUp");
  await expect(axis(page, "forward")).toHaveText("1.00");
  await page.keyboard.down("ArrowDown");
  await expect(axis(page, "forward")).toHaveText("0.00");

  await page.keyboard.up("ArrowUp");
  await page.keyboard.up("ArrowDown");
});

test("a diagonal holds both axes at full normalized deflection; the backend does the clamping", async ({ page }) => {
  const backend = await openPilotPanel(page);
  await reveal(page);
  await enableControl(page);

  await page.keyboard.down("ArrowUp");
  await page.keyboard.down("ArrowRight");
  await expect(axis(page, "forward")).toHaveText("1.00");
  await expect(axis(page, "right")).toHaveText("1.00");

  await expect.poll(() => backend.inputs().at(-1)?.body).toMatchObject({ forward: 1, right: 1 });
  // The browser never scales speed; it says "full stick", and the backend
  // turns that into 0.30 m/s of *total* horizontal velocity.
  await page.keyboard.up("ArrowUp");
  await page.keyboard.up("ArrowRight");
});

// ----------------------------------------------------------------------
// Stopping
// ----------------------------------------------------------------------

test("Space neutralises every axis, tells the backend, and shows it happened", async ({ page }) => {
  const backend = await openPilotPanel(page);
  await reveal(page);
  await enableControl(page);

  await page.keyboard.down("ArrowUp");
  await page.keyboard.down("KeyW");
  await expect(axis(page, "forward")).toHaveText("1.00");

  // Mark the position in the stream *before* the key, so the neutral frame
  // cannot slip past while the assertions below are running.
  const before = backend.inputs().length;
  await page.keyboard.press("Space");

  // The confirmation indicator is time-limited (it tracks the window in which
  // zeros are actually being transmitted), so check it before anything slower.
  await expect(page.locator("#pilotNeutralFlash")).toBeVisible();
  await expect(axis(page, "forward")).toHaveText("0.00");
  await expect(axis(page, "up")).toHaveText("0.00");

  await expectStopped(backend, before);

  // Space is a movement command, not a disable: the channel stays open.
  await expect(page.locator("#pilotEnabled")).toContainText("有効");
  await page.keyboard.up("ArrowUp");
  await page.keyboard.up("KeyW");
});

test("losing window focus while a key is held commands neutral", async ({ page }) => {
  const backend = await openPilotPanel(page);
  await reveal(page);
  await enableControl(page);

  await page.keyboard.down("ArrowUp");
  await expect.poll(() => backend.inputs().at(-1)?.body?.forward).toBe(1);

  const before = backend.inputs().length;
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));

  await expect(axis(page, "forward")).toHaveText("0.00");
  // A key the browser can no longer see released must not keep commanding.
  await expectStopped(backend, before);
});

test("the tab becoming hidden commands neutral", async ({ page }) => {
  const backend = await openPilotPanel(page);
  await reveal(page);
  await enableControl(page);

  await page.keyboard.down("ArrowUp");
  await expect.poll(() => backend.inputs().at(-1)?.body?.forward).toBe(1);

  const before = backend.inputs().length;
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });

  await expect(axis(page, "forward")).toHaveText("0.00");
  await expectStopped(backend, before);
});

test("the neutral button stops movement without closing the channel", async ({ page }) => {
  const backend = await openPilotPanel(page);
  await reveal(page);
  await enableControl(page);

  await page.keyboard.down("ArrowUp");
  await expect.poll(() => backend.inputs().at(-1)?.body?.forward).toBe(1);

  const before = backend.inputs().length;
  await page.locator("#pilotNeutralButton").click();
  await expect.poll(() => backend.since(before).some((p) => p.body?.neutral === true)).toBe(true);
  await expect(page.locator("#pilotEnabled")).toContainText("有効");
  await page.keyboard.up("ArrowUp");
});

test("disabling stops the stream entirely", async ({ page }) => {
  const backend = await openPilotPanel(page);
  await reveal(page);
  await enableControl(page);

  await page.locator("#pilotEnableButton").click();
  await expect(page.locator("#pilotEnabled")).toContainText("無効");
  expect(backend.paths()).toContain("/api/drone/pilot/disable");

  const sent = backend.inputs().length;
  await page.keyboard.down("ArrowUp");
  await page.waitForTimeout(400);
  await page.keyboard.up("ArrowUp");
  expect(backend.inputs().length).toBe(sent);
});

// ----------------------------------------------------------------------
// Not stealing the keyboard
// ----------------------------------------------------------------------

test("typing into a survey field never moves an axis, even with control enabled", async ({ page }) => {
  const backend = await openPilotPanel(page);
  await reveal(page);
  await enableControl(page);

  // The guard keys off the event target's element type, so any focused text
  // field exercises it. The survey's own fields live inside collapsed panels
  // in this workspace, so plant a visible one rather than fight the layout.
  await page.evaluate(() => {
    const field = document.createElement("input");
    field.type = "text";
    field.id = "pilotTypingProbe";
    document.body.prepend(field);
  });
  const field = page.locator("#pilotTypingProbe");
  await field.click();
  await page.keyboard.type("wasd");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowRight");

  await expect(axis(page, "up")).toHaveText("0.00");
  await expect(axis(page, "yaw")).toHaveText("0.00");
  await expect(axis(page, "right")).toHaveText("0.00");

  const moved = backend.inputs().some((p) => Object.values(p.body || {}).some((v) => typeof v === "number" && v !== 0));
  expect(moved, "typing must never produce a movement command").toBe(false);
});

test("the page does not scroll away under the operator while flying", async ({ page }) => {
  await openPilotPanel(page);
  await reveal(page);
  await enableControl(page);

  const before = await page.evaluate(() => window.scrollY);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Space");
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
});

// ----------------------------------------------------------------------
// The rest of the app
// ----------------------------------------------------------------------

test("the gamepad preview panel is unaffected by the pilot panel being present", async ({ page }) => {
  await openPilotPanel(page);
  await page.waitForFunction(() => Boolean(window.gamepadController));
  await page.evaluate(() => {
    const panel = document.getElementById("gamepadPanel");
    panel.hidden = false;
    panel.open = true;
  });
  await expect(page.locator("#gamepadPanel")).toContainText("No aircraft commands are being transmitted");
});

test("the survey workflow still works with the pilot panel mounted", async ({ page }) => {
  await openPilotPanel(page);
  await expect(page.locator("#serialConnectButton")).toBeAttached();
  await expect(page.locator("#recStartButton")).toBeAttached();
});
