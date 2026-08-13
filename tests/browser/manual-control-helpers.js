import { expect } from "@playwright/test";

export const BACKEND = "http://127.0.0.1:8787";
export const WS_BACKEND = "ws://127.0.0.1:8787/api/drone/telemetry/ws";

export function pilotSnapshot(overrides = {}) {
  return {
    available: true,
    enabled: false,
    benchMode: false,
    propsRemovedAck: false,
    deadman: false,
    transmitting: false,
    outputActive: false,
    failsafe: false,
    readyToArm: false,
    blockedReason: "not_enabled",
    supportedModes: ["STABILIZE", "ALT_HOLD"],
    axes: { pitch: 0, roll: 0, throttle: 0, yaw: 0 },
    sequence: 0,
    nextSequence: 1,
    inputTimeoutSeconds: 0.5,
    overrideRateHz: 15,
    override: {
      channels: [0, 0, 0, 0, 0, 0, 0, 0],
      active: false,
      framesSent: 0,
      releaseFramesSent: 0
    },
    rcConfiguration: {
      mapping: { roll: 1, pitch: 2, throttle: 3, yaw: 4 },
      channels: {
        1: { min: 1100, trim: 1500, max: 1900, reversed: false },
        2: { min: 1100, trim: 1500, max: 1900, reversed: false },
        3: { min: 1100, trim: 1500, max: 1900, reversed: false },
        4: { min: 1100, trim: 1500, max: 1900, reversed: false }
      },
      overrideTimeoutSeconds: 3,
      rcOptions: 0,
      sourceIdParameter: "SYSID_MYGCS",
      sysidMygcs: 255,
      diagnostics: []
    },
    armingInputActive: false,
    throttleFailsafe: null,
    ...overrides
  };
}

export function telemetryStatus({
  pilot = pilotSnapshot(),
  armed = false,
  flightMode = "STABILIZE",
  rc = { channels: [null, null, null, null, null, null, null, null], channelCount: null, rssi: null, receiverHealthy: null, ageSeconds: null },
  prearmCheck = null
} = {}) {
  return {
    connectionState: "connected",
    connected: true,
    commandable: true,
    mode: "mock",
    allowSafeCommands: true,
    armSupported: true,
    takeoffSupported: false,
    error: null,
    transport: { transport: "mock", port: null, baud: null },
    link: {
      stale: false,
      staleTimeout: 2,
      lastMessageAge: 0.2,
      lastHeartbeatAge: 0.2,
      messageCounts: {},
      totalMessages: 10
    },
    vehicle: {
      armed,
      flightMode,
      vehicleTypeName: "QUADROTOR",
      autopilotName: "ARDUPILOTMEGA",
      systemId: 1,
      componentId: 1
    },
    battery: { voltage: 16.2, current: 1.4, remaining: 96, sensorsOk: true },
    gps: { fixType: 3, fixTypeName: "3D_FIX", satellites: 14, lat: 34.54, lon: 135.735, altMsl: 62 },
    attitude: { roll: 0, pitch: 0, yaw: 0, yawNormalized: 0 },
    motion: { heading: 0, groundSpeed: 0, airSpeed: 0, altitude: 62, climbRate: 0 },
    position: { lat: 34.54, lon: 135.735, altAmsl: 62, altRelative: 0.1, available: true },
    version: { flightSwVersion: "4.5.7" },
    statusTexts: [],
    rc,
    prearmCheck,
    pilot
  };
}

const clone = (value) => JSON.parse(JSON.stringify(value));
const axesNonzero = (body = {}) => ["pitch", "roll", "throttle", "yaw"].some((key) => Math.abs(Number(body[key]) || 0) > 0);

/** Keep in sync with `PilotInputRequest` in backend/app/models.py. */
const WIRE_PROVIDERS = ["keyboard", "browser", "mock", "gamepad", "unknown"];

/** The subset of the backend's request validation that the browser can
 * actually violate. Returns a FastAPI-shaped error entry, or null. */
export function wireContractError(body) {
  if (body?.provider != null && !WIRE_PROVIDERS.includes(body.provider)) {
    return {
      type: "literal_error",
      loc: ["body", "provider"],
      msg: `Input should be ${WIRE_PROVIDERS.map((value) => `'${value}'`).join(", ")}`,
      input: body.provider
    };
  }
  if (typeof body?.source !== "string" || body.source.length < 1) {
    return { type: "string_too_short", loc: ["body", "source"], msg: "String should have at least 1 character" };
  }
  if (!Number.isInteger(body?.sequence)) {
    return { type: "int_type", loc: ["body", "sequence"], msg: "Input should be a valid integer" };
  }
  return null;
}

/** Stateful, in-memory backend used by Manual Control browser acceptance.
 * It never starts Python, opens a serial port, or touches COM10. */
export async function stubManualBackend(page, { initial = telemetryStatus(), rejectArm = false } = {}) {
  const state = clone(initial);
  const posts = [];
  let socket = null;
  // Mutable, not the destructured param directly: setArmRejection() lets a
  // single test drive ARM through a rejection and then a real retry without
  // re-registering page.route() (which does not reliably supersede an
  // existing handler for the same pattern on the same page).
  let currentRejectArm = rejectArm;

  const pilotResponse = (reason, message = "") => ({
    ok: true,
    reason,
    message,
    detail: { pilot: clone(state.pilot) }
  });

  const release = (reason, { failsafe = false } = {}) => {
    state.pilot.axes = { pitch: 0, roll: 0, throttle: 0, yaw: 0 };
    state.pilot.deadman = false;
    state.pilot.transmitting = false;
    state.pilot.outputActive = false;
    state.pilot.failsafe = failsafe;
    state.pilot.blockedReason = reason;
    state.pilot.override.active = false;
    state.pilot.override.channels = [0, 0, 0, 0, 0, 0, 0, 0];
    state.pilot.override.releaseFramesSent += 1;
  };

  await page.routeWebSocket(WS_BACKEND, (route) => {
    socket = route;
  });

  await page.route(`${BACKEND}/**`, async (route) => {
    const request = route.request();
    const path = request.url().replace(BACKEND, "");
    let body = null;
    if (request.method() !== "GET") {
      try { body = request.postDataJSON(); } catch { body = null; }
      posts.push({ path, body });
    }

    if (path === "/api/drone/status") {
      await route.fulfill({ json: clone(state) });
      return;
    }
    if (path === "/api/drone/config") {
      await route.fulfill({
        json: {
          config: {
            mode: state.mode,
            port: null,
            baud: null,
            allowSafeCommands: true,
            allowPilotControl: true,
            armSupported: true,
            takeoffSupported: false,
            allowedModes: ["STABILIZE", "ALT_HOLD"]
          },
          allowedModes: ["STABILIZE", "ALT_HOLD"],
          allowedStreams: [],
          disabledOperations: {}
        }
      });
      return;
    }
    if (path === "/api/drone/pilot/bench/enable") {
      state.pilot.enabled = true;
      state.pilot.benchMode = true;
      state.pilot.propsRemovedAck = body?.propsRemovedAck === true;
      state.pilot.failsafe = false;
      state.pilot.blockedReason = state.vehicle.armed ? "deadman_released" : "disarmed";
      state.pilot.readyToArm = !state.vehicle.armed;
      await route.fulfill({ json: pilotResponse("bench_enabled", "Bench Pilot enabled") });
      return;
    }
    if (path === "/api/drone/pilot/enable") {
      state.pilot.enabled = true;
      state.pilot.benchMode = false;
      state.pilot.blockedReason = state.vehicle.armed ? "deadman_released" : "disarmed";
      state.pilot.readyToArm = !state.vehicle.armed;
      await route.fulfill({ json: pilotResponse("enabled") });
      return;
    }
    if (path === "/api/drone/pilot/disable") {
      release("not_enabled");
      state.pilot.enabled = false;
      state.pilot.benchMode = false;
      state.pilot.propsRemovedAck = false;
      state.pilot.readyToArm = false;
      await route.fulfill({ json: pilotResponse("disabled", "RC override released") });
      return;
    }
    if (path === "/api/drone/pilot/neutral") {
      release("neutral_commanded");
      await route.fulfill({ json: pilotResponse("neutral") });
      return;
    }
    if (path === "/api/drone/pilot/input") {
      // Mirror the real backend's Pydantic contract. Without this the stub
      // accepted values FastAPI rejects with HTTP 422 — which is exactly how
      // a provider/source vocabulary mix-up reached a live operator while the
      // browser suite stayed green.
      const literalError = wireContractError(body);
      if (literalError) {
        await route.fulfill({ status: 422, json: { detail: [literalError] } });
        return;
      }
      state.pilot.sequence = Number(body?.sequence) || state.pilot.sequence;
      state.pilot.nextSequence = state.pilot.sequence + 1;
      state.pilot.axes = {
        pitch: Number(body?.pitch) || 0,
        roll: Number(body?.roll) || 0,
        throttle: Number(body?.throttle) || 0,
        yaw: Number(body?.yaw) || 0
      };
      state.pilot.deadman = body?.deadman === true;
      if (body?.neutral || !body?.deadman) {
        release(body?.neutral ? "neutral_commanded" : "deadman_released", {
          failsafe: state.vehicle.armed && !body?.neutral
        });
      } else if (!state.vehicle.armed) {
        release("disarmed");
      } else if (!axesNonzero(body)) {
        // The real PilotService treats all-zero semantic axes as neutral and
        // releases override even when the dead-man remains held.
        release("neutral_commanded");
      } else {
        state.pilot.transmitting = true;
        state.pilot.outputActive = true;
        state.pilot.failsafe = false;
        state.pilot.blockedReason = null;
        state.pilot.override.active = true;
        state.pilot.override.framesSent += 1;
        state.pilot.override.channels = [1500, 1500, 1500, 1500, 65535, 65535, 65535, 65535];
      }
      await route.fulfill({ json: pilotResponse("accepted") });
      return;
    }
    if (path === "/api/drone/arm") {
      const rejectArm = currentRejectArm;
      if (rejectArm === true) {
        await route.fulfill({
          status: 502,
          json: {
            ok: false,
            reason: "rejected_by_vehicle",
            message: "Pre-arm checks failed",
            detail: { command: 400, param1: 1, param2: 0 }
          }
        });
        return;
      }
      if (rejectArm) {
        // Object form: mirrors the real backend's CommandRejected detail
        // shape for the "vehicle refused ARM" path (ack.resultName,
        // vehicleReason, relevantStatusTexts) -- see
        // command_service.py's capture_arm_reason. Lets tests drive the
        // Command-result / Vehicle-reason UI split precisely.
        const {
          resultName = "FAILED",
          vehicleReason = null,
          relevantStatusTexts = vehicleReason
            ? [{ severity: 4, severityName: "WARNING", text: vehicleReason, receivedAt: Date.now() / 1000 }]
            : [],
          message = `The vehicle rejected normal ARM: ${resultName}.`,
          // Mirrors command_service.py's _arm_attempt_evidence(): raw facts
          // read at the moment of rejection, shown only when there is no
          // vehicleReason to explain it. `undefined` (not passed) lets a test
          // that only cares about the vehicleReason path ignore this entirely.
          armEvidence
        } = rejectArm;
        await route.fulfill({
          status: 502,
          json: {
            ok: false,
            reason: "rejected_by_vehicle",
            message,
            detail: {
              command: 400,
              ack: { command: 400, result: 4, resultName, accepted: false },
              statusTexts: relevantStatusTexts,
              relevantStatusTexts,
              vehicleReason,
              armEvidence
            }
          }
        });
        return;
      }
      state.vehicle.armed = true;
      state.pilot.readyToArm = false;
      release("deadman_released", { failsafe: true });
      await route.fulfill({
        json: {
          ok: true,
          reason: "confirmed",
          message: "ARM confirmed by vehicle telemetry",
          detail: { command: 400, param1: 1, param2: 0, armed: true }
        }
      });
      return;
    }
    if (path === "/api/drone/disarm") {
      state.vehicle.armed = false;
      state.pilot.readyToArm = state.pilot.enabled;
      release("disarmed");
      await route.fulfill({
        json: {
          ok: true,
          reason: "confirmed",
          message: "DISARM confirmed by vehicle telemetry",
          detail: { command: 400, param1: 0, param2: 0, armed: false }
        }
      });
      return;
    }
    await route.fulfill({ json: { ok: true, reason: "ok", message: "ok", detail: {} } });
  });

  return {
    state,
    posts,
    paths: () => posts.map((post) => post.path),
    inputs: () => posts.filter((post) => post.path === "/api/drone/pilot/input"),
    movementInputs: () => posts.filter((post) => post.path === "/api/drone/pilot/input" && !post.body?.neutral && post.body?.deadman && axesNonzero(post.body)),
    closeWebSocket() { socket?.close(); },
    /** Change how /api/drone/arm responds for the *next* click, without
     * re-registering the route. `false` restores the normal ARM-succeeds
     * behaviour. */
    setArmRejection(spec) { currentRejectArm = spec; },
    pushTelemetry(patch = {}) {
      Object.assign(state, patch);
      if (patch.link) state.link = { ...state.link, ...patch.link };
      socket?.send(JSON.stringify({ type: "telemetry", payload: clone(state) }));
    }
  };
}

export async function openManualPanel(page, options = {}) {
  const backend = await stubManualBackend(page, options);
  await page.goto("/?gamepadMock=1#survey");
  await page.waitForFunction(() => Boolean(window.pilotControlPanel), null, { timeout: 20_000 });
  await page.evaluate(() => {
    const panel = document.getElementById("pilotPanel");
    panel.hidden = false;
    panel.open = true;
  });
  await expect(page.locator("#pilotRoot")).not.toBeEmpty();
  await expect(page.locator("#gpSource")).toBeVisible();
  return backend;
}

export async function enableBench(page) {
  await page.locator("#pilotBenchPropsAck").check();
  await expect(page.locator("#pilotBenchEnableButton")).toBeEnabled();
  await page.locator("#pilotBenchEnableButton").click();
  await page.waitForFunction(() => window.pilotControlPanel?.controller?.enabled === true);
  await expect(page.locator("#pilotStatusEnabled")).toHaveAttribute("data-tone", "warn");
}

export async function armMock(page) {
  await expect(page.locator("#pilotArmButton")).toBeEnabled();
  await page.locator("#pilotArmButton").click();
  await expect(page.locator("#pilotArmed")).toHaveText("ARMED");
}

export const pilotAxis = (page, name) => page.locator(`#pilotAxis-${name}`);
