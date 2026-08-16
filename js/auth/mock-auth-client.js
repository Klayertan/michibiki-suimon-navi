// In-memory authentication provider, for tests and for local development
// without a Supabase project.
//
// It is only ever constructed when the config explicitly says
// `provider: "mock"`, which the committed config/cloud-config.js does not.
// Nothing in the shipped app reaches this file.
//
// It implements the same narrow contract as supabase-auth-client.js:
//
//   init()               -> { session | null }
//   signUp({ email, password, displayName })
//   signIn({ email, password })
//   signOut()
//   getSession() / getUser() / getAccessToken()
//   onAuthStateChange(listener) -> unsubscribe
//
// PASSWORDS: the brief forbids implementing password storage, and this does
// not implement any. It is a test double that compares two in-memory strings
// and never persists a password anywhere — not to localStorage, not to disk,
// not to a log. Real credentials are handled exclusively by Supabase Auth.

import { MIN_PASSWORD_LENGTH } from "./auth-errors.js";

const SESSION_KEY = "suimonNaviMockAuthSessionV1";

/** Deterministic pseudo-UUID so seeded test users keep stable ids across reloads. */
function mockUserId(email) {
  let hash = 0;
  const source = `mock:${String(email).toLowerCase()}`;
  for (let index = 0; index < source.length; index += 1) {
    hash = (hash * 31 + source.charCodeAt(index)) >>> 0;
  }
  const hex = hash.toString(16).padStart(8, "0");
  return `${hex}-0000-4000-8000-${hex}0000`;
}

export class MockAuthClient {
  /**
   * `seed.users` is `[{ email, password, displayName }]`. `seed.online`
   * starts the provider in a reachable/unreachable state; tests flip it with
   * `setOnline()` to exercise the offline paths.
   */
  constructor({ seed = {}, storage = typeof localStorage !== "undefined" ? localStorage : null } = {}) {
    this.storage = storage;
    this.online = seed.online !== false;
    this.users = new Map();
    (seed.users || []).forEach((user) => {
      const email = String(user.email).toLowerCase();
      this.users.set(email, {
        id: user.id || mockUserId(email),
        email,
        password: String(user.password ?? ""),
        displayName: user.displayName ?? ""
      });
    });
    this.session = null;
    this.listeners = new Set();
  }

  setOnline(online) {
    this.online = Boolean(online);
  }

  async init() {
    // Mirrors Supabase's own behavior: the SDK restores a persisted session
    // from storage without a network round trip, which is what makes
    // offline_authenticated possible at all.
    try {
      const raw = this.storage?.getItem(SESSION_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.user?.id) {
          this.session = parsed;
        }
      }
    } catch {
      this.session = null;
    }
    return { session: this.session };
  }

  requireOnline() {
    if (!this.online) {
      const error = new Error("Failed to fetch");
      error.name = "AuthRetryableFetchError";
      throw error;
    }
  }

  async signUp({ email, password, displayName = "" }) {
    this.requireOnline();
    const address = String(email).toLowerCase().trim();
    if (this.users.has(address)) {
      throw Object.assign(new Error("User already registered"), { status: 422 });
    }
    if (String(password).length < MIN_PASSWORD_LENGTH) {
      throw Object.assign(new Error(`Password should be at least ${MIN_PASSWORD_LENGTH} characters`), { status: 422 });
    }
    const user = { id: mockUserId(address), email: address, password: String(password), displayName: String(displayName ?? "") };
    this.users.set(address, user);
    return this.establishSession(user);
  }

  async signIn({ email, password }) {
    this.requireOnline();
    const address = String(email).toLowerCase().trim();
    const user = this.users.get(address);
    if (!user || user.password !== String(password)) {
      throw Object.assign(new Error("Invalid login credentials"), { status: 400 });
    }
    return this.establishSession(user);
  }

  establishSession(user) {
    this.session = {
      accessToken: `mock-token:${user.id}`,
      user: { id: user.id, email: user.email, displayName: user.displayName }
    };
    this.persistSession();
    this.emit();
    return { user: this.session.user, session: this.session, needsEmailConfirmation: false };
  }

  async signOut() {
    this.session = null;
    try {
      this.storage?.removeItem(SESSION_KEY);
    } catch {
      // Nothing to clean up if storage is unavailable.
    }
    this.emit();
  }

  async updateDisplayName(displayName) {
    if (!this.session) {
      return;
    }
    const user = this.users.get(this.session.user.email);
    if (user) {
      user.displayName = String(displayName ?? "");
    }
    this.session.user.displayName = String(displayName ?? "");
    this.persistSession();
    this.emit();
  }

  persistSession() {
    try {
      // The token is a fake string and the record holds no password — see the
      // module header.
      this.storage?.setItem(SESSION_KEY, JSON.stringify(this.session));
    } catch {
      // Private-browsing storage denial: the session simply won't survive a reload.
    }
  }

  getSession() {
    return this.session;
  }

  getUser() {
    return this.session?.user || null;
  }

  getAccessToken() {
    return this.session?.accessToken || null;
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
        // A broken listener must not break sign-in.
      }
    });
  }
}
