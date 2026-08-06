import test from "node:test";
import assert from "node:assert/strict";
import { DroneStore } from "../../js/drone/drone-store.js";

function telemetry(overrides = {}) {
  return {
    connectionState: "connected",
    connected: true,
    commandable: true,
    allowSafeCommands: true,
    mode: "mock",
    vehicle: { armed: false, flightMode: "STABILIZE" },
    statusTexts: [],
    ...overrides
  };
}

test("a fresh store is disconnected and cannot command", () => {
  const store = new DroneStore();
  const state = store.getState();

  assert.equal(state.connectionState, "disconnected");
  assert.equal(state.armed, null);
  assert.equal(state.canCommand, false);
  assert.equal(state.backendReachable, null);
});

test("change events fire for every mutation", () => {
  const store = new DroneStore();
  let changes = 0;
  store.addEventListener("change", () => { changes += 1; });

  store.setBackendReachable(true);
  store.setTelemetry(telemetry());
  store.setBusy(true);
  store.setSocketOpen(true);
  store.setCommandResult({ ok: true, reason: "accepted", message: "done" });

  assert.equal(changes, 5);
});

test("commands need a reachable backend, a commandable link, and enabled commands", () => {
  const store = new DroneStore();
  store.setTelemetry(telemetry());
  assert.equal(store.getState().canCommand, false, "backend not confirmed reachable yet");

  store.setBackendReachable(true);
  assert.equal(store.getState().canCommand, true);

  store.setTelemetry(telemetry({ commandable: false }));
  assert.equal(store.getState().canCommand, false, "a stale link is not commandable");

  store.setTelemetry(telemetry({ allowSafeCommands: false }));
  assert.equal(store.getState().canCommand, false, "read-only backend blocks commands");

  store.setBackendReachable(false);
  store.setTelemetry(telemetry());
  assert.equal(store.getState().canCommand, false, "an unreachable backend blocks commands");
});

test("armed state is surfaced verbatim from the backend", () => {
  const store = new DroneStore();
  store.setBackendReachable(true);

  store.setTelemetry(telemetry({ vehicle: { armed: true } }));
  assert.equal(store.getState().armed, true);

  store.setTelemetry(telemetry({ vehicle: {} }));
  assert.equal(store.getState().armed, null, "absent must stay unknown, not become false");
});

test("status texts accumulate newest-first without duplicates", () => {
  const store = new DroneStore();
  store.setTelemetry(telemetry({
    statusTexts: [
      { text: "first", severityName: "INFO", receivedAt: 100 },
      { text: "second", severityName: "WARNING", receivedAt: 101 }
    ]
  }));
  assert.deepEqual(store.getState().messages.map((entry) => entry.text), ["second", "first"]);

  // The backend resends its whole ring buffer each frame; only the new entry
  // must be added.
  store.setTelemetry(telemetry({
    statusTexts: [
      { text: "first", severityName: "INFO", receivedAt: 100 },
      { text: "second", severityName: "WARNING", receivedAt: 101 },
      { text: "third", severityName: "ERROR", receivedAt: 102 }
    ]
  }));
  assert.deepEqual(store.getState().messages.map((entry) => entry.text), ["third", "second", "first"]);
});

test("identical text at a different time is kept as a separate event", () => {
  const store = new DroneStore();
  store.setTelemetry(telemetry({ statusTexts: [{ text: "PreArm: GPS", severityName: "WARNING", receivedAt: 100 }] }));
  store.setTelemetry(telemetry({ statusTexts: [{ text: "PreArm: GPS", severityName: "WARNING", receivedAt: 105 }] }));

  assert.equal(store.getState().messages.length, 2);
});

test("the message list is bounded", () => {
  const store = new DroneStore();
  for (let index = 0; index < 60; index += 1) {
    store.setTelemetry(telemetry({
      statusTexts: [{ text: `line ${index}`, severityName: "INFO", receivedAt: index }]
    }));
  }
  const { messages } = store.getState();

  assert.equal(messages.length, 30);
  assert.equal(messages[0].text, "line 59", "newest first");
});

test("clearing vehicle state removes telemetry and messages", () => {
  const store = new DroneStore();
  store.setBackendReachable(true);
  store.setTelemetry(telemetry({ statusTexts: [{ text: "hello", severityName: "INFO", receivedAt: 1 }] }));

  store.clearVehicleState();
  const state = store.getState();

  assert.equal(state.telemetry, null);
  assert.equal(state.messages.length, 0);
  assert.equal(state.connectionState, "disconnected");
  assert.equal(state.canCommand, false);
  assert.equal(state.backendReachable, true, "backend reachability is independent of the vehicle");
});

test("command results are recorded and clearable", () => {
  const store = new DroneStore();
  store.setCommandResult({ ok: false, reason: "armed", message: "refused" });

  const { lastCommand } = store.getState();
  assert.equal(lastCommand.ok, false);
  assert.equal(lastCommand.reason, "armed");
  assert.ok(typeof lastCommand.at === "number");

  store.clearCommandResult();
  assert.equal(store.getState().lastCommand, null);
});
