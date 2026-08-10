import { GamepadProvider } from "./gamepad-provider.js";

/** Thin, transport-free adapter around the browser Gamepad API. */
export class BrowserGamepadProvider extends GamepadProvider {
  constructor({
    win = globalThis.window,
    nav = globalThis.navigator,
    now = () => globalThis.performance?.now?.() ?? Date.now()
  } = {}) {
    super("browser");
    this.win = win;
    this.nav = nav;
    this.now = now;
    this.index = null;
    this.frame = null;
    this.running = false;
    this.connected = false;

    this.onConnect = (event) => {
      this.index = event.gamepad.index;
      this.connected = true;
      this.emit("connection", this.sample());
    };
    this.onDisconnect = (event) => {
      if (event.gamepad.index !== this.index) return;
      this.index = null;
      this.connected = false;
      this.emit("connection", null);
    };
    this.poll = this.poll.bind(this);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.win?.addEventListener?.("gamepadconnected", this.onConnect);
    this.win?.addEventListener?.("gamepaddisconnected", this.onDisconnect);
    const existing = this.sample();
    if (existing) {
      this.connected = true;
      this.emit("connection", existing);
    }
    this.poll();
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.win?.removeEventListener?.("gamepadconnected", this.onConnect);
    this.win?.removeEventListener?.("gamepaddisconnected", this.onDisconnect);
    if (this.frame != null) this.win?.cancelAnimationFrame?.(this.frame);
    this.frame = null;
  }

  sample() {
    const pads = Array.from(this.nav?.getGamepads?.() || []).filter(Boolean);
    const gamepad = this.index == null
      ? pads[0]
      : pads.find((candidate) => candidate.index === this.index);
    if (!gamepad) return null;
    this.index = gamepad.index;
    return {
      provider: "browser",
      id: gamepad.id,
      mapping: gamepad.mapping,
      axes: [...gamepad.axes],
      buttons: [...gamepad.buttons].map((button) => ({
        pressed: Boolean(button.pressed),
        touched: Boolean(button.touched),
        value: Number(button.value) || 0
      })),
      timestamp: Number.isFinite(gamepad.timestamp) ? gamepad.timestamp : this.now()
    };
  }

  poll() {
    if (!this.running) return;
    const sample = this.sample();
    if (sample) {
      if (!this.connected) {
        this.connected = true;
        this.emit("connection", sample);
      } else {
        this.emit("sample", sample);
      }
    } else if (this.connected) {
      // Fail closed even if the browser omitted gamepaddisconnected.
      this.connected = false;
      this.index = null;
      this.emit("connection", null);
    }
    this.frame = this.win?.requestAnimationFrame?.(this.poll) ?? null;
  }
}
