import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTH_ERROR,
  AUTH_GUEST,
  AUTH_OFFLINE_AUTHENTICATED,
  AUTH_SIGNED_IN,
  AUTH_SIGNED_OUT,
  AUTH_UNAVAILABLE,
  AUTH_UNKNOWN,
  accountLabel,
  accountStatusText,
  deriveAuthState,
  isAuthenticated,
  shouldShowLoginScreen
} from "../../js/auth/auth-state.js";

// Credential validation and provider-error wording are covered by
// tests/unit/auth-errors.test.js; this file is only the state machine.

// ---------------------------------------------------------------------------
// State derivation
// ---------------------------------------------------------------------------

test("no configured cloud is 'unavailable', whatever else is true", () => {
  assert.equal(deriveAuthState({ configured: false, session: { user: { id: "u" } } }), AUTH_UNAVAILABLE);
  assert.equal(deriveAuthState({ configured: false }), AUTH_UNAVAILABLE);
});

test("a cached session with no network is offline_authenticated, never signed_out", () => {
  // Signing a farmer out because their phone lost signal would hide the
  // paddies they are standing in.
  const state = deriveAuthState({ configured: true, session: { user: { id: "u" } }, online: false });
  assert.equal(state, AUTH_OFFLINE_AUTHENTICATED);
  assert.equal(isAuthenticated(state), true);
});

test("a live session online is signed_in", () => {
  assert.equal(deriveAuthState({ configured: true, session: { user: { id: "u" } }, online: true }), AUTH_SIGNED_IN);
});

test("no session resolves to guest or signed_out depending on the remembered choice", () => {
  assert.equal(deriveAuthState({ configured: true, session: null, guestChosen: true }), AUTH_GUEST);
  assert.equal(deriveAuthState({ configured: true, session: null, guestChosen: false }), AUTH_SIGNED_OUT);
});

test("an unresolved session is 'unknown', not 'signed out'", () => {
  assert.equal(deriveAuthState({ configured: true, resolved: false }), AUTH_UNKNOWN);
});

// ---------------------------------------------------------------------------
// Login-screen visibility — the rules that stop it flashing
// ---------------------------------------------------------------------------

test("the login screen never appears while the session is still being restored", () => {
  assert.equal(shouldShowLoginScreen({ state: AUTH_UNKNOWN }), false);
});

test("the login screen never appears when no cloud is configured", () => {
  // The shipped state. An account screen with no backend is a dead end in a
  // paddy, and tomorrow's field test must not need a login.
  assert.equal(shouldShowLoginScreen({ state: AUTH_UNAVAILABLE }), false);
  assert.equal(shouldShowLoginScreen({ state: AUTH_UNAVAILABLE, requested: true }), false);
});

test("the login screen appears once for an undecided farmer with a cloud available", () => {
  assert.equal(shouldShowLoginScreen({ state: AUTH_SIGNED_OUT, guestChosen: false }), true);
});

test("choosing ログインせずに使う is remembered and suppresses the screen", () => {
  assert.equal(shouldShowLoginScreen({ state: AUTH_GUEST, guestChosen: true }), false);
  assert.equal(shouldShowLoginScreen({ state: AUTH_SIGNED_OUT, guestChosen: true }), false);
});

test("a guest can still ask for the login screen from the account menu", () => {
  assert.equal(shouldShowLoginScreen({ state: AUTH_GUEST, guestChosen: true, requested: true }), true);
});

test("the login screen never covers a signed-in farmer, online or offline", () => {
  for (const state of [AUTH_SIGNED_IN, AUTH_OFFLINE_AUTHENTICATED]) {
    assert.equal(shouldShowLoginScreen({ state, requested: true }), false, state);
  }
});

test("a failed attempt keeps the screen up so it can be retried", () => {
  assert.equal(shouldShowLoginScreen({ state: AUTH_ERROR, guestChosen: false }), true);
});

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

test("the header label prefers a display name, then the email local part", () => {
  assert.equal(accountLabel({ displayName: "Kai", email: "kai@example.jp" }), "Kai");
  assert.equal(accountLabel({ displayName: "", email: "kai@example.jp" }), "kai");
  assert.equal(accountLabel(null), "アカウント");
});

test("a long email local part is truncated rather than breaking the header", () => {
  const label = accountLabel({ email: "averyveryverylongaddress@example.jp" });
  assert.ok(label.length <= 14, label);
  assert.ok(label.endsWith("…"));
});

test("every state has Japanese status wording", () => {
  for (const state of [AUTH_SIGNED_IN, AUTH_OFFLINE_AUTHENTICATED, AUTH_GUEST, AUTH_SIGNED_OUT, AUTH_ERROR, AUTH_UNAVAILABLE, AUTH_UNKNOWN]) {
    const text = accountStatusText(state);
    assert.ok(text.length > 0, state);
    assert.doesNotMatch(text, /[a-z]/, `${state} leaked English: ${text}`);
  }
});
