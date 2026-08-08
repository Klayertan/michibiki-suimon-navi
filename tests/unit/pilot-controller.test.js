import test from "node:test";
import assert from "node:assert/strict";
import { PilotController, SEND_RATE_HZ } from "../../js/pilot/pilot-controller.js";

/** A client that records calls instead of doing network I/O. */
function makeClient({ failInput = false } = {}) {
  const calls = [];
  return {
    calls,
    inputs: () => calls.filter((c) => c.kind === "input"),
    enable: async () => { calls.push({ kind: "enable" }); return { detail: { pilot: { enabled: true } } }; },
    disable: async () => { calls.push({ kind: "disable" }); return { detail: { pilot: { enabled: false } } }; },
    neutral: async () => { calls.push({ kind: "neutral" }); return { detail: { pilot: {} } }; },
    sendInput: async (axes, opts) => {
      calls.push({ kind: "input", axes: { ...axes }, neutral: Boolean(opts?.neutral) });
      if (failInput) throw new Error("backend unreachable");
      return { detail: { pilot: { enabled: true } } };
    }
  };
}

/** Fake window/document so no real listeners or timers are involved. */
function makeEnv() {
  const listeners = {};
  const add = (type, fn) => { (listeners[type] ||= []).push(fn); };
  const remove = (type, fn) => { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); };
  return {
    win: { addEventListener: add, removeEventListener: remove },
    doc: { hidden: false, addEventListener: add, removeEventListener: remove },
    fire: (type, event = {}) => (listeners[type] || []).forEach((fn) => fn(event)),
    listeners
  };
}

function makeController(overrides = {}) {
  const client = overrides.client || makeClient();
  const env = makeEnv();
  let clock = 0;
  const controller = new PilotController({
    client,
    win: env.win,
    doc: env.doc,
    now: () => clock
  });
  return {
    controller,
    client,
    env,
    advance: (ms) => { clock += ms; },
    setClock: (value) => { clock = value; }
  };
}

const sample = (axes) => ({ axes });
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("the send rate is in the requested 10-20 Hz band", () => {
  assert.ok(SEND_RATE_HZ >= 10 && SEND_RATE_HZ <= 20, `rate ${SEND_RATE_HZ} out of band`);
});

test("nothing is transmitted before the channel is enabled", async () => {
  const { controller, client } = makeController();
  controller.acceptSample(sample([0, 0, 0, -1]));
  controller.pump();
  await flush();
  assert.equal(client.inputs().length, 0);
});

test("enabling opens the channel and starts neutral", async () => {
  const { controller, client } = makeController();
  await controller.enable();
  assert.ok(client.calls.some((c) => c.kind === "enable"));
  assert.deepEqual(controller.getAxes(), { forward: 0, right: 0, up: 0, yaw: 0 });
  await controller.disable();
});

test("a held key is transmitted as a forward command", async () => {
  const { controller, client, advance } = makeController();
  await controller.enable();
  controller.acceptSample(sample([0, 0, 0, -1])); // pitch forward
  advance(100);
  controller.pump();
  await flush();

  const last = client.inputs().at(-1);
  assert.equal(last.axes.forward, 1);
  assert.equal(last.neutral, false);
  await controller.disable();
});

test("an unchanged command is resent as a keepalive so the backend never times out", async () => {
  const { controller, client, advance } = makeController();
  await controller.enable();
  controller.acceptSample(sample([0, 0, 0, -1]));

  advance(100); controller.pump(); await flush();
  const first = client.inputs().length;

  // Past the 200 ms keepalive window. The backend's own input timeout is
  // 500 ms, so refreshing at 200 ms leaves two chances to land before it
  // would decide the browser has gone away and command neutral.
  advance(250); controller.pump(); await flush();
  const second = client.inputs().length;

  assert.ok(second > first, "a still-held key must keep being refreshed");
  await controller.disable();
});

test("an unchanged command is not resent every single frame", async () => {
  const { controller, client, advance } = makeController();
  await controller.enable();
  controller.acceptSample(sample([0, 0, 0, -1]));
  advance(100); controller.pump(); await flush();
  const after = client.inputs().length;

  // Several frames well inside the keepalive window.
  for (let i = 0; i < 5; i += 1) { advance(10); controller.pump(); await flush(); }
  assert.equal(client.inputs().length, after, "unchanged input must not flood the backend");
  await controller.disable();
});

test("a changed command is sent immediately on the next frame", async () => {
  const { controller, client, advance } = makeController();
  await controller.enable();
  controller.acceptSample(sample([0, 0, 0, -1]));
  advance(100); controller.pump(); await flush();

  controller.acceptSample(sample([0, 0, 1, 0])); // now rolling right
  advance(10); controller.pump(); await flush();
  assert.equal(client.inputs().at(-1).axes.right, 1);
  await controller.disable();
});

// ----------------------------------------------------------------------
// Neutralising paths
// ----------------------------------------------------------------------

test("panic zeroes the axes and sends an explicit neutral", async () => {
  const { controller, client, advance } = makeController();
  await controller.enable();
  controller.acceptSample(sample([0, 0, 0, -1]));
  advance(100); controller.pump(); await flush();

  controller.panic("space");
  await flush();

  const last = client.inputs().at(-1);
  assert.equal(last.neutral, true, "a neutral must be flagged so the backend forces zero");
  assert.deepEqual(last.axes, { forward: 0, right: 0, up: 0, yaw: 0 });
  assert.deepEqual(controller.getAxes(), { forward: 0, right: 0, up: 0, yaw: 0 });
  await controller.disable();
});

test("window blur sends a neutral without waiting for the next frame", async () => {
  const { controller, client, env, advance } = makeController();
  await controller.enable();
  controller.acceptSample(sample([0, 0, 0, -1]));
  advance(100); controller.pump(); await flush();

  env.fire("blur");
  await flush();
  assert.equal(client.inputs().at(-1).neutral, true, "focus loss must neutralise immediately");
  await controller.disable();
});

test("tab becoming hidden sends a neutral", async () => {
  const { controller, client, env, advance } = makeController();
  await controller.enable();
  controller.acceptSample(sample([0, 0, 0, -1]));
  advance(100); controller.pump(); await flush();

  env.doc.hidden = true;
  env.fire("visibilitychange");
  await flush();
  assert.equal(client.inputs().at(-1).neutral, true);
  await controller.disable();
});

test("a visibilitychange back to visible does not neutralise", async () => {
  const { controller, client, env } = makeController();
  await controller.enable();
  const before = client.inputs().length;
  env.doc.hidden = false;
  env.fire("visibilitychange");
  await flush();
  assert.equal(client.inputs().length, before);
  await controller.disable();
});

test("pagehide sends a neutral", async () => {
  const { controller, client, env, advance } = makeController();
  await controller.enable();
  controller.acceptSample(sample([0, 0, 0, -1]));
  advance(100); controller.pump(); await flush();
  env.fire("pagehide");
  await flush();
  assert.equal(client.inputs().at(-1).neutral, true);
  await controller.disable();
});

test("disabling stops the stream and detaches its listeners", async () => {
  const { controller, client, env, advance } = makeController();
  await controller.enable();
  await controller.disable();

  const after = client.inputs().length;
  controller.acceptSample(sample([0, 0, 0, -1]));
  advance(500);
  controller.pump();
  await flush();
  assert.equal(client.inputs().length, after, "a disabled controller must transmit nothing");

  // And a late blur must not resurrect it.
  env.fire("blur");
  await flush();
  assert.equal(client.inputs().length, after);
});

test("destroy leaves the controller neutral and silent", async () => {
  const { controller, client, advance } = makeController();
  await controller.enable();
  controller.acceptSample(sample([0, 0, 0, -1]));
  controller.destroy();

  const after = client.inputs().length;
  advance(500);
  controller.pump();
  await flush();
  assert.equal(client.inputs().length, after);
  assert.deepEqual(controller.getAxes(), { forward: 0, right: 0, up: 0, yaw: 0 });
});

// ----------------------------------------------------------------------
// Failure handling
// ----------------------------------------------------------------------

test("a failed send is recorded and never retried into a backlog", async () => {
  const client = makeClient({ failInput: true });
  const { controller, advance } = makeController({ client });
  await controller.enable();
  controller.acceptSample(sample([0, 0, 0, -1]));
  advance(100); controller.pump(); await flush();

  assert.ok(controller.getState().error, "a transport failure must be visible");
  // The backend times the command out on its own; the browser must not
  // hammer it with retries.
  const attempts = client.inputs().length;
  advance(10); controller.pump(); await flush();
  assert.ok(client.inputs().length - attempts <= 1);
  await controller.disable();
});

test("a slow in-flight request does not queue stale commands behind it", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const client = {
    enable: async () => ({ detail: { pilot: {} } }),
    disable: async () => ({ detail: { pilot: {} } }),
    neutral: async () => ({ detail: { pilot: {} } }),
    sendInput: async (axes, opts) => {
      calls.push({ axes: { ...axes }, neutral: Boolean(opts?.neutral) });
      await gate;
      return { detail: { pilot: {} } };
    }
  };
  const { controller, advance } = makeController({ client });
  await controller.enable();

  controller.acceptSample(sample([0, 0, 0, -1]));
  advance(100); controller.pump();          // starts, blocks on the gate
  controller.acceptSample(sample([0, 0, 1, 0]));
  advance(100); controller.pump();          // must be dropped, not queued
  assert.equal(calls.length, 1, "a stale frame must be dropped while one is in flight");

  release();
  await flush();
  controller.destroy();
});

test("a neutral is sent even while another request is in flight", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const client = {
    enable: async () => ({ detail: { pilot: {} } }),
    disable: async () => ({ detail: { pilot: {} } }),
    neutral: async () => ({ detail: { pilot: {} } }),
    sendInput: async (axes, opts) => {
      calls.push({ neutral: Boolean(opts?.neutral) });
      if (!opts?.neutral) await gate;
      return { detail: { pilot: {} } };
    }
  };
  const { controller, advance } = makeController({ client });
  await controller.enable();

  controller.acceptSample(sample([0, 0, 0, -1]));
  advance(100); controller.pump();      // in flight, blocked
  controller.panic("space");            // must not be dropped
  await flush();

  assert.ok(calls.some((c) => c.neutral), "stop must never be dropped for being busy");
  release();
  await flush();
  controller.destroy();
});

test("the pilot layer never mentions MAVLink concepts", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dir = path.resolve("js/pilot");
  const source = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
    .join("\n");

  // The browser expresses intent only. Speeds, frames and message names live
  // server-side so a tampered frontend cannot raise its own limits.
  for (const token of [
    "SET_POSITION_TARGET",
    "MAV_FRAME",
    "type_mask",
    "COMPONENT_ARM_DISARM",
    "NAV_TAKEOFF",
    "DO_SET_SERVO",
    "RC_CHANNELS_OVERRIDE",
    "MANUAL_CONTROL"
  ]) {
    assert.ok(!source.includes(token), `js/pilot must not contain ${token}`);
  }
  // And no hard-coded speed constants.
  assert.ok(!/0\.3\s*[;,)]/.test(source), "js/pilot must not hard-code velocities");
});
