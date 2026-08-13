// Unified Manual Control panel.
//
// GamepadController is the single owner of Keyboard/PS5 providers,
// calibration and provider safety. PilotController is the single owner of
// command cadence and release behaviour. Both sources therefore share the
// exact same backend path.

import { DroneApiClient } from "../drone/drone-api-client.js";
import { GamepadController } from "../gamepad/gamepad-controller.js";
import { NEUTRAL_AXES } from "./pilot-axes.js";
import { PilotClient } from "./pilot-client.js";
import { PilotController } from "./pilot-controller.js";
import { PilotView } from "./pilot-view.js";

export const TELEMETRY_POLL_MS = 500;
const SOCKET_RETRY_MS = 1000;

/**
 * Build the ARM-rejection diagnostic shown separately from the plain ARM
 * outcome text, distinguishing what the numeric MAV_RESULT code says
 * ("Command result") from what the vehicle itself explained via STATUSTEXT
 * ("Vehicle reason") -- see `command_service.py`'s `capture_arm_reason`.
 *
 * Returns null for every rejection that is *not* the vehicle refusing the
 * arm request itself (e.g. link down, pilot channel not ready, ack timeout):
 * those already have a clear, accurate top-level message, and forcing them
 * into this two-line frame would misrepresent them.
 */
export function buildArmDiagnostic(error) {
  if (error?.reason !== "rejected_by_vehicle") return null;
  const detail = error.detail || {};
  const resultName = (detail.ack && detail.ack.resultName) || "FAILED";
  const vehicleReason = typeof detail.vehicleReason === "string" && detail.vehicleReason.trim()
    ? detail.vehicleReason.trim()
    : null;
  return {
    resultName,
    vehicleReason,
    // Shown only when the backend genuinely found no arming-relevant
    // STATUSTEXT for this attempt -- never fabricated from any other field.
    fallbackText: vehicleReason
      ? null
      : `Vehicle rejected ARM (MAV_RESULT_${resultName}); no detailed reason received.`,
    // Raw evidence read from the vehicle at the moment of rejection (mode,
    // armed state, pre-arm health, actual RC input, override/RCMAP/
    // calibration state, throttle failsafe params). The view shows this only
    // when there is no vehicleReason to explain the rejection -- it is
    // evidence for the operator to read, never a stated cause.
    evidence: detail.armEvidence || null
  };
}

export class PilotPanel {
  constructor({
    baseUrl = "",
    doc = globalThis.document,
    win = globalThis.window,
    nav = globalThis.navigator,
    fetchImpl,
    WebSocketImpl,
    now = () => performance.now(),
    inputController,
    controller
  } = {}) {
    this.doc = doc;
    this.win = win;
    this.now = now;
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.fetchImpl = fetchImpl || ((...args) => globalThis.fetch(...args));

    this.view = new PilotView(doc);
    const pilotClient = new PilotClient({ baseUrl: this.baseUrl, fetchImpl: this.fetchImpl });
    this.controller = controller || new PilotController({ client: pilotClient, win, doc, now });
    this.inputController = inputController || new GamepadController({ win, doc, nav });
    this.droneClient = new DroneApiClient({
      baseUrl: this.baseUrl,
      fetchImpl: this.fetchImpl,
      WebSocketImpl,
      requestTimeoutMs: 1500
    });

    this.telemetry = null;
    this.inputState = null;
    this.pollTimer = null;
    this.flashTimer = null;
    this.socketRetryTimer = null;
    this.socketHandle = null;
    this.socketConnected = false;
    this.busy = false;
    this.destroyed = false;
    this.propsAckChecked = false;
    this.message = "";
    // The most recent ARM outcome's *diagnostic* detail, kept separate from
    // the transient `this.message` line. Persists across renders and across
    // the 500 ms telemetry poll -- it is only replaced by the next ARM
    // attempt's own outcome, or cleared once the vehicle actually reports
    // ARMED (see applyTelemetrySafety): an old rejection reason must not
    // linger once it is moot, but must also not vanish just because a retry
    // was clicked and is still pending.
    this.armDiagnostic = null;

    this.onControllerChange = () => this.render();
    this.onInputState = (event) => {
      this.inputState = event.detail || this.inputController.getState();
      this.controller.acceptInput(this.inputState);
      this.render();
    };
    this.onInputNeutral = (event) => {
      const detail = event?.detail || {};
      const reason = detail.reason || detail.gateReason || "input-neutral";
      if (reason === "escape") {
        void this.stopFlying("escape");
      } else if (reason === "space" || reason === "neutral") {
        void this.controller.panic(reason, { failsafe: false });
      }
    };
  }

  /** Always mount the unified PREVIEW surface. Backend permission controls
   * output, not whether calibration/diagnostics are visible. */
  async mount() {
    if (!this.view.isMounted) return false;

    this.controller.addEventListener("change", this.onControllerChange);
    this.inputController.addEventListener("statechange", this.onInputState);
    this.inputController.addEventListener("neutral", this.onInputNeutral);
    await this.inputController.mount();
    this.inputState = this.inputController.getState();
    this.controller.acceptInput(this.inputState);

    const panel = this.doc.getElementById("pilotPanel");
    if (panel) panel.hidden = false;

    await this.refreshTelemetry({ render: false });
    this.render();
    this.openSocket();
    this.pollTimer = setInterval(() => this.refreshTelemetry(), TELEMETRY_POLL_MS);
    this.pollTimer?.unref?.();
    return true;
  }

  async toggleBench() {
    if (this.busy) return;
    this.busy = true;
    this.message = "";
    try {
      if (this.controller.enabled) {
        await this.stopFlying("bench-disabled", { alreadyBusy: true });
      } else {
        await this.controller.enableBench(this.propsAckChecked);
        this.inputController.startCapture?.();
        // Re-read after capture starts so Shift can become authoritative.
        this.inputState = this.inputController.getState();
        this.controller.acceptInput(this.inputState);
        this.message = "Bench Pilot enabled. Hold the selected dead-man continuously.";
      }
    } catch (error) {
      this.inputController.stopCapture?.();
      this.message = error.message;
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async stopFlying(reason, { alreadyBusy = false } = {}) {
    if (!alreadyBusy) this.busy = true;
    this.inputController.stopCapture?.();
    await this.controller.panic(reason, { failsafe: reason === "escape" });
    await this.controller.disable();
    this.propsAckChecked = false;
    this.message = reason === "escape" ? "Escape: manual input released and Bench Pilot disabled." : "Bench Pilot disabled; RC override released.";
    if (!alreadyBusy) this.busy = false;
    this.render();
  }

  async arm() {
    if (this.busy) return;
    this.busy = true;
    this.message = "ARM requested; waiting for command acknowledgement and ARMED telemetry…";
    // Deliberately not cleared here: the previous attempt's diagnostic stays
    // on screen while this one is in flight, and is only replaced once this
    // attempt itself concludes (below) -- see the field comment.
    this.render();
    try {
      const result = await this.controller.arm();
      this.message = result?.message || "ARM confirmed by vehicle telemetry.";
      // A confirmed ARM makes any earlier rejection reason moot.
      this.armDiagnostic = null;
      await this.refreshTelemetry({ render: false });
    } catch (error) {
      this.message = `ARM rejected: ${error.message}`;
      this.armDiagnostic = buildArmDiagnostic(error);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async disarm() {
    if (this.busy) return;
    this.busy = true;
    this.message = "DISARM requested; waiting for DISARMED telemetry…";
    this.render();
    await this.controller.panic("disarm-requested", { failsafe: false });
    try {
      const result = await this.controller.disarm();
      this.message = result?.message || "DISARM confirmed by vehicle telemetry.";
      await this.refreshTelemetry({ render: false });
    } catch (error) {
      this.message = `DISARM rejected: ${error.message}`;
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async refreshTelemetry({ render = true } = {}) {
    try {
      const snapshot = await this.droneClient.status();
      this.telemetry = snapshot;
      this.inputController.setMockAllowed?.(snapshot?.mode === "mock");
      this.controller.setExternalGate?.("backend", null);
      if (snapshot?.pilot) this.controller.syncPilotState(snapshot.pilot);
      this.applyTelemetrySafety(snapshot);
    } catch {
      this.telemetry = {
        ...(this.telemetry || {}),
        connectionState: "disconnected",
        connected: false,
        commandable: false,
        link: { ...(this.telemetry?.link || {}), stale: true }
      };
      this.controller.setExternalGate?.("backend", "backend-unreachable");
    }
    if (render) this.render();
  }

  openSocket() {
    if (this.destroyed) return;
    // CONNECTING is not healthy. Hold the same persistent gate used after a
    // close until the WebSocket has actually opened; status polling alone
    // must never make live manual input eligible.
    this.socketConnected = false;
    this.controller.setExternalGate?.("socket", "websocket-disconnected");
    try {
      this.socketHandle = this.droneClient.openTelemetrySocket({
        onOpen: () => {
          this.socketConnected = true;
          this.controller.setExternalGate?.("socket", null);
          this.render();
        },
        onMessage: (payload) => {
          this.socketConnected = true;
          this.controller.setExternalGate?.("socket", null);
          this.telemetry = { ...payload, pilot: this.telemetry?.pilot || this.controller.pilotState };
          this.applyTelemetrySafety(payload);
          this.render();
        },
        onClose: () => this.handleSocketLoss(),
        onError: () => {
          this.controller.setExternalGate?.("socket", "websocket-disconnected");
        }
      });
    } catch {
      this.handleSocketLoss();
    }
  }

  handleSocketLoss() {
    this.socketConnected = false;
    this.socketHandle = null;
    this.controller.setExternalGate?.("socket", "websocket-disconnected");
    this.render();
    if (!this.destroyed && !this.socketRetryTimer) {
      this.socketRetryTimer = setTimeout(() => {
        this.socketRetryTimer = null;
        this.openSocket();
      }, SOCKET_RETRY_MS);
      this.socketRetryTimer?.unref?.();
    }
  }

  /** A healthy WebSocket is not proof that the serial/MAVLink side is
   * healthy. Clear browser output as soon as either push or poll telemetry
   * reports a stale/lost vehicle link; the backend independently releases the
   * RC override as the authoritative safety layer. */
  applyTelemetrySafety(snapshot) {
    if (!snapshot) return;
    const stale = snapshot?.link?.stale === true || snapshot.connectionState === "telemetry_stale";
    const disconnected = snapshot.connectionState !== "connected";
    const reason = stale ? "telemetry-stale" : disconnected ? "mavlink-disconnected" : null;
    this.controller.setExternalGate?.("telemetry", reason);
    // A held rejection reason from an earlier ARM click is moot once the
    // vehicle actually reports ARMED, however that happened (this panel's own
    // retry, or an operator arming from the transmitter in the meantime).
    if (this.armDiagnostic && snapshot?.vehicle?.armed === true) {
      this.armDiagnostic = null;
    }
  }

  render() {
    if (!this.view.isMounted) return;
    const state = this.controller.getState();
    const inputState = this.inputState || this.inputController.getState();
    const flashing = state.neutralFlashUntil > this.now();

    this.view.render({
      axes: state.axes || { ...NEUTRAL_AXES },
      enabled: state.enabled,
      deadmanHeld: state.deadmanHeld,
      propsAckChecked: this.propsAckChecked,
      busy: this.busy,
      // PilotController clears its local snapshot synchronously on every
      // panic/release. Prefer that newer safety state over the last HTTP poll
      // so a stale telemetry object cannot keep TRANSMITTING lit for 500 ms.
      pilot: state.pilot || this.telemetry?.pilot || null,
      telemetry: this.telemetry,
      error: state.error,
      message: this.message,
      armDiagnostic: this.armDiagnostic,
      neutralFlash: flashing,
      localFailsafeReason: state.failsafeReason,
      externalGateReason: state.externalGateReason,
      inputState,
      inputHtml: this.inputController.renderHtml(),
      socketConnected: this.socketConnected
    });

    this.inputController.bind(this.doc.getElementById("manualInputRoot"));
    this.bind();
    if (flashing && !this.flashTimer) {
      this.flashTimer = setTimeout(() => {
        this.flashTimer = null;
        this.render();
      }, Math.max(50, state.neutralFlashUntil - this.now()));
      this.flashTimer?.unref?.();
    }
  }

  bind() {
    this.doc.getElementById("pilotBenchEnableButton")?.addEventListener("click", () => this.toggleBench());
    this.doc.getElementById("pilotArmButton")?.addEventListener("click", () => this.arm());
    this.doc.getElementById("pilotDisarmButton")?.addEventListener("click", () => this.disarm());
    this.doc.getElementById("pilotNeutralButton")?.addEventListener("click", () => {
      void this.controller.panic("neutral", { failsafe: false });
    });
    this.doc.getElementById("pilotBenchPropsAck")?.addEventListener("change", (event) => {
      this.propsAckChecked = Boolean(event.target.checked);
      this.render();
    });
  }

  destroy() {
    this.destroyed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.flashTimer) clearTimeout(this.flashTimer);
    if (this.socketRetryTimer) clearTimeout(this.socketRetryTimer);
    this.pollTimer = null;
    this.flashTimer = null;
    this.socketRetryTimer = null;
    this.socketHandle?.close?.();
    this.socketHandle = null;
    this.inputController.removeEventListener("statechange", this.onInputState);
    this.inputController.removeEventListener("neutral", this.onInputNeutral);
    this.inputController.destroy?.();
    this.controller.destroy();
  }
}
