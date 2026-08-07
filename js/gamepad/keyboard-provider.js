// Keyboard input provider — PREVIEW ONLY.
//
// Emits exactly the same sample shape as the browser and simulated gamepad
// providers, so keyboard input flows through the identical normalization,
// calibration and dead-man gating pipeline in gamepad-normalization.js.
// There is deliberately no separate control path: anything the keyboard can
// produce is subject to the same gatePreview() checks as a real stick.
//
// This never commands an aircraft. The backend implements no manual-control
// endpoint of any kind -- no manual-control frame, no RC-override frame, no
// attitude or position setpoints -- so a keypress cannot reach the vehicle
// even if the UI were bypassed entirely.
//
// (Those MAVLink message names are spelled descriptively rather than
// literally on purpose: tests/unit/gamepad-safety.test.js scans this
// directory for the exact identifiers and must keep finding none.)
//
// Axis layout matches the gamepad providers (Mode 2):
//   axes[0] = yaw       (Arrow Left / Arrow Right)
//   axes[1] = vertical  (Arrow Up / Arrow Down)
//   axes[2] = roll      (A / D)
//   axes[3] = pitch     (W / S)
//   buttons[4] = L1 = dead-man (Left Shift)

import { GamepadProvider } from "./gamepad-provider.js";

/** Default key → (axis, direction) mapping. */
export const DEFAULT_KEY_MAP = Object.freeze({
  KeyW: { axis: 3, value: -1 }, // pitch forward (stick up is negative, as on a gamepad)
  KeyS: { axis: 3, value: 1 }, // pitch backward
  KeyA: { axis: 2, value: -1 }, // roll left
  KeyD: { axis: 2, value: 1 }, // roll right
  ArrowLeft: { axis: 0, value: -1 }, // yaw left
  ArrowRight: { axis: 0, value: 1 }, // yaw right
  ArrowUp: { axis: 1, value: -1 }, // climb preview
  ArrowDown: { axis: 1, value: 1 } // descend preview
});

/** Button index used as the dead-man, matching the gamepad L1 default. */
export const DEADMAN_BUTTON_INDEX = 4;
/** Physical key that acts as the dead-man. */
export const DEADMAN_CODE = "ShiftLeft";
/** Panic key: zero everything and drop capture. */
export const PANIC_CODE = "Escape";

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
  constructor({ win = window, doc = document, keyMap = DEFAULT_KEY_MAP } = {}) {
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
  reset() {
    const changed = this.held.size > 0 || this.deadman;
    this.held.clear();
    this.deadman = false;
    if (changed || this.capturing) this.emitSample();
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
      this.emitSample();
    }
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
      timestamp: typeof performance !== "undefined" ? performance.now() : Date.now(),
      capturing: this.capturing
    };
  }

  emitSample() {
    this.emit("sample", this.sample());
  }
}
