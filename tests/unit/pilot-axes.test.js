import test from "node:test";
import assert from "node:assert/strict";
import {
  AXIS_EPSILON,
  KEYBOARD_DIGITAL_DEFLECTION,
  NEUTRAL_AXES,
  axesAreNeutral,
  axesEqual,
  horizontalMagnitude,
  sampleDeadman,
  sampleToPilotAxes
} from "../../js/pilot/pilot-axes.js";
import {
  DEFAULT_KEY_MAP,
  DEADMAN_CODE,
  KEYBOARD_DEFLECTION,
  NEUTRAL_CODE,
  PANIC_CODE,
  KeyboardProvider
} from "../../js/gamepad/keyboard-provider.js";

function sample(axes, extra = {}) {
  return { provider: "test", id: "test", mapping: "standard", axes, buttons: [], timestamp: 0, ...extra };
}

test("provider axes become pitch, roll, throttle and yaw with documented signs", () => {
  assert.deepEqual(sampleToPilotAxes(sample([0.7, -0.6, 0.5, -0.4])), {
    pitch: 0.4,
    roll: 0.5,
    throttle: 0.6,
    yaw: 0.7
  });
  assert.deepEqual(sampleToPilotAxes(sample([-0.7, 0.6, -0.5, 0.4])), {
    pitch: -0.4,
    roll: -0.5,
    throttle: -0.6,
    yaw: -0.7
  });
});

test("missing, malformed and non-finite samples fail closed to neutral", () => {
  for (const bad of [null, undefined, {}, { axes: "nope" }, { axes: null }]) {
    assert.deepEqual(sampleToPilotAxes(bad), { ...NEUTRAL_AXES });
  }
  assert.deepEqual(sampleToPilotAxes(sample([NaN, Infinity, -Infinity, NaN])), { ...NEUTRAL_AXES });
});

test("provider axes are clamped and stick noise collapses to zero", () => {
  assert.deepEqual(sampleToPilotAxes(sample([9, -9, 9, -9])), {
    pitch: 1,
    roll: 1,
    throttle: 1,
    yaw: 1
  });
  const tiny = AXIS_EPSILON / 2;
  assert.ok(axesAreNeutral(sampleToPilotAxes(sample([tiny, -tiny, tiny, -tiny]))));
});

test("axis comparison and horizontal magnitude use semantic pitch and roll", () => {
  assert.ok(axesEqual(NEUTRAL_AXES, { pitch: AXIS_EPSILON / 2, roll: 0, throttle: 0, yaw: 0 }));
  assert.ok(!axesEqual(NEUTRAL_AXES, { pitch: 1, roll: 0, throttle: 0, yaw: 0 }));
  assert.equal(horizontalMagnitude({ pitch: 1, roll: 1 }), 1);
  assert.ok(Math.abs(horizontalMagnitude({ pitch: 0.6, roll: 0.8 }) - 1) < 1e-9);
});

function makeProvider() {
  const listeners = {};
  const add = (type, fn) => { (listeners[type] ||= []).push(fn); };
  const remove = (type, fn) => { listeners[type] = (listeners[type] || []).filter((candidate) => candidate !== fn); };
  const win = { addEventListener: add, removeEventListener: remove };
  const doc = { hidden: false, addEventListener: add, removeEventListener: remove };
  const provider = new KeyboardProvider({ win, doc });
  const fire = (type, event = {}) => (listeners[type] || []).forEach((fn) => fn(event));
  const event = (code, target = {}) => ({ code, target, preventDefault() {} });
  return {
    provider,
    doc,
    fire,
    press: (code, target) => fire("keydown", event(code, target)),
    release: (code, target) => fire("keyup", event(code, target))
  };
}

function pilotAxes(provider) {
  return sampleToPilotAxes(provider.sample());
}

test("keyboard directions are conservative quarter-stick semantic intentions", () => {
  assert.equal(KEYBOARD_DEFLECTION, 0.25);
  assert.equal(KEYBOARD_DIGITAL_DEFLECTION, KEYBOARD_DEFLECTION);
  const { provider, press, release } = makeProvider();
  provider.startCapture();

  for (const [code, axis, expected] of [
    ["ArrowUp", "pitch", 0.25],
    ["ArrowDown", "pitch", -0.25],
    ["ArrowRight", "roll", 0.25],
    ["ArrowLeft", "roll", -0.25],
    ["KeyW", "throttle", 0.25],
    ["KeyS", "throttle", -0.25],
    ["KeyD", "yaw", 0.25],
    ["KeyA", "yaw", -0.25]
  ]) {
    press(code);
    assert.equal(pilotAxes(provider)[axis], expected, `${code} -> ${axis}`);
    release(code);
    assert.ok(axesAreNeutral(pilotAxes(provider)), `${code} release -> neutral`);
  }
});

test("opposing keys cancel and diagonal intent preserves both axes", () => {
  const { provider, press, release } = makeProvider();
  provider.startCapture();
  press("ArrowUp");
  press("ArrowDown");
  assert.equal(pilotAxes(provider).pitch, 0);
  release("ArrowDown");
  press("ArrowRight");
  assert.deepEqual(pilotAxes(provider), { pitch: 0.25, roll: 0.25, throttle: 0, yaw: 0 });
});

test("Shift is the keyboard dead-man and movement keys cannot impersonate it", () => {
  const { provider, press, release } = makeProvider();
  provider.startCapture();
  press("ArrowUp");
  assert.equal(sampleDeadman(provider.sample()), false);
  press(DEADMAN_CODE);
  assert.equal(sampleDeadman(provider.sample()), true);
  assert.equal(pilotAxes(provider).pitch, 0.25);
  release(DEADMAN_CODE);
  assert.equal(sampleDeadman(provider.sample()), false);
});

test("sampleDeadman prefers the provider's configured boolean over button positions", () => {
  const buttons = Array.from({ length: 18 }, () => ({ pressed: false, value: 0 }));
  buttons[4].pressed = true;
  assert.equal(sampleDeadman({ buttons, deadmanHeld: false }), false);
  assert.equal(sampleDeadman({ buttons, deadmanHeld: true }), true);
  delete buttons[4].pressed;
  buttons[7].pressed = true;
  assert.equal(sampleDeadman({ buttons, deadmanHeld: true }), true, "configured provider mapping is authoritative");
});

test("malformed dead-man samples fail closed", () => {
  for (const bad of [null, undefined, {}, { buttons: null }, { buttons: [] }, { buttons: [{}] }]) {
    assert.equal(sampleDeadman(bad), false);
  }
});

test("Space clears movement and emits an immediate neutral event without ending capture", () => {
  const { provider, press } = makeProvider();
  provider.startCapture();
  let detail = null;
  provider.addEventListener("neutral", (event) => { detail = event.detail; });
  press("ArrowUp");
  press("KeyW");
  press(NEUTRAL_CODE);
  assert.ok(axesAreNeutral(pilotAxes(provider)));
  assert.equal(provider.active, true);
  assert.equal(detail?.reason, "space");
});

test("Escape clears all input, drops capture and emits panic", () => {
  const { provider, press } = makeProvider();
  provider.startCapture();
  let reason = null;
  provider.addEventListener("panic", (event) => { reason = event.detail.reason; });
  press(DEADMAN_CODE);
  press("ArrowUp");
  press(PANIC_CODE);
  assert.ok(axesAreNeutral(pilotAxes(provider)));
  assert.equal(sampleDeadman(provider.sample()), false);
  assert.equal(provider.active, false);
  assert.equal(reason, "escape");
});

test("blur, hidden tab and pagehide each clear movement and dead-man", () => {
  for (const unsafe of ["blur", "visibilitychange", "pagehide"]) {
    const { provider, doc, press, fire } = makeProvider();
    provider.startCapture();
    press(DEADMAN_CODE);
    press("ArrowUp");
    if (unsafe === "visibilitychange") doc.hidden = true;
    fire(unsafe);
    assert.ok(axesAreNeutral(pilotAxes(provider)), unsafe);
    assert.equal(sampleDeadman(provider.sample()), false, unsafe);
  }
});

test("capture is opt-in, stopping clears held state, and typing surfaces are ignored", () => {
  const { provider, press } = makeProvider();
  press("ArrowUp");
  assert.ok(axesAreNeutral(pilotAxes(provider)));
  provider.startCapture();
  for (const target of [
    { tagName: "INPUT", type: "text" },
    { tagName: "TEXTAREA" },
    { tagName: "SELECT" },
    { isContentEditable: true }
  ]) {
    press("ArrowUp", target);
    assert.ok(axesAreNeutral(pilotAxes(provider)));
  }
  press("ArrowUp", { tagName: "INPUT", type: "checkbox" });
  assert.equal(pilotAxes(provider).pitch, 0.25);
  provider.stopCapture();
  assert.ok(axesAreNeutral(pilotAxes(provider)));
});

test("the documented key map is stable", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(DEFAULT_KEY_MAP).map(([key, binding]) => [key, `${binding.axis}:${binding.value}`])),
    {
      ArrowUp: "3:-1",
      ArrowDown: "3:1",
      ArrowLeft: "2:-1",
      ArrowRight: "2:1",
      KeyW: "1:-1",
      KeyS: "1:1",
      KeyA: "0:-1",
      KeyD: "0:1"
    }
  );
});
