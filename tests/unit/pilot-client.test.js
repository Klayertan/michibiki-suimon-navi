import test from "node:test";
import assert from "node:assert/strict";
import {
  COMMAND_CONFIRM_TIMEOUT_MS,
  PilotClient,
  WIRE_PROVIDERS,
  describeApiFailure,
  normalizeProvider
} from "../../js/pilot/pilot-client.js";

function recordingFetch() {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true })
      };
    }
  };
}

test("neutral carries the monotonic sequence required by the backend barrier", async () => {
  const recorder = recordingFetch();
  const client = new PilotClient({ fetchImpl: recorder.fetchImpl });

  await client.neutral(42);

  assert.equal(recorder.calls[0].url, "/api/drone/pilot/neutral");
  assert.deepEqual(recorder.calls[0].body, { sequence: 42 });
});

test("manual input uses only the canonical semantic axes and safety metadata", async () => {
  const recorder = recordingFetch();
  const client = new PilotClient({ fetchImpl: recorder.fetchImpl });

  await client.sendInput(
    { pitch: 0.25, roll: -0.2, throttle: 0.1, yaw: -0.15 },
    { deadman: true, neutral: false, source: "keyboard", sequence: 9 }
  );

  assert.equal(recorder.calls[0].url, "/api/drone/pilot/input");
  assert.deepEqual(recorder.calls[0].body, {
    pitch: 0.25,
    roll: -0.2,
    throttle: 0.1,
    yaw: -0.15,
    neutral: false,
    deadman: true,
    source: "keyboard",
    provider: "keyboard",
    sequence: 9
  });
});

test("ARM and DISARM requests are explicit confirmed actions", async () => {
  const recorder = recordingFetch();
  const client = new PilotClient({ fetchImpl: recorder.fetchImpl });

  await client.arm();
  await client.disarm();

  assert.deepEqual(
    recorder.calls.map(({ url, body }) => ({ url, body })),
    [
      { url: "/api/drone/arm", body: { confirmed: true } },
      { url: "/api/drone/disarm", body: { confirmed: true } }
    ]
  );
});

test("ARM confirmation uses its own ACK/HEARTBEAT timeout, not the manual-frame deadline", async () => {
  assert.ok(COMMAND_CONFIRM_TIMEOUT_MS > 10_000);
  const fetchImpl = (_url, { signal }) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, message: "telemetry confirms ARMED" })
    }), 20);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }, { once: true });
  });
  const client = new PilotClient({ fetchImpl, timeoutMs: 5, commandTimeoutMs: 50 });

  await assert.doesNotReject(client.arm());
});

// ----------------------------------------------------------------------
// Wire contract: provider vocabulary and validation-error reporting
//
// `provider` is a provider-implementation id on the wire, constrained by a
// Pydantic Literal. The UI's input *source* vocabulary ("keyboard" / "ps5")
// is a different namespace, and leaking "ps5" into this field made FastAPI
// reject the whole frame with HTTP 422 — release frames included.
// ----------------------------------------------------------------------

test("a UI source id is never emitted as a wire provider id", async () => {
  const recorder = recordingFetch();
  const client = new PilotClient({ fetchImpl: recorder.fetchImpl });

  await client.sendInput({ pitch: 0, roll: 0, throttle: 0, yaw: 0 }, {
    source: "ps5",
    provider: "ps5",
    sequence: 7
  });

  const sent = recorder.calls.at(-1).body;
  assert.equal(sent.provider, "unknown", "'ps5' is a source, not a provider");
  assert.equal(sent.source, "ps5", "the source field may still carry it verbatim");
  assert.ok(WIRE_PROVIDERS.includes(sent.provider));
});

test("every provider the UI can supply serialises to a value the backend accepts", async () => {
  const recorder = recordingFetch();
  const client = new PilotClient({ fetchImpl: recorder.fetchImpl });

  for (const candidate of ["keyboard", "browser", "mock", "gamepad", "unknown", "ps5", "", null, undefined, 42]) {
    await client.sendInput({ pitch: 0, roll: 0, throttle: 0, yaw: 0 }, {
      source: "keyboard",
      provider: candidate,
      sequence: 1
    });
    const sent = recorder.calls.at(-1).body;
    assert.ok(WIRE_PROVIDERS.includes(sent.provider), `provider ${String(candidate)} -> ${sent.provider}`);
  }
});

test("an empty source is replaced rather than sent as a rejected empty string", async () => {
  const recorder = recordingFetch();
  const client = new PilotClient({ fetchImpl: recorder.fetchImpl });

  await client.sendInput({ pitch: 0, roll: 0, throttle: 0, yaw: 0 }, { source: "", sequence: 2 });
  assert.equal(recorder.calls.at(-1).body.source, "unknown");
});

test("normalizeProvider keeps known values and collapses everything else", () => {
  for (const known of WIRE_PROVIDERS) assert.equal(normalizeProvider(known), known);
  for (const unknown of ["ps5", "PS5", "", null, undefined, {}]) {
    assert.equal(normalizeProvider(unknown), "unknown");
  }
});

test("a FastAPI validation failure is reported as a field-level reason, not a bare status", () => {
  const message = describeApiFailure({
    detail: [{ loc: ["body", "provider"], msg: "Input should be 'keyboard', 'browser', 'mock', 'gamepad' or 'unknown'" }]
  }, 422);

  assert.match(message, /provider/, "the offending field must be named");
  assert.match(message, /422/);
  assert.notEqual(message, "HTTP 422", "a bare status is not actionable");
});

test("a backend rejection message is preferred over the generic validation text", () => {
  assert.equal(
    describeApiFailure({ reason: "rejected_by_vehicle", message: "PreArm: compass not calibrated" }, 502),
    "PreArm: compass not calibrated"
  );
});

test("a response with no usable body still yields the status", () => {
  assert.equal(describeApiFailure(null, 500), "HTTP 500");
});
