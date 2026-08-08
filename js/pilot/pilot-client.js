// HTTP client for the backend pilot-control endpoints.
//
// The only file in the frontend that talks to the pilot API. It sends four
// normalized numbers and a neutral flag; it never names a MAVLink message, a
// frame, or a speed, because none of those are the browser's business.
//
// Kept out of js/gamepad/ on purpose: those modules are input *preview* and
// an automated safety test asserts they contain no transport at all.

export class PilotApiError extends Error {
  constructor(message, { reason = "unknown", status = 0, detail = {} } = {}) {
    super(message);
    this.name = "PilotApiError";
    this.reason = reason;
    this.status = status;
    this.detail = detail;
  }
}

export class PilotClient {
  constructor({ baseUrl = "", fetchImpl, timeoutMs = 1500 } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.fetchImpl = fetchImpl || ((...args) => globalThis.fetch(...args));
    // Short by design: a pilot frame that has not landed within a fraction of
    // a second is worthless, and the backend's own input timeout will command
    // neutral anyway. Never let a slow request queue up behind a stale one.
    this.timeoutMs = timeoutMs;
  }

  async post(path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {})
      });
    } catch (error) {
      throw new PilotApiError(`バックエンドに送信できません: ${error.message}`, {
        reason: "backend_unreachable"
      });
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
      throw new PilotApiError(payload?.message || `HTTP ${response.status}`, {
        reason: payload?.reason || `http_${response.status}`,
        status: response.status,
        detail: payload?.detail || {}
      });
    }
    return payload;
  }

  enable() {
    return this.post("/api/drone/pilot/enable");
  }

  disable() {
    return this.post("/api/drone/pilot/disable");
  }

  /** Stop movement now. Not a motor kill — see the backend endpoint. */
  neutral() {
    return this.post("/api/drone/pilot/neutral");
  }

  /** One normalized command. `axes` is {forward, right, up, yaw}. */
  sendInput(axes, { neutral = false } = {}) {
    return this.post("/api/drone/pilot/input", {
      forward: axes?.forward ?? 0,
      right: axes?.right ?? 0,
      up: axes?.up ?? 0,
      yaw: axes?.yaw ?? 0,
      neutral
    });
  }
}
