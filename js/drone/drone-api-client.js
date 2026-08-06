// HTTP + WebSocket client for the local MAVLink backend.
//
// The browser never touches the serial port. Every drone interaction goes
// through this client to http://127.0.0.1:8787, which is the only process that
// owns COM10.
//
// This module knows nothing about the DOM or about display formatting; it
// returns plain data and throws DroneApiError on failure so the controller can
// decide what the operator sees.

export const DEFAULT_BASE_URL = "http://127.0.0.1:8787";

/** A backend rejection or transport failure, carrying the machine-readable reason. */
export class DroneApiError extends Error {
  constructor(message, { reason = "unknown", status = 0, detail = {} } = {}) {
    super(message);
    this.name = "DroneApiError";
    this.reason = reason;
    this.status = status;
    this.detail = detail;
  }
}

export class DroneApiClient {
  constructor({ baseUrl = DEFAULT_BASE_URL, fetchImpl, WebSocketImpl, requestTimeoutMs = 15000 } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl || ((...args) => globalThis.fetch(...args));
    this.WebSocketImpl = WebSocketImpl || globalThis.WebSocket;
    this.requestTimeoutMs = requestTimeoutMs;
    this.socket = null;
  }

  get webSocketUrl() {
    return `${this.baseUrl.replace(/^http/, "ws")}/api/drone/telemetry/ws`;
  }

  async request(path, { method = "GET", body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (error) {
      // A network-level failure here almost always means the backend is not
      // running — a far more common situation than a genuine transport fault.
      throw new DroneApiError(
        `バックエンド (${this.baseUrl}) に接続できません: ${error.message}`,
        { reason: "backend_unreachable" }
      );
    } finally {
      clearTimeout(timer);
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      throw new DroneApiError(payload?.message || `HTTP ${response.status}`, {
        reason: payload?.reason || `http_${response.status}`,
        status: response.status,
        detail: payload?.detail || {}
      });
    }
    return payload;
  }

  health() {
    return this.request("/api/health");
  }

  status() {
    return this.request("/api/drone/status");
  }

  config() {
    return this.request("/api/drone/config");
  }

  connect({ propellersRemoved = false } = {}) {
    return this.request("/api/drone/connect", { method: "POST", body: { propellersRemoved } });
  }

  disconnect() {
    return this.request("/api/drone/disconnect", { method: "POST" });
  }

  requestVersion() {
    return this.request("/api/drone/request-version", { method: "POST" });
  }

  /**
   * Change flight mode. `mode` must be one of the backend's allowed names;
   * this client does not translate numbers into modes and there is no way to
   * pass a raw custom_mode value through it.
   */
  setMode(mode, { confirmed = false } = {}) {
    return this.request("/api/drone/mode", { method: "POST", body: { mode, confirmed } });
  }

  requestStreams(streams) {
    return this.request("/api/drone/request-streams", {
      method: "POST",
      body: streams ? { streams } : {}
    });
  }

  /**
   * Open the telemetry WebSocket.
   * Returns a handle with close(); reconnection is the controller's job so the
   * retry policy stays in one place.
   */
  openTelemetrySocket({ onMessage, onOpen, onClose, onError } = {}) {
    this.closeTelemetrySocket();
    if (!this.WebSocketImpl) {
      throw new DroneApiError("このブラウザはWebSocketに対応していません。", { reason: "no_websocket" });
    }

    const socket = new this.WebSocketImpl(this.webSocketUrl);
    this.socket = socket;

    socket.onopen = () => onOpen?.();
    socket.onerror = (event) => onError?.(event);
    socket.onclose = (event) => {
      if (this.socket === socket) this.socket = null;
      onClose?.(event);
    };
    socket.onmessage = (event) => {
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        // A frame we cannot parse is dropped, but never silently: the
        // controller surfaces it in the status line.
        onError?.(new DroneApiError("テレメトリの解析に失敗しました。", { reason: "bad_frame" }));
        return;
      }
      if (frame?.type === "telemetry" && frame.payload) onMessage?.(frame.payload);
    };

    return { close: () => this.closeTelemetrySocket() };
  }

  closeTelemetrySocket() {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch {
      // Closing an already-dead socket is not an error worth reporting.
    }
  }
}
