// QZ1LE over Web Bluetooth -- transport only.
//
// Responsibilities of this module, and only these:
//   - browser capability detection (Web Bluetooth present? secure context?)
//   - user-initiated device selection (navigator.bluetooth.requestDevice)
//   - GATT connect/disconnect lifecycle, including the unsolicited
//     "gattserverdisconnected" event a real device fires on power-off / out
//     of range
//   - decoding incoming notification bytes and splitting them into complete
//     NMEA lines, tolerating a line split across two notifications
//   - reporting state changes, errors and complete raw lines to the caller
//
// What this module deliberately does NOT do: parse NMEA sentences, know
// about GGA/RMC/fix quality, touch the DOM, or touch map/recording state.
// A complete raw line is handed to `onLine`, and the caller (index.html)
// feeds it into the exact same handleSerialLine() pipeline the existing
// Web Serial (QZ1 USB / Bluetooth Classic SPP) transport already uses --
// there is intentionally no second NMEA parser here.
//
// The GATT service/characteristic UUIDs are never hard-coded in this file.
// They come from config/qz1le-ble-profile.js (via qz1le-ble-config.js)
// because the real QZ1LE profile has not been confirmed against hardware --
// see the large comment in config/qz1le-ble-profile.js. connect() refuses
// outright, with a clear reason, when the profile is not configured; it
// never falls back to a guessed UUID.

/** Thrown for every connect()/disconnect() failure this module recognizes, with a stable `reason`. */
export class Qz1LeBluetoothError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "Qz1LeBluetoothError";
    this.reason = reason;
  }
}

// Mirrors index.html's SERIAL_READ_BUFFER_LIMIT: a bound on how much
// unterminated data can accumulate before something is very wrong (wrong
// characteristic, binary data, a device that never sends a line ending).
export const QZ1LE_LINE_BUFFER_LIMIT = 8192;

/**
 * Decodes BLE notification payloads and splits them into complete NMEA
 * lines, buffering a trailing partial line across calls. Pure, DOM-free,
 * and independent of any real BluetoothRemoteGATTCharacteristic -- feed it
 * a DataView/ArrayBuffer/typed array (what a real `characteristicvaluechanged`
 * event carries) or a plain string (convenient for tests).
 */
export class NmeaLineSplitter {
  constructor({ bufferLimit = QZ1LE_LINE_BUFFER_LIMIT } = {}) {
    this.decoder = new TextDecoder("utf-8");
    this.buffer = "";
    this.bufferLimit = bufferLimit;
  }

  /**
   * @param chunk DataView | ArrayBuffer | TypedArray | string
   * @returns {{ lines: string[], overflowed: boolean }} `lines` are the raw
   *   split segments (untrimmed, may include empty strings for blank lines)
   *   found in `chunk` plus anything buffered from a prior call -- exactly
   *   what `buffer.split(/\r\n|\r|\n/)` would yield, so the shared
   *   handleSerialLine() pipeline (which already trims and drops blanks)
   *   needs no special-casing for this transport. `overflowed` is true only
   *   for the push that tripped the buffer limit (not sticky).
   */
  push(chunk) {
    const text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    this.buffer += text;
    const parts = this.buffer.split(/\r\n|\r|\n/);
    this.buffer = parts.pop() ?? "";
    let overflowed = false;
    if (this.buffer.length > this.bufferLimit) {
      overflowed = true;
      this.buffer = this.buffer.slice(-256);
    }
    return { lines: parts, overflowed };
  }

  /** Discards any incomplete trailing line and resets decoder state. Call on disconnect -- an unterminated fragment is never treated as a complete sentence. */
  reset() {
    this.buffer = "";
    this.decoder = new TextDecoder("utf-8");
  }
}

/** True when this environment can even attempt Web Bluetooth, before touching any specific device. */
export function isWebBluetoothSupported({
  bluetooth = typeof navigator !== "undefined" ? navigator.bluetooth : undefined,
  isSecureContext = typeof window !== "undefined" ? window.isSecureContext : true
} = {}) {
  return Boolean(bluetooth) && isSecureContext !== false;
}

const ACTIVE_STATES = new Set(["connecting", "connected"]);

/**
 * GATT connect/disconnect lifecycle for one QZ1LE. Every browser API is
 * received via the constructor (defaulting to the real `navigator.bluetooth`)
 * so tests can supply a fake device with no physical hardware and no real
 * browser -- see tests/unit/qz1le-bluetooth.test.js.
 */
export class Qz1LeBluetoothTransport {
  constructor({
    bluetooth = typeof navigator !== "undefined" ? navigator.bluetooth : undefined,
    isSecureContext = typeof window !== "undefined" ? window.isSecureContext : true,
    profile,
    onLine = () => {},
    onStateChange = () => {},
    onError = () => {}
  } = {}) {
    this.bluetooth = bluetooth || null;
    this.isSecureContext = isSecureContext;
    this.profile = profile || null;
    this.onLine = onLine;
    this.onStateChange = onStateChange;
    this.onError = onError;

    this.device = null;
    this.characteristic = null;
    this.splitter = new NmeaLineSplitter();
    this.state = "idle";

    this._handleValueChanged = this._handleValueChanged.bind(this);
    this._handleGattDisconnected = this._handleGattDisconnected.bind(this);
  }

  isBrowserSupported() {
    return isWebBluetoothSupported({ bluetooth: this.bluetooth, isSecureContext: this.isSecureContext });
  }

  isProfileConfigured() {
    return Boolean(this.profile?.configured);
  }

  _setState(state) {
    this.state = state;
    this.onStateChange(state);
  }

  /**
   * Opens the device picker and connects. Rejects with a Qz1LeBluetoothError
   * (never a guessed-UUID connection) when the browser lacks Web Bluetooth,
   * the page is not a secure context, or the BLE profile has not been
   * identified yet -- these three checks happen before requestDevice() is
   * ever called, so an unconfigured profile never opens a device picker
   * that could not possibly find the right service anyway.
   */
  async connect() {
    if (!this.isBrowserSupported()) {
      this._setState("unsupported");
      const error = new Qz1LeBluetoothError("unsupported", "このブラウザは Web Bluetooth 非対応です。デスクトップ版の Chrome / Edge、または Android 版 Chrome をご利用ください。");
      this.onError(error);
      throw error;
    }
    if (!this.isProfileConfigured()) {
      this._setState("not-configured");
      const error = new Qz1LeBluetoothError("not-configured", "QZ1LEのBluetooth LEプロファイル（GATTサービス/通知キャラクタリスティック）がまだ特定されていません。config/qz1le-ble-profile.js の設定が必要です。");
      this.onError(error);
      throw error;
    }

    this._setState("requesting");
    const filter = { services: [this.profile.serviceUuid] };
    if (this.profile.deviceNamePrefix) {
      filter.namePrefix = this.profile.deviceNamePrefix;
    }
    let device;
    try {
      device = await this.bluetooth.requestDevice({
        filters: [filter],
        optionalServices: [this.profile.serviceUuid]
      });
    } catch (error) {
      this._setState("error");
      this.onError(error);
      throw error;
    }
    return this._connectToDevice(device);
  }

  async _connectToDevice(device) {
    this.device = device;
    this.device.addEventListener?.("gattserverdisconnected", this._handleGattDisconnected);
    this._setState("connecting");
    try {
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(this.profile.serviceUuid);
      const characteristic = await service.getCharacteristic(this.profile.notifyCharacteristicUuid);
      await characteristic.startNotifications();
      characteristic.addEventListener("characteristicvaluechanged", this._handleValueChanged);
      this.characteristic = characteristic;
      this.splitter = new NmeaLineSplitter();
      this._setState("connected");
      return device;
    } catch (error) {
      this._setState("error");
      this.onError(error);
      try {
        device.removeEventListener?.("gattserverdisconnected", this._handleGattDisconnected);
      } catch {}
      try {
        device.gatt?.disconnect();
      } catch {}
      this.device = null;
      throw error;
    }
  }

  _handleValueChanged(event) {
    const { lines, overflowed } = this.splitter.push(event.target.value);
    if (overflowed) {
      this.onError(new Qz1LeBluetoothError("buffer-overflow", "改行のないデータを受信しています。プロファイル設定（通知キャラクタリスティック）を確認してください。"));
    }
    for (const line of lines) {
      this.onLine(line);
    }
  }

  /** Handles the device disconnecting on its own (power off, out of range) -- distinct from a user-initiated disconnect(). */
  _handleGattDisconnected() {
    if (!ACTIVE_STATES.has(this.state)) {
      return; // a stale listener from an already-cleaned-up device
    }
    this._teardown().finally(() => this._setState("disconnected"));
  }

  /** User-initiated, clean cancellation. Safe to call at any time, including mid-connect. */
  async disconnect() {
    if (this.state === "idle" || this.state === "disconnected") {
      return;
    }
    this._setState("disconnecting");
    await this._teardown();
    this._setState("disconnected");
  }

  async _teardown() {
    try {
      this.characteristic?.removeEventListener("characteristicvaluechanged", this._handleValueChanged);
      await this.characteristic?.stopNotifications?.();
    } catch {}
    try {
      this.device?.removeEventListener?.("gattserverdisconnected", this._handleGattDisconnected);
      if (this.device?.gatt?.connected) {
        this.device.gatt.disconnect();
      }
    } catch {}
    this.characteristic = null;
    this.device = null;
    this.splitter.reset();
  }
}
