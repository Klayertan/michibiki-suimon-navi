// Sakura Cloud Auth adapter — talks to the cloud_backend/ FastAPI service
// (see docs/SAKURA_CLOUD_BACKEND.md, docs/AUTH_ARCHITECTURE.md) instead of
// Supabase. Same narrow contract as MockAuthClient/SupabaseAuthClient:
//
//   init() / signUp() / signIn() / signOut() / updateDisplayName()
//   getSession() / getUser() / getAccessToken()
//   onAuthStateChange(listener) -> unsubscribe
//
// SESSION MODEL: the server issues an HttpOnly, opaque, cookie-based session
// token (see cloud_backend/app/security.py) — this file never sees or
// stores that token itself; every request just goes through with
// `credentials: "include"` and the browser attaches the cookie
// automatically. There is therefore no bearer access token to hand back
// from getAccessToken() (always returns null here) — CSRF protection
// instead uses a SEPARATE, JS-readable `suisui_csrf` cookie, echoed back as
// the X-Suisui-Csrf header on every state-changing request (see
// cloud_backend/app/dependencies.py's require_csrf and getCsrfToken()
// below). No password, session token, or CSRF token is ever written to
// localStorage by this file.
//
// OFFLINE IDENTITY CACHE: unlike the Supabase SDK, which caches a signed
// session (with its own expiry) in localStorage and can answer "who is
// signed in" with zero network calls, this adapter has nothing to read
// locally except the (invisible, HttpOnly) session cookie itself —
// init() normally has to ask the server via GET /api/auth/me. Taken
// literally, that would make a previously-signed-in farmer look signed OUT
// the instant they lose signal in a paddy, which is exactly backwards (see
// js/auth/auth-state.js — AUTH_OFFLINE_AUTHENTICATED exists precisely to
// avoid this for the Supabase case). So this file keeps one small,
// non-secret cache in localStorage: the last-known {id, email,
// displayName} — never a token, never anything that grants access on its
// own; it only exists to pick the right per-user local-data namespace
// (js/cloud/user-scope.js) and label the account menu while offline. On a
// genuine network failure (not a 401 — a 401 legitimately means "not
// signed in" and clears this cache), init() falls back to it.

const IDENTITY_CACHE_KEY = "suimonNaviSakuraIdentityV1";
const DEFAULT_CSRF_COOKIE_NAME = "suisui_csrf";
const DEFAULT_CSRF_HEADER_NAME = "x-suisui-csrf";

function toUser(apiUser) {
  if (!apiUser) {
    return null;
  }
  return {
    id: apiUser.id,
    email: apiUser.email || "",
    displayName: apiUser.display_name || ""
  };
}

function toSession(authResponse) {
  const user = toUser(authResponse?.user);
  if (!user) {
    return null;
  }
  // No accessToken: see this file's module comment. expiresAt is likewise
  // not surfaced to JS — the server alone decides when the (invisible)
  // session cookie stops being valid.
  return { accessToken: null, expiresAt: null, user };
}

function readCookie(name) {
  if (typeof document === "undefined" || !document.cookie) {
    return null;
  }
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * FastAPI validation errors (422) carry `detail` as a list of
 * `{loc, msg, type}` objects, not a plain string — this turns the first one
 * into something auth-errors.js's substring matching can still make sense
 * of. Purely a nicety: the frontend already validates email shape and
 * password length before ever calling signUp()/signIn(), so this path is
 * defense-in-depth, not the normal case.
 */
function summarizeValidationDetail(detail) {
  const first = Array.isArray(detail) ? detail[0] : null;
  const loc = Array.isArray(first?.loc) ? first.loc.join(".") : "";
  const msg = String(first?.msg || "invalid request");
  if (loc.includes("password")) {
    return `password should be at least 8 characters (${msg})`;
  }
  if (loc.includes("email")) {
    return `invalid email address (${msg})`;
  }
  return msg;
}

function isNetworkError(error) {
  return error?.name === "NetworkError";
}

export class SakuraAuthClient {
  constructor(config = {}) {
    this.config = config;
    this.apiBaseUrl = String(config.apiBaseUrl || "").replace(/\/+$/, "");
    this.csrfCookieName = config.csrfCookieName || DEFAULT_CSRF_COOKIE_NAME;
    this.csrfHeaderName = config.csrfHeaderName || DEFAULT_CSRF_HEADER_NAME;
    this.storage = config.storage || (typeof localStorage !== "undefined" ? localStorage : null);
    this.session = null;
    this.listeners = new Set();
  }

  async init() {
    try {
      const data = await this.request("GET", "/api/auth/me");
      this.session = toSession(data);
      this.cacheIdentity(this.session?.user || null);
    } catch (error) {
      if (error.status === 401) {
        // Genuinely not signed in — not an offline/error condition.
        this.session = null;
        this.cacheIdentity(null);
      } else {
        const cached = this.readCachedIdentity();
        if (cached && isNetworkError(error)) {
          this.session = { accessToken: null, expiresAt: null, user: cached };
        } else {
          throw error;
        }
      }
    }
    return { session: this.session };
  }

  async signUp({ email, password, displayName = "" }) {
    const data = await this.request("POST", "/api/auth/register", {
      email: String(email).trim(),
      password,
      display_name: String(displayName ?? "").trim()
    });
    if (data?.needs_email_confirmation) {
      return { user: null, session: null, needsEmailConfirmation: true };
    }
    this.session = toSession(data);
    this.cacheIdentity(this.session?.user || null);
    this.emit();
    return { user: this.session?.user || null, session: this.session, needsEmailConfirmation: false };
  }

  async signIn({ email, password }) {
    const data = await this.request("POST", "/api/auth/login", {
      email: String(email).trim(),
      password
    });
    this.session = toSession(data);
    this.cacheIdentity(this.session?.user || null);
    this.emit();
    return { user: this.session?.user || null, session: this.session };
  }

  async signOut() {
    try {
      await this.request("POST", "/api/auth/logout");
    } catch (error) {
      // Same reasoning as SupabaseAuthClient.signOut(): a network failure
      // during sign-out must still end the LOCAL session — leaving a
      // farmer "signed in" on a shared phone because the server was
      // unreachable is the worse outcome. If this request never lands, the
      // server-side session simply expires on its own schedule
      // (session_ttl_days) rather than being explicitly revoked.
      if (!isNetworkError(error)) {
        this.session = null;
        this.cacheIdentity(null);
        this.emit();
        throw error;
      }
    }
    this.session = null;
    this.cacheIdentity(null);
    this.emit();
  }

  async updateDisplayName(displayName) {
    await this.request("PUT", "/api/profile", { display_name: String(displayName ?? "").trim() });
  }

  getSession() {
    return this.session;
  }

  getUser() {
    return this.session?.user || null;
  }

  getAccessToken() {
    // Always null — see this file's module comment. Implemented only to
    // satisfy the shared AuthClient contract; SakuraCloudStore uses cookies,
    // not a bearer token, so nothing in this codebase actually reads this
    // for the Sakura provider.
    return null;
  }

  /** Read by SakuraCloudStore to attach X-Suisui-Csrf on state-changing calls. */
  getCsrfToken() {
    return readCookie(this.csrfCookieName);
  }

  onAuthStateChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit() {
    this.listeners.forEach((listener) => {
      try {
        listener(this.session);
      } catch {
        // A broken listener must not break auth.
      }
    });
  }

  dispose() {
    this.listeners.clear();
  }

  // -- offline identity cache --------------------------------------------------

  cacheIdentity(user) {
    if (!this.storage) {
      return;
    }
    try {
      if (user) {
        this.storage.setItem(IDENTITY_CACHE_KEY, JSON.stringify(user));
      } else {
        this.storage.removeItem(IDENTITY_CACHE_KEY);
      }
    } catch {
      // Private browsing / storage full: the app just re-asks the server
      // next time, exactly as if nothing had ever been cached.
    }
  }

  readCachedIdentity() {
    if (!this.storage) {
      return null;
    }
    try {
      const raw = this.storage.getItem(IDENTITY_CACHE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && parsed.id ? parsed : null;
    } catch {
      return null;
    }
  }

  // -- transport ----------------------------------------------------------------

  async request(method, path, body) {
    const headers = {};
    let payload;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    if (method !== "GET") {
      const csrf = this.getCsrfToken();
      if (csrf) {
        headers[this.csrfHeaderName] = csrf;
      }
    }
    let response;
    try {
      response = await fetch(`${this.apiBaseUrl}${path}`, {
        method,
        credentials: "include",
        headers,
        body: payload
      });
    } catch (cause) {
      const error = new Error("network request failed");
      error.name = "NetworkError";
      error.cause = cause;
      throw error;
    }
    if (response.status === 204) {
      return null;
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      const detail = data?.detail;
      const message = typeof detail === "string"
        ? detail
        : Array.isArray(detail)
          ? summarizeValidationDetail(detail)
          : `request failed with status ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.detail = detail;
      throw error;
    }
    return data;
  }
}
