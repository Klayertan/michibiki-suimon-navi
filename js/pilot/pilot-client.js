// HTTP client for the backend Manual Control endpoints.
//
// The only file in the frontend that talks to the pilot API. It sends four
// normalized pilot intentions and safety metadata; it never names a MAVLink
// message, channel number or PWM value. Mapping those intentions onto the
// vehicle's RCMAP/RCx calibration belongs exclusively to the backend.
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

/** ARM/DISARM can legitimately consume the backend ACK wait plus HEARTBEAT
 * verification window (5 s + 5 s by default). Never apply the 1.5 s manual
 * frame deadline to a state-changing command whose outcome must be known. */
export const COMMAND_CONFIRM_TIMEOUT_MS = 15_000;

/**
 * Provider identities the backend's `PilotInputRequest.provider` literal
 * accepts. This is a *provider implementation* vocabulary and is deliberately
 * NOT the same as the UI's input-*source* vocabulary (`keyboard` / `ps5`):
 * one PS5 source is served by either the `browser` or the `mock` provider.
 *
 * Keep in sync with `PilotInputRequest.provider` in backend/app/models.py.
 * Anything unrecognised is sent as `unknown` rather than verbatim, because
 * the field is backend diagnostics only and a mismatch here used to fail the
 * whole frame with HTTP 422 — including neutral/release frames, which are
 * exactly the frames that must never be lost.
 */
export const WIRE_PROVIDERS = Object.freeze(["keyboard", "browser", "mock", "gamepad", "unknown"]);

export function normalizeProvider(value) {
  return WIRE_PROVIDERS.includes(value) ? value : "unknown";
}

/**
 * Turn a failed response into something an operator can act on.
 *
 * The backend's own rejections carry a `message`. FastAPI request-validation
 * failures instead carry a `detail` array of field errors, which previously
 * collapsed to a bare "HTTP 422" — true but useless, and indistinguishable
 * from an autopilot refusing a command.
 */
export function describeApiFailure(payload, status) {
  if (payload?.message) return payload.message;

  const detail = payload?.detail;
  if (Array.isArray(detail) && detail.length) {
    const fields = detail
      .map((entry) => {
        const field = Array.isArray(entry?.loc)
          ? entry.loc.filter((part) => part !== "body").join(".")
          : null;
        const text = entry?.msg || "is invalid";
        return field ? `${field}: ${text}` : text;
      })
      .join("; ");
    return `Request rejected by API validation (HTTP ${status}) — ${fields}`;
  }
  if (typeof detail === "string" && detail) return detail;
  return `HTTP ${status}`;
}

export class PilotClient {
  constructor({
    baseUrl = "",
    fetchImpl,
    timeoutMs = 1500,
    commandTimeoutMs = COMMAND_CONFIRM_TIMEOUT_MS
  } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.fetchImpl = fetchImpl || ((...args) => globalThis.fetch(...args));
    // Short by design: a pilot frame that has not landed within a fraction of
    // a second is worthless, and the backend's own input timeout will command
    // neutral anyway. Never let a slow request queue up behind a stale one.
    this.timeoutMs = timeoutMs;
    this.commandTimeoutMs = commandTimeoutMs;
  }

  async post(path, body, { timeoutMs = this.timeoutMs } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
      throw new PilotApiError(describeApiFailure(payload, response.status), {
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

  /**
   * Open the channel for a PROPELLERS-REMOVED bench test. `propsRemovedAck`
   * must be exactly `true` — the backend's model rejects anything else, so
   * this call cannot silently succeed without the confirmation.
   */
  enableBench(propsRemovedAck) {
    return this.post("/api/drone/pilot/bench/enable", { propsRemovedAck });
  }

  /** Closes the channel for both general flight and bench mode. */
  disable() {
    return this.post("/api/drone/pilot/disable");
  }

  /** Stop movement now. Not a motor kill — see the backend endpoint. */
  neutral(sequence) {
    return this.post("/api/drone/pilot/neutral", { sequence });
  }

  /** Normal ARM command. The backend always uses param2=0 (never force-arm). */
  arm() {
    return this.post("/api/drone/arm", { confirmed: true }, { timeoutMs: this.commandTimeoutMs });
  }

  /** Normal DISARM command. The backend always uses param2=0. */
  disarm() {
    return this.post("/api/drone/disarm", { confirmed: true }, { timeoutMs: this.commandTimeoutMs });
  }

  /** One normalized manual command: positive pitch is forward, positive roll
   * is right, positive throttle is up/increase and positive yaw is right. */
  sendInput(axes, {
    neutral = false,
    deadman = false,
    source = "unknown",
    provider = source,
    sequence = 0
  } = {}) {
    return this.post("/api/drone/pilot/input", {
      pitch: axes?.pitch ?? 0,
      roll: axes?.roll ?? 0,
      throttle: axes?.throttle ?? 0,
      yaw: axes?.yaw ?? 0,
      neutral,
      deadman,
      // `source` is free-form on the wire but must be non-empty.
      source: String(source || "unknown").slice(0, 64) || "unknown",
      provider: normalizeProvider(provider),
      sequence
    });
  }
}
