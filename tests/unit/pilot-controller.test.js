import test from "node:test";
import assert from "node:assert/strict";
import {
  KEEPALIVE_MS,
  PilotController,
  SEND_RATE_HZ
} from "../../js/pilot/pilot-controller.js";

const neutralAxes = () => ({ pitch: 0, roll: 0, throttle: 0, yaw: 0 });
const movementAxes = () => ({ pitch: 0.25, roll: -0.2, throttle: 0.1, yaw: -0.15 });
const flush = () => new Promise((resolve) => setImmediate(resolve));

function makeClient({ failInput = false, nextSequence = 1 } = {}) {
  const calls = [];
  let highWater = nextSequence - 1;
  const pilot = (extra = {}) => ({
    available: true,
    enabled: true,
    outputActive: false,
    transmitting: false,
    sequence: highWater,
    nextSequence: highWater + 1,
    ...extra
  });
  return {
    calls,
    inputs: () => calls.filter((call) => call.kind === "input"),
    enable: async () => {
      calls.push({ kind: "enable" });
      return { detail: { pilot: pilot() } };
    },
    enableBench: async (propsRemovedAck) => {
      calls.push({ kind: "enableBench", propsRemovedAck });
      return { detail: { pilot: pilot({ benchMode: true, propsRemovedAck: true }) } };
    },
    disable: async () => {
      calls.push({ kind: "disable" });
      return { detail: { pilot: pilot({ enabled: false }) } };
    },
    sendInput: async (axes, options) => {
      const call = { kind: "input", axes: { ...axes }, options: { ...options } };
      calls.push(call);
      if (failInput) throw Object.assign(new Error("backend unreachable"), { reason: "backend_unreachable" });
      highWater = Math.max(highWater, options.sequence);
      return {
        detail: {
          pilot: pilot({
            outputActive: !options.neutral && options.deadman,
            transmitting: !options.neutral && options.deadman
          })
        }
      };
    },
    arm: async () => { calls.push({ kind: "arm" }); return { message: "ARM confirmed" }; },
    disarm: async () => { calls.push({ kind: "disarm" }); return { message: "DISARM confirmed" }; }
  };
}

function makeEnv() {
  const listeners = {};
  const add = (type, fn) => { (listeners[type] ||= []).push(fn); };
  const remove = (type, fn) => { listeners[type] = (listeners[type] || []).filter((candidate) => candidate !== fn); };
  return {
    win: { addEventListener: add, removeEventListener: remove },
    doc: { hidden: false, addEventListener: add, removeEventListener: remove },
    fire: (type, event = {}) => (listeners[type] || []).forEach((fn) => fn(event)),
    listeners
  };
}

function makeController({ client = makeClient() } = {}) {
  const env = makeEnv();
  let clock = 0;
  const controller = new PilotController({ client, win: env.win, doc: env.doc, now: () => clock });
  return {
    controller,
    client,
    env,
    advance(ms) { clock += ms; }
  };
}

function input(overrides = {}) {
  return {
    source: "keyboard",
    provider: "keyboard",
    connected: true,
    calibrated: true,
    stale: false,
    deadmanHeld: true,
    gateReason: null,
    axes: movementAxes(),
    ...overrides
  };
}

test("manual frame rate remains in the 10-20 Hz safety band", () => {
  assert.ok(SEND_RATE_HZ >= 10 && SEND_RATE_HZ <= 20);
});

test("input never transmits before the backend channel is enabled", async () => {
  const { controller, client } = makeController();
  controller.acceptInput(input());
  controller.pump();
  await flush();
  assert.equal(client.inputs().length, 0);
});

test("bench enable requires an exact propellers-removed acknowledgement", async () => {
  const { controller, client } = makeController();
  await assert.rejects(controller.enableBench(false), /Propellers-removed/);
  await assert.rejects(controller.enableBench(), /Propellers-removed/);
  assert.equal(client.calls.length, 0);
  await controller.enableBench(true);
  assert.deepEqual(client.calls[0], { kind: "enableBench", propsRemovedAck: true });
  await controller.disable();
});

test("every manual mode requires the dead-man before movement can transmit", async () => {
  for (const open of ["enable", "enableBench"]) {
    const { controller, client } = makeController();
    if (open === "enableBench") await controller.enableBench(true);
    else await controller.enable();
    controller.acceptInput(input({ deadmanHeld: false, gateReason: "deadman-released" }));
    controller.pump();
    await flush();
    assert.equal(client.inputs().filter((call) => !call.options.neutral).length, 0, open);
    assert.deepEqual(controller.getAxes(), neutralAxes());
    await controller.disable();
  }
});

test("safe common input sends canonical axes, source, dead-man and sequence", async () => {
  const { controller, client } = makeController({ client: makeClient({ nextSequence: 17 }) });
  await controller.enableBench(true);
  controller.acceptInput(input({ source: "ps5", provider: "browser" }));
  await flush();
  const call = client.inputs().find((candidate) => !candidate.options.neutral);
  assert.deepEqual(call.axes, movementAxes());
  assert.deepEqual(call.options, {
    neutral: false,
    deadman: true,
    source: "ps5",
    provider: "browser",
    sequence: 17
  });
  await controller.disable();
});

test("unchanged safe input is resent as a keepalive before backend timeout", async () => {
  const { controller, client, advance } = makeController();
  await controller.enableBench(true);
  controller.acceptInput(input());
  await flush();
  const first = client.inputs().filter((call) => !call.options.neutral).length;
  advance(KEEPALIVE_MS + 1);
  controller.pump();
  await flush();
  assert.equal(client.inputs().filter((call) => !call.options.neutral).length, first + 1);
  await controller.disable();
});

test("dead-man release immediately zeroes local output and sends an out-of-band release", async () => {
  const { controller, client } = makeController();
  await controller.enableBench(true);
  controller.acceptInput(input());
  await flush();
  const before = client.inputs().length;
  controller.acceptInput(input({ deadmanHeld: false, gateReason: "deadman-released" }));
  assert.deepEqual(controller.getAxes(), neutralAxes(), "UI output must clear synchronously");
  assert.equal(controller.getState().failsafeReason, "deadman-released");
  await flush();
  const release = client.inputs().slice(before).find((call) => call.options.neutral);
  assert.ok(release);
  assert.equal(release.options.deadman, false);
  assert.deepEqual(release.axes, neutralAxes());
  await controller.disable();
});

test("disconnect, calibration loss and stale provider all fail closed", async () => {
  for (const unsafe of [
    { connected: false, gateReason: "controller-disconnected" },
    { calibrated: false, gateReason: "calibration-incomplete" },
    { stale: true, gateReason: "provider-stale" }
  ]) {
    const { controller, client } = makeController();
    await controller.enableBench(true);
    controller.acceptInput(input());
    await flush();
    const before = client.inputs().length;
    controller.acceptInput(input(unsafe));
    await flush();
    assert.deepEqual(controller.getAxes(), neutralAxes());
    assert.ok(client.inputs().slice(before).some((call) => call.options.neutral), unsafe.gateReason);
    await controller.disable();
  }
});

test("blur, hidden tab and pagehide release output immediately", async () => {
  for (const unsafe of ["blur", "visibilitychange", "pagehide"]) {
    const { controller, client, env } = makeController();
    await controller.enableBench(true);
    controller.acceptInput(input());
    await flush();
    const before = client.inputs().length;
    if (unsafe === "visibilitychange") env.doc.hidden = true;
    env.fire(unsafe);
    await flush();
    assert.deepEqual(controller.getAxes(), neutralAxes(), unsafe);
    assert.ok(client.inputs().slice(before).some((call) => call.options.neutral), unsafe);
    await controller.disable();
  }
});

test("Space-style neutral does not label an intentional stop as failsafe", async () => {
  const { controller, client } = makeController();
  await controller.enableBench(true);
  controller.acceptInput(input());
  await flush();
  await controller.panic("space", { failsafe: false });
  assert.equal(controller.getState().failsafeReason, null);
  assert.equal(client.inputs().at(-1).options.neutral, true);
  await controller.disable();
  assert.equal(controller.getState().failsafeReason, null, "DISARMED/disabled is not FAILSAFE");
});

test("a backend input failure clears TRANSMITTING and records a fail-closed reason", async () => {
  const { controller } = makeController({ client: makeClient({ failInput: true }) });
  await controller.enableBench(true);
  controller.acceptInput(input());
  await flush();
  assert.deepEqual(controller.getAxes(), neutralAxes());
  assert.equal(controller.getState().failsafeReason, "backend_unreachable");
  assert.equal(controller.getState().pilot?.outputActive, false);
  await controller.disable();
});

test("a movement response arriving after panic can never relight output", async () => {
  const base = makeClient();
  let resolveMovement;
  const client = {
    ...base,
    sendInput(axes, options) {
      base.calls.push({ kind: "input", axes: { ...axes }, options: { ...options } });
      if (!options.neutral) {
        return new Promise((resolve) => { resolveMovement = resolve; });
      }
      return Promise.resolve({ detail: { pilot: { enabled: true, outputActive: false, sequence: options.sequence, nextSequence: options.sequence + 1 } } });
    }
  };
  const { controller } = makeController({ client });
  await controller.enableBench(true);
  controller.acceptInput(input());
  await flush();
  const release = controller.panic("deadman-released");
  await release;
  resolveMovement({ detail: { pilot: { enabled: true, outputActive: true, transmitting: true, sequence: 1, nextSequence: 2 } } });
  await flush();
  assert.equal(controller.getState().pilot.outputActive, false);
  assert.deepEqual(controller.getAxes(), neutralAxes());
  await controller.disable();
});

test("a delayed neutral response cannot hide a newer accepted movement", async () => {
  const base = makeClient();
  let resolveNeutral;
  const client = {
    ...base,
    sendInput(axes, options) {
      base.calls.push({ kind: "input", axes: { ...axes }, options: { ...options } });
      if (options.neutral) {
        return new Promise((resolve) => { resolveNeutral = resolve; });
      }
      return Promise.resolve({
        detail: {
          pilot: {
            enabled: true,
            outputActive: true,
            transmitting: true,
            sequence: options.sequence,
            nextSequence: options.sequence + 1
          }
        }
      });
    }
  };
  const { controller } = makeController({ client });
  await controller.enableBench(true);
  controller.acceptInput(input());
  await flush();
  void controller.panic("neutral", { failsafe: false });
  controller.acceptInput(input({ axes: { pitch: -0.25, roll: 0, throttle: 0, yaw: 0 } }));
  await flush();
  assert.equal(controller.getState().pilot.outputActive, true);

  resolveNeutral({
    detail: {
      pilot: { enabled: true, outputActive: false, transmitting: false, sequence: 2, nextSequence: 3 }
    }
  });
  await flush();
  assert.equal(controller.getState().pilot.outputActive, true);
  controller.destroy();
});

test("an external socket gate persists and requires dead-man release before resume", async () => {
  const { controller, client } = makeController();
  await controller.enableBench(true);
  controller.acceptInput(input());
  await flush();
  const beforeGate = client.inputs().length;

  controller.setExternalGate("socket", "websocket-disconnected");
  await flush();
  controller.acceptInput(input({ axes: { pitch: -0.25, roll: 0, throttle: 0, yaw: 0 } }));
  controller.pump();
  await flush();
  assert.equal(controller.getState().externalGateReason, "websocket-disconnected");
  assert.deepEqual(controller.getAxes(), neutralAxes());
  assert.equal(
    client.inputs().slice(beforeGate).filter((call) => !call.options.neutral).length,
    0
  );

  controller.setExternalGate("socket", null);
  assert.equal(controller.getState().inputGateReason, "deadman-rearm-required");
  controller.acceptInput(input({ deadmanHeld: false, gateReason: "deadman-released" }));
  controller.acceptInput(input({ axes: { pitch: -0.25, roll: 0, throttle: 0, yaw: 0 } }));
  await flush();
  assert.ok(client.inputs().slice(beforeGate).some((call) => !call.options.neutral));
  await controller.disable();
});

test("pressing the dead-man during a socket outage cannot auto-resume on reconnect", async () => {
  const { controller, client } = makeController();
  await controller.enableBench(true);
  controller.acceptInput(input({ deadmanHeld: false, gateReason: "deadman-released" }));
  controller.setExternalGate("socket", "websocket-disconnected");
  controller.acceptInput(input());
  await flush();
  const beforeReconnect = client.inputs().length;

  controller.setExternalGate("socket", null);
  controller.pump();
  await flush();
  assert.equal(controller.getState().inputGateReason, "deadman-rearm-required");
  assert.deepEqual(controller.getAxes(), neutralAxes());
  assert.equal(
    client.inputs().slice(beforeReconnect).filter((call) => !call.options.neutral).length,
    0
  );

  controller.acceptInput(input({ deadmanHeld: false, gateReason: "deadman-released" }));
  controller.acceptInput(input());
  await flush();
  assert.ok(client.inputs().slice(beforeReconnect).some((call) => !call.options.neutral));
  await controller.disable();
});

test("a provider safety gate cannot resume a physically held PS5 dead-man", async () => {
  const { controller, client } = makeController();
  await controller.enableBench(true);
  controller.acceptInput(input({ source: "ps5", provider: "browser" }));
  await flush();
  const beforeGate = client.inputs().length;

  controller.acceptInput(input({
    source: "ps5",
    provider: "browser",
    deadmanHeld: false,
    rawDeadmanHeld: true,
    gateReason: "tab-hidden"
  }));
  controller.acceptInput(input({
    source: "ps5",
    provider: "browser",
    deadmanHeld: true,
    rawDeadmanHeld: true,
    gateReason: null
  }));
  controller.pump();
  await flush();
  assert.equal(controller.getState().inputGateReason, "deadman-rearm-required");
  assert.deepEqual(controller.getAxes(), neutralAxes());
  assert.equal(
    client.inputs().slice(beforeGate).filter((call) => !call.options.neutral).length,
    0
  );

  controller.acceptInput(input({
    source: "ps5",
    provider: "browser",
    deadmanHeld: false,
    rawDeadmanHeld: false,
    gateReason: "deadman-released"
  }));
  controller.acceptInput(input({ source: "ps5", provider: "browser" }));
  await flush();
  assert.ok(client.inputs().slice(beforeGate).some((call) => !call.options.neutral));
  await controller.disable();
});

test("sequence is monotonic across movement, panic, disable and re-enable", async () => {
  const client = makeClient({ nextSequence: 40 });
  const { controller } = makeController({ client });
  await controller.enableBench(true);
  controller.acceptInput(input());
  await flush();
  await controller.panic("neutral", { failsafe: false });
  await controller.disable();
  await controller.enableBench(true);
  controller.acceptInput(input({ axes: { pitch: -0.25, roll: 0, throttle: 0, yaw: 0 } }));
  await flush();
  const sequences = client.inputs().map((call) => call.options.sequence);
  assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
  assert.equal(new Set(sequences).size, sequences.length);
  assert.ok(sequences[0] >= 40);
  await controller.disable();
});

test("disable sends release before closing the manual channel", async () => {
  const { controller, client } = makeController();
  await controller.enableBench(true);
  controller.acceptInput(input());
  await flush();
  await controller.disable();
  const releaseIndex = client.calls.findLastIndex((call) => call.kind === "input" && call.options.neutral);
  const disableIndex = client.calls.findLastIndex((call) => call.kind === "disable");
  assert.ok(releaseIndex >= 0 && releaseIndex < disableIndex);
  assert.equal(controller.enabled, false);
  assert.equal(controller.getState().failsafeReason, null);
});

test("ARM and DISARM use only the client's explicit normal command methods", async () => {
  const { controller, client } = makeController();
  assert.equal((await controller.arm()).message, "ARM confirmed");
  assert.equal((await controller.disarm()).message, "DISARM confirmed");
  assert.deepEqual(client.calls.map((call) => call.kind), ["arm", "disarm"]);
});

test("destroy releases active control and removes global safety listeners", async () => {
  const { controller, client, env } = makeController();
  await controller.enableBench(true);
  controller.acceptInput(input());
  await flush();
  controller.destroy();
  await flush();
  assert.equal(controller.enabled, false);
  assert.deepEqual(controller.getAxes(), neutralAxes());
  assert.ok(client.inputs().some((call) => call.options.neutral));
  assert.ok(Object.values(env.listeners).every((entries) => entries.length === 0));
});

// ----------------------------------------------------------------------
// Wire-contract regressions behind the reported HTTP 422 / sticky gate
// ----------------------------------------------------------------------

test("a provider-less input never promotes the source id into the provider field", async () => {
  const { controller, client } = makeController();
  await controller.enableBench(true);

  // Select the PS5 source, then deliver a state object with no provider key
  // at all — exactly what setExternalGate() synthesises before the first
  // provider sample arrives.
  controller.acceptInput({ source: "ps5", connected: true, calibrated: true, deadmanHeld: true, axes: {} });
  await flush();
  controller.acceptInput({ source: "ps5", connected: true, calibrated: true, deadmanHeld: true, axes: { pitch: 0.2 } });
  await flush();

  const providers = client.inputs().map((call) => call.options.provider);
  assert.ok(providers.length > 0, "the test must actually transmit");
  for (const provider of providers) {
    assert.notEqual(provider, "ps5", "'ps5' is a UI source id and is rejected by the backend literal");
    assert.ok(
      ["keyboard", "browser", "mock", "gamepad", "unknown"].includes(provider),
      `provider ${provider} is not in the backend literal`
    );
  }
  // The source field may still carry the UI id verbatim; only provider is constrained.
  assert.equal(client.inputs().at(-1).options.source, "ps5");
  await controller.disable();
});

test("a latched transport failure clears once a later frame is delivered", async () => {
  const { controller, client } = makeController();
  await controller.enableBench(true);

  controller.failsafeReason = "http_422";
  assert.equal(controller.getState().failsafeReason, "http_422");

  controller.acceptInput({
    source: "keyboard", provider: "keyboard", connected: true, calibrated: true,
    deadmanHeld: true, axes: { pitch: 0.25 }
  });
  await flush();

  assert.ok(client.inputs().length > 0, "a frame must have been delivered");
  assert.notEqual(controller.getState().failsafeReason, "http_422",
    "a delivered frame proves the transport recovered");
  await controller.disable();
});

test("a genuine input gate is not cleared by a successful frame", async () => {
  const { controller } = makeController();
  await controller.enableBench(true);

  // Dead-man released is a real gate, not a transport failure.
  controller.acceptInput({
    source: "keyboard", provider: "keyboard", connected: true, calibrated: true,
    deadmanHeld: false, axes: {}
  });
  await flush();
  assert.equal(controller.getState().failsafeReason, "deadman-released");
  await controller.disable();
});
