// Observable state for the drone panel.
//
// Follows the same shape as the other stores in this app: extends EventTarget,
// mutating methods emit a "change" event, and the view re-renders from a single
// getState() snapshot rather than from event payloads.
//
// The store holds only what the UI needs. It never derives safety decisions of
// its own: `armed`, `commandable` and `connectionState` all come from the
// backend, which is the component that can actually see the vehicle.

const MAX_MESSAGES = 30;

export class DroneStore extends EventTarget {
  constructor() {
    super();
    this.backendReachable = null; // null = not checked yet
    this.telemetry = null;
    this.config = null;
    this.socketOpen = false;
    this.busy = false;
    this.lastCommand = null; // { ok, reason, message, at }
    this.messages = [];
    this.lastUpdatedAt = null;
  }

  setBackendReachable(reachable) {
    this.backendReachable = reachable;
    this.emitChange();
  }

  setConfig(config) {
    this.config = config;
    this.emitChange();
  }

  setTelemetry(telemetry) {
    this.telemetry = telemetry;
    this.lastUpdatedAt = Date.now();
    this.mergeStatusTexts(telemetry?.statusTexts || []);
    this.emitChange();
  }

  setSocketOpen(open) {
    this.socketOpen = open;
    this.emitChange();
  }

  setBusy(busy) {
    this.busy = busy;
    this.emitChange();
  }

  setCommandResult({ ok, reason, message }) {
    this.lastCommand = { ok, reason, message, at: Date.now() };
    this.emitChange();
  }

  clearCommandResult() {
    this.lastCommand = null;
    this.emitChange();
  }

  /**
   * Keep a de-duplicated, newest-first list of STATUSTEXT entries.
   * The backend already bounds its own ring buffer; this bounds the UI copy so
   * a long session cannot grow the DOM without limit.
   */
  mergeStatusTexts(entries) {
    if (!entries.length) return;
    const known = new Set(this.messages.map((entry) => `${entry.receivedAt}|${entry.text}`));
    const additions = entries
      .filter((entry) => !known.has(`${entry.receivedAt}|${entry.text}`))
      .map((entry) => ({ ...entry }));
    if (!additions.length) return;
    this.messages = [...additions.reverse(), ...this.messages].slice(0, MAX_MESSAGES);
  }

  clearVehicleState() {
    this.telemetry = null;
    this.messages = [];
    this.emitChange();
  }

  /** Everything the view needs, in one object. */
  getState() {
    const telemetry = this.telemetry;
    return {
      backendReachable: this.backendReachable,
      socketOpen: this.socketOpen,
      busy: this.busy,
      lastCommand: this.lastCommand,
      config: this.config,
      telemetry,
      messages: this.messages,
      lastUpdatedAt: this.lastUpdatedAt,
      connectionState: telemetry?.connectionState || "disconnected",
      armed: telemetry?.vehicle?.armed ?? null,
      // Mode controls require all three: a live backend, a commandable link,
      // and commands enabled in the backend configuration.
      canCommand: Boolean(
        this.backendReachable && telemetry?.commandable && telemetry?.allowSafeCommands
      )
    };
  }

  emitChange() {
    this.dispatchEvent(new Event("change"));
  }
}
