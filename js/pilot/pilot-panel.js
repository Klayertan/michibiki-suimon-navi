// Pilot panel: wires an input provider to the pilot controller and the view.
//
//   provider (keyboard / gamepad)  ->  PilotController  ->  backend
//                                  \-> PilotView (display only)
//
// This module owns no safety logic of its own. It only decides which provider
// is attached and keeps the display in step; every gate that can stop the
// aircraft lives in PilotController (browser side) and PilotService (backend).
//
// It owns its *own* KeyboardProvider instance, separate from the preview
// instance inside the gamepad panel, so enabling flight never silently
// hijacks the preview UI and vice versa.
//
// Flight input is keyboard-only for now. A physical gamepad can be attached
// with `useProvider()` -- both providers emit the same sample shape, so
// nothing downstream changes -- but nothing does so automatically, because a
// stick that starts off-centre would command movement the instant the channel
// was enabled.

import { KeyboardProvider } from "../gamepad/keyboard-provider.js";
import { PilotController } from "./pilot-controller.js";
import { PilotView } from "./pilot-view.js";
import { NEUTRAL_AXES } from "./pilot-axes.js";

/** How often the panel re-reads backend telemetry for mode / armed display. */
export const TELEMETRY_POLL_MS = 500;

const SOURCE_NONE = "なし / None";
const SOURCE_KEYBOARD = "キーボード / Keyboard";

export class PilotPanel {
  constructor({
    baseUrl = "",
    doc = globalThis.document,
    win = globalThis.window,
    fetchImpl,
    now = () => performance.now()
  } = {}) {
    this.doc = doc;
    this.win = win;
    this.now = now;
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.fetchImpl = fetchImpl || ((...args) => globalThis.fetch(...args));

    this.view = new PilotView(doc);
    this.controller = new PilotController({ baseUrl: this.baseUrl, win, doc, now });
    this.keyboard = new KeyboardProvider({ win, doc });
    this.provider = null;
    this.sourceName = SOURCE_KEYBOARD;
    this.telemetry = null;
    this.pollTimer = null;
    this.flashTimer = null;
    this.busy = false;

    this.onSample = (event) => this.controller.acceptSample(event.detail);
    // Space, and the provider's own Escape panic, both mean "stop moving now".
    this.onProviderNeutral = (event) => this.controller.panic(event?.detail?.reason || "neutral");
    this.onProviderPanic = () => this.stopFlying("escape");
    this.onControllerChange = () => this.render();
  }

  /**
   * Reveal and populate the panel.
   *
   * Returns false without touching the DOM when the markup is absent or when
   * the backend reports that pilot control is not permitted -- an operator who
   * has not opted in should not be shown a flight-control surface at all.
   */
  async mount() {
    if (!this.view.isMounted) return false;
    await this.refreshTelemetry({ render: false });
    if (!this.telemetry?.pilot?.available) return false;

    const panel = this.doc.getElementById("pilotPanel");
    if (panel) panel.hidden = false;

    this.controller.addEventListener("change", this.onControllerChange);
    this.useProvider(this.keyboard, SOURCE_KEYBOARD);
    this.render();

    this.pollTimer = setInterval(() => this.refreshTelemetry(), TELEMETRY_POLL_MS);
    this.pollTimer?.unref?.();
    return true;
  }

  /** Swap the active input source. Only ever one is attached. */
  useProvider(provider, label) {
    if (this.provider && this.provider !== provider) {
      this.provider.removeEventListener("sample", this.onSample);
      this.provider.removeEventListener("neutral", this.onProviderNeutral);
      this.provider.removeEventListener("panic", this.onProviderPanic);
      this.provider.stop?.();
    }
    this.provider = provider;
    this.sourceName = label;
    provider.addEventListener("sample", this.onSample);
    provider.addEventListener("neutral", this.onProviderNeutral);
    provider.addEventListener("panic", this.onProviderPanic);
    // Switching source must never carry a held command across.
    this.controller.acceptSample({ axes: [0, 0, 0, 0] });
  }

  // --------------------------------------------------------------------
  // Enable / disable
  // --------------------------------------------------------------------

  /**
   * Toggle the control channel.
   *
   * Order matters in both directions: key capture starts only after the
   * backend has confirmed the channel is open, and stops before the channel
   * is closed, so there is never a window where a keypress is read but has
   * nowhere safe to go.
   */
  async toggle() {
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.controller.enabled) {
        await this.stopFlying("disabled");
      } else {
        await this.controller.enable();
        this.keyboard.startCapture();
      }
    } catch (error) {
      // The controller recorded the message; make sure keys are not live.
      this.keyboard.stopCapture();
    } finally {
      this.busy = false;
      this.render();
    }
  }

  /** Drop key capture and close the channel. Safe to call at any time. */
  async stopFlying(reason) {
    this.keyboard.stopCapture();
    this.controller.panic(reason);
    await this.controller.disable();
    this.render();
  }

  // --------------------------------------------------------------------
  // Display
  // --------------------------------------------------------------------

  async refreshTelemetry({ render = true } = {}) {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/drone/status`);
      if (response?.ok) this.telemetry = await response.json();
    } catch {
      // The drone panel already reports backend reachability. The pilot panel
      // keeps showing what it last knew; its gates stay closed either way,
      // because the backend is the thing that decides whether to transmit.
    }
    if (render) this.render();
  }

  render() {
    if (!this.view.isMounted) return;
    const state = this.controller.getState();
    const flashing = state.neutralFlashUntil > this.now();

    this.view.render({
      source: this.controller.enabled ? this.sourceName : SOURCE_NONE,
      sourceActive: this.controller.enabled,
      axes: state.axes || { ...NEUTRAL_AXES },
      enabled: state.enabled,
      // Prefer the pilot state carried back on each command -- it is fresher
      // than the poll -- and fall back to the poll before the first send.
      pilot: state.pilot || this.telemetry?.pilot || null,
      telemetry: this.telemetry,
      error: state.error,
      neutralFlash: flashing
    });

    this.bind();
    // The flash is time-based, so schedule the render that clears it.
    if (flashing && !this.flashTimer) {
      this.flashTimer = setTimeout(() => {
        this.flashTimer = null;
        this.render();
      }, Math.max(50, state.neutralFlashUntil - this.now()));
      this.flashTimer?.unref?.();
    }
  }

  /** Re-attach button handlers after a render replaced the nodes. */
  bind() {
    const enableButton = this.doc.getElementById("pilotEnableButton");
    if (enableButton) enableButton.addEventListener("click", () => this.toggle());
    const neutralButton = this.doc.getElementById("pilotNeutralButton");
    if (neutralButton) neutralButton.addEventListener("click", () => this.controller.panic("button"));
  }

  destroy() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.pollTimer = null;
    this.flashTimer = null;
    this.keyboard.stopCapture();
    this.controller.destroy();
  }
}
