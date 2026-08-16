// Provider errors -> farmer-readable Japanese.
//
// Supabase (and any other auth provider) reports failures as English strings
// aimed at developers: "Invalid login credentials", "User already registered",
// "Password should be at least 6 characters". Showing those to a farmer
// standing in a paddy is useless at best, and leaks provider internals at
// worst. Every message that reaches the UI goes through this module.
//
// Pure: no DOM, no provider import. The provider adapters hand it whatever
// error object they caught; this module reads only `message`/`status`/`code`
// and never re-throws.

export const MIN_PASSWORD_LENGTH = 8;

export const GENERIC_AUTH_ERROR = "サインインできませんでした。しばらくしてからもう一度お試しください。";
export const OFFLINE_ERROR = "インターネットに接続できません。オフラインのままでも「ログインせずに使う」で作業を続けられます。";

/**
 * Client-side validation, run before the network is touched at all — an
 * obviously-empty form should not cost a farmer a round trip on a weak
 * mobile connection.
 *
 * Returns null when the input is acceptable.
 */
export function validateCredentials({ email, password, mode = "login" } = {}) {
  const address = String(email ?? "").trim();
  const secret = String(password ?? "");
  if (!address) {
    return "メールアドレスを入力してください。";
  }
  if (!isPlausibleEmail(address)) {
    return "メールアドレスの形式が正しくありません。";
  }
  if (!secret) {
    return "パスワードを入力してください。";
  }
  if (mode === "signup" && secret.length < MIN_PASSWORD_LENGTH) {
    return `パスワードは${MIN_PASSWORD_LENGTH}文字以上にしてください。`;
  }
  return null;
}

/**
 * Deliberately permissive: this is a typo guard, not an RFC 5322 parser. The
 * provider is the authority on whether an address exists, and a farmer with a
 * valid-but-unusual address must never be locked out by our regex.
 */
export function isPlausibleEmail(value) {
  const address = String(value ?? "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
}

/**
 * Maps a caught provider error to Japanese.
 *
 * `context` is "login" | "signup" | "logout" | "sync" and only changes wording
 * where the same provider message means different things in each flow.
 */
export function authErrorMessage(error, context = "login") {
  if (!error) {
    return GENERIC_AUTH_ERROR;
  }
  if (isOfflineError(error)) {
    return OFFLINE_ERROR;
  }
  const raw = String(error.message ?? error ?? "").toLowerCase();
  const status = Number(error.status ?? error.statusCode ?? NaN);

  if (raw.includes("invalid login credentials") || raw.includes("invalid credentials")) {
    return "メールアドレスまたはパスワードが違います。";
  }
  if (raw.includes("already registered") || raw.includes("already been registered") || raw.includes("already exists")) {
    return "このメールアドレスは既に登録されています。ログインしてください。";
  }
  if (raw.includes("password should be") || raw.includes("password is too short") || raw.includes("weak password")) {
    return `パスワードが短すぎます。${MIN_PASSWORD_LENGTH}文字以上にしてください。`;
  }
  if (raw.includes("unable to validate email") || raw.includes("invalid email") || raw.includes("email address") && raw.includes("invalid")) {
    return "メールアドレスの形式が正しくありません。";
  }
  if (raw.includes("email not confirmed") || raw.includes("not confirmed")) {
    return "メールの確認が完了していません。届いた確認メールのリンクを開いてください。";
  }
  if (raw.includes("rate limit") || raw.includes("too many requests") || status === 429) {
    return "試行回数が多すぎます。しばらく待ってからもう一度お試しください。";
  }
  if (raw.includes("signups not allowed") || raw.includes("signup is disabled")) {
    return "現在、新しいアカウントの作成は受け付けていません。";
  }
  if (status === 401 || status === 403) {
    return context === "sync"
      ? "ログインの有効期限が切れました。もう一度ログインしてください。"
      : "メールアドレスまたはパスワードが違います。";
  }
  if (status >= 500) {
    return "クラウド側で問題が発生しました。データは端末に保存されています。";
  }
  return context === "signup"
    ? "アカウントを作成できませんでした。しばらくしてからもう一度お試しください。"
    : GENERIC_AUTH_ERROR;
}

/**
 * A network failure is not an auth failure — it must never be reported as
 * "wrong password", and it must never block local work.
 *
 * `fetch()` rejects with a bare TypeError on a dropped connection, so the
 * message text is the only signal available in most browsers; an explicit
 * `navigator.onLine === false` is checked by callers before this point.
 */
export function isOfflineError(error) {
  if (!error) {
    return false;
  }
  if (error.name === "AuthRetryableFetchError" || error.name === "NetworkError") {
    return true;
  }
  const raw = String(error.message ?? "").toLowerCase();
  return raw.includes("failed to fetch")
    || raw.includes("networkerror")
    || raw.includes("network request failed")
    || raw.includes("load failed")
    || raw.includes("err_internet_disconnected")
    || raw.includes("offline");
}

/** Japanese for a sync failure that did NOT lose local data. */
export function syncErrorMessage(error) {
  if (isOfflineError(error)) {
    return "オフラインのため同期できません。圃場は端末に保存されています。";
  }
  return `クラウド同期に失敗しました。圃場は端末に保存されています。（${authErrorMessage(error, "sync")}）`;
}
