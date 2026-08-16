// Supabase Auth adapter.
//
// Implements the same narrow contract as MockAuthClient so the controller
// above never learns which provider it is talking to:
//
//   init() / signUp() / signIn() / signOut()
//   getSession() / getUser() / getAccessToken()
//   onAuthStateChange(listener) -> unsubscribe
//
// WHY A PROVIDER RATHER THAN OUR OWN PASSWORD TABLE: storing password hashes
// correctly means Argon2id/bcrypt parameters, per-user salts, timing-safe
// comparison, credential-stuffing rate limits, breach-password screening,
// email-verification tokens, recovery-token expiry and rotation, and session
// revocation. Every one of those is a way to leak a farmer's credentials, and
// none of them is this project's problem to solve. Supabase Auth owns all of
// it; this file owns none of it and never sees a stored password.
//
// The display name is written to `user_metadata.display_name`, which is
// user-editable by design — it is a label, never an authorization input.
// Ownership is decided exclusively by `auth.uid()` inside the database.

import { createSupabaseClient } from "../cloud/supabase-client.js";

function toUser(supabaseUser) {
  if (!supabaseUser) {
    return null;
  }
  return {
    id: supabaseUser.id,
    email: supabaseUser.email || "",
    displayName: supabaseUser.user_metadata?.display_name || ""
  };
}

function toSession(supabaseSession) {
  if (!supabaseSession) {
    return null;
  }
  return {
    accessToken: supabaseSession.access_token,
    expiresAt: supabaseSession.expires_at || null,
    user: toUser(supabaseSession.user)
  };
}

export class SupabaseAuthClient {
  constructor(config) {
    this.config = config;
    this.client = null;
    this.session = null;
    this.listeners = new Set();
    this.subscription = null;
  }

  async init() {
    this.client = await createSupabaseClient(this.config);
    // getSession() reads the persisted session from local storage and does
    // NOT require the network, which is what keeps a signed-in farmer signed
    // in when they walk out of coverage.
    const { data } = await this.client.auth.getSession();
    this.session = toSession(data?.session);
    const { data: subscriptionData } = this.client.auth.onAuthStateChange((_event, supabaseSession) => {
      this.session = toSession(supabaseSession);
      this.emit();
    });
    this.subscription = subscriptionData?.subscription || null;
    return { session: this.session };
  }

  /** The shared client, for the cloud store to reuse — one connection, one session. */
  getClient() {
    return this.client;
  }

  async signUp({ email, password, displayName = "" }) {
    const { data, error } = await this.client.auth.signUp({
      email: String(email).trim(),
      password,
      options: {
        data: { display_name: String(displayName ?? "").trim() },
        emailRedirectTo: this.config.redirectTo || undefined
      }
    });
    if (error) {
      throw error;
    }
    this.session = toSession(data?.session);
    return {
      user: toUser(data?.user),
      session: this.session,
      // With "Confirm email" enabled (the Supabase default) sign-up returns a
      // user but no session — the farmer has to open the emailed link first.
      // Reported rather than papered over, so the UI can say so plainly.
      needsEmailConfirmation: Boolean(data?.user) && !data?.session
    };
  }

  async signIn({ email, password }) {
    const { data, error } = await this.client.auth.signInWithPassword({
      email: String(email).trim(),
      password
    });
    if (error) {
      throw error;
    }
    this.session = toSession(data?.session);
    return { user: toUser(data?.user), session: this.session };
  }

  async signOut() {
    const { error } = await this.client.auth.signOut();
    // A network failure during sign-out still has to end the local session:
    // leaving a farmer "signed in" on a shared phone because the server was
    // unreachable is the worse outcome. The SDK clears local state first, so
    // the error is reported but not rethrown.
    this.session = null;
    this.emit();
    if (error && error.status && error.status !== 401 && error.status !== 403) {
      throw error;
    }
  }

  async updateDisplayName(displayName) {
    const { error } = await this.client.auth.updateUser({
      data: { display_name: String(displayName ?? "").trim() }
    });
    if (error) {
      throw error;
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
        // A broken listener must not break auth.
      }
    });
  }

  dispose() {
    this.subscription?.unsubscribe?.();
    this.listeners.clear();
  }
}
