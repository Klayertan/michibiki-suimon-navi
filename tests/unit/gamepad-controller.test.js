import test from "node:test";
import assert from "node:assert/strict";

import {
  GamepadController,
  INPUT_SOURCES
} from "../../js/gamepad/gamepad-controller.js";
import { defaultCalibration } from "../../js/gamepad/gamepad-calibration.js";
import { KEYBOARD_DEFLECTION } from "../../js/gamepad/keyboard-provider.js";
import { MockGamepadProvider } from "../../js/gamepad/mock-gamepad-provider.js";

function environment() {
  const win = new EventTarget();
  win.location = { search: "" };
  win.requestAnimationFrame = () => 1;
  win.cancelAnimationFrame = () => {};
  const doc = new EventTarget();
  doc.hidden = false;
  doc.hasFocus = () => true;
  return { win, doc };
}

function fireKey(win, type, code) {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, "code", { value: code });
  win.dispatchEvent(event);
}

function memoryRepository(record = null) {
  return {
    record,
    async load() { return this.record; },
    async save(next) { this.record = { ...next, validationState: "valid" }; return this.record; },
    async delete() { this.record = null; }
  };
}

function validCalibration(id = "Simulated DualSense Controller") {
  const calibration = defaultCalibration({ id, axesCount: 4, buttonsCount: 18 });
  calibration.validationState = "valid";
  calibration.deadzones = [0, 0, 0, 0];
  calibration.expoValues = [0, 0, 0, 0];
  return calibration;
}

test("source selector exposes only Keyboard and PS5 Controller", () => {
  assert.deepEqual(INPUT_SOURCES, { keyboard: "Keyboard", ps5: "PS5 Controller" });
  const { win, doc } = environment();
  const controller = new GamepadController({ win, doc, repo: memoryRepository() });
  const html = controller.renderHtml();
  assert.match(html, />Keyboard<\/option>/);
  assert.match(html, />PS5 Controller<\/option>/);
  assert.doesNotMatch(html, /Simulated gamepad|Browser gamepad|None/);
});

test("the simulator query is inert until an authoritative mock backend allows it", () => {
  const { win, doc } = environment();
  win.location.search = "?gamepadMock=1";
  const controller = new GamepadController({ win, doc, repo: memoryRepository() });

  assert.equal(controller.mockRequested, true);
  assert.equal(controller.mockEnabled, false);
  assert.equal(controller.ps5Provider, controller.browser);
  controller.setMockAllowed(false);
  assert.equal(controller.ps5Provider, controller.browser);
  controller.setMockAllowed(true);
  assert.equal(controller.mockEnabled, true);
  assert.equal(controller.ps5Provider, controller.mock);
});

test("desktop runtime identity remains visible inside the unified input fragment", () => {
  const { win, doc } = environment();
  win.SUISUI_DESKTOP = { mode: "preview", modeLabel: "Preview", development: false };
  const controller = new GamepadController({ win, doc, repo: memoryRepository() });
  const html = controller.renderHtml();
  assert.match(html, /class="gp-desktop-badge"/);
  assert.match(html, /デスクトップ版 \/ Desktop/);
  assert.match(html, /Preview mode/);
});

test("keyboard emits calibrated semantic quarter-stick axes and Shift dead-man", async (t) => {
  const { win, doc } = environment();
  const controller = new GamepadController({ win, doc, repo: memoryRepository() });
  t.after(() => controller.destroy());
  await controller.mount();

  assert.equal(KEYBOARD_DEFLECTION, 0.25);
  assert.equal(controller.getState().connected, true);
  assert.equal(controller.getState().calibrated, true);
  assert.equal(controller.getState().gateReason, "capture-inactive");
  assert.match(controller.renderHtml(), /Calibration: not required/);
  assert.match(controller.renderHtml(), /id="gpKeyCapture"[^>]*data-input-capture/);
  assert.doesNotMatch(controller.renderHtml(), /Advanced \/ Calibration|Raw input diagnostics/);

  controller.startCapture();
  fireKey(win, "keydown", "ShiftLeft");
  fireKey(win, "keydown", "ArrowUp");
  const active = controller.getState();
  assert.equal(active.deadmanHeld, true);
  assert.equal(active.gateReason, null);
  assert.equal(active.axes.pitch, KEYBOARD_DEFLECTION);
  assert.deepEqual(active.axes, { pitch: 0.25, roll: 0, throttle: 0, yaw: 0 });
  fireKey(win, "keydown", "ArrowRight");
  assert.deepEqual(controller.getState().axes, { pitch: 0.25, roll: 0.25, throttle: 0, yaw: 0 });

  let neutral;
  controller.addEventListener("neutral", (event) => { neutral = event.detail; }, { once: true });
  fireKey(win, "keyup", "ShiftLeft");
  assert.equal(neutral.reason, "deadman-released");
  assert.deepEqual(neutral.axes, { pitch: 0, roll: 0, throttle: 0, yaw: 0 });
});

test("PS5 state uses configured dead-man, assignments and inversions", async (t) => {
  const clock = { value: 100 };
  const { win, doc } = environment();
  const mock = new MockGamepadProvider({ now: () => clock.value, random: () => 0.5 });
  const controller = new GamepadController({
    win,
    doc,
    now: () => clock.value,
    initialSource: "ps5",
    ps5Provider: mock,
    mockProvider: mock,
    repo: memoryRepository()
  });
  t.after(() => controller.destroy());
  await controller.mount();
  mock.connect();

  const calibration = validCalibration();
  calibration.axisAssignments = [2, 3, 0, 1];
  calibration.axisInversions[3] = true;
  calibration.deadmanButtonIndex = 5;
  assert.equal(controller.setCalibration(calibration), true);
  controller.startCapture();

  mock.setButton(4, 1);
  assert.equal(controller.getState().deadmanHeld, false, "L1 is not authoritative after reconfiguration");
  mock.setButton(5, 1);
  mock.setAxis(0, 0.3);
  mock.setAxis(1, -0.4);
  mock.setAxis(2, 0.5);
  mock.setAxis(3, -0.6);
  const state = controller.getState();
  assert.equal(state.deadmanButtonIndex, 5);
  assert.equal(state.deadmanHeld, true);
  assert.equal(state.gateReason, null);
  assert.deepEqual(state.axes, { yaw: 0.5, throttle: -0.6, roll: 0.3, pitch: 0.4 });
  assert.match(controller.renderHtml(), /<details[^>]*data-input-calibration/);
  assert.match(controller.renderHtml(), /<details[^>]*data-input-raw/);
});

test("disconnect, focus loss, hidden tab, stale input and source switch publish immediate neutral", async (t) => {
  const clock = { value: 100 };
  const { win, doc } = environment();
  const mock = new MockGamepadProvider({ now: () => clock.value, random: () => 0.5 });
  const controller = new GamepadController({
    win,
    doc,
    now: () => clock.value,
    initialSource: "ps5",
    ps5Provider: mock,
    mockProvider: mock,
    repo: memoryRepository()
  });
  t.after(() => controller.destroy());
  const reasons = [];
  controller.addEventListener("neutral", (event) => reasons.push(event.detail.reason));
  await controller.mount();
  mock.connect();
  controller.setCalibration(validCalibration());
  controller.startCapture();
  mock.setButton(4, 1);
  mock.setAxis(0, 0.4);
  assert.equal(controller.getState().axes.yaw, 0.4);

  win.dispatchEvent(new Event("blur"));
  assert.equal(controller.getState().gateReason, "focus-lost");
  assert.deepEqual(controller.getState().axes, { pitch: 0, roll: 0, throttle: 0, yaw: 0 });
  assert.ok(reasons.includes("focus-lost"));

  win.dispatchEvent(new Event("focus"));
  doc.hidden = true;
  doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(controller.getState().gateReason, "tab-hidden");
  assert.ok(reasons.includes("tab-hidden"));

  doc.hidden = false;
  doc.dispatchEvent(new Event("visibilitychange"));
  win.dispatchEvent(new Event("pagehide"));
  assert.equal(controller.getState().gateReason, "tab-hidden");
  assert.deepEqual(controller.getState().axes, { pitch: 0, roll: 0, throttle: 0, yaw: 0 });
  assert.ok(reasons.includes("page-hidden"));

  doc.hidden = false;
  doc.dispatchEvent(new Event("visibilitychange"));
  mock.setStale(true);
  assert.equal(controller.getState().gateReason, "stale-input");
  assert.ok(reasons.includes("stale-input"));

  mock.setStale(false);
  mock.disconnect();
  assert.equal(controller.getState().connected, false);
  assert.equal(controller.getState().gateReason, "controller-disconnected");
  assert.ok(reasons.includes("controller-disconnected"));

  controller.selectSource("keyboard");
  assert.equal(controller.getState().source, "keyboard");
  assert.deepEqual(controller.getState().axes, { pitch: 0, roll: 0, throttle: 0, yaw: 0 });
  assert.ok(reasons.includes("source-switched"));
});

test("a provider stream that stops becomes stale even if its last stick value was valid", async (t) => {
  const clock = { value: 10 };
  const { win, doc } = environment();
  const buttons = Array.from({ length: 18 }, () => ({ pressed: false, touched: false, value: 0 }));
  buttons[4] = { pressed: true, touched: true, value: 1 };
  const sample = {
    provider: "browser",
    id: "Static PS5",
    mapping: "standard",
    axes: [0.4, 0, 0, 0],
    buttons,
    timestamp: 10
  };
  class StaticProvider extends EventTarget {
    constructor() { super(); this.type = "browser"; }
    start() { this.dispatchEvent(new CustomEvent("connection", { detail: sample })); }
    stop() {}
  }
  const controller = new GamepadController({
    win,
    doc,
    now: () => clock.value,
    staleMs: 500,
    initialSource: "ps5",
    ps5Provider: new StaticProvider(),
    repo: memoryRepository()
  });
  t.after(() => controller.destroy());
  await controller.mount();
  controller.setCalibration(validCalibration("Static PS5"));
  controller.startCapture();
  assert.equal(controller.getState().axes.yaw, 0.4);

  clock.value = 511;
  assert.equal(controller.checkStale(), true);
  assert.equal(controller.getState().gateReason, "stale-input");
  assert.deepEqual(controller.getState().axes, { pitch: 0, roll: 0, throttle: 0, yaw: 0 });
});

test("a stalled keyboard event stream expires held Shift and movement", async (t) => {
  const clock = { value: 10 };
  const { win, doc } = environment();
  const controller = new GamepadController({
    win,
    doc,
    now: () => clock.value,
    staleMs: 500,
    repo: memoryRepository()
  });
  t.after(() => controller.destroy());
  const reasons = [];
  controller.addEventListener("neutral", (event) => reasons.push(event.detail.reason));
  await controller.mount();
  controller.startCapture();
  fireKey(win, "keydown", "ShiftLeft");
  fireKey(win, "keydown", "KeyW");
  assert.equal(controller.getState().axes.throttle, KEYBOARD_DEFLECTION);

  clock.value = 511;
  assert.equal(controller.checkStale(), true);
  assert.equal(controller.getState().stale, true);
  assert.equal(controller.getState().deadmanHeld, false);
  assert.deepEqual(controller.getState().axes, { pitch: 0, roll: 0, throttle: 0, yaw: 0 });
  assert.ok(reasons.includes("stale-input"));

  // A late W repeat cannot resurrect the cached dead-man. Shift must be
  // deliberately pressed again before the common state can become active.
  fireKey(win, "keydown", "KeyW");
  assert.equal(controller.getState().gateReason, "deadman-released");
  assert.deepEqual(controller.getState().axes, { pitch: 0, roll: 0, throttle: 0, yaw: 0 });
});

test("mount without a root starts providers but never queries or overwrites DOM", async (t) => {
  const { win, doc } = environment();
  let queried = 0;
  doc.querySelector = () => { queried += 1; return { innerHTML: "do not replace" }; };
  const controller = new GamepadController({ win, doc, repo: memoryRepository() });
  t.after(() => controller.destroy());
  await controller.mount();
  assert.equal(queried, 0);
  assert.equal(controller.getState().connected, true);
});
