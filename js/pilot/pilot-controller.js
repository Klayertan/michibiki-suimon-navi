// Manual Control: turns a common Keyboard/PS5 input state into a steady stream
// of normalized intentions and guarantees that every unsafe transition sends
// an out-of-band release request.
//
//   InputProvider -> normalized Mode-2 axes -> PilotController -> backend
//
// This layer owns timing and browser-side failsafes. It deliberately knows no
// RC channel numbers, PWM values or MAVLink message names; those belong to the
// backend mapping/transport boundary.

import { PilotClient, normalizeProvider } from "./pilot-client.js";
import {
  NEUTRAL_AXES,
  axesAreNeutral,
  axesEqual,
  sampleDeadman,
  sampleToPilotAxes
} from "./pilot-axes.js";

/**
 * Reasons that mean "the last frame did not reach the backend", as opposed to
 * a real vehicle/input condition. These are latched as a failsafe while they
 * hold — a frame we could not deliver may have left an override running — but
 * a later *successful* frame proves the transport recovered, so they must not
 * stay on screen as the current gate afterwards. See clearTransportFailure().
 */
const TRANSPORT_FAILURE_REASONS = new Set([
  "backend-unreachable",
  "backend_unreachable"
]);

function isTransportFailureReason(reason) {
  if (!reason) return false;
  // Validation/HTTP failures surface as `http_<status>` from PilotClient.
  return TRANSPORT_FAILURE_REASONS.has(reason) || /^http_\d{3}$/.test(String(reason));
}

/** Command rate, Hz. The backend independently rate-limits its output. */
export const SEND_RATE_HZ = 15;
const SEND_INTERVAL_MS = 1000 / SEND_RATE_HZ;

/** Refresh an unchanged held input before the backend's 0.5 s timeout. */
export const KEEPALIVE_MS = 200;

/** Positive feedback duration after a neutral/release action. */
export const NEUTRAL_FLASH_MS = 2000;

function finiteAxis(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(-1, Math.min(1, number));
}

function cleanAxes(axes) {
  return {
    pitch: finiteAxis(axes?.pitch),
    roll: finiteAxis(axes?.roll),
    throttle: finiteAxis(axes?.throttle),
    yaw: finiteAxis(axes?.yaw)
  };
}

export class PilotController extends EventTarget {
  constructor({
    client,
    baseUrl = "",
    win = globalThis.window,
    doc = globalThis.document,
    now = () => performance.now()
  } = {}) {
    super();
    this.client = client || new PilotClient({ baseUrl });
    this.win = win;
    this.doc = doc;
    this.now = now;

    this.enabled = false;
    this.benchMode = false;
    this.deadmanHeld = false;
    this.rawDeadmanHeld = false;
    this.axes = { ...NEUTRAL_AXES };
    this.source = "keyboard";
    this.provider = "keyboard";
    this.inputConnected = false;
    this.inputCalibrated = true;
    this.inputGateReason = "input-disconnected";
    this.externalGates = new Map();
    this.deadmanRearmRequired = false;
    this.lastProviderInput = null;
    this.failsafeReason = null;
    this.lastInputAt = 0;

    this.lastSentAxes = { ...NEUTRAL_AXES };
    this.lastSentDeadman = false;
    this.lastSentAt = 0;
    this.timer = null;
    this.movementInFlight = false;
    this.commandEpoch = 0;
    this.sequence = 0;
    this.lastAppliedSequence = 0;
    this.pilotState = null;
    this.lastError = null;
    this.neutralFlash = 0;

    this.onBlur = () => this.panic("focus-lost");
    this.onVisibility = () => {
      if (this.doc?.hidden) this.panic("tab-hidden");
    };
    this.onPageHide = () => this.panic("page-hidden");
  }

  getAxes() {
    return { ...this.axes };
  }

  getState() {
    return {
      enabled: this.enabled,
      benchMode: this.benchMode,
      deadmanHeld: this.deadmanHeld,
      rawDeadmanHeld: this.rawDeadmanHeld,
      source: this.source,
      provider: this.provider,
      inputConnected: this.inputConnected,
      inputCalibrated: this.inputCalibrated,
      inputGateReason: this.inputGateReason,
      externalGateReason: this.externalGateReason(),
      failsafeReason: this.failsafeReason,
      axes: this.getAxes(),
      pilot: this.pilotState,
      error: this.lastError,
      neutralFlashUntil: this.neutralFlash
    };
  }

  /** Merge a status/command snapshot and advance the browser sequence above
   * the backend's accepted high-water mark. */
  syncPilotState(snapshot) {
    if (!snapshot) return;
    this.pilotState = snapshot;
    const lastAccepted = Number.isFinite(Number(snapshot.sequence)) ? Number(snapshot.sequence) : null;
    const next = Number.isFinite(Number(snapshot.nextSequence)) ? Number(snapshot.nextSequence) : null;
    if (lastAccepted != null) this.sequence = Math.max(this.sequence, lastAccepted);
    if (next != null) this.sequence = Math.max(this.sequence, next - 1);
    if (lastAccepted != null) this.lastAppliedSequence = Math.max(this.lastAppliedSequence, lastAccepted);
  }

  externalGateReason() {
    return this.externalGates.values().next().value || null;
  }

  /** Hold a named safety gate until its owning subsystem explicitly clears
   * it. Clearing a link/socket gate never resumes a held stick: Shift/the
   * configured controller dead-man must first be observed released. */
  setExternalGate(name, reason = null) {
    const key = String(name || "external");
    const previous = this.externalGateReason();
    if (reason) {
      this.externalGates.set(key, String(reason));
      if (this.rawDeadmanHeld) this.deadmanRearmRequired = true;
    } else {
      this.externalGates.delete(key);
    }
    const current = this.externalGateReason();
    if (previous === current && !reason) return;
    this.acceptInput(this.lastProviderInput || {
      source: this.source,
      connected: this.inputConnected,
      calibrated: this.inputCalibrated,
      deadmanHeld: this.deadmanHeld,
      rawDeadmanHeld: this.rawDeadmanHeld,
      gateReason: this.inputGateReason,
      axes: this.axes
    });
  }

  /** Consume the common input provider's semantic state. The provider has
   * already applied calibration and its configured dead-man button. */
  acceptInput(input = {}) {
    this.lastProviderInput = {
      ...input,
      axes: cleanAxes(input.axes)
    };
    const previousReason = this.inputGateReason;
    const wasMoving = !axesAreNeutral(this.axes);
    this.source = input.source || this.source || "unknown";
    // Never fall back to the *source* id here: `ps5` is a UI source, not a
    // provider implementation, and sending it as `provider` was rejected by
    // the backend with HTTP 422 — which killed release frames too.
    this.provider = normalizeProvider(input.provider ?? this.provider);
    this.inputConnected = Boolean(input.connected);
    this.inputCalibrated = input.calibrated !== false;
    this.deadmanHeld = Boolean(input.deadmanHeld);
    // Providers suppress the safe dead-man state while hidden, stale, or
    // disconnected, but preserve the physical/raw button state. Rearm must
    // follow that raw edge or a held PS5 button could resume on recovery.
    this.rawDeadmanHeld = Boolean(input.rawDeadmanHeld ?? input.deadmanHeld);
    this.lastInputAt = this.now();

    if ((this.externalGateReason() || input.gateReason) && this.rawDeadmanHeld) {
      this.deadmanRearmRequired = true;
    }
    if (this.deadmanRearmRequired && !this.rawDeadmanHeld) {
      this.deadmanRearmRequired = false;
    }

    let reason = this.externalGateReason() || input.gateReason || null;
    if (!reason && this.deadmanRearmRequired) reason = "deadman-rearm-required";
    if (!reason && !this.inputConnected) reason = "input-disconnected";
    if (!reason && !this.inputCalibrated) reason = "calibration-incomplete";
    if (!reason && !this.deadmanHeld) reason = "deadman-released";
    this.inputGateReason = reason;

    if (reason) {
      this.axes = { ...NEUTRAL_AXES };
      this.failsafeReason = this.enabled ? reason : null;
      this.emitChange();
      // One immediate release on the transition is enough; the backend then
      // repeats the MAVLink release frame independently.
      if (this.enabled && (previousReason !== reason || wasMoving || this.pilotState?.outputActive)) {
        void this.panic(reason);
      }
      return;
    }

    this.failsafeReason = null;
    this.axes = cleanAxes(input.axes);
    this.emitChange();
    if (this.enabled) this.pump();
  }

  /** Compatibility adapter for transport-free providers and focused tests. */
  acceptSample(sample) {
    this.acceptInput({
      source: sample?.provider || "unknown",
      provider: sample?.provider || "unknown",
      connected: Boolean(sample),
      calibrated: true,
      deadmanHeld: sampleDeadman(sample),
      gateReason: sample ? null : "input-disconnected",
      axes: sampleToPilotAxes(sample)
    });
  }

  /** Immediately clear local TRANSMITTING state and ask the backend to release
   * RC override. The release request jumps ahead of any movement request. */
  async panic(reason, { failsafe = true } = {}) {
    this.commandEpoch += 1;
    this.axes = { ...NEUTRAL_AXES };
    this.lastSentAxes = { ...NEUTRAL_AXES };
    this.neutralFlash = this.now() + NEUTRAL_FLASH_MS;
    if (failsafe && this.enabled) this.failsafeReason = reason;
    if (this.pilotState) {
      this.pilotState = { ...this.pilotState, outputActive: false, transmitting: false };
    }
    this.emitChange();
    if (!this.enabled) return null;
    return this.sendNeutral(reason, { force: true });
  }

  async enable() {
    if (this.enabled) return this.pilotState;
    return this._openChannel(() => this.client.enable(), { benchMode: false });
  }

  async enableBench(propsRemovedAck) {
    if (this.enabled) return this.pilotState;
    if (propsRemovedAck !== true) throw new Error("Propellers-removed acknowledgement is required.");
    return this._openChannel(() => this.client.enableBench(true), { benchMode: true });
  }

  async _openChannel(request, { benchMode }) {
    try {
      const response = await request();
      this.syncPilotState(response?.detail?.pilot ?? null);
      this.lastError = null;
    } catch (error) {
      this.lastError = error.message;
      this.emitChange();
      throw error;
    }

    this.enabled = true;
    this.benchMode = benchMode;
    this.axes = { ...NEUTRAL_AXES };
    this.lastSentAxes = { ...NEUTRAL_AXES };
    this.lastSentDeadman = false;
    this.lastSentAt = 0;
    this.commandEpoch += 1;
    this.failsafeReason = this.inputGateReason || "deadman-released";

    this.win?.addEventListener?.("blur", this.onBlur);
    this.win?.addEventListener?.("pagehide", this.onPageHide);
    this.doc?.addEventListener?.("visibilitychange", this.onVisibility);

    this.timer = setInterval(() => this.pump(), SEND_INTERVAL_MS);
    this.timer?.unref?.();
    this.emitChange();
    return this.pilotState;
  }

  /** Release first, then close the one manual channel. */
  async disable() {
    if (!this.enabled) return this.pilotState;
    await this.panic("pilot-disabled", { failsafe: false });
    this.enabled = false;
    this.benchMode = false;
    this.deadmanHeld = false;
    this.rawDeadmanHeld = false;
    this.failsafeReason = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;

    this.win?.removeEventListener?.("blur", this.onBlur);
    this.win?.removeEventListener?.("pagehide", this.onPageHide);
    this.doc?.removeEventListener?.("visibilitychange", this.onVisibility);

    try {
      const response = await this.client.disable();
      this.syncPilotState(response?.detail?.pilot ?? null);
      this.lastError = null;
    } catch (error) {
      this.lastError = error.message;
    }
    this.emitChange();
    return this.pilotState;
  }

  pump() {
    if (!this.enabled || this.inputGateReason || !this.deadmanHeld) return;
    const timestamp = this.now();
    const changed = !axesEqual(this.axes, this.lastSentAxes) || this.deadmanHeld !== this.lastSentDeadman;
    const keepaliveDue = timestamp - this.lastSentAt >= KEEPALIVE_MS;
    if (!changed && !keepaliveDue) return;
    void this.send(this.axes);
  }

  sendNeutral(reason, { force = false } = {}) {
    const promise = this.send({ ...NEUTRAL_AXES }, { neutral: true, force });
    this.dispatchEvent(new CustomEvent("neutral", { detail: { reason } }));
    return promise;
  }

  async send(axes, { neutral = false, force = false } = {}) {
    if (!this.enabled) return null;
    if (this.movementInFlight && !neutral && !force) return null;

    const epoch = this.commandEpoch;
    const sequence = ++this.sequence;
    const snapshot = cleanAxes(axes);
    const deadman = neutral ? false : this.deadmanHeld;
    if (!neutral) this.movementInFlight = true;

    try {
      const response = await this.client.sendInput(snapshot, {
        neutral,
        deadman,
        source: this.source,
        provider: this.provider,
        sequence
      });
      // HTTP completion order is not command order. An older movement,
      // neutral, or error response is diagnostics only and must never replace
      // the state produced by a newer sequence/epoch.
      if (epoch !== this.commandEpoch || sequence < this.lastAppliedSequence) return response;
      this.lastAppliedSequence = sequence;
      this.syncPilotState(response?.detail?.pilot ?? this.pilotState);
      this.lastSentAxes = snapshot;
      this.lastSentDeadman = deadman;
      this.lastSentAt = this.now();
      this.lastError = null;
      this.clearTransportFailure();
      return response;
    } catch (error) {
      if (epoch !== this.commandEpoch || sequence < this.lastAppliedSequence) return null;
      this.lastAppliedSequence = sequence;
      this.lastError = error.message;
      this.failsafeReason = error.reason || "backend-unreachable";
      this.axes = { ...NEUTRAL_AXES };
      if (this.pilotState) {
        this.pilotState = { ...this.pilotState, outputActive: false, transmitting: false };
      }
      return null;
    } finally {
      if (!neutral) this.movementInFlight = false;
      this.emitChange();
    }
  }

  /** A delivered frame proves the transport recovered, so a latched transport
   * failure must stop masquerading as the current gate. Any genuine
   * input/vehicle gate is recomputed by acceptInput on the next sample. */
  clearTransportFailure() {
    if (isTransportFailureReason(this.failsafeReason)) {
      this.failsafeReason = this.inputGateReason || null;
    }
  }

  arm() {
    return this.client.arm();
  }

  disarm() {
    return this.client.disarm();
  }

  emitChange() {
    this.dispatchEvent(new Event("change"));
  }

  /** Best-effort release on teardown; backend input timeout remains the
   * independent final layer if the page has already lost its network. */
  destroy() {
    if (this.enabled) {
      void this.panic("controller-destroyed");
      void this.client.disable().catch?.(() => {});
    }
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.win?.removeEventListener?.("blur", this.onBlur);
    this.win?.removeEventListener?.("pagehide", this.onPageHide);
    this.doc?.removeEventListener?.("visibilitychange", this.onVisibility);
    this.enabled = false;
    this.benchMode = false;
    this.deadmanHeld = false;
    this.rawDeadmanHeld = false;
    this.axes = { ...NEUTRAL_AXES };
  }
}
