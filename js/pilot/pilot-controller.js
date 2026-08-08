// Pilot control: turns provider samples into a steady stream of normalized
// commands, and guarantees the stream stops the instant it should.
//
//   keyboard / gamepad provider  ->  pilot axes  ->  PilotController  ->  backend
//
// This layer owns *when* to send and *when to stop*. It owns no speeds and no
// MAVLink knowledge; the backend clamps everything and is the only thing that
// can actually move an aircraft.
//
// Fail-closed: every path that is not "enabled, focused, visible, fresh"
// results in a neutral command being sent, not merely in sending nothing.
// Silence would let the last command stand until the backend's own timeout;
// an explicit zero stops immediately.

import { PilotClient } from "./pilot-client.js";
import { NEUTRAL_AXES, axesAreNeutral, axesEqual, sampleToPilotAxes } from "./pilot-axes.js";

/** Command rate, Hz. Matches the backend's setpoint rate. */
export const SEND_RATE_HZ = 15;
const SEND_INTERVAL_MS = 1000 / SEND_RATE_HZ;

/** Resend even an unchanged command at least this often, so the backend's
 *  input-timeout never trips while the operator is genuinely holding a key. */
const KEEPALIVE_MS = 200;

/** How long the UI shows "movement neutralised" after a stop.
 *  Matches the backend's NEUTRAL_HOLD_SECONDS, so the indicator is lit for
 *  exactly as long as zeros are actually being transmitted. */
export const NEUTRAL_FLASH_MS = 2000;

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
    this.axes = { ...NEUTRAL_AXES };
    this.lastSentAxes = { ...NEUTRAL_AXES };
    this.lastSentAt = 0;
    this.timer = null;
    this.inFlight = false;
    this.pilotState = null;
    this.lastError = null;
    this.neutralFlash = 0;

    this.onBlur = () => this.panic("focus-lost");
    this.onVisibility = () => {
      if (this.doc.hidden) this.panic("tab-hidden");
    };
    this.onPageHide = () => this.panic("page-hide");
  }

  /** Latest normalized axes, for the UI. */
  getAxes() {
    return { ...this.axes };
  }

  getState() {
    return {
      enabled: this.enabled,
      axes: this.getAxes(),
      pilot: this.pilotState,
      error: this.lastError,
      // Non-zero for a moment after a neutral command, so the UI can show
      // that Space (or a focus loss) actually did something.
      neutralFlashUntil: this.neutralFlash
    };
  }

  /**
   * Feed one provider sample. Called by whichever input source is active;
   * the controller does not care which, and only one is ever active.
   */
  acceptSample(sample) {
    this.axes = sampleToPilotAxes(sample);
    this.emitChange();
  }

  /** Immediately zero the axes and push a neutral command out of band. */
  panic(reason) {
    const wasMoving = !axesAreNeutral(this.axes);
    this.axes = { ...NEUTRAL_AXES };
    this.neutralFlash = this.now() + NEUTRAL_FLASH_MS;
    this.emitChange();
    if (!this.enabled) return;
    // Send even when already neutral: a focus loss during a hold is exactly
    // when the backend most needs to hear "stop" without waiting.
    this.sendNeutral(reason, { force: wasMoving || true });
  }

  async enable() {
    if (this.enabled) return this.pilotState;
    try {
      const response = await this.client.enable();
      this.pilotState = response?.detail?.pilot ?? null;
      this.lastError = null;
    } catch (error) {
      this.lastError = error.message;
      this.emitChange();
      throw error;
    }
    this.enabled = true;
    this.axes = { ...NEUTRAL_AXES };
    this.lastSentAxes = { ...NEUTRAL_AXES };
    this.lastSentAt = 0;

    this.win.addEventListener("blur", this.onBlur);
    this.win.addEventListener("pagehide", this.onPageHide);
    this.doc.addEventListener("visibilitychange", this.onVisibility);

    this.timer = setInterval(() => this.pump(), SEND_INTERVAL_MS);
    // Node returns a Timeout object whose presence keeps the process alive;
    // browsers return a plain number. Unref'ing where it exists stops a test
    // runner hanging on a controller a test forgot to disable, and changes
    // nothing in the browser.
    this.timer?.unref?.();
    this.emitChange();
    return this.pilotState;
  }

  async disable() {
    if (!this.enabled) return;
    this.enabled = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;

    this.win.removeEventListener("blur", this.onBlur);
    this.win.removeEventListener("pagehide", this.onPageHide);
    this.doc.removeEventListener("visibilitychange", this.onVisibility);

    this.axes = { ...NEUTRAL_AXES };
    try {
      const response = await this.client.disable();
      this.pilotState = response?.detail?.pilot ?? null;
    } catch (error) {
      this.lastError = error.message;
    }
    this.emitChange();
  }

  /** One scheduled frame. */
  pump() {
    if (!this.enabled) return;
    const timestamp = this.now();
    const changed = !axesEqual(this.axes, this.lastSentAxes);
    const stale = timestamp - this.lastSentAt >= KEEPALIVE_MS;
    if (!changed && !stale) return;
    this.send(this.axes, { neutral: false });
  }

  sendNeutral(reason, { force = false } = {}) {
    this.send({ ...NEUTRAL_AXES }, { neutral: true, force });
    this.dispatchEvent(new CustomEvent("neutral", { detail: { reason } }));
  }

  async send(axes, { neutral = false, force = false } = {}) {
    // Never queue: if the previous frame is still in flight, drop this one.
    // A backlog of stale commands is worse than a missed frame, and the next
    // scheduled pump is only ~66 ms away. A neutral always jumps the queue.
    if (this.inFlight && !neutral && !force) return;
    this.inFlight = true;
    const snapshot = { ...axes };
    try {
      const response = await this.client.sendInput(snapshot, { neutral });
      this.pilotState = response?.detail?.pilot ?? this.pilotState;
      this.lastSentAxes = snapshot;
      this.lastSentAt = this.now();
      this.lastError = null;
    } catch (error) {
      this.lastError = error.message;
      // A failed send means the backend did not hear us. It will time the
      // command out on its own within PILOT_INPUT_TIMEOUT and go neutral,
      // which is the correct outcome — so there is nothing to retry here.
    } finally {
      this.inFlight = false;
      this.emitChange();
    }
  }

  emitChange() {
    this.dispatchEvent(new Event("change"));
  }

  /** Release timers and listeners. Safe to call more than once. */
  destroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.win.removeEventListener("blur", this.onBlur);
    this.win.removeEventListener("pagehide", this.onPageHide);
    this.doc.removeEventListener("visibilitychange", this.onVisibility);
    this.enabled = false;
    this.axes = { ...NEUTRAL_AXES };
  }
}
