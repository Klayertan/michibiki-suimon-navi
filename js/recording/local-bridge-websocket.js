// Local Android RFCOMM bridge transport. Messages are line text or JSON status frames.
export class LocalBridgeWebSocketTransport {
  constructor({ WebSocketImpl = globalThis.WebSocket, url = "ws://127.0.0.1:8765", reconnectMinMs = 500, reconnectMaxMs = 8000, onLine = () => {}, onStateChange = () => {}, onError = () => {}, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
    this.WebSocketImpl = WebSocketImpl;
    this.url = url;
    this.reconnectMinMs = reconnectMinMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.onLine = onLine;
    this.onStateChange = onStateChange;
    this.onError = onError;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.socket = null;
    this.buffer = "";
    this.retryDelay = reconnectMinMs;
    this.retryTimer = null;
    this.intentionalClose = false;
    this.state = "idle";
  }

  _state(state, detail = {}) {
    this.state = state;
    this.onStateChange(state, detail);
  }

  connect() {
    if (!this.WebSocketImpl) {
      const error = new Error("このブラウザではWebSocketを利用できません。");
      this.onError(error);
      this._state("unsupported");
      return;
    }
    this.intentionalClose = false;
    this._open();
  }

  _open() {
    this._state("connecting");
    let socket;
    try {
      try { socket = new this.WebSocketImpl(this.url, { targetAddressSpace: "loopback" }); }
      catch { socket = new this.WebSocketImpl(this.url); }
    }
    catch (error) { this.onError(error); this._state("bridge-not-running"); this._scheduleReconnect(); return; }
    this.socket = socket;
    socket.onopen = () => { this.retryDelay = this.reconnectMinMs; this.buffer = ""; this._state("bridge-connected"); };
    socket.onmessage = (event) => this._handleMessage(event.data);
    socket.onerror = (event) => { this.onError(event instanceof Error ? event : new Error("Local bridge WebSocket error")); };
    socket.onclose = () => {
      this.socket = null;
      this.buffer = "";
      if (!this.intentionalClose) { this._state("bridge-not-running"); this._scheduleReconnect(); }
      else this._state("disconnected");
    };
  }

  _handleMessage(data) {
    const text = typeof data === "string" ? data : "";
    if (text.startsWith("{")) {
      try {
        const status = JSON.parse(text);
        if (status.type === "status") {
          this._state(status.state === "connected" ? "qz1-connected" : "qz1-disconnected", status);
          return;
        }
      } catch {}
    }
    this.buffer += text;
    const lines = this.buffer.split(/\r\n|\r|\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) this.onLine(line);
  }

  _scheduleReconnect() {
    if (this.intentionalClose || this.retryTimer !== null) return;
    const wait = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, this.reconnectMaxMs);
    this.retryTimer = this.setTimeoutImpl(() => { this.retryTimer = null; if (!this.intentionalClose) this._open(); }, wait);
  }

  disconnect() {
    this.intentionalClose = true;
    if (this.retryTimer !== null) this.clearTimeoutImpl(this.retryTimer);
    this.retryTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < 2) socket.close();
    else this._state("disconnected");
  }
}
