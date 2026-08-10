import { test, expect } from "@playwright/test";
import {
  armMock,
  enableBench,
  openManualPanel,
  pilotAxis,
  pilotSnapshot,
  telemetryStatus
} from "./manual-control-helpers.js";

test("Keyboard and PS5 live in one Manual Control panel with no duplicate cards or controls", async ({ page }) => {
  await openManualPanel(page);

  await expect(page.locator("#pilotPanel")).toHaveCount(1);
  await expect(page.locator("#gamepadPanel")).toHaveCount(0);
  await expect(page.locator("#pilotPanel > summary")).toContainText("手動操縦");
  await expect(page.locator("#pilotPanel > summary")).toContainText("Manual Control");
  await expect(page.locator("#gpSource")).toHaveCount(1);
  await expect(page.locator("#pilotBenchEnableButton")).toHaveCount(1);
  await expect(page.locator("#pilotArmButton")).toHaveCount(1);
  await expect(page.locator("#pilotDisarmButton")).toHaveCount(1);

  const sources = await page.locator("#gpSource option").allTextContents();
  expect(sources).toEqual(["Keyboard", "PS5 Controller"]);
  await expect(page.locator("#manualInputRoot")).toContainText("Calibration: not required");
  await expect(page.locator("[data-input-calibration]")).toHaveCount(0);
  await expect(page.locator("[data-input-raw]")).toHaveCount(0);

  await page.locator("#gpSource").selectOption("ps5");
  await expect(page.locator("[data-input-calibration]")).toBeAttached();
  await expect(page.locator("[data-input-raw]")).toBeAttached();
  await expect(page.locator("#manualInputRoot")).not.toContainText("Calibration: not required");

  const placement = await page.evaluate(() => {
    const banner = document.getElementById("pilotBlockedBanner").getBoundingClientRect();
    const actions = document.querySelector(".pilot-action-row").getBoundingClientRect();
    return { bannerBottom: banner.bottom, actionsTop: actions.top };
  });
  expect(placement.bannerBottom).toBeLessThan(placement.actionsTop);
});

test("Keyboard preview is opt-in, quarter-stick, and transport-free before Bench Pilot enable", async ({ page }) => {
  const backend = await openManualPanel(page);
  await expect(page.locator("#gpKeyCapture")).toContainText("Preview keyboard input");

  await page.keyboard.down("ShiftLeft");
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(100);
  await expect(pilotAxis(page, "throttle")).toHaveText("0.00");
  expect(backend.inputs()).toEqual([]);
  await page.keyboard.up("KeyW");
  await page.keyboard.up("ShiftLeft");

  await page.locator("#gpKeyCapture").click();
  await page.keyboard.down("ShiftLeft");
  await page.keyboard.down("KeyW");
  await expect(pilotAxis(page, "throttle")).toHaveText("0.25");
  expect(backend.inputs()).toEqual([]);
  await page.keyboard.up("KeyW");
  await page.keyboard.up("ShiftLeft");
});

test("mock Keyboard bench flow enables, normally arms, transmits, releases dead-man, and disarms", async ({ page }) => {
  const backend = await openManualPanel(page);
  await enableBench(page);

  const benchCall = backend.posts.find((post) => post.path === "/api/drone/pilot/bench/enable");
  expect(benchCall.body).toEqual({ propsRemovedAck: true });
  await expect(page.locator("#pilotStatusReady")).toHaveAttribute("data-tone", "ok");
  await expect(page.locator("#pilotStatusFailsafe")).toHaveAttribute("data-tone", "idle");
  await expect(page.locator("#pilotBlockedBanner")).toContainText("Ready to arm");
  await expect(page.locator("#pilotArmed")).toHaveText("DISARMED");

  await armMock(page);
  expect(backend.posts.find((post) => post.path === "/api/drone/arm").body).toEqual({ confirmed: true });

  await page.keyboard.down("ShiftLeft");
  await expect(page.locator("#pilotDeadman")).toHaveText("HELD");
  await page.waitForTimeout(50);
  await page.keyboard.down("KeyW");

  await expect.poll(() => backend.movementInputs().at(-1)?.body).toMatchObject({
    pitch: 0,
    roll: 0,
    throttle: 0.25,
    yaw: 0,
    deadman: true,
    neutral: false,
    source: "keyboard"
  });
  const movement = backend.movementInputs().at(-1).body;
  expect(movement).not.toHaveProperty("forward");
  expect(movement).not.toHaveProperty("right");
  expect(movement).not.toHaveProperty("up");
  await expect(page.locator("#pilotStatusTransmitting")).toHaveAttribute("data-tone", "danger");
  await expect(page.locator("#pilotBlockedBanner")).toContainText("None");

  const beforeRelease = backend.inputs().length;
  await page.keyboard.up("ShiftLeft");
  await expect.poll(() => backend.inputs().slice(beforeRelease).some((post) => post.body?.neutral === true)).toBe(true);
  await expect(page.locator("#pilotStatusTransmitting")).toHaveAttribute("data-tone", "idle");
  await expect(page.locator("#pilotStatusFailsafe")).toHaveAttribute("data-tone", "warn");
  await expect(page.locator("#pilotBlockedBanner")).toContainText("Dead-man released");
  await page.keyboard.up("KeyW");

  await expect(page.locator("#pilotDisarmButton")).toBeEnabled();
  await page.locator("#pilotDisarmButton").click();
  await expect.poll(() => backend.paths()).toContain("/api/drone/disarm");
  expect(backend.posts.find((post) => post.path === "/api/drone/disarm").body).toEqual({ confirmed: true });
  await expect(page.locator("#pilotArmed")).toHaveText("DISARMED");
  await expect(page.locator("#pilotStatusFailsafe")).toHaveAttribute("data-tone", "idle");

  const sequences = backend.inputs().map((post) => post.body.sequence);
  expect(sequences.every((value, index) => index === 0 || value > sequences[index - 1])).toBe(true);
});

test("mock PS5 uses calibrated Mode 2 axes and the configured dead-man button on the same endpoint", async ({ page }) => {
  const backend = await openManualPanel(page);
  await page.locator("#gpSource").selectOption("ps5");
  await page.evaluate(() => window.gamepadController.mock.connect());
  await page.waitForFunction(() => Boolean(window.gamepadController?.calibration));
  await page.evaluate(() => {
    const controller = window.gamepadController;
    const calibration = { ...controller.calibration, deadmanButtonIndex: 5, validationState: "valid" };
    controller.setCalibration(calibration);
  });
  await expect(page.locator("[data-input-calibration] summary")).toContainText("valid");

  await enableBench(page);
  await armMock(page);

  // L1/index 4 is deliberately not the configured dead-man in this test.
  await page.evaluate(() => {
    const controller = window.gamepadController;
    controller.mock.setButton(4, 1);
    controller.mock.setAxis(1, -0.35);
  });
  await page.waitForTimeout(150);
  expect(backend.movementInputs().filter((post) => post.body.source === "ps5")).toHaveLength(0);

  await page.evaluate(() => {
    const controller = window.gamepadController;
    controller.mock.setButton(4, 0);
    controller.mock.setButton(5, 1);
    controller.mock.setAxis(1, -0.4);
  });
  await expect.poll(() => backend.movementInputs().filter((post) => post.body.source === "ps5").at(-1)?.body?.throttle).toBeGreaterThan(0);
  await expect(page.locator("#pilotStatusTransmitting")).toHaveAttribute("data-tone", "danger");
  await expect(page.locator("#pilotDeadman")).toHaveText("HELD");

  const beforeRelease = backend.inputs().length;
  await page.evaluate(() => window.gamepadController.mock.setButton(5, 0));
  await expect.poll(() => backend.inputs().slice(beforeRelease).some((post) => post.body?.neutral === true)).toBe(true);
  await expect(page.locator("#pilotStatusTransmitting")).toHaveAttribute("data-tone", "idle");
  await expect(page.locator("#pilotStatusFailsafe")).toHaveAttribute("data-tone", "warn");

  await page.locator("#pilotDisarmButton").click();
  await expect(page.locator("#pilotArmed")).toHaveText("DISARMED");
});

test("normal ARM rejection is surfaced and never claimed as ARMED", async ({ page }) => {
  const backend = await openManualPanel(page, { rejectArm: true });
  await enableBench(page);
  await page.locator("#pilotArmButton").click();
  await expect(page.locator("#pilotMessage")).toContainText("Pre-arm checks failed");
  await expect(page.locator("#pilotArmed")).toHaveText("DISARMED");
  expect(backend.posts.find((post) => post.path === "/api/drone/arm").body).toEqual({ confirmed: true });
  expect(JSON.stringify(backend.posts)).not.toContain("21196");
});

// ----------------------------------------------------------------------
// ARM rejection diagnostics
//
// Reported symptom: a useful orange ArduPilot STATUSTEXT briefly appeared,
// then Manual Control replaced it with "ARM rejected: The vehicle rejected
// normal ARM: FAILED." — the numeric MAV_RESULT, with the vehicle's own
// explanation discarded. These tests exercise the fix on the real page.
// ----------------------------------------------------------------------

test("a PreArm vehicle reason is shown distinctly from the numeric command result", async ({ page }) => {
  const backend = await openManualPanel(page, {
    rejectArm: { resultName: "FAILED", vehicleReason: "PreArm: Hardware safety switch" }
  });
  await enableBench(page);
  await page.locator("#pilotArmButton").click();

  await expect(page.locator("#pilotArmDiagnostic")).toBeVisible();
  await expect(page.locator("#pilotArmCommandResult")).toHaveText("ARM FAILED");
  await expect(page.locator("#pilotArmVehicleReason")).toHaveText("PreArm: Hardware safety switch");
  await expect(page.locator("#pilotArmVehicleReason")).toHaveAttribute("data-fallback", "false");
  await expect(page.locator("#pilotArmed")).toHaveText("DISARMED");

  expect(backend.posts.find((post) => post.path === "/api/drone/arm").body).toEqual({ confirmed: true });
  expect(JSON.stringify(backend.posts)).not.toContain("21196");
});

test("with no detailed STATUSTEXT, the UI states that honestly instead of inventing a cause", async ({ page }) => {
  await openManualPanel(page, { rejectArm: { resultName: "FAILED", vehicleReason: null } });
  await enableBench(page);
  await page.locator("#pilotArmButton").click();

  await expect(page.locator("#pilotArmDiagnostic")).toBeVisible();
  await expect(page.locator("#pilotArmCommandResult")).toHaveText("ARM FAILED");
  await expect(page.locator("#pilotArmVehicleReason")).toHaveText(
    "Vehicle rejected ARM (MAV_RESULT_FAILED); no detailed reason received."
  );
  await expect(page.locator("#pilotArmVehicleReason")).toHaveAttribute("data-fallback", "true");
});

test("a different MAV_RESULT is named accurately, not hardcoded to FAILED", async ({ page }) => {
  await openManualPanel(page, { rejectArm: { resultName: "DENIED", vehicleReason: null } });
  await enableBench(page);
  await page.locator("#pilotArmButton").click();
  await expect(page.locator("#pilotArmCommandResult")).toHaveText("ARM DENIED");
  await expect(page.locator("#pilotArmVehicleReason")).toHaveText(
    "Vehicle rejected ARM (MAV_RESULT_DENIED); no detailed reason received."
  );
});

// ----------------------------------------------------------------------
// ARM rejection evidence
//
// Real-hardware report: "ARM rejected: FAILED" with no detailed reason at
// all. These tests exercise the raw-evidence fallback that replaces a dead
// end with the mode/armed/pre-arm-health/RC-input facts read at the moment
// of rejection -- shown only when there is genuinely no vehicleReason.
// ----------------------------------------------------------------------

const SAMPLE_ARM_EVIDENCE = {
  flightMode: "STABILIZE",
  armed: false,
  prearmCheck: false,
  rc: { channels: [1500, 1500, 1100, 1500, null, null, null, null], receiverHealthy: true, ageSeconds: 0.2 },
  pilot: {
    enabled: true,
    benchMode: true,
    deadman: false,
    override: { channels: [1500, 1500, 1100, 1500, 65535, 65535, 65535, 65535], released: false },
    overrideOwned: true,
    transmitting: false,
    outputActive: false,
    armingInputActive: true,
    rcConfiguration: {
      mapping: { roll: 1, pitch: 2, throttle: 3, yaw: 4 },
      channels: { 3: { min: 1100, trim: 1500, max: 1900, reversed: false } }
    },
    throttleFailsafe: { enabled: true, enableRaw: 1, valuePwm: 975 }
  },
  recentStatusTexts: []
};

test("with no vehicle reason, raw evidence is shown instead of a dead end", async ({ page }) => {
  await openManualPanel(page, {
    rejectArm: { resultName: "FAILED", vehicleReason: null, armEvidence: SAMPLE_ARM_EVIDENCE }
  });
  await enableBench(page);
  await page.locator("#pilotArmButton").click();

  await expect(page.locator("#pilotArmVehicleReason")).toHaveAttribute("data-fallback", "true");
  const evidence = page.locator("#pilotArmEvidence");
  await expect(evidence).toBeVisible();
  await expect(evidence).toContainText("No detailed STATUSTEXT received");
  await expect(evidence).toContainText("STABILIZE");
  await expect(evidence).toContainText("DISARMED");
  await expect(evidence).toContainText("FAIL"); // pre-arm check health
  await expect(evidence).toContainText("1100"); // throttle PWM (CH3)
  await expect(evidence).toContainText("975"); // FS_THR_VALUE
  // Evidence reports facts; it must never claim to know the cause.
  await expect(evidence).not.toContainText("caused by");
  await expect(evidence).not.toContainText("because");
});

test("with a vehicle reason present, the evidence block is not shown at all", async ({ page }) => {
  await openManualPanel(page, {
    rejectArm: {
      resultName: "FAILED",
      vehicleReason: "PreArm: Hardware safety switch",
      armEvidence: SAMPLE_ARM_EVIDENCE
    }
  });
  await enableBench(page);
  await page.locator("#pilotArmButton").click();

  await expect(page.locator("#pilotArmVehicleReason")).toHaveText("PreArm: Hardware safety switch");
  await expect(page.locator("#pilotArmEvidence")).toHaveCount(0);
});

// ----------------------------------------------------------------------
// "RC INPUT SEEN BY PIXHAWK": the vehicle's own reported RC input, not
// merely what the browser intended to send.
// ----------------------------------------------------------------------

test("RC input seen by Pixhawk shows the vehicle's own reported channel values, mapped through RCMAP", async ({ page }) => {
  await openManualPanel(page, {
    initial: telemetryStatus({
      rc: { channels: [1500, 1500, 1100, 1500, null, null, null, null], channelCount: 4, rssi: 200, receiverHealthy: true, ageSeconds: 0.3 },
      prearmCheck: true
    })
  });

  const section = page.locator(".pilot-rc-input-section");
  await expect(section).toContainText("1500 µs"); // roll / CH1
  await expect(section).toContainText("1100 µs"); // throttle / CH3
  await expect(page.locator("#pilotRcFailsafe")).toHaveText("NO");
  await expect(page.locator("#pilotPrearmHealth")).toHaveText("PASS");
  await expect(page.locator("#pilotRcAge")).toContainText("0.3 s");
});

test("RC input seen by Pixhawk shows UNKNOWN, not a false PASS, when the vehicle has not reported it", async ({ page }) => {
  await openManualPanel(page); // default telemetryStatus(): rc channels all null, prearmCheck null

  await expect(page.locator("#pilotPrearmHealth")).toHaveText("UNKNOWN");
  await expect(page.locator("#pilotRcFailsafe")).toHaveText("UNKNOWN");
  const section = page.locator(".pilot-rc-input-section");
  await expect(section).toContainText("—"); // no channel data yet, never a fabricated PWM
});

test("RC input seen by Pixhawk reports failsafe YES when the vehicle's RC receiver is unhealthy", async ({ page }) => {
  await openManualPanel(page, {
    initial: telemetryStatus({
      rc: { channels: [0, 0, 0, 0, null, null, null, null], channelCount: 4, rssi: 0, receiverHealthy: false, ageSeconds: 1.1 }
    })
  });
  await expect(page.locator("#pilotRcFailsafe")).toHaveText("YES");
});

test("the diagnostic survives the 500 ms telemetry poll instead of disappearing", async ({ page }) => {
  await openManualPanel(page, {
    rejectArm: { vehicleReason: "PreArm: Hardware safety switch" }
  });
  await enableBench(page);
  await page.locator("#pilotArmButton").click();
  await expect(page.locator("#pilotArmVehicleReason")).toHaveText("PreArm: Hardware safety switch");

  // Comfortably longer than TELEMETRY_POLL_MS (500 ms): several polls must
  // pass without the reason being blanked or replaced.
  await page.waitForTimeout(1300);
  await expect(page.locator("#pilotArmVehicleReason")).toHaveText("PreArm: Hardware safety switch");
});

test("a successful ARM clears the earlier rejection's vehicle reason", async ({ page }) => {
  const backend = await openManualPanel(page, {
    rejectArm: { vehicleReason: "PreArm: Hardware safety switch" }
  });
  await enableBench(page);

  await page.locator("#pilotArmButton").click();
  await expect(page.locator("#pilotArmVehicleReason")).toHaveText("PreArm: Hardware safety switch");

  backend.setArmRejection(false);
  await page.locator("#pilotArmButton").click();
  await expect(page.locator("#pilotArmed")).toHaveText("ARMED");
  await expect(page.locator("#pilotArmDiagnostic")).toHaveCount(0);
});

test("the diagnostic is cleared once the vehicle reports ARMED, even without a fresh ARM click", async ({ page }) => {
  const backend = await openManualPanel(page, {
    rejectArm: { vehicleReason: "PreArm: Hardware safety switch" }
  });
  await enableBench(page);
  await page.locator("#pilotArmButton").click();
  await expect(page.locator("#pilotArmVehicleReason")).toHaveText("PreArm: Hardware safety switch");

  // The vehicle arms by some other means (transmitter) while the browser was
  // just polling -- the held reason is now moot and must not linger.
  backend.pushTelemetry({ vehicle: { ...backend.state.vehicle, armed: true } });
  await expect(page.locator("#pilotArmed")).toHaveText("ARMED");
  await expect(page.locator("#pilotArmDiagnostic")).toHaveCount(0);
});

test("the full Messages list still carries every STATUSTEXT untouched", async ({ page }) => {
  const initial = telemetryStatus();
  initial.statusTexts = [
    { severity: 6, severityName: "INFO", text: "ArduCopter V4.5.7", receivedAt: 1 },
    { severity: 4, severityName: "WARNING", text: "PreArm: Hardware safety switch", receivedAt: 2 }
  ];
  await openManualPanel(page, {
    initial,
    rejectArm: { vehicleReason: "PreArm: Hardware safety switch" }
  });
  await enableBench(page);
  await page.locator("#pilotArmButton").click();
  await expect(page.locator("#pilotArmVehicleReason")).toHaveText("PreArm: Hardware safety switch");

  // The dedicated diagnostic block does not remove or replace the ordinary
  // Messages surface; both statustext entries are still present wherever
  // that list is rendered.
  const messages = await page.evaluate(() => window.pilotControlPanel?.telemetry?.statusTexts ?? []);
  const texts = messages.map((entry) => entry.text);
  expect(texts).toContain("ArduCopter V4.5.7");
  expect(texts).toContain("PreArm: Hardware safety switch");
});

test("WebSocket loss stays gated and cannot resume a held command", async ({ page }) => {
  const backend = await openManualPanel(page);
  await enableBench(page);
  await armMock(page);
  await page.keyboard.down("ShiftLeft");
  await page.keyboard.down("KeyW");
  await expect(page.locator("#pilotStatusTransmitting")).toHaveAttribute("data-tone", "danger");

  const before = backend.inputs().length;
  backend.closeWebSocket();
  await expect.poll(() => backend.inputs().slice(before).some((post) => post.body?.neutral === true)).toBe(true);
  await expect(page.locator("#pilotStatusTransmitting")).toHaveAttribute("data-tone", "idle");
  await expect(page.locator("#pilotBlockedBanner")).toContainText("WebSocket disconnected");

  const movementCount = backend.movementInputs().length;
  await page.keyboard.up("KeyW");
  await page.keyboard.down("ArrowRight");
  await page.waitForTimeout(350);
  expect(backend.movementInputs()).toHaveLength(movementCount);
  await expect(page.locator("#pilotStatusTransmitting")).toHaveAttribute("data-tone", "idle");
  await page.keyboard.up("ArrowRight");
  await page.keyboard.up("ShiftLeft");
});

test("WebSocket loss before ARM hides Ready and disables ARM", async ({ page }) => {
  const backend = await openManualPanel(page);
  await enableBench(page);
  await expect(page.locator("#pilotArmButton")).toBeEnabled();

  backend.closeWebSocket();
  await expect(page.locator("#pilotBlockedBanner")).toContainText("WebSocket disconnected");
  await expect(page.locator("#pilotArmButton")).toBeDisabled();
  await expect(page.locator("#pilotStatusFailsafe")).toHaveAttribute("data-tone", "warn");
});

test("a WebSocket that never opens cannot enable or transmit manual control", async ({ page }) => {
  const backend = await openManualPanel(page, {
    initial: telemetryStatus({ armed: true })
  });
  await page.evaluate(() => {
    const panel = window.pilotControlPanel;
    panel.socketHandle?.close?.();
    panel.droneClient.WebSocketImpl = class StuckWebSocket extends EventTarget {
      static CONNECTING = 0;
      constructor() {
        super();
        this.readyState = 0;
      }
      close() {}
    };
    panel.openSocket();
  });
  await page.locator("#pilotBenchPropsAck").check();
  await expect(page.locator("#pilotBenchEnableButton")).toBeDisabled();
  await expect(page.locator("#pilotBlockedBanner")).toContainText("WebSocket disconnected");

  await page.locator("#gpKeyCapture").click();
  await page.keyboard.down("ShiftLeft");
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(300);
  expect(backend.movementInputs()).toHaveLength(0);
  await page.keyboard.up("KeyW");
  await page.keyboard.up("ShiftLeft");
});

test("backend readiness and RC diagnostics remain authoritative", async ({ page }) => {
  const pilot = pilotSnapshot({
    enabled: true,
    readyToArm: false,
    blockedReason: "rc_overrides_ignored",
    rcConfiguration: null,
    rcConfigurationError: {
      reason: "rc_overrides_ignored",
      message: "RC_OPTIONS bit 1 ignores MAVLink overrides"
    }
  });
  await openManualPanel(page, { initial: telemetryStatus({ pilot }) });

  await expect(page.locator("#pilotBlockedBanner")).toContainText("RC_OPTIONS");
  await expect(page.locator("#pilotBlockedBanner")).not.toContainText("Ready to arm");
  await expect(page.locator("#pilotArmButton")).toBeDisabled();
  await page.getByText("RC mapping / Safety diagnostics").click();
  await expect(page.locator("#pilotRoot")).toContainText("Pending / incompatible");
});

test("the mock-provider query cannot drive input when the backend reports real mode", async ({ page }) => {
  const initial = telemetryStatus();
  initial.mode = "real";
  const backend = await openManualPanel(page, { initial });
  await page.locator("#gpSource").selectOption("ps5");

  await expect(page.locator("[data-mock-connect]")).toHaveCount(0);
  expect(await page.evaluate(() => window.gamepadController.mockEnabled)).toBe(false);
  await enableBench(page);
  await armMock(page);
  await page.evaluate(() => {
    window.gamepadController.mock.connect();
    window.gamepadController.mock.setButton(4, 1);
    window.gamepadController.mock.setAxis(1, -0.8);
  });
  await page.waitForTimeout(350);
  expect(backend.movementInputs()).toHaveLength(0);
  await expect(page.locator("#pilotStatusTransmitting")).toHaveAttribute("data-tone", "idle");
});

test("a live WebSocket payload reporting stale MAVLink clears output immediately", async ({ page }) => {
  const backend = await openManualPanel(page);
  await enableBench(page);
  await armMock(page);
  await page.keyboard.down("ShiftLeft");
  await page.keyboard.down("KeyW");
  await expect(page.locator("#pilotStatusTransmitting")).toHaveAttribute("data-tone", "danger");

  const before = backend.inputs().length;
  backend.pushTelemetry({ connectionState: "telemetry_stale", link: { stale: true, lastMessageAge: 8.4 } });
  await expect.poll(() => backend.inputs().slice(before).some((post) => post.body?.neutral === true)).toBe(true);
  await expect(page.locator("#pilotStatusTransmitting")).toHaveAttribute("data-tone", "idle");
  await expect(page.locator("#pilotBlockedBanner")).toContainText("Telemetry is stale");
  await page.keyboard.up("KeyW");
  await page.keyboard.up("ShiftLeft");
});

for (const viewport of [
  { width: 1024, height: 768 },
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 }
]) {
  test(`Manual Control is readable without document overflow at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openManualPanel(page);
    const layout = await page.evaluate(() => {
      const chips = [...document.querySelectorAll("#pilotRoot .drone-chip")];
      return {
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        chips: chips.map((chip) => {
          const style = getComputedStyle(chip);
          return {
            text: chip.textContent.trim(),
            whiteSpace: style.whiteSpace,
            wordBreak: style.wordBreak,
            height: chip.getBoundingClientRect().height,
            lineHeight: parseFloat(style.lineHeight) || chip.getBoundingClientRect().height
          };
        })
      };
    });
    expect(layout.overflow).toBeLessThanOrEqual(1);
    for (const chip of layout.chips) {
      expect(chip.whiteSpace, chip.text).toBe("nowrap");
      expect(chip.wordBreak, chip.text).not.toBe("break-all");
      expect(chip.height / chip.lineHeight, chip.text).toBeLessThan(1.8);
    }
  });
}

// ----------------------------------------------------------------------
// ARM eligibility and the HTTP 422 regression
//
// Reported symptom: the ARM button was disabled (bare "not-allowed" cursor,
// no stated reason) while the blocked banner read "Blocked: http 422".
//
// Two independent defects, both covered here:
//   1. The browser could send `provider: "ps5"` — a UI *source* id in a field
//      whose backend contract is a provider Literal — so FastAPI rejected the
//      frame with 422. Release/neutral frames were rejected too, and the
//      failure latched into the gate banner.
//   2. A disabled ARM button explained nothing.
//
// The dead-man is deliberately NOT an ARM gate: it authorises continuous
// manual RC movement, whereas ARM is one deliberate operator action.
// ----------------------------------------------------------------------

test("ARM is enabled with the dead-man released, and stays enabled while it is held", async ({ page }) => {
  await openManualPanel(page);
  await enableBench(page);

  await expect(page.locator("#pilotDeadman")).toHaveText("RELEASED");
  await expect(page.locator("#pilotArmButton")).toBeEnabled();
  await expect(page.locator("#pilotArmStatus")).toHaveText("READY");
  await expect(page.locator("#pilotArmReason")).toHaveCount(0);

  await page.keyboard.down("ShiftLeft");
  await expect(page.locator("#pilotDeadman")).toHaveText("HELD");
  await expect(page.locator("#pilotArmButton")).toBeEnabled();
  await page.keyboard.up("ShiftLeft");
});

test("a disabled ARM button always states why, in words", async ({ page }) => {
  await openManualPanel(page);

  // Bench Pilot not enabled yet.
  await expect(page.locator("#pilotArmButton")).toBeDisabled();
  await expect(page.locator("#pilotArmReason")).toContainText("Enable Bench Pilot first");
  await expect(page.locator("#pilotArmStatus")).toHaveText("UNAVAILABLE");

  // Ticking the acknowledgement alone must not enable ARM.
  await page.locator("#pilotBenchPropsAck").check();
  await expect(page.locator("#pilotArmButton")).toBeDisabled();
  await expect(page.locator("#pilotArmReason")).toContainText("Enable Bench Pilot first");
});

test("ARM is disabled with a stated reason when MAVLink drops, and DISARM is offered once ARMED", async ({ page }) => {
  const backend = await openManualPanel(page);
  await enableBench(page);
  await expect(page.locator("#pilotArmButton")).toBeEnabled();

  await armMock(page);
  await expect(page.locator("#pilotArmButton")).toBeDisabled();
  await expect(page.locator("#pilotArmReason")).toContainText("already ARMED");
  await expect(page.locator("#pilotDisarmButton")).toBeEnabled();

  backend.pushTelemetry({ connectionState: "disconnected", connected: false, link: { stale: true } });
  await expect(page.locator("#pilotArmButton")).toBeDisabled();
  await expect(page.locator("#pilotArmReason")).toContainText("MAVLink is disconnected or telemetry is stale");
});

test("no manual frame is ever rejected as an API validation error, on either input source", async ({ page }) => {
  const backend = await openManualPanel(page);

  // Exercise the PS5 source too: its UI id ("ps5") is not a wire provider id,
  // and sending it verbatim is what produced HTTP 422.
  await page.locator("#gpSource").selectOption("ps5");
  await page.locator("#gpSource").selectOption("keyboard");

  await enableBench(page);
  await page.keyboard.down("ShiftLeft");
  await page.keyboard.down("ArrowUp");
  await expect.poll(() => backend.inputs().length).toBeGreaterThan(0);
  await page.keyboard.up("ArrowUp");
  await page.keyboard.up("ShiftLeft");

  const allowed = ["keyboard", "browser", "mock", "gamepad", "unknown"];
  for (const post of backend.inputs()) {
    expect(allowed, `provider ${post.body?.provider}`).toContain(post.body?.provider ?? "unknown");
    expect(typeof post.body?.source).toBe("string");
    expect(post.body.source.length).toBeGreaterThan(0);
    expect(Number.isInteger(post.body?.sequence)).toBe(true);
  }

  // And nothing latched an HTTP validation failure into the gate banner.
  await expect(page.locator("#pilotBlockedBanner")).not.toContainText("422");
});

test("a stale transport failure stops masquerading as the current gate once frames flow again", async ({ page }) => {
  await openManualPanel(page);
  await enableBench(page);
  // Arm first: while the vehicle is ready-to-arm the banner deliberately shows
  // "Ready to arm", so a latched gate is only observable once it is armed —
  // which is also the state the operator reported the sticky 422 in.
  await armMock(page);

  // Latch a transport failure the same way a failed frame does.
  await page.evaluate(() => {
    window.pilotControlPanel.controller.failsafeReason = "http_422";
    window.pilotControlPanel.render();
  });
  await expect(page.locator("#pilotBlockedBanner")).toContainText("http 422");

  // A delivered frame proves the transport recovered.
  await page.keyboard.down("ShiftLeft");
  await page.keyboard.down("ArrowUp");
  await expect(page.locator("#pilotBlockedBanner")).not.toContainText("422");
  await page.keyboard.up("ArrowUp");
  await page.keyboard.up("ShiftLeft");
});

test("an idle, disarmed bench vehicle with the dead-man released is not a FAILSAFE", async ({ page }) => {
  await openManualPanel(page);
  await enableBench(page);

  await expect(page.locator("#pilotDeadman")).toHaveText("RELEASED");
  await expect(page.locator("#pilotStatusFailsafe")).toHaveAttribute("data-tone", "idle");
  await expect(page.locator("#pilotBlockedBanner")).toContainText("Ready to arm");
});
