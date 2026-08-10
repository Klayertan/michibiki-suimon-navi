import { GamepadProvider } from "./gamepad-provider.js";

/** Development/test provider that deliberately presents itself as a PS5 pad. */
export class MockGamepadProvider extends GamepadProvider {
  constructor({
    now = () => globalThis.performance?.now?.() ?? Date.now(),
    random = Math.random,
    id = "Simulated DualSense Controller"
  } = {}) {
    super("mock");
    this.now = now;
    this.random = random;
    this.id = id;
    this.connected = false;
    this.axes = [0, 0, 0, 0];
    this.buttons = Array.from({ length: 18 }, () => ({ pressed: false, touched: false, value: 0 }));
    this.drift = 0;
    this.noise = 0;
    this.stale = false;
  }

  start() {
    if (this.connected) this.emit("connection", this.sample());
  }

  stop() {}

  connect() {
    if (this.connected) return;
    this.connected = true;
    this.emit("connection", this.sample());
  }

  disconnect() {
    if (!this.connected) return;
    this.connected = false;
    this.axes.fill(0);
    this.buttons = this.buttons.map(() => ({ pressed: false, touched: false, value: 0 }));
    this.emit("connection", null);
  }

  reset() {
    this.axes.fill(0);
    this.buttons = this.buttons.map(() => ({ pressed: false, touched: false, value: 0 }));
    if (this.connected) this.emit("sample", this.sample());
  }

  setAxis(index, value) {
    if (!Number.isInteger(index) || index < 0 || index >= this.axes.length) return;
    this.axes[index] = Math.max(-1, Math.min(1, Number(value) || 0));
    if (this.connected) this.emit("sample", this.sample());
  }

  setButton(index, value) {
    if (!Number.isInteger(index) || index < 0 || index >= this.buttons.length) return;
    const numeric = Math.max(0, Math.min(1, Number(value) || 0));
    this.buttons[index] = {
      pressed: numeric > 0.5,
      touched: numeric > 0,
      value: numeric
    };
    if (this.connected) this.emit("sample", this.sample());
  }

  setStale(stale) {
    this.stale = Boolean(stale);
    if (this.connected) this.emit("sample", this.sample());
  }

  sample() {
    if (!this.connected) return null;
    return {
      provider: "mock",
      id: this.id,
      mapping: "standard",
      axes: this.axes.map((value) => Math.max(
        -1,
        Math.min(1, value + this.drift + (this.random() * 2 - 1) * this.noise)
      )),
      buttons: this.buttons.map((button) => ({ ...button })),
      stale: this.stale,
      timestamp: this.stale ? 0 : this.now()
    };
  }
}
