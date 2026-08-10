// Keyboard input provider — an input source only.
//
// Emits the same raw sample shape as the browser and simulated gamepad
// providers. GamepadController turns that digital direction into a deliberately
// reduced semantic deflection before it can reach the pilot layer.
// There is deliberately no separate control path: anything the keyboard can
// produce is subject to the same gatePreview() checks as a real stick.
//
// This module has no transport of any kind and never speaks to the backend.
// It reports which keys are down; that is all. Whether those keys can move an
// aircraft is decided entirely elsewhere:
//
//   this module  ->  js/pilot/pilot-controller.js  (when and whether to send)
//                ->  backend PilotService          (all limits and safety gates)
//
// Manual output is opt-in and off unless the backend was started with
// SUISUI_MAVLINK_ALLOW_PILOT_CONTROL=1. This provider itself cannot ARM,
// DISARM, take off, or transmit anything; normal ARM/DISARM is a separate,
// explicitly confirmed PilotClient action. Keeping this file transport-free
// is what makes that separation checkable:
// tests/unit/gamepad-safety.test.js scans this directory for fetch, sockets
// and MAVLink identifiers and must keep finding none.
//
// Axis layout matches the gamepad providers (Mode 2):
//   axes[0] = yaw       (A / D)
//   axes[1] = vertical  (W / S)
//   axes[2] = roll      (Arrow Left / Arrow Right)
//   axes[3] = pitch     (Arrow Up / Arrow Down)
//   buttons[4] = L1 = dead-man (Left Shift)

import { GamepadProvider } from "./gamepad-provider.js";

/**
 * Default key → (axis, direction) mapping.
 *
 * Arrows translate, WASD changes altitude and heading:
 *
 *   ↑ forward   ↓ backward   ← left   → right
 *   W climb     S descend    A yaw left   D yaw right
 *   Space       neutral (all axes to zero)
 *
 * Axis indices and their signs follow the gamepad convention the rest of the
 * pipeline already uses (axes[0] yaw, [1] vertical, [2] roll, [3] pitch; a
 * stick pushed *up* reads negative), so keyboard and gamepad samples are
 * interchangeable downstream. `js/pilot/pilot-axes.js` is the single place
 * that turns either one into semantic forward/right/up/yaw.
 */
export const DEFAULT_KEY_MAP = Object.freeze({
  ArrowUp: { axis: 3, value: -1 }, // pitch forward (stick up is negative)
  ArrowDown: { axis: 3, value: 1 }, // pitch backward
  ArrowLeft: { axis: 2, value: -1 }, // roll left
  ArrowRight: { axis: 2, value: 1 }, // roll right
  KeyW: { axis: 1, value: -1 }, // climb (stick up is negative)
  KeyS: { axis: 1, value: 1 }, // descend
  KeyA: { axis: 0, value: -1 }, // yaw left
  KeyD: { axis: 0, value: 1 } // yaw right
});

/**
 * Movement-neutral key. Zeroes every axis immediately and keeps capture
 * active, so the operator can fly again without re-enabling anything.
 *
 * This is deliberately **not** an emergency motor kill and must never be
 * described as one: the pilot layer releases manual RC override while the
 * autopilot remains responsible for the vehicle's resulting behavior.
 */
export const NEUTRAL_CODE = "Space";

/** Button index used as the dead-man, matching the gamepad L1 default. */
export const DEADMAN_BUTTON_INDEX = 4;
/** Physical key that acts as the dead-man. */
export const DEADMAN_CODE = "ShiftLeft";
/** Panic key: zero everything and drop capture. */
export const PANIC_CODE = "Escape";

/** One digital key press is a conservative quarter-stick command. */
export const KEYBOARD_DEFLECTION = 0.25;

const BUTTON_COUNT = 18;

function blankButtons() {
  return Array.from({ length: BUTTON_COUNT }, () => ({ pressed: false, touched: false, value: 0 }));
}

/**
 * True when the event target is a text-entry surface.
 * Flight-preview keys must never fire while somebody is typing a field name,
 * a note, or a number into the survey forms.
 */
export function isTextEntryTarget(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = String(target.tagName || "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = String(target.type || "text").toLowerCase();
  // Buttons/checkboxes are not text entry; everything else on <input> is.
  return !["button", "submit", "reset", "checkbox", "radio", "range", "color", "file"].includes(type);
}

export class KeyboardProvider extends GamepadProvider {
  constructor({ win = globalThis.window, doc = globalThis.document, keyMap = DEFAULT_KEY_MAP } = {}) {
    super("keyboard");
    this.win = win;
    this.doc = doc;
    this.keyMap = keyMap;
    /** Capture is opt-in: no global key interception until the operator asks. */
    this.capturing = false;
    this.held = new Set();
    this.deadman = false;

    this.onKeyDown = this.onKeyDown.bind(this);
    this.onKeyUp = this.onKeyUp.bind(this);
    this.onBlur = this.onBlur.bind(this);
    this.onVisibility = this.onVisibility.bind(this);
    this.onPageHide = this.onPageHide.bind(this);
  }

  /** Whether keys are currently being read. */
  get active() {
    return this.capturing;
  }

  /**
   * Begin capturing keys. Nothing is intercepted before this is called, so
   * the app's normal typing and shortcuts are untouched while inactive.
   */
  startCapture() {
    if (this.capturing) return;
    this.capturing = true;
    this.win.addEventListener("keydown", this.onKeyDown);
    this.win.addEventListener("keyup", this.onKeyUp);
    this.win.addEventListener("blur", this.onBlur);
    this.doc.addEventListener("visibilitychange", this.onVisibility);
    this.win.addEventListener("pagehide", this.onPageHide);
    this.emit("capture", { capturing: true });
    this.emitSample();
  }

  /** Stop capturing and zero everything. */
  stopCapture() {
    if (!this.capturing) {
      this.reset();
      return;
    }
    this.capturing = false;
    this.win.removeEventListener("keydown", this.onKeyDown);
    this.win.removeEventListener("keyup", this.onKeyUp);
    this.win.removeEventListener("blur", this.onBlur);
    this.doc.removeEventListener("visibilitychange", this.onVisibility);
    this.win.removeEventListener("pagehide", this.onPageHide);
    this.reset();
    this.emit("capture", { capturing: false });
  }

  start() {
    // The provider is "connected" as soon as it is selected; capture is a
    // separate, explicit step.
    this.emit("connection", this.sample());
  }

  stop() {
    this.stopCapture();
    this.emit("connection", null);
  }

  /** Release every key and zero the dead-man, then publish the zeroed sample. */
  reset({ emit = true } = {}) {
    const changed = this.held.size > 0 || this.deadman;
    this.held.clear();
    this.deadman = false;
    if (emit && (changed || this.capturing)) this.emitSample();
  }

  onKeyDown(event) {
    if (!this.capturing) return;
    if (event.code === PANIC_CODE) {
      // Escape always wins: immediate neutral, capture off.
      this.stopCapture();
      this.emit("panic", { reason: "escape" });
      return;
    }
    if (isTextEntryTarget(event.target)) return;

    // If a Shift key-up was lost but a later real keyboard event reports that
    // Shift is no longer depressed, fail closed immediately. We never infer a
    // held dead-man from this generic modifier flag (Right Shift must not
    // impersonate the configured Left Shift).
    if (event.code !== DEADMAN_CODE && this.deadman && event.shiftKey === false) {
      this.deadman = false;
    }

    if (event.code === NEUTRAL_CODE) {
      // Movement-neutral: drop every held key so the very next sample is
      // zero, and tell listeners so the pilot layer can push an immediate
      // neutral rather than waiting for its next scheduled frame.
      this.held.clear();
      this.emitSample();
      this.emit("neutral", { reason: "space" });
      event.preventDefault();
      return;
    }

    if (event.code === DEADMAN_CODE) {
      if (!this.deadman) {
        this.deadman = true;
        this.emitSample();
      }
      event.preventDefault();
      return;
    }
    if (!this.keyMap[event.code]) return;
    if (!this.held.has(event.code)) {
      this.held.add(event.code);
    }
    // Key repeat is the keyboard provider's physical liveness signal. Emit
    // every repeat so a held command remains fresh; if repeats stop, the
    // common controller expires the cached keys and requires a new Shift.
    this.emitSample();
    // Arrow keys would otherwise scroll the panel under the operator.
    event.preventDefault();
  }

  onKeyUp(event) {
    if (!this.capturing) return;
    if (event.code === DEADMAN_CODE) {
      if (this.deadman) {
        this.deadman = false;
        this.emitSample();
      }
      return;
    }
    if (this.held.delete(event.code)) this.emitSample();
  }

  /** Window lost focus: a held key we can no longer see must not persist. */
  onBlur() {
    this.reset();
  }

  onVisibility() {
    // Covers tab switches and minimizing, both of which stop keyup delivery.
    if (this.doc.hidden) this.reset();
  }

  onPageHide() {
    this.reset();
  }

  /** Current axes, derived from the held keys. Opposite keys cancel out. */
  axes() {
    const axes = [0, 0, 0, 0];
    for (const code of this.held) {
      const binding = this.keyMap[code];
      if (binding) axes[binding.axis] += binding.value;
    }
    return axes.map((value) => Math.max(-1, Math.min(1, value)));
  }

  buttons() {
    const buttons = blankButtons();
    if (this.deadman) {
      buttons[DEADMAN_BUTTON_INDEX] = { pressed: true, touched: true, value: 1 };
    }
    return buttons;
  }

  sample() {
    return {
      provider: "keyboard",
      id: "Keyboard (preview only)",
      mapping: "keyboard",
      axes: this.axes(),
      buttons: this.buttons(),
      // Consumers of the common controller never need to know which synthetic
      // button slot represents Shift.
      deadmanHeld: this.deadman,
      timestamp: typeof performance !== "undefined" ? performance.now() : Date.now(),
      capturing: this.capturing
    };
  }

  emitSample() {
    this.emit("sample", this.sample());
  }
}
