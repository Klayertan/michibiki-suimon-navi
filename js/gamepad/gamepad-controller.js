import { BrowserGamepadProvider } from "./browser-gamepad-provider.js";
import { MockGamepadProvider } from "./mock-gamepad-provider.js";
import {
  DEADMAN_BUTTON_INDEX,
  KEYBOARD_DEFLECTION,
  KeyboardProvider
} from "./keyboard-provider.js";
import {
  DEFAULT_AXIS_ASSIGNMENTS,
  defaultCalibration,
  observeAxis,
  validateCalibration
} from "./gamepad-calibration.js";
import { CalibrationRepository } from "./gamepad-storage.js";
import {
  MODE2_AXIS_NAMES,
  NEUTRAL_MODE2_AXES,
  gatePreview,
  isNeutral,
  normalizeMode2Axes
} from "./gamepad-normalization.js";
import { likelyDualSense } from "./gamepad-provider.js";

export const INPUT_SOURCES = Object.freeze({
  keyboard: "Keyboard",
  ps5: "PS5 Controller"
});

export const DEFAULT_INPUT_STALE_MS = 500;

const CALIBRATION_STEPS = Object.freeze([
  "Leave both sticks centred",
  "Move the left stick through its full range",
  "Move the right stick through its full range",
  "Press and release L2",
  "Press and release R2",
  "Press the chosen dead-man several times",
  "Review assignments, inversions and ranges",
  "Save calibration"
]);

const BUTTON_NAMES = Object.freeze({
  0: "Cross",
  1: "Circle",
  2: "Square",
  3: "Triangle",
  4: "L1",
  5: "R1",
  6: "L2",
  7: "R2",
  8: "Create",
  9: "Options",
  12: "D-pad Up",
  13: "D-pad Down",
  14: "D-pad Left",
  15: "D-pad Right"
});

const cloneAxes = (axes = NEUTRAL_MODE2_AXES) => ({
  pitch: Number(axes.pitch) || 0,
  roll: Number(axes.roll) || 0,
  throttle: Number(axes.throttle) || 0,
  yaw: Number(axes.yaw) || 0
});

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sourceName(value) {
  if (value === "browser" || value === "mock") return "ps5";
  return value in INPUT_SOURCES ? value : "keyboard";
}

function stateSignature(state) {
  return JSON.stringify({
    source: state.source,
    provider: state.provider,
    controllerId: state.controllerId,
    connected: state.connected,
    calibrated: state.calibrated,
    stale: state.stale,
    captureActive: state.captureActive,
    focused: state.focused,
    visible: state.visible,
    deadmanHeld: state.deadmanHeld,
    rawDeadmanHeld: state.rawDeadmanHeld,
    deadmanButtonIndex: state.deadmanButtonIndex,
    gateReason: state.gateReason,
    axes: state.axes,
    previewAxes: state.previewAxes,
    rawAxes: state.rawSample?.axes,
    rawButtons: state.rawSample?.buttons?.map((button) => [button.pressed, button.touched, button.value]),
    calibrationStep: state.calibrationStep
  });
}

/**
 * Presentation helper retained for callers that used the old standalone
 * preview. It never treats an absent controller as neutral input.
 */
export function inputStatusModel({ source, sample, gated, stale, state } = {}) {
  const current = state || {
    source,
    connected: Boolean(sample),
    controllerId: sample?.id || "",
    axes: gated?.values || NEUTRAL_MODE2_AXES,
    gateReason: gated?.reason || null,
    deadmanHeld: Boolean(gated?.active),
    stale: Boolean(stale)
  };
  if (!current.connected) {
    return {
      controller: current.source === "keyboard" ? "Keyboard" : "Not detected",
      neutral: "unavailable",
      inputActive: "no",
      deadman: "inactive - source unavailable",
      available: false,
      stale: false
    };
  }
  return {
    controller: current.controllerId || INPUT_SOURCES[current.source] || current.source,
    neutral: isNeutral(Object.values(current.previewAxes || current.axes || {}), []) ? "neutral" : "active",
    inputActive: current.gateReason ? "no" : "yes",
    deadman: current.deadmanHeld ? "held" : `released - ${current.gateReason || "inactive"}`,
    available: true,
    stale: Boolean(current.stale)
  };
}

/**
 * Common, transport-free Keyboard/PS5 input owner.
 *
 * Raw providers stop here. Consumers subscribe to `statechange` and receive
 * calibrated, named Mode 2 axes plus the already-resolved configured
 * dead-man state. Every safety transition publishes zero axes first and also
 * emits a `neutral` event with its reason.
 */
export class GamepadController extends EventTarget {
  constructor({
    win = globalThis.window,
    doc = globalThis.document,
    nav = globalThis.navigator,
    now = () => globalThis.performance?.now?.() ?? Date.now(),
    staleMs = DEFAULT_INPUT_STALE_MS,
    repo,
    browserProvider,
    keyboardProvider,
    mockProvider,
    ps5Provider,
    initialSource = "keyboard",
    mockEnabled
  } = {}) {
    super();
    this.win = win;
    this.doc = doc;
    this.nav = nav;
    this.now = now;
    this.staleMs = staleMs;
    this.desktop = win?.SUISUI_DESKTOP || null;
    this.repo = repo || new CalibrationRepository();

    this.browser = browserProvider || new BrowserGamepadProvider({ win, nav, now });
    this.mock = mockProvider || new MockGamepadProvider({ now });
    this.keyboard = keyboardProvider || new KeyboardProvider({ win, doc });

    const queryUsesMock = (() => {
      try {
        return new URLSearchParams(win?.location?.search || "").get("gamepadMock") === "1";
      } catch {
        return false;
      }
    })();
    // A URL is untrusted input. `?gamepadMock=1` records a request only; the
    // unified panel enables it after the backend itself confirms mock mode.
    // Explicit dependency injection remains available to isolated tests.
    this.mockRequested = mockEnabled ?? queryUsesMock;
    this.mockEnabled = mockEnabled === true;
    this.ps5ProviderInjected = Boolean(ps5Provider);
    this.ps5Provider = ps5Provider || (this.mockEnabled ? this.mock : this.browser);

    this.source = sourceName(initialSource);
    this.provider = this.source === "keyboard" ? this.keyboard : this.ps5Provider;
    this.sample = null;
    this.calibration = null;
    this.stats = [];
    this.step = 0;
    this.connectedAt = null;
    this.lastMeaningful = null;
    this.lastReceivedAt = null;
    this.focused = typeof doc?.hasFocus === "function" ? Boolean(doc.hasFocus()) : true;
    this.visible = !doc?.hidden;
    this.captureEnabled = false;
    this.started = false;
    this.connected = false;
    this.staleLatched = false;
    this.staleTimer = null;
    this.mountRoot = null;
    this.mountContent = null;
    this.calibrationMessage = "";
    this._calibrationToken = 0;
    this._state = this._buildState();
    this._signature = stateSignature(this._state);

    this.onProviderSample = (event) => {
      void this.accept(event.detail);
    };
    this.onProviderConnection = (event) => {
      if (event.detail) {
        this.connected = true;
        this.connectedAt = this.now();
        void this.accept(event.detail);
      } else {
        this._disconnect("controller-disconnected");
      }
    };
    this.onProviderNeutral = (event) => {
      this._publish({ neutralReason: event?.detail?.reason || "neutral", force: true });
    };
    this.onProviderPanic = (event) => {
      this.captureEnabled = false;
      this._publish({ neutralReason: event?.detail?.reason || "escape", force: true });
    };
    this.onProviderCapture = () => this._publish({ force: true });
    this.onFocus = () => {
      this.focused = true;
      this._publish({ force: true });
    };
    this.onBlur = () => {
      this.focused = false;
      this._publish({ neutralReason: "focus-lost", force: true });
    };
    this.onVisibility = () => {
      this.visible = !this.doc?.hidden;
      this._publish({
        neutralReason: this.visible ? null : "tab-hidden",
        force: true
      });
    };
    this.onPageHide = () => {
      this.visible = false;
      this._publish({ neutralReason: "page-hidden", force: true });
    };
  }

  /** Start providers and safety listeners. No DOM is required or changed. */
  start() {
    if (this.started) return;
    this.started = true;
    this.win?.addEventListener?.("focus", this.onFocus);
    this.win?.addEventListener?.("blur", this.onBlur);
    this.win?.addEventListener?.("pagehide", this.onPageHide);
    this.doc?.addEventListener?.("visibilitychange", this.onVisibility);
    this._previousDesktopBlur = this.win?.suisuiDesktopBlur;
    if (this.win) {
      this.win.suisuiDesktopBlur = (...args) => {
        this._previousDesktopBlur?.(...args);
        this.onBlur();
      };
    }
    this._attachProvider();
    this.provider?.start?.();
    const interval = Math.max(25, Math.min(100, Math.floor(this.staleMs / 2) || 25));
    this.staleTimer = setInterval(() => this.checkStale(), interval);
    this.staleTimer?.unref?.();
    this._publish({ force: true });
  }

  /**
   * Async-compatible mount used by PilotPanel. Passing a root opts into the
   * legacy standalone preview; omitting it only starts the input layer.
   */
  async mount(root = null) {
    this.start();
    if (root) {
      this.mountRoot = typeof root === "string" ? this.doc?.querySelector?.(root) : root;
      if (this.mountRoot) {
        this.mountRoot.innerHTML = `
          <div class="gamepad-safety" role="note">Input preview only; this module has no command transport.</div>
          <div id="gpLive" role="status" aria-live="polite" class="sr-only"></div>
          <div id="gpContent"></div>`;
        this.mountContent = this.mountRoot.querySelector?.("#gpContent") || null;
        this.render();
      }
    }
    return true;
  }

  _attachProvider() {
    this.provider?.addEventListener?.("sample", this.onProviderSample);
    this.provider?.addEventListener?.("connection", this.onProviderConnection);
    this.provider?.addEventListener?.("neutral", this.onProviderNeutral);
    this.provider?.addEventListener?.("panic", this.onProviderPanic);
    this.provider?.addEventListener?.("capture", this.onProviderCapture);
  }

  _detachProvider() {
    this.provider?.removeEventListener?.("sample", this.onProviderSample);
    this.provider?.removeEventListener?.("connection", this.onProviderConnection);
    this.provider?.removeEventListener?.("neutral", this.onProviderNeutral);
    this.provider?.removeEventListener?.("panic", this.onProviderPanic);
    this.provider?.removeEventListener?.("capture", this.onProviderCapture);
  }

  /** Switch source and publish an immediate zero before reading the new one. */
  selectSource(name) {
    const next = sourceName(name);
    if (next === this.source) return this.getState();

    const wasStarted = this.started;
    if (wasStarted) {
      this._detachProvider();
      this.provider?.stop?.();
    }
    this.keyboard.stopCapture?.();
    this.source = next;
    this.provider = next === "keyboard" ? this.keyboard : this.ps5Provider;
    this.sample = null;
    this.calibration = null;
    this.stats = [];
    this.step = 0;
    this.connected = false;
    this.lastReceivedAt = null;
    this.staleLatched = false;
    this._calibrationToken += 1;
    this._publish({ neutralReason: "source-switched", force: true });

    if (wasStarted) {
      this._attachProvider();
      this.provider?.start?.();
      if (this.captureEnabled && this.source === "keyboard") this.keyboard.startCapture?.();
    }
    return this.getState();
  }

  /** Compatibility hook: a mock provider still appears as the PS5 option. */
  switchProvider(provider) {
    if (!provider) return this.selectSource("keyboard");
    if (provider === this.keyboard || provider.type === "keyboard") return this.selectSource("keyboard");
    const wasPs5 = this.source === "ps5";
    if (wasPs5 && this.started) {
      this._detachProvider();
      this.provider?.stop?.();
    }
    this.ps5Provider = provider;
    this.provider = provider;
    this.source = "ps5";
    this.sample = null;
    this.calibration = null;
    this.stats = [];
    this.connected = false;
    this._calibrationToken += 1;
    this._publish({ neutralReason: "source-switched", force: true });
    if (this.started) {
      this._attachProvider();
      this.provider?.start?.();
    }
    return this.getState();
  }

  /** Select the simulator only after the authoritative backend reports mock
   * mode. A query parameter alone can never put simulated input on the active
   * provider path of a real vehicle session. */
  setMockAllowed(allowed) {
    if (this.ps5ProviderInjected) return this.getState();
    const nextEnabled = Boolean(allowed && this.mockRequested);
    const nextProvider = nextEnabled ? this.mock : this.browser;
    this.mockEnabled = nextEnabled;
    if (this.ps5Provider === nextProvider) return this.getState();
    if (this.source === "ps5") return this.switchProvider(nextProvider);
    this.ps5Provider = nextProvider;
    this._publish({ force: true });
    return this.getState();
  }

  /** Enable authoritative input after the pilot channel has opened. */
  startCapture() {
    if (this.captureEnabled) return this.getState();
    this.captureEnabled = true;
    if (this.source === "keyboard") this.keyboard.startCapture?.();
    this._publish({ force: true });
    return this.getState();
  }

  /** Stop authoritative input and immediately publish neutral for all sources. */
  stopCapture(reason = "capture-stopped") {
    const wasEnabled = this.captureEnabled;
    this.captureEnabled = false;
    this.keyboard.stopCapture?.();
    if (wasEnabled || !this._state.gateReason) {
      this._publish({ neutralReason: reason, force: true });
    } else {
      this._publish({ force: true });
    }
    return this.getState();
  }

  /** Release synthetic held controls without changing the selected source. */
  zeroInput(reason = "neutral") {
    this.keyboard.reset?.();
    if (this.provider === this.mock) this.mock.reset?.();
    this._publish({ neutralReason: reason, force: true });
  }

  _disconnect(reason) {
    this.connected = false;
    this.sample = null;
    this.lastReceivedAt = null;
    this._publish({ neutralReason: reason, force: true });
  }

  /** Accept a raw sample only from the currently selected provider. */
  async accept(sample) {
    if (!sample || !Array.isArray(sample.axes) || !Array.isArray(sample.buttons)) return this.getState();
    const previous = this._state;
    this.sample = sample;
    this.connected = true;
    this.lastReceivedAt = this.now();
    this.staleLatched = false;
    sample.axes.forEach((value, index) => {
      this.stats[index] = observeAxis(this.stats[index], Number(value) || 0);
    });
    if (sample.axes.some((value) => Math.abs(value) > 0.08) || sample.buttons.some((button) => button.pressed)) {
      this.lastMeaningful = this.now();
    }

    let loadPromise = null;
    if (this.source === "ps5" && this.calibration?.controllerId !== sample.id) {
      this.stats = sample.axes.map((value) => observeAxis(null, Number(value) || 0));
      this.calibration = defaultCalibration({
        id: sample.id,
        mapping: sample.mapping,
        axesCount: sample.axes.length,
        buttonsCount: sample.buttons.length
      });
      const token = ++this._calibrationToken;
      loadPromise = this._loadCalibration(sample.id, token);
    }

    const preview = this._previewAxes();
    const rawDeadmanHeld = this._rawDeadmanHeld();
    const stale = this._isStale();
    let neutralReason = null;
    if (previous?.rawDeadmanHeld && !rawDeadmanHeld) neutralReason = "deadman-released";
    else if (!previous?.stale && stale) neutralReason = "stale-input";
    else if (!isNeutral(Object.values(previous?.axes || {}), []) && isNeutral(Object.values(preview), []) && sample.provider === "keyboard") neutralReason = null;
    this._publish({ neutralReason });
    if (loadPromise) await loadPromise;
    return this.getState();
  }

  async _loadCalibration(controllerId, token) {
    try {
      const saved = await this.repo?.load?.(controllerId);
      if (
        saved
        && token === this._calibrationToken
        && this.source === "ps5"
        && this.sample?.id === controllerId
      ) {
        this.calibration = saved;
        this._publish({ force: true });
      }
    } catch {
      // Storage is optional in restricted/private browser contexts. Remaining
      // incomplete is safer than pretending an unavailable record was valid.
    }
  }

  _previewAxes() {
    if (!this.sample) return cloneAxes();
    return normalizeMode2Axes(
      this.sample,
      this.source === "keyboard" ? null : this.calibration,
      {
        scale: this.source === "keyboard" ? KEYBOARD_DEFLECTION : 1,
        // Each digital direction is independently a quarter-stick. A two-key
        // diagonal therefore remains 0.25/0.25, matching the documented
        // keyboard contract; analogue sticks retain circular clamping.
        clampRadial: this.source !== "keyboard"
      }
    );
  }

  _rawDeadmanHeld() {
    if (!this.sample) return false;
    if (this.source === "keyboard") {
      return typeof this.sample.deadmanHeld === "boolean"
        ? this.sample.deadmanHeld
        : Boolean(this.sample.buttons?.[DEADMAN_BUTTON_INDEX]?.pressed);
    }
    const index = this.calibration?.deadmanButtonIndex;
    return Number.isInteger(index) && Boolean(this.sample.buttons?.[index]?.pressed);
  }

  _isStale() {
    if (!this.connected || !this.sample) return false;
    if (this.staleLatched) return true;
    if (this.sample.stale === true) return true;
    const current = this.now();
    // The browser provider polls current Gamepad API state every animation
    // frame. A controller may legitimately keep the same hardware timestamp
    // while a stick is held steady, so freshness is the age of the received
    // provider sample rather than the age of the last physical value change.
    // The simulator has an explicit stale switch and otherwise stays fresh.
    if (this.sample.provider === "mock") return false;
    if (this.source === "keyboard") {
      // A neutral keyboard has nothing dangerous to cache. Once Shift or a
      // movement key is held, however, repeated keydown events are required
      // as proof that the event stream is alive.
      const activeCachedInput = this._rawDeadmanHeld()
        || !isNeutral(Object.values(this._previewAxes()), []);
      if (!activeCachedInput) return false;
    }
    return current - (this.lastReceivedAt ?? current) > this.staleMs;
  }

  checkStale() {
    const stale = this._isStale();
    if (stale && this.source === "keyboard" && !this.staleLatched) {
      // Expire the provider's cached Set as well as the published axes. A
      // late key-repeat may refresh movement, but cannot resurrect Shift; the
      // operator must deliberately press the dead-man again.
      this.staleLatched = true;
      this.keyboard.reset?.({ emit: false });
      this.sample = this.keyboard.sample?.() || this.sample;
    }
    if (stale !== this._state.stale) {
      this._publish({ neutralReason: stale ? "stale-input" : null, force: true });
    }
    return stale;
  }

  _buildState() {
    const previewAxes = this._previewAxes?.() || cloneAxes();
    const connected = Boolean(this.started && this.connected);
    const calibrated = this.source === "keyboard"
      ? true
      : Boolean(
        this.calibration?.validationState === "valid"
        && validateCalibration(this.calibration).valid
      );
    const stale = this._isStale?.() || false;
    const captureActive = Boolean(
      this.captureEnabled
      && (this.source !== "keyboard" || this.keyboard?.capturing)
    );
    const rawDeadmanHeld = this._rawDeadmanHeld?.() || false;
    const gated = gatePreview(previewAxes, {
      deadman: rawDeadmanHeld,
      connected,
      focused: this.focused,
      visible: this.visible,
      stale,
      calibrated,
      captureActive
    });
    const safeDeadmanHeld = Boolean(rawDeadmanHeld && ![
      "controller-disconnected",
      "focus-lost",
      "tab-hidden",
      "stale-input",
      "calibration-incomplete",
      "capture-inactive"
    ].includes(gated.reason));

    return {
      source: this.source,
      sourceLabel: INPUT_SOURCES[this.source],
      provider: this.sample?.provider || this.provider?.type || this.source,
      controllerId: this.sample?.id || (this.source === "keyboard" ? "Keyboard" : ""),
      connected,
      calibrated,
      stale,
      captureActive,
      focused: Boolean(this.focused),
      visible: Boolean(this.visible),
      deadmanHeld: safeDeadmanHeld,
      rawDeadmanHeld,
      deadmanButtonIndex: this.source === "keyboard"
        ? null
        : (this.calibration?.deadmanButtonIndex ?? null),
      gateReason: gated.reason,
      active: gated.active,
      axes: cloneAxes(gated.values),
      previewAxes: cloneAxes(previewAxes),
      rawSample: this.sample,
      lastInputAt: this.lastReceivedAt,
      lastMeaningfulAt: this.lastMeaningful,
      calibrationStep: this.step,
      calibration: this.source === "keyboard" ? null : this.calibration
    };
  }

  _publish({ neutralReason = null, force = false } = {}) {
    const previous = this._state;
    const next = this._buildState();
    // A neutral notification is an executable safety contract, not merely a
    // label. Its state payload must never contain a still-live stick command.
    if (neutralReason && !isNeutral(Object.values(next.axes), [])) {
      next.axes = cloneAxes();
      next.active = false;
    }
    const signature = stateSignature(next);
    const transitionedToGate = previous && !previous.gateReason && next.gateReason;
    const reason = neutralReason || transitionedToGate || null;
    const changed = force || signature !== this._signature;
    this._state = next;
    this._signature = signature;

    if (changed) {
      const detail = this.getState();
      this.dispatchEvent(new CustomEvent("statechange", { detail }));
      // Alias for consumers that prefer an explicitly provider-oriented name.
      this.dispatchEvent(new CustomEvent("inputstate", { detail }));
      this.render();
    }
    if (reason) {
      this.dispatchEvent(new CustomEvent("neutral", {
        detail: { ...this.getState(), reason, neutralReason: reason }
      }));
    }
    return next;
  }

  getState() {
    const state = this._state || this._buildState();
    return {
      ...state,
      axes: cloneAxes(state.axes),
      previewAxes: cloneAxes(state.previewAxes),
      rawSample: state.rawSample
        ? {
          ...state.rawSample,
          axes: [...state.rawSample.axes],
          buttons: state.rawSample.buttons.map((button) => ({ ...button }))
        }
        : null,
      calibration: state.calibration
        ? {
          ...state.calibration,
          axisAssignments: [...(state.calibration.axisAssignments || DEFAULT_AXIS_ASSIGNMENTS)],
          axisCenters: [...(state.calibration.axisCenters || [])],
          axisMinimums: [...(state.calibration.axisMinimums || [])],
          axisMaximums: [...(state.calibration.axisMaximums || [])],
          axisInversions: [...(state.calibration.axisInversions || [])],
          deadzones: [...(state.calibration.deadzones || [])],
          expoValues: [...(state.calibration.expoValues || [])]
        }
        : null
    };
  }

  setCalibration(calibration, { persist = false } = {}) {
    if (this.source !== "ps5" || !calibration) return false;
    this.calibration = {
      ...calibration,
      axisAssignments: [...(calibration.axisAssignments || DEFAULT_AXIS_ASSIGNMENTS)]
    };
    const checked = validateCalibration(this.calibration);
    if (!checked.valid) {
      this.calibrationMessage = checked.errors.join("; ");
      this._publish({ force: true });
      return false;
    }
    this.calibrationMessage = "";
    if (persist) void this.repo?.save?.(this.calibration);
    this._publish({ force: true });
    return true;
  }

  setDeadmanButtonIndex(index) {
    if (!this.calibration) return false;
    const numeric = Number(index);
    if (!Number.isInteger(numeric) || numeric < 0 || numeric >= this.calibration.buttonsCount) return false;
    const wasHeld = this._rawDeadmanHeld();
    this.calibration.deadmanButtonIndex = numeric;
    this.calibration.validationState = "incomplete";
    const nowHeld = this._rawDeadmanHeld();
    this._publish({
      neutralReason: wasHeld && !nowHeld ? "deadman-reconfigured" : null,
      force: true
    });
    return true;
  }

  setAxisAssignment(semanticName, rawIndex) {
    const semanticIndex = MODE2_AXIS_NAMES.indexOf(semanticName);
    const numeric = Number(rawIndex);
    if (
      !this.calibration
      || semanticIndex < 0
      || !Number.isInteger(numeric)
      || numeric < 0
      || numeric >= this.calibration.axesCount
    ) return false;
    this.calibration.axisAssignments[semanticIndex] = numeric;
    this.calibration.validationState = "incomplete";
    this._publish({ neutralReason: "axis-mapping-changed", force: true });
    return true;
  }

  setAxisInversion(rawIndex, inverted) {
    const numeric = Number(rawIndex);
    if (!this.calibration || !Number.isInteger(numeric) || numeric < 0 || numeric >= this.calibration.axesCount) return false;
    this.calibration.axisInversions[numeric] = Boolean(inverted);
    this.calibration.validationState = "incomplete";
    this._publish({ neutralReason: "axis-mapping-changed", force: true });
    return true;
  }

  async saveCalibration() {
    if (!this.calibration || !this.sample) return false;
    this.calibration.axisMinimums = this.stats.map((stats, index) => stats?.min ?? this.calibration.axisMinimums[index]);
    this.calibration.axisMaximums = this.stats.map((stats, index) => stats?.max ?? this.calibration.axisMaximums[index]);
    this.calibration.validationState = "valid";
    const checked = validateCalibration(this.calibration);
    if (!checked.valid) {
      this.calibration.validationState = "incomplete";
      this.calibrationMessage = checked.errors.join("; ");
      this._publish({ force: true });
      return false;
    }
    this.calibration = await this.repo.save(this.calibration);
    this.calibrationMessage = "Calibration saved";
    this._publish({ force: true });
    return true;
  }

  async deleteCalibration() {
    if (!this.sample) return false;
    await this.repo?.delete?.(this.sample.id);
    this.calibration = defaultCalibration({
      id: this.sample.id,
      mapping: this.sample.mapping,
      axesCount: this.sample.axes.length,
      buttonsCount: this.sample.buttons.length
    });
    this.step = 0;
    this.calibrationMessage = "Calibration removed";
    this._publish({ neutralReason: "calibration-removed", force: true });
    return true;
  }

  nextCalibrationStep() {
    if (!this.sample || !this.calibration) return;
    this.calibration.validationState = "incomplete";
    if (this.step === 0) this.calibration.axisCenters = [...this.sample.axes];
    this.step = Math.min(CALIBRATION_STEPS.length - 1, this.step + 1);
    this._publish({ force: true });
  }

  renderHtml() {
    const state = this.getState();
    const info = inputStatusModel({ state });
    const gateText = state.gateReason || "ready";
    const sourceOptions = Object.entries(INPUT_SOURCES)
      .map(([value, label]) => `<option value="${value}" ${state.source === value ? "selected" : ""}>${label}</option>`)
      .join("");
    const sourceStatus = state.connected
      ? escapeHtml(state.controllerId || state.sourceLabel)
      : state.source === "keyboard" ? "Keyboard ready" : "PS5 controller not detected";

    const keyboard = state.source === "keyboard" ? `
      <div class="gp-keyboard gp-keyboard-preview">
        <button id="gpKeyCapture" type="button" class="panel-button ${state.captureActive ? "" : "primary"}" data-input-capture>
          ${state.captureActive ? "Stop keyboard preview" : "Preview keyboard input"}
        </button>
        <span class="meta">Opt-in only; keys are ignored until preview or Bench Pilot is enabled.</span>
      </div>
      <p class="manual-input-calibration-note">Calibration: not required</p>` : "";

    const calibration = state.source === "ps5" ? this._renderCalibrationHtml(state) : "";
    const diagnostics = state.source === "ps5" ? this._renderRawHtml(state) : "";
    const simulator = state.source === "ps5" && this.ps5Provider === this.mock
      ? this._renderSimulatorHtml()
      : "";

    return `
      <div class="manual-input-controller" data-manual-input-controller>
        ${this.desktop ? `<p class="gp-desktop-badge">デスクトップ版 / Desktop — ${escapeHtml(this.desktop.modeLabel || this.desktop.mode || "Unknown")} mode${this.desktop.development ? " [DEV]" : ""}</p>` : ""}
        <div class="input-row manual-input-source-row">
          <label for="gpSource">Input source</label>
          <select id="gpSource" data-input-source>${sourceOptions}</select>
          <strong class="drone-chip" data-tone="${state.connected ? "ok" : "idle"}" data-input-connection>${sourceStatus}</strong>
          ${state.source === "ps5" && likelyDualSense(state.controllerId) ? '<span class="gp-badge">DualSense / PS5</span>' : ""}
          ${state.provider === "mock" ? '<span class="gp-sim">SIMULATION</span>' : ""}
        </div>
        <div class="manual-input-status" role="status" aria-live="polite">
          <span>Dead-man <strong data-input-deadman>${state.deadmanHeld ? "HELD" : "RELEASED"}</strong></span>
          <span>Input <strong>${info.neutral}</strong></span>
          <span>Gate <strong class="gp-gate ${state.active ? "active" : ""}">${escapeHtml(gateText)}</strong></span>
        </div>
        ${keyboard}
        ${calibration}
        ${diagnostics}
        ${simulator}
      </div>`;
  }

  _renderCalibrationHtml(state) {
    const calibration = this.calibration;
    const axisCount = this.sample?.axes.length || calibration?.axesCount || 4;
    const assignmentRows = MODE2_AXIS_NAMES.map((name, semanticIndex) => {
      const selected = calibration?.axisAssignments?.[semanticIndex] ?? semanticIndex;
      const options = Array.from({ length: axisCount }, (_, rawIndex) => (
        `<option value="${rawIndex}" ${selected === rawIndex ? "selected" : ""}>Raw axis ${rawIndex}</option>`
      )).join("");
      return `<label>${name}<select data-axis-assignment="${name}">${options}</select></label>`;
    }).join("");
    const inversionRows = Array.from({ length: axisCount }, (_, rawIndex) => `
      <label><input type="checkbox" data-axis-inversion="${rawIndex}" ${calibration?.axisInversions?.[rawIndex] ? "checked" : ""}> Invert raw axis ${rawIndex}</label>`).join("");
    const buttonCount = this.sample?.buttons.length || calibration?.buttonsCount || 18;
    const buttonOptions = Array.from({ length: buttonCount }, (_, index) => (
      `<option value="${index}" ${calibration?.deadmanButtonIndex === index ? "selected" : ""}>${escapeHtml(BUTTON_NAMES[index] || `Button ${index}`)}</option>`
    )).join("");

    return `
      <details class="pilot-disclosure gp-calibration" data-input-calibration>
        <summary>Advanced / Calibration <span>${state.calibrated ? "valid" : "required"}</span></summary>
        <p>Step ${this.step + 1}/${CALIBRATION_STEPS.length}: ${escapeHtml(CALIBRATION_STEPS[this.step])}</p>
        <div class="gp-calibration-grid">${assignmentRows}</div>
        <div class="gp-calibration-grid">${inversionRows}</div>
        <label>Dead-man button <select id="gpDeadman" data-deadman-button>${buttonOptions}</select></label>
        <div class="gp-actions">
          <button type="button" data-calibration-next ${this.sample ? "" : "disabled"}>Next</button>
          <button type="button" data-calibration-save ${this.step < CALIBRATION_STEPS.length - 1 || !this.sample ? "disabled" : ""}>Save</button>
          <button type="button" data-calibration-delete ${this.sample ? "" : "disabled"}>Delete</button>
        </div>
        <p class="meta" data-calibration-message>${escapeHtml(this.calibrationMessage)}</p>
      </details>`;
  }

  _renderRawHtml(state) {
    const rows = (state.rawSample?.axes || []).map((value, index) => `
      <tr>
        <td>${index}</td>
        <td>${Number(value).toFixed(3)}</td>
        <td>${Number(this.stats[index]?.min ?? value).toFixed(3)}</td>
        <td>${Number(this.calibration?.axisCenters?.[index] ?? 0).toFixed(3)}</td>
        <td>${Number(this.stats[index]?.max ?? value).toFixed(3)}</td>
      </tr>`).join("");
    const buttons = (state.rawSample?.buttons || []).map((button, index) => (
      `<span>${escapeHtml(BUTTON_NAMES[index] || index)}: ${button.pressed ? "pressed" : "released"} (${Number(button.value).toFixed(2)})</span>`
    )).join("");
    return `
      <details class="pilot-disclosure gp-raw" data-input-raw>
        <summary>Raw input diagnostics</summary>
        <div class="gp-table-wrap">
          <table><thead><tr><th>Axis</th><th>Raw</th><th>Min</th><th>Centre</th><th>Max</th></tr></thead><tbody>${rows}</tbody></table>
        </div>
        <div class="gp-buttons">${buttons}</div>
      </details>`;
  }

  _renderSimulatorHtml() {
    return `
      <details class="pilot-disclosure" data-input-simulator>
        <summary><span class="gp-sim">SIMULATION</span> PS5 controller</summary>
        <div class="gp-actions">
          <button type="button" data-mock-connect>Connect</button>
          <button type="button" data-mock-disconnect>Disconnect</button>
          <button type="button" data-mock-reset>Neutral</button>
        </div>
        ${["Left X", "Left Y", "Right X", "Right Y"].map((name, index) => `
          <label>${name}<input data-mock-axis="${index}" type="range" min="-1" max="1" step=".01" value="${this.mock.axes[index]}"></label>`).join("")}
        <div class="gp-buttons">
          ${[4, 5, 0, 1, 2, 3].map((index) => `<button type="button" data-mock-button="${index}">${escapeHtml(BUTTON_NAMES[index])}</button>`).join("")}
        </div>
        <label><input type="checkbox" data-mock-stale ${this.mock.stale ? "checked" : ""}> Stale input</label>
      </details>`;
  }

  /** Bind controls in an embedded fragment. The caller owns re-rendering. */
  bind(root) {
    if (!root?.querySelector) return;
    const query = (selector) => root.querySelector(selector);
    query("[data-input-source]")?.addEventListener("change", (event) => {
      this.selectSource(event.target.value);
    });
    query("[data-input-capture]")?.addEventListener("click", () => {
      if (this.captureEnabled) this.stopCapture("preview-stopped");
      else this.startCapture();
    });
    query("[data-deadman-button]")?.addEventListener("change", (event) => {
      this.setDeadmanButtonIndex(Number(event.target.value));
    });
    root.querySelectorAll?.("[data-axis-assignment]").forEach((element) => {
      element.addEventListener("change", (event) => {
        this.setAxisAssignment(event.target.dataset.axisAssignment, Number(event.target.value));
      });
    });
    root.querySelectorAll?.("[data-axis-inversion]").forEach((element) => {
      element.addEventListener("change", (event) => {
        this.setAxisInversion(Number(event.target.dataset.axisInversion), event.target.checked);
      });
    });
    query("[data-calibration-next]")?.addEventListener("click", () => this.nextCalibrationStep());
    query("[data-calibration-save]")?.addEventListener("click", () => { void this.saveCalibration(); });
    query("[data-calibration-delete]")?.addEventListener("click", () => { void this.deleteCalibration(); });
    query("[data-mock-connect]")?.addEventListener("click", () => this.mock.connect());
    query("[data-mock-disconnect]")?.addEventListener("click", () => this.mock.disconnect());
    query("[data-mock-reset]")?.addEventListener("click", () => this.mock.reset());
    root.querySelectorAll?.("[data-mock-axis]").forEach((element) => {
      element.addEventListener("input", (event) => {
        this.mock.setAxis(Number(event.target.dataset.mockAxis), Number(event.target.value));
      });
    });
    root.querySelectorAll?.("[data-mock-button]").forEach((element) => {
      const index = Number(element.dataset.mockButton);
      element.addEventListener("pointerdown", () => this.mock.setButton(index, 1));
      element.addEventListener("pointerup", () => this.mock.setButton(index, 0));
      element.addEventListener("pointercancel", () => this.mock.setButton(index, 0));
      element.addEventListener("pointerleave", () => this.mock.setButton(index, 0));
    });
    query("[data-mock-stale]")?.addEventListener("change", (event) => {
      this.mock.setStale(event.target.checked);
    });
  }

  /** Update only a root explicitly passed to mount(root). */
  render() {
    if (!this.mountContent) return;
    this.mountContent.innerHTML = this.renderHtml();
    this.bind(this.mountContent);
    const live = this.mountRoot?.querySelector?.("#gpLive");
    if (live) live.textContent = `${this._state.sourceLabel}; ${this._state.gateReason || "ready"}`;
  }

  destroy() {
    this.stopCapture("destroyed");
    if (this.started) {
      this._detachProvider();
      this.provider?.stop?.();
      this.win?.removeEventListener?.("focus", this.onFocus);
      this.win?.removeEventListener?.("blur", this.onBlur);
      this.win?.removeEventListener?.("pagehide", this.onPageHide);
      this.doc?.removeEventListener?.("visibilitychange", this.onVisibility);
      if (this.win?.suisuiDesktopBlur) this.win.suisuiDesktopBlur = this._previousDesktopBlur;
    }
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.staleTimer = null;
    this.started = false;
    this.connected = false;
    this.sample = null;
    this._publish({ neutralReason: "destroyed", force: true });
    this.mountRoot = null;
    this.mountContent = null;
  }
}
