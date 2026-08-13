// Unified Manual Control panel rendering. This module is display-only: all
// provider gating lives in GamepadController/PilotController and every
// vehicle-side decision comes from the backend snapshot.

const EMPTY = "—";

const REASON_TEXT = {
  pilot_control_disabled: "Manual Control is disabled in the backend",
  not_enabled: "Bench Pilot is not enabled",
  not_connected: "MAVLink is disconnected",
  telemetry_stale: "Telemetry is stale",
  no_input: "Waiting for fresh input",
  input_timeout: "Input timed out — RC override released",
  stale_input: "Input is stale — RC override released",
  unsupported_mode: "Current mode does not accept this manual-control profile",
  wrong_mode: "Current mode does not accept manual RC input",
  disarmed: "Ready to arm",
  arm_state_unknown: "Vehicle armed state is unknown",
  neutral_commanded: "Manual input is neutral / released",
  transmit_failed: "Manual RC transmission failed",
  deadman_released: "Dead-man released — RC override released",
  rc_parameters_pending: "Waiting for vehicle RC parameters",
  rc_configuration_missing: "Required vehicle RC parameters are unavailable",
  rc_configuration_invalid: "Vehicle RC mapping/calibration is incompatible",
  rc_mapping_invalid: "Vehicle RCMAP channel assignments are incompatible",
  rc_calibration_invalid: "Vehicle RC channel calibration is incompatible",
  rc_override_timeout_incompatible: "RC_OVERRIDE_TIME must be finite and greater than zero",
  rc_override_disabled: "RC_OVERRIDE_TIME=0 disables MAVLink RC override",
  rc_override_timeout_infinite: "RC_OVERRIDE_TIME=-1 is infinite and is not accepted",
  rc_override_timeout_too_short: "RC_OVERRIDE_TIME is too short for a safely refreshed override",
  rc_override_timeout_invalid: "RC_OVERRIDE_TIME is outside the accepted finite safety range",
  rc_overrides_ignored: "Vehicle RC_OPTIONS is configured to ignore MAVLink overrides",
  rc_gcs_sysid_mismatch: "Vehicle MAVLink GCS system-ID configuration rejects this override source",
  arming_input_barrier: "ARM verification in progress — waiting for a fresh post-confirmation input frame",
  mock_provider_forbidden: "Simulated controller input is forbidden against a real vehicle backend",
  input_disconnected: "Selected input disconnected",
  "input-disconnected": "Selected input disconnected",
  "controller-disconnected": "PS5 controller disconnected",
  "calibration-incomplete": "PS5 calibration is incomplete",
  "capture-inactive": "Input capture stopped — RC override released",
  "deadman-released": "Dead-man released — RC override released",
  "deadman-rearm-required": "Release and press the dead-man again after the safety gate clears",
  "focus-lost": "Window focus lost — RC override released",
  "tab-hidden": "Tab hidden — RC override released",
  "page-hidden": "Page hidden — RC override released",
  "source-switched": "Input source changed — RC override released",
  "stale-input": "Input sample stale — RC override released",
  "provider-stale": "Input provider stopped updating — RC override released",
  "backend-unreachable": "Backend connection lost — RC override released",
  backend_unreachable: "Backend connection lost — RC override released",
  "websocket-disconnected": "Telemetry WebSocket disconnected — RC override released",
  websocket_disconnected: "Telemetry WebSocket disconnected — RC override released",
  provider_disconnected: "Input provider disconnected — RC override released",
  stale_sequence: "Delayed or replayed input was rejected — resynchronising sequence",
  "telemetry-stale": "Telemetry is stale — RC override released",
  "mavlink-disconnected": "MAVLink disconnected — RC override released",
  "pilot-disabled": "Bench Pilot disabled — RC override released",
  escape: "Escape pressed — RC override released"
};

const FAILSAFE_REASONS = new Set([
  "not_connected",
  "telemetry_stale",
  "input_timeout",
  "stale_input",
  "transmit_failed",
  "deadman_released",
  "input_disconnected",
  "input-disconnected",
  "controller-disconnected",
  "calibration-incomplete",
  "capture-inactive",
  "deadman-released",
  "deadman-rearm-required",
  "focus-lost",
  "tab-hidden",
  "page-hidden",
  "source-switched",
  "stale-input",
  "provider-stale",
  "backend-unreachable",
  "backend_unreachable",
  "websocket-disconnected",
  "websocket_disconnected",
  "provider_disconnected",
  "stale_sequence",
  "telemetry-stale",
  "mavlink-disconnected",
  "escape",
  "unsupported_mode",
  "wrong_mode",
  "rc_parameters_pending",
  "rc_configuration_missing",
  "rc_configuration_invalid",
  "rc_mapping_invalid",
  "rc_calibration_invalid",
  "rc_override_timeout_incompatible",
  "rc_override_disabled",
  "rc_override_timeout_infinite",
  "rc_override_timeout_too_short",
  "rc_override_timeout_invalid",
  "rc_overrides_ignored",
  "rc_gcs_sysid_mismatch",
  "mock_provider_forbidden"
]);

/**
 * Failsafe reasons that are simply the resting state of a disarmed bench
 * vehicle nobody is currently commanding. They stop being benign — and become
 * a real FAILSAFE — as soon as the vehicle is armed or output is live.
 * Everything else in FAILSAFE_REASONS is a genuine fault at any armed state.
 */
const IDLE_BENIGN_REASONS = new Set([
  "deadman_released",
  "deadman-released",
  "deadman-rearm-required",
  "capture-inactive"
]);

function fmt(value, digits = 2) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : EMPTY;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function axisRow(label, key, value) {
  const safe = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return `
    <div class="pilot-axis" data-axis="${key}">
      <span class="pilot-axis-label">${label}</span>
      <meter min="-1" max="1" value="${safe}"></meter>
      <output id="pilotAxis-${key}" data-tone="${safe === 0 ? "idle" : "ok"}">${safe.toFixed(2)}</output>
    </div>`;
}

function connectionLabel(state) {
  if (state === "connected") return "Connected";
  if (state === "telemetry_stale") return "Telemetry stale";
  return state ? state.replaceAll("_", " ") : "Disconnected";
}

function mappingText(mapping) {
  if (!mapping) return "CH1 Roll · CH2 Pitch · CH3 Throttle · CH4 Yaw (awaiting vehicle confirmation)";
  return [
    `CH${mapping.roll ?? "?"} Roll`,
    `CH${mapping.pitch ?? "?"} Pitch`,
    `CH${mapping.throttle ?? "?"} Throttle`,
    `CH${mapping.yaw ?? "?"} Yaw`
  ].join(" · ");
}

/** One channel's raw PWM as ArduPilot itself reports it, via RCMAP. `null`
 * (no data at all) and `undefined` (message never arrived) are both shown
 * the same honest way -- neither is invented as a number. */
function rcChannelValue(channels, channelNumber) {
  if (!Array.isArray(channels) || !Number.isInteger(channelNumber)) return null;
  const value = channels[channelNumber - 1];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pwmText(value) {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value)} µs` : EMPTY;
}

function overridePwmText(value) {
  if (value === 0) return "0 (RELEASE)";
  if (value === 0xFFFF) return "65535 (IGNORE)";
  return pwmText(value);
}

function triState(value, { yes = "PASS", no = "FAIL", unknown = "UNKNOWN" } = {}) {
  if (value === true) return yes;
  if (value === false) return no;
  return unknown;
}

/**
 * "RC INPUT SEEN BY PIXHAWK": the vehicle's own RC_CHANNELS report, mapped
 * through the same RCMAP the override itself uses, plus the vehicle's own
 * RC-receiver and pre-arm health bits. Deliberately not "what the browser
 * intended to send" -- this is what ArduPilot itself currently sees,
 * independent of source, which is what its own arming checks evaluate.
 */
function renderOutgoingOverrideSection(view) {
  const outgoing = view.pilot?.lastOutgoingOverride || null;
  const channels = outgoing?.channels;
  const rows = Array.from({ length: 8 }, (_, index) => `
    <div><span>CH${index + 1}</span><strong>${overridePwmText(Array.isArray(channels) ? channels[index] : null)}</strong></div>`
  ).join("");
  const age = typeof outgoing?.ageSeconds === "number" ? `${fmt(outgoing.ageSeconds, 1)} s` : EMPTY;
  return `
    <section class="pilot-section pilot-outgoing-override-section">
      <h3 class="drone-section-title">Last outgoing RC override <span class="en">Backend → MAVLink</span></h3>
      <div class="pilot-diagnostic-grid">
        ${rows}
        <div><span>Frame state</span><strong id="pilotOutgoingState">${escapeHtml(outgoing?.state || "NOT_SENT")}</strong></div>
        <div><span>Reason</span><strong id="pilotOutgoingReason">${escapeHtml(outgoing?.reason || EMPTY)}</strong></div>
        <div><span>Sent age</span><strong id="pilotOutgoingAge">${age}</strong></div>
      </div>
      <p class="meta">Exact first-eight-channel frame last handed to the MAVLink transport. This is backend output evidence, not browser intent and not proof that Pixhawk accepted it.</p>
    </section>`;
}

function renderMotorOutputSection(view) {
  const diagnostics = view.telemetry?.motorOutputs || {};
  const outputs = Array.isArray(diagnostics.outputs) ? diagnostics.outputs : [];
  const rows = outputs.length
    ? outputs.map((output) => `
      <div>
        <span>${escapeHtml(output.functionName || `Motor ${output.motorNumber}`)} (OUT${output.outputChannel}, function ${output.function})</span>
        <strong>${pwmText(output.pwm)}</strong>
      </div>`).join("")
    : `<div><span>Motor mapping</span><strong>${diagnostics.mappingComplete ? "No Copter motor functions configured" : "Waiting for SERVOx_FUNCTION"}</strong></div>`;
  const age = typeof diagnostics.ageSeconds === "number" ? `${fmt(diagnostics.ageSeconds, 1)} s` : EMPTY;
  return `
    <section class="pilot-section pilot-motor-output-section">
      <h3 class="drone-section-title">Motor output reported by Pixhawk <span class="en">Read-only</span></h3>
      <div class="pilot-diagnostic-grid">
        ${rows}
        <div><span>Output telemetry age</span><strong id="pilotMotorOutputAge">${age}</strong></div>
      </div>
      <p class="meta">Read-only SERVO_OUTPUT_RAW telemetry, labelled only where the matching SERVOx_FUNCTION identifies a Copter motor. This application does not command motors.</p>
    </section>`;
}

function renderRcInputSection(view) {
  const { pilot, telemetry } = view;
  const rc = telemetry?.rc || {};
  const mapping = pilot?.rcConfiguration?.mapping || null;
  const channels = rc.channels;
  const rows = [
    ["Roll", mapping?.roll],
    ["Pitch", mapping?.pitch],
    ["Throttle", mapping?.throttle],
    ["Yaw", mapping?.yaw]
  ];
  const rowsHtml = rows.map(([label, channelNumber]) => `
    <div>
      <span>${label}${Number.isInteger(channelNumber) ? ` (CH${channelNumber})` : ""}</span>
      <strong>${pwmText(rcChannelValue(channels, channelNumber))}</strong>
    </div>`).join("");

  const failsafeText = triState(
    rc.receiverHealthy === null || rc.receiverHealthy === undefined ? null : !rc.receiverHealthy,
    { yes: "YES", no: "NO", unknown: "UNKNOWN" }
  );
  const outputActive = Boolean(pilot?.outputActive || pilot?.transmitting);
  const overrideOwned = Boolean(pilot?.overrideOwned);
  const prearmText = triState(telemetry?.prearmCheck);
  const rcReady = Boolean(pilot?.rcConfiguration && !pilot?.rcConfigurationError);

  return `
    <section class="pilot-section pilot-rc-input-section">
      <h3 class="drone-section-title">RC input seen by Pixhawk</h3>
      <div class="pilot-diagnostic-grid">
        ${rowsHtml}
        <div><span>RC failsafe</span><strong id="pilotRcFailsafe" class="drone-chip" data-tone="${failsafeText === "YES" ? "danger" : failsafeText === "NO" ? "ok" : "idle"}">${failsafeText}</strong></div>
        <div><span>Backend output active</span><strong id="pilotOverrideActive">${outputActive ? "YES" : "NO"}</strong></div>
        <div><span>Backend owns RC override</span><strong id="pilotOverrideOwned">${overrideOwned ? "YES" : "NO"}</strong></div>
        <div><span>Pixhawk RC telemetry age</span><strong id="pilotRcAge">${typeof rc.ageSeconds === "number" ? `${fmt(rc.ageSeconds, 1)} s` : EMPTY}</strong></div>
        <div><span>RC calibration ready</span><strong>${rcReady ? "Yes" : "No"}</strong></div>
        <div><span>Pre-arm check health</span><strong id="pilotPrearmHealth" class="drone-chip" data-tone="${prearmText === "PASS" ? "ok" : prearmText === "FAIL" ? "danger" : "idle"}">${prearmText}</strong></div>
      </div>
      <p class="meta">This is what the vehicle itself reports on RC_CHANNELS, mapped through its own RCMAP -- not merely what the browser most recently intended to send.</p>
    </section>`;
}

/**
 * Evidence shown when an ARM rejection carried no vehicle STATUSTEXT reason.
 * Raw facts only -- this never states a cause, matching the backend's own
 * `_arm_attempt_evidence()` docstring.
 */
function renderArmEvidence(evidence) {
  if (!evidence) return "";
  const pilotEvidence = evidence.pilot || {};
  const rc = evidence.rc || {};
  const mapping = pilotEvidence.rcConfiguration?.mapping || null;
  const throttleChannel = mapping?.throttle;
  const throttlePwm = rcChannelValue(rc.channels, throttleChannel);
  const fsThr = pilotEvidence.throttleFailsafe;
  const rows = [
    ["Flight mode", evidence.flightMode ?? EMPTY],
    ["Armed", evidence.armed === true ? "ARMED" : evidence.armed === false ? "DISARMED" : "UNKNOWN"],
    ["Pre-arm check health", triState(evidence.prearmCheck)],
    [`Throttle input${Number.isInteger(throttleChannel) ? ` (CH${throttleChannel})` : ""}`, pwmText(throttlePwm)],
    ["Throttle MIN", pwmText(mapping ? pilotEvidence.rcConfiguration?.channels?.[String(throttleChannel)]?.min : null)],
    ["FS_THR_ENABLE", fsThr ? (fsThr.enabled ? `Enabled (${fsThr.enableRaw})` : "Disabled") : "Unknown"],
    ["FS_THR_VALUE", fsThr && typeof fsThr.valuePwm === "number" ? pwmText(fsThr.valuePwm) : "Unknown"],
    ["RC override", pilotEvidence.override && pilotEvidence.override.released === false ? "Active" : "Released"],
    ["Dead-man", pilotEvidence.deadman ? "HELD" : "RELEASED"]
  ];
  return `
    <div id="pilotArmEvidence" class="pilot-arm-evidence">
      <p class="meta"><strong>No detailed STATUSTEXT received.</strong> Evidence captured at the moment of rejection:</p>
      <div class="pilot-diagnostic-grid">
        ${rows.map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`).join("")}
      </div>
    </div>`;
}

export class PilotView {
  constructor(root = document) {
    this.root = root;
    this.host = root.getElementById ? root.getElementById("pilotRoot") : null;
    this.panel = root.getElementById ? root.getElementById("pilotPanel") : null;
  }

  get isMounted() {
    return Boolean(this.host);
  }

  render(view) {
    if (!this.isMounted) return;
    const {
      axes,
      enabled,
      deadmanHeld,
      propsAckChecked,
      busy,
      pilot,
      telemetry,
      error,
      message,
      armDiagnostic,
      neutralFlash,
      localFailsafeReason,
      externalGateReason,
      inputState,
      inputHtml,
      socketConnected
    } = view;

    const vehicle = telemetry?.vehicle || {};
    const connectionState = telemetry?.connectionState || "disconnected";
    const linkReady = connectionState === "connected" && telemetry?.link?.stale !== true;
    const available = Boolean(pilot?.available);
    const outputActive = Boolean(pilot?.outputActive || pilot?.transmitting);
    const armed = vehicle.armed;
    const armedText = armed === true ? "ARMED" : armed === false ? "DISARMED" : "UNKNOWN";
    const armedTone = armed === true ? "danger" : armed === false ? "ok" : "warn";
    const mode = vehicle.flightMode || EMPTY;
    const backendReason = pilot?.blockedReason || null;
    // A deliberately disarmed vehicle can be ready for the operator's
    // separate ARM action even though no dead-man is currently held. Do not
    // turn that safe, intentional state into a red-herring FAILSAFE.
    const backendReadyToArm = pilot?.readyToArm === true;
    const readyToArm = Boolean(
      backendReadyToArm && socketConnected && !externalGateReason && !outputActive
    );
    const reason = externalGateReason || (readyToArm
      ? "disarmed"
      : (localFailsafeReason || backendReason || (!linkReady ? "not_connected" : null)));
    // Not holding the dead-man is the *normal* idle state of a disarmed bench
    // vehicle, so on its own it must not read as FAILSAFE. It becomes one only
    // once it interrupts something: an armed vehicle, or live output. Genuine
    // faults (link loss, staleness, transmit failure) stay a FAILSAFE whatever
    // the armed state, and the backend's own latched flag always wins.
    const benignWhileIdle = IDLE_BENIGN_REASONS.has(reason) && armed !== true && !outputActive;
    const failsafeActive = Boolean(
      enabled && (pilot?.failsafe || (FAILSAFE_REASONS.has(reason) && !benignWhileIdle))
    );
    const disconnected = !linkReady;
    const ready = Boolean(linkReady && available && !outputActive && !failsafeActive);
    const preview = !enabled;
    const reasonText = reason ? (REASON_TEXT[reason] || String(reason).replaceAll("_", " ")) : "None";
    const age = telemetry?.link?.lastMessageAge;
    const allowSafeCommands = Boolean(telemetry?.allowSafeCommands);

    // ARM eligibility. Deliberately independent of the dead-man, of current
    // stick deflection and of TRANSMITTING: the dead-man authorises continuous
    // manual RC movement, whereas ARM is a single deliberate operator action.
    // Every blocker is listed so a disabled button can say why, instead of
    // leaving the operator with only a "not-allowed" mouse cursor.
    const armBlockers = [];
    if (!available) armBlockers.push("Manual Control is disabled in the backend");
    if (!enabled) armBlockers.push("Enable Bench Pilot first");
    if (!propsAckChecked) armBlockers.push("Confirm the propellers-removed acknowledgement");
    if (!allowSafeCommands) armBlockers.push("Backend safe commands are disabled");
    if (!linkReady) armBlockers.push("MAVLink is disconnected or telemetry is stale");
    if (!socketConnected) armBlockers.push("Telemetry WebSocket is disconnected");
    if (externalGateReason) {
      armBlockers.push(REASON_TEXT[externalGateReason] || String(externalGateReason).replaceAll("_", " "));
    }
    if (armed === true) armBlockers.push("Vehicle is already ARMED");
    else if (armed !== false) armBlockers.push("Vehicle armed state is unknown");
    // Backend-side eligibility (RC parameters loaded, supported flight mode,
    // no post-arm input barrier). Only surfaced once the local prerequisites
    // are satisfied, otherwise it just restates them.
    if (!armBlockers.length && !backendReadyToArm) {
      armBlockers.push(
        backendReason
          ? (REASON_TEXT[backendReason] || String(backendReason).replaceAll("_", " "))
          : "Vehicle is not reporting itself ready to arm"
      );
    }
    const armDisabled = Boolean(busy || armBlockers.length);
    const disarmDisabled = busy || !linkReady || !allowSafeCommands || armed !== true;
    // Closing the channel must stay available even if telemetry disappears;
    // opening it requires a fresh link and the explicit physical-safety ack.
    const benchDisabled = busy || (!enabled && (
      !available || !linkReady || !socketConnected || Boolean(externalGateReason) || !propsAckChecked
    ));
    const rcConfig = pilot?.rcConfiguration || null;
    const timeout = rcConfig?.overrideTimeoutSeconds ?? rcConfig?.rcOverrideTimeout ?? null;
    const mapping = rcConfig?.mapping || pilot?.channelMapping;
    const rcReady = Boolean(rcConfig && !pilot?.rcConfigurationError);
    const limits = pilot?.limits || {};
    const percent = (value, fallback) => Number.isFinite(Number(value))
      ? `${Math.round(Number(value) * 100)}%`
      : fallback;
    const sourceIdText = rcConfig?.sourceIdParameter === "SYSID_MYGCS"
      ? `SYSID_MYGCS=${rcConfig.sysidMygcs}`
      : rcConfig?.sourceIdParameter === "MAV_GCS_SYSID"
        ? `MAV_GCS_SYSID=${rcConfig.mavGcsSysid}..${rcConfig.mavGcsSysidHi ?? rcConfig.mavGcsSysid}`
        : "Unknown";

    this.host.innerHTML = `
      <div class="pilot-safety" role="note">
        <strong>Propellers must be removed for Bench Mode.</strong> Manual Control uses normal
        ArduPilot safety checks, conservative RC limits and a continuously-held dead-man.
        It does not bypass pre-arm checks or force-arm the vehicle.
      </div>

      <div class="pilot-status-strip" role="group" aria-label="Manual Control status">
        <strong id="pilotStatusPreview" class="drone-chip" data-tone="${preview ? "ok" : "idle"}">PREVIEW</strong>
        <strong id="pilotStatusReady" class="drone-chip" data-tone="${ready ? "ok" : "idle"}">READY</strong>
        <strong id="pilotStatusEnabled" class="drone-chip" data-tone="${enabled ? "warn" : "idle"}">PILOT ENABLED</strong>
        <strong id="pilotStatusTransmitting" class="drone-chip" data-tone="${outputActive ? "danger" : "idle"}">TRANSMITTING</strong>
        <strong id="pilotStatusFailsafe" class="drone-chip" data-tone="${failsafeActive ? "warn" : "idle"}">FAILSAFE</strong>
        <strong id="pilotStatusDisconnected" class="drone-chip" data-tone="${disconnected ? "danger" : "idle"}">DISCONNECTED</strong>
      </div>

      <div id="pilotBlockedBanner" class="pilot-blocked" data-tone="${failsafeActive ? "warn" : ready ? "ok" : "idle"}" role="status" aria-live="polite">
        <strong>${reason === "disarmed" ? "Ready to arm" : `Blocked: ${escapeHtml(reasonText)}`}</strong>
        ${reason === "disarmed" ? "<span>Vehicle is intentionally DISARMED; this is not a failsafe.</span>" : ""}
      </div>

      <section class="pilot-section pilot-input-source-section">
        <h3 class="drone-section-title">Input</h3>
        <div id="manualInputRoot">${inputHtml || ""}</div>
      </section>

      <div class="pilot-two-column">
        <section class="pilot-section">
          <h3 class="drone-section-title">Input</h3>
          ${axisRow("Pitch / forward", "pitch", axes.pitch)}
          ${axisRow("Roll / right", "roll", axes.roll)}
          ${axisRow("Throttle / up", "throttle", axes.throttle)}
          ${axisRow("Yaw / right", "yaw", axes.yaw)}
          <div class="pilot-inline-status">
            <span>Dead-man</span>
            <strong id="pilotDeadman" class="drone-chip" data-tone="${deadmanHeld ? "ok" : "idle"}">${deadmanHeld ? "HELD" : "RELEASED"}</strong>
          </div>
          <p id="pilotNeutralFlash" class="pilot-neutral" ${neutralFlash ? "" : "hidden"}>RC override released / input neutralised</p>
        </section>

        <section class="pilot-section">
          <h3 class="drone-section-title">Vehicle</h3>
          <div class="pilot-vehicle-grid">
            <div><span>Mode</span><strong id="pilotMode">${escapeHtml(mode)}</strong></div>
            <div><span>Armed</span><strong id="pilotArmed" class="drone-chip" data-tone="${armedTone}">${armedText}</strong></div>
            <div><span>MAVLink</span><strong id="pilotMavlink">${escapeHtml(connectionLabel(connectionState))}</strong></div>
            <div><span>Telemetry</span><strong id="pilotTelemetryAge">${typeof age === "number" ? `${fmt(age, 1)} s` : EMPTY}</strong></div>
            <div><span>Telemetry WS</span><strong>${socketConnected ? "Connected" : "Disconnected"}</strong></div>
            <div><span>Manual transport</span><strong>RC override</strong></div>
          </div>
        </section>
      </div>

      ${renderOutgoingOverrideSection(view)}

      ${renderRcInputSection(view)}

      ${renderMotorOutputSection(view)}

      <section class="pilot-section pilot-bench-section">
        <h3 class="drone-section-title">Bench test <span class="en">Propellers removed</span></h3>
        <label class="pilot-bench-ack">
          <input type="checkbox" id="pilotBenchPropsAck" ${propsAckChecked ? "checked" : ""} ${enabled ? "disabled" : ""}>
          <span>I confirm every propeller is physically removed / プロペラをすべて取り外しました</span>
        </label>
        <div class="pilot-bench-summary">
          <div><span>Bench Pilot</span><strong id="pilotBenchState">${enabled ? "ENABLED" : "DISABLED"}</strong></div>
          <div><span>Vehicle</span><strong>${armedText}</strong></div>
          <div><span>Dead-man</span><strong>${deadmanHeld ? "HELD" : "RELEASED"}</strong></div>
          <div><span>ARM status</span><strong id="pilotArmStatus" class="drone-chip" data-tone="${armDisabled ? "idle" : "ok"}">${armDisabled ? "UNAVAILABLE" : "READY"}</strong></div>
        </div>
        <div class="pilot-action-row">
          <button id="pilotBenchEnableButton" class="panel-button ${enabled ? "" : "primary"}" type="button" ${benchDisabled ? "disabled" : ""}>${enabled ? "Disable Bench Pilot" : "Enable Bench Pilot"}</button>
          <button id="pilotArmButton" class="panel-button danger" type="button" ${armDisabled ? "disabled" : ""}>ARM</button>
          <button id="pilotDisarmButton" class="panel-button" type="button" ${disarmDisabled ? "disabled" : ""}>DISARM</button>
          <button id="pilotNeutralButton" class="panel-button" type="button" ${enabled ? "" : "disabled"}>Neutral / Release</button>
        </div>
        ${armDisabled && armBlockers.length ? `
          <div id="pilotArmReason" class="pilot-arm-reason" role="status" aria-live="polite">
            <strong>ARM unavailable:</strong>
            <ul>${armBlockers.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
          </div>` : ""}
        <p id="pilotMessage" class="meta" role="status" aria-live="polite">${escapeHtml(message || "")}</p>
        ${error ? `<p id="pilotCommandError" class="pilot-command-error" role="status" aria-live="polite">Last command: ${escapeHtml(error)}</p>` : ""}
        ${armDiagnostic ? `
          <div id="pilotArmDiagnostic" class="pilot-arm-diagnostic" role="status" aria-live="polite">
            <div class="pilot-arm-diagnostic-row">
              <span>Command result</span>
              <strong id="pilotArmCommandResult">ARM ${escapeHtml(armDiagnostic.resultName)}</strong>
            </div>
            <div class="pilot-arm-diagnostic-row">
              <span>Vehicle reason</span>
              <strong id="pilotArmVehicleReason" data-fallback="${armDiagnostic.vehicleReason ? "false" : "true"}">${escapeHtml(armDiagnostic.vehicleReason || armDiagnostic.fallbackText)}</strong>
            </div>
            ${!armDiagnostic.vehicleReason ? renderArmEvidence(armDiagnostic.evidence) : ""}
          </div>` : ""}
      </section>

      <details class="pilot-disclosure">
        <summary>Key / controller mapping</summary>
        ${inputState?.source === "keyboard" ? `
          <table class="pilot-keymap-table"><tbody>
            <tr><td>↑ / ↓</td><td>Pitch forward / back (25% input; vehicle cap ${percent(limits.pitch, "25%")})</td></tr>
            <tr><td>← / →</td><td>Roll left / right (25% input; vehicle cap ${percent(limits.roll, "25%")})</td></tr>
            <tr><td>W / S</td><td>Throttle up / down (25% input; vehicle cap ${percent(limits.throttle, "15%")})</td></tr>
            <tr><td>A / D</td><td>Yaw left / right (25% input; vehicle cap ${percent(limits.yaw, "25%")})</td></tr>
            <tr><td>Left Shift</td><td>Dead-man — hold continuously</td></tr>
            <tr><td>Space</td><td>Neutral / release manual input</td></tr>
            <tr><td>Escape</td><td>Immediate release and disable</td></tr>
          </tbody></table>` : `
          <p>Mode 2: left stick = yaw/throttle; right stick = roll/pitch. The configured calibration and dead-man button are authoritative.</p>`}
      </details>

      <details class="pilot-disclosure">
        <summary>RC mapping / Safety diagnostics</summary>
        <div class="pilot-diagnostic-grid">
          <div><span>Mapping</span><strong>${escapeHtml(mappingText(mapping))}</strong></div>
          <div><span>RC calibration</span><strong>${rcReady ? "Vehicle parameters loaded" : "Pending / incompatible"}</strong></div>
          <div><span>RC_OVERRIDE_TIME</span><strong>${timeout == null ? "Unknown" : `${fmt(timeout, 1)} s`}</strong></div>
          <div><span>Override source ID</span><strong>${escapeHtml(sourceIdText)}</strong></div>
          <div><span>Input timeout</span><strong>${fmt(pilot?.inputTimeoutSeconds, 1)} s</strong></div>
          <div><span>Override rate</span><strong>${fmt(pilot?.overrideRateHz ?? pilot?.setpointRateHz, 0)} Hz</strong></div>
          <div><span>Active source</span><strong>${escapeHtml(inputState?.provider || inputState?.source || EMPTY)}</strong></div>
        </div>
        <p class="meta">STABILIZE maps zero throttle to the calibrated low-stick endpoint; ALT_HOLD uses calibrated trim for centred hold/climb/descent input.</p>
        <p class="meta">Parameters are read for diagnostics and mapping only. This application never writes RC, timeout, arming-check or failsafe parameters.</p>
      </details>
    `;
  }
}
