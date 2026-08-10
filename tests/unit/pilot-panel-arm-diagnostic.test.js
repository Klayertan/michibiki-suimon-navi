import test from "node:test";
import assert from "node:assert/strict";
import { buildArmDiagnostic } from "../../js/pilot/pilot-panel.js";

// ----------------------------------------------------------------------
// buildArmDiagnostic(error) — pure function, no DOM.
//
// Reported symptom: an ARM rejection with a useful ArduPilot PreArm
// STATUSTEXT was collapsing to "ARM rejected: The vehicle rejected normal
// ARM: FAILED." because the frontend only ever read `error.message` and
// discarded `error.detail`, where the backend actually put the reason
// (command_service.py's capture_arm_reason).
// ----------------------------------------------------------------------

function rejectionError({ reason = "rejected_by_vehicle", resultName = "FAILED", vehicleReason = null, armEvidence } = {}) {
  const error = new Error("The vehicle rejected normal ARM: " + resultName + ".");
  error.reason = reason;
  error.detail = { ack: { command: 400, resultName, accepted: false }, vehicleReason, armEvidence };
  return error;
}

function sampleEvidence(overrides = {}) {
  return {
    flightMode: "STABILIZE",
    armed: false,
    prearmCheck: null,
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
    recentStatusTexts: [],
    ...overrides
  };
}

test("a matching PreArm STATUSTEXT becomes the vehicle reason, verbatim", () => {
  const diagnostic = buildArmDiagnostic(rejectionError({ vehicleReason: "PreArm: Hardware safety switch" }));
  assert.equal(diagnostic.resultName, "FAILED");
  assert.equal(diagnostic.vehicleReason, "PreArm: Hardware safety switch");
  assert.equal(diagnostic.fallbackText, null, "a real reason must not also carry a fallback");
});

test("no detailed STATUSTEXT falls back honestly, naming the actual MAV_RESULT", () => {
  const diagnostic = buildArmDiagnostic(rejectionError({ resultName: "FAILED", vehicleReason: null }));
  assert.equal(diagnostic.vehicleReason, null);
  assert.equal(diagnostic.fallbackText, "Vehicle rejected ARM (MAV_RESULT_FAILED); no detailed reason received.");
});

test("the fallback names whatever MAV_RESULT was actually returned, not a hardcoded FAILED", () => {
  const diagnostic = buildArmDiagnostic(rejectionError({ resultName: "DENIED", vehicleReason: null }));
  assert.equal(diagnostic.fallbackText, "Vehicle rejected ARM (MAV_RESULT_DENIED); no detailed reason received.");
});

test("a rejection that is not the vehicle refusing ARM is not given this treatment", () => {
  for (const reason of ["pilot_not_ready", "not_connected", "ack_timeout", "verify_timeout", "commands_disabled"]) {
    assert.equal(
      buildArmDiagnostic(rejectionError({ reason, vehicleReason: "PreArm: should be ignored" })),
      null,
      reason
    );
  }
});

test("a missing detail object does not throw and yields the honest fallback", () => {
  const error = new Error("The vehicle rejected normal ARM: FAILED.");
  error.reason = "rejected_by_vehicle";
  const diagnostic = buildArmDiagnostic(error);
  assert.equal(diagnostic.resultName, "FAILED");
  assert.equal(diagnostic.vehicleReason, null);
  assert.match(diagnostic.fallbackText, /no detailed reason received/);
});

test("a blank or whitespace-only vehicleReason is treated as absent, not displayed as a blank reason", () => {
  for (const blank of ["", "   ", "\n\t"]) {
    const diagnostic = buildArmDiagnostic(rejectionError({ vehicleReason: blank }));
    assert.equal(diagnostic.vehicleReason, null, JSON.stringify(blank));
    assert.ok(diagnostic.fallbackText);
  }
});

test("a non-string vehicleReason (defensive against a malformed backend response) is treated as absent", () => {
  for (const bad of [42, {}, [], true]) {
    const diagnostic = buildArmDiagnostic(rejectionError({ vehicleReason: bad }));
    assert.equal(diagnostic.vehicleReason, null, JSON.stringify(bad));
  }
});

test("nothing here fabricates a cause: the reason is only ever exactly what the backend sent", () => {
  const diagnostic = buildArmDiagnostic(rejectionError({ vehicleReason: "EKF: velocity variance" }));
  assert.equal(diagnostic.vehicleReason, "EKF: velocity variance");
  // No trailing punctuation, no paraphrase, no severity label injected.
  assert.equal(diagnostic.vehicleReason.length, "EKF: velocity variance".length);
});

// ----------------------------------------------------------------------
// evidence: the raw snapshot shown when there is no vehicle STATUSTEXT.
// ----------------------------------------------------------------------

test("the evidence snapshot passes through verbatim when there is no vehicle reason", () => {
  const evidence = sampleEvidence();
  const diagnostic = buildArmDiagnostic(rejectionError({ vehicleReason: null, armEvidence: evidence }));
  assert.deepEqual(diagnostic.evidence, evidence);
});

test("evidence is still carried even when a vehicle reason IS present, but the view decides not to show it", () => {
  // buildArmDiagnostic does not drop evidence just because a reason exists --
  // it is pilot-view.js's job to only render it in the no-reason case.
  const evidence = sampleEvidence();
  const diagnostic = buildArmDiagnostic(
    rejectionError({ vehicleReason: "PreArm: Hardware safety switch", armEvidence: evidence })
  );
  assert.equal(diagnostic.vehicleReason, "PreArm: Hardware safety switch");
  assert.deepEqual(diagnostic.evidence, evidence);
});

test("a missing armEvidence becomes null, never undefined or a throw", () => {
  const diagnostic = buildArmDiagnostic(rejectionError({ vehicleReason: null }));
  assert.equal(diagnostic.evidence, null);
});
