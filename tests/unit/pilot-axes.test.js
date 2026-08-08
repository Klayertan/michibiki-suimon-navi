import test from "node:test";
import assert from "node:assert/strict";
import {
  AXIS_EPSILON,
  NEUTRAL_AXES,
  axesAreNeutral,
  axesEqual,
  horizontalMagnitude,
  sampleToPilotAxes
} from "../../js/pilot/pilot-axes.js";
import { DEFAULT_KEY_MAP, NEUTRAL_CODE, KeyboardProvider } from "../../js/gamepad/keyboard-provider.js";

// A sample as the providers emit it: axes[0]=yaw, [1]=vertical, [2]=roll, [3]=pitch.
function sample(axes) {
  return { provider: "test", id: "test", mapping: "standard", axes, buttons: [], timestamp: 0 };
}

// ----------------------------------------------------------------------
// Axis conversion signs
// ----------------------------------------------------------------------

test("a stick pushed forward means fly forward", () => {
  // Pitch axis reads negative when pushed away from the pilot.
  assert.equal(sampleToPilotAxes(sample([0, 0, 0, -1])).forward, 1);
  assert.equal(sampleToPilotAxes(sample([0, 0, 0, 1])).forward, -1);
});

test("roll right is positive right", () => {
  assert.equal(sampleToPilotAxes(sample([0, 0, 1, 0])).right, 1);
  assert.equal(sampleToPilotAxes(sample([0, 0, -1, 0])).right, -1);
});

test("vertical axis inverts into a positive climb", () => {
  assert.equal(sampleToPilotAxes(sample([0, -1, 0, 0])).up, 1);
  assert.equal(sampleToPilotAxes(sample([0, 1, 0, 0])).up, -1);
});

test("yaw right is positive", () => {
  assert.equal(sampleToPilotAxes(sample([1, 0, 0, 0])).yaw, 1);
  assert.equal(sampleToPilotAxes(sample([-1, 0, 0, 0])).yaw, -1);
});

test("a malformed or missing sample yields neutral, never a partial command", () => {
  for (const bad of [null, undefined, {}, { axes: "nope" }, { axes: null }]) {
    assert.deepEqual(sampleToPilotAxes(bad), { ...NEUTRAL_AXES });
  }
});

test("non-finite axis values become zero", () => {
  const axes = sampleToPilotAxes(sample([NaN, Infinity, -Infinity, NaN]));
  assert.deepEqual(axes, { ...NEUTRAL_AXES });
});

test("out-of-range values are clamped, not amplified", () => {
  const axes = sampleToPilotAxes(sample([9, -9, 9, -9]));
  assert.equal(axes.yaw, 1);
  assert.equal(axes.up, 1);
  assert.equal(axes.right, 1);
  assert.equal(axes.forward, 1);
});

test("stick noise below the epsilon reads as exactly zero", () => {
  const tiny = AXIS_EPSILON / 2;
  assert.ok(axesAreNeutral(sampleToPilotAxes(sample([tiny, -tiny, tiny, -tiny]))));
});

test("horizontal magnitude never exceeds 1 even on a full diagonal", () => {
  assert.equal(horizontalMagnitude({ forward: 1, right: 1 }), 1);
  assert.ok(Math.abs(horizontalMagnitude({ forward: 0.6, right: 0.8 }) - 1) < 1e-9);
});

test("axesEqual treats sub-epsilon differences as the same command", () => {
  assert.ok(axesEqual({ forward: 0, right: 0, up: 0, yaw: 0 }, { forward: AXIS_EPSILON / 2, right: 0, up: 0, yaw: 0 }));
  assert.ok(!axesEqual({ forward: 0, right: 0, up: 0, yaw: 0 }, { forward: 1, right: 0, up: 0, yaw: 0 }));
});

// ----------------------------------------------------------------------
// The requested keyboard mapping, end to end through the provider
// ----------------------------------------------------------------------

/** Drive a real KeyboardProvider with fake window/document. */
function makeProvider() {
  const listeners = {};
  const win = {
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: (type, fn) => { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); }
  };
  const doc = {
    hidden: false,
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: (type, fn) => { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); }
  };
  const provider = new KeyboardProvider({ win, doc });
  const fire = (type, event) => (listeners[type] || []).forEach((fn) => fn(event));
  const press = (code, target = {}) => fire("keydown", { code, target, preventDefault() {} });
  const release = (code, target = {}) => fire("keyup", { code, target, preventDefault() {} });
  return { provider, fire, press, release };
}

function pilotAxesOf(provider) {
  return sampleToPilotAxes(provider.sample());
}

test("Arrow Up produces a forward command", () => {
  const { provider, press } = makeProvider();
  provider.startCapture();
  press("ArrowUp");
  assert.equal(pilotAxesOf(provider).forward, 1);
});

test("Arrow Down produces a backward command", () => {
  const { provider, press } = makeProvider();
  provider.startCapture();
  press("ArrowDown");
  assert.equal(pilotAxesOf(provider).forward, -1);
});

test("Arrow Left and Arrow Right have the correct sign", () => {
  const { provider, press, release } = makeProvider();
  provider.startCapture();
  press("ArrowLeft");
  assert.equal(pilotAxesOf(provider).right, -1);
  release("ArrowLeft");
  press("ArrowRight");
  assert.equal(pilotAxesOf(provider).right, 1);
});

test("W climbs and S descends", () => {
  const { provider, press, release } = makeProvider();
  provider.startCapture();
  press("KeyW");
  assert.equal(pilotAxesOf(provider).up, 1, "W must climb");
  release("KeyW");
  press("KeyS");
  assert.equal(pilotAxesOf(provider).up, -1, "S must descend");
});

test("A yaws left and D yaws right", () => {
  const { provider, press, release } = makeProvider();
  provider.startCapture();
  press("KeyA");
  assert.equal(pilotAxesOf(provider).yaw, -1);
  release("KeyA");
  press("KeyD");
  assert.equal(pilotAxesOf(provider).yaw, 1);
});

test("releasing a key returns that axis to zero immediately", () => {
  const { provider, press, release } = makeProvider();
  provider.startCapture();
  press("ArrowUp");
  assert.equal(pilotAxesOf(provider).forward, 1);
  release("ArrowUp");
  assert.equal(pilotAxesOf(provider).forward, 0);
});

test("opposing keys on the same axis resolve to zero", () => {
  const { provider, press } = makeProvider();
  provider.startCapture();
  press("ArrowUp");
  press("ArrowDown");
  assert.equal(pilotAxesOf(provider).forward, 0, "up+down must cancel");
  press("KeyA");
  press("KeyD");
  assert.equal(pilotAxesOf(provider).yaw, 0, "A+D must cancel");
});

test("diagonal input drives both horizontal axes at once", () => {
  const { provider, press } = makeProvider();
  provider.startCapture();
  press("ArrowUp");
  press("ArrowRight");
  const axes = pilotAxesOf(provider);
  assert.equal(axes.forward, 1);
  assert.equal(axes.right, 1);
  // The magnitude clamp itself happens server-side; the browser only reports
  // intent. This asserts the intent survives the trip.
  assert.equal(horizontalMagnitude(axes), 1);
});

test("Space clears every held key", () => {
  const { provider, press } = makeProvider();
  provider.startCapture();
  press("ArrowUp");
  press("ArrowRight");
  press("KeyW");
  press("KeyD");
  assert.ok(!axesAreNeutral(pilotAxesOf(provider)));

  press(NEUTRAL_CODE);
  assert.ok(axesAreNeutral(pilotAxesOf(provider)), "Space must zero all movement");
});

test("Space emits a neutral event so the pilot layer can send out of band", () => {
  const { provider, press } = makeProvider();
  provider.startCapture();
  let fired = 0;
  provider.addEventListener("neutral", () => { fired += 1; });
  press(NEUTRAL_CODE);
  assert.equal(fired, 1);
});

test("window blur clears all held keys", () => {
  const { provider, press, fire } = makeProvider();
  provider.startCapture();
  press("ArrowUp");
  press("KeyD");
  fire("blur", {});
  assert.ok(axesAreNeutral(pilotAxesOf(provider)), "focus loss must neutralise");
});

test("visibility hidden clears all held keys", () => {
  const { provider, press, fire } = makeProvider();
  const doc = provider.doc;
  provider.startCapture();
  press("ArrowUp");
  doc.hidden = true;
  fire("visibilitychange", {});
  assert.ok(axesAreNeutral(pilotAxesOf(provider)));
});

test("pagehide clears all held keys", () => {
  const { provider, press, fire } = makeProvider();
  provider.startCapture();
  press("KeyW");
  fire("pagehide", {});
  assert.ok(axesAreNeutral(pilotAxesOf(provider)));
});

test("stopping capture clears held keys, preventing a stuck key", () => {
  const { provider, press } = makeProvider();
  provider.startCapture();
  press("ArrowUp");
  provider.stopCapture();
  assert.ok(axesAreNeutral(pilotAxesOf(provider)));
});

test("keys do nothing at all before capture is enabled", () => {
  const { provider, press } = makeProvider();
  press("ArrowUp");
  assert.ok(axesAreNeutral(pilotAxesOf(provider)));
});

test("flight keys are ignored while typing in text entry surfaces", () => {
  const { provider, press } = makeProvider();
  provider.startCapture();
  for (const target of [
    { tagName: "INPUT", type: "text" },
    { tagName: "TEXTAREA" },
    { tagName: "SELECT" },
    { isContentEditable: true },
    { tagName: "INPUT", type: "number" },
    { tagName: "INPUT", type: "search" }
  ]) {
    press("ArrowUp", target);
    assert.ok(axesAreNeutral(pilotAxesOf(provider)), `must ignore keys on ${target.tagName || "contenteditable"}`);
  }
});

test("a checkbox is not text entry, so flight keys still work there", () => {
  const { provider, press } = makeProvider();
  provider.startCapture();
  press("ArrowUp", { tagName: "INPUT", type: "checkbox" });
  assert.equal(pilotAxesOf(provider).forward, 1);
});

test("the mapping is exactly the documented one", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(DEFAULT_KEY_MAP).map(([k, v]) => [k, `${v.axis}:${v.value}`])),
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
  assert.equal(NEUTRAL_CODE, "Space");
});
