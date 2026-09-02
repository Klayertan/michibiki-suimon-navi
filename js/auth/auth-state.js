// Authentication state machine (pure — no DOM, no provider, no storage).
//
// The point of pulling this out is that "should the login screen be showing
// right now?" is a question with a lot of wrong answers: flashing the login
// screen on every reload, showing it to a farmer who chose 「ログインせずに使う」
// yesterday, or hiding it forever because one network call failed. Those are
// decided here, once, and unit-tested.

export const AUTH_UNKNOWN = "unknown";                 // still restoring a session
export const AUTH_UNAVAILABLE = "unavailable";         // no cloud configured (the shipped default)
export const AUTH_GUEST = "guest";                     // chose 「ログインせずに使う」
export const AUTH_SIGNED_OUT = "signed_out";           // cloud available, nobody signed in
export const AUTH_SIGNED_IN = "signed_in";             // live session, provider reachable
export const AUTH_OFFLINE_AUTHENTICATED = "offline_authenticated"; // cached session, provider unreachable
export const AUTH_ERROR = "auth_error";                // last attempt failed; still usable locally

export const AUTH_STATES = [
  AUTH_UNKNOWN, AUTH_UNAVAILABLE, AUTH_GUEST, AUTH_SIGNED_OUT,
  AUTH_SIGNED_IN, AUTH_OFFLINE_AUTHENTICATED, AUTH_ERROR
];

/** The two states in which a cloud user identity exists and owns local data. */
export function isAuthenticated(state) {
  return state === AUTH_SIGNED_IN || state === AUTH_OFFLINE_AUTHENTICATED;
}

/** True while the app must not render either the login screen or the account menu. */
export function isResolving(state) {
  return state === AUTH_UNKNOWN;
}

/**
 * Decides whether the full-screen login/onboarding surface is shown.
 *
 * Rules, in order:
 *  1. Never while the session is still being restored — that is the flash
 *     §21 forbids.
 *  2. Never when no cloud is configured. The shipped repo has no credentials,
 *     so the app opens straight into 基本モード exactly as it does today; an
 *     account screen with no backend would be a dead end in a paddy.
 *  3. Never once signed in (online or offline-cached).
 *  4. Always, with no bypass at all, when `requireAuth` is set (the
 *     production login gate — see docs/AUTH_ARCHITECTURE.md "Production
 *     login gate") — this is checked BEFORE `guestChosen`/`requested`
 *     specifically so a guest choice stored in localStorage from before
 *     `requireAuth` was turned on cannot let anyone in.
 *  5. Never once the farmer has chosen 「ログインせずに使う」 — that choice is
 *     remembered until they explicitly ask for the account screen.
 *  6. Shown on an explicit request (the account menu's ログイン item), even
 *     from guest.
 *  7. Otherwise shown when cloud is available and nobody has decided yet.
 */
export function shouldShowLoginScreen({ state, guestChosen = false, requested = false, requireAuth = false } = {}) {
  if (state === AUTH_UNKNOWN) {
    return false;
  }
  if (state === AUTH_UNAVAILABLE) {
    return false;
  }
  if (isAuthenticated(state)) {
    return false;
  }
  if (requireAuth) {
    return true;
  }
  if (requested) {
    return true;
  }
  if (guestChosen) {
    return false;
  }
  return state === AUTH_SIGNED_OUT || state === AUTH_ERROR;
}

/**
 * Derives the state from what the provider and the network actually reported.
 *
 * A cached session plus an unreachable provider is `offline_authenticated`,
 * not `signed_out`: signing a farmer out because their phone lost signal in a
 * paddy would hide the fields they are standing in.
 */
export function deriveAuthState({ configured, session, online = true, error = null, guestChosen = false, resolved = true } = {}) {
  if (!configured) {
    return AUTH_UNAVAILABLE;
  }
  if (!resolved) {
    return AUTH_UNKNOWN;
  }
  if (session) {
    return online ? AUTH_SIGNED_IN : AUTH_OFFLINE_AUTHENTICATED;
  }
  if (error) {
    return AUTH_ERROR;
  }
  return guestChosen ? AUTH_GUEST : AUTH_SIGNED_OUT;
}

/**
 * The short label for the header control.
 *
 * Display name first, then the local part of the email (a full address does
 * not fit a phone header and is not what a farmer calls themselves), then a
 * generic fallback.
 */
export function accountLabel(user) {
  const displayName = String(user?.displayName ?? "").trim();
  if (displayName) {
    return displayName;
  }
  const email = String(user?.email ?? "").trim();
  if (email) {
    const local = email.split("@")[0];
    return local.length > 14 ? `${local.slice(0, 13)}…` : local;
  }
  return "アカウント";
}

/** One-line status for the account menu and the Settings account section. */
export function accountStatusText(state) {
  switch (state) {
    case AUTH_SIGNED_IN:
      return "ログイン中";
    case AUTH_OFFLINE_AUTHENTICATED:
      return "ログイン中（オフライン）";
    case AUTH_GUEST:
      return "ログインせずに使用中";
    case AUTH_SIGNED_OUT:
      return "ログインしていません";
    case AUTH_ERROR:
      return "ログインに失敗しました";
    case AUTH_UNAVAILABLE:
      return "クラウド未設定（端末内保存のみ）";
    default:
      return "確認中";
  }
}
