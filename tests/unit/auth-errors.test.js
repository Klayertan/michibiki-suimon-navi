import test from "node:test";
import assert from "node:assert/strict";
import {
  GENERIC_AUTH_ERROR,
  MIN_PASSWORD_LENGTH,
  OFFLINE_ERROR,
  authErrorMessage,
  isOfflineError,
  isPlausibleEmail,
  syncErrorMessage,
  validateCredentials
} from "../../js/auth/auth-errors.js";

test("empty and malformed input is caught before the network is touched", () => {
  assert.match(validateCredentials({ email: "", password: "x" }), /メールアドレスを入力/);
  assert.match(validateCredentials({ email: "not-an-email", password: "x" }), /形式が正しくありません/);
  assert.match(validateCredentials({ email: "a@b.jp", password: "" }), /パスワードを入力/);
  assert.equal(validateCredentials({ email: "a@b.jp", password: "anything" }), null);
});

test("a short password is rejected on signup but never on login", () => {
  const short = "a".repeat(MIN_PASSWORD_LENGTH - 1);
  assert.match(validateCredentials({ email: "a@b.jp", password: short, mode: "signup" }), /8文字以上/);
  // Rejecting a short password at LOGIN would lock out anyone whose account
  // predates the rule; only the provider decides whether a login is valid.
  assert.equal(validateCredentials({ email: "a@b.jp", password: short, mode: "login" }), null);
});

test("the email check is a typo guard, not an RFC parser", () => {
  assert.equal(isPlausibleEmail("kai@example.jp"), true);
  assert.equal(isPlausibleEmail("kai+paddy@sub.example.co.jp"), true);
  assert.equal(isPlausibleEmail("kai@example"), false);
  assert.equal(isPlausibleEmail("kai example@x.jp"), false);
});

// Farmers must never see "Invalid login credentials" or a stack trace.
test("provider messages become Japanese, never raw provider text", () => {
  const cases = [
    [{ message: "Invalid login credentials", status: 400 }, "login", /違います/],
    [{ message: "User already registered", status: 422 }, "signup", /既に登録されています/],
    [{ message: "Password should be at least 6 characters" }, "signup", /短すぎます/],
    [{ message: "Unable to validate email address: invalid format" }, "signup", /形式が正しくありません/],
    [{ message: "Email not confirmed", status: 400 }, "login", /確認メール/],
    [{ message: "Request rate limit reached", status: 429 }, "login", /しばらく待って/],
    [{ message: "Signups not allowed for this instance" }, "signup", /受け付けていません/],
    [{ message: "internal error", status: 503 }, "login", /端末に保存/]
  ];
  for (const [error, context, pattern] of cases) {
    const message = authErrorMessage(error, context);
    assert.match(message, pattern);
    assert.doesNotMatch(message, /[A-Za-z]{6,}/, `leaked provider text: ${message}`);
  }
});

test("an unrecognised failure still produces Japanese, not a blank", () => {
  assert.equal(authErrorMessage({ message: "kaboom" }, "login"), GENERIC_AUTH_ERROR);
  assert.match(authErrorMessage({ message: "kaboom" }, "signup"), /作成できませんでした/);
  assert.equal(authErrorMessage(null), GENERIC_AUTH_ERROR);
});

// A dropped connection is not a wrong password. Saying so would send a farmer
// hunting for a typo that does not exist, and would imply their data is gone.
test("a network failure is reported as offline and points at guest mode", () => {
  // The three shapes browsers actually produce, plus the SDK's own.
  assert.equal(isOfflineError(new TypeError("Failed to fetch")), true);                              // Chrome
  assert.equal(isOfflineError({ message: "Load failed" }), true);                                     // Safari
  assert.equal(isOfflineError({ message: "NetworkError when attempting to fetch resource." }), true); // Firefox
  assert.equal(isOfflineError({ name: "AuthRetryableFetchError", message: "" }), true);
  assert.equal(isOfflineError({ message: "Invalid login credentials" }), false);

  const message = authErrorMessage(new TypeError("Failed to fetch"), "login");
  assert.equal(message, OFFLINE_ERROR);
  assert.match(message, /ログインせずに使う/);
});

test("an expired session during sync says so, rather than blaming the password", () => {
  assert.match(authErrorMessage({ status: 401 }, "sync"), /有効期限/);
  assert.match(authErrorMessage({ status: 401 }, "login"), /違います/);
});

// The single most important promise the sync layer makes to a farmer.
test("every sync failure message states that local data survived", () => {
  assert.match(syncErrorMessage(new TypeError("Failed to fetch")), /端末に保存されています/);
  assert.match(syncErrorMessage({ message: "boom", status: 500 }), /端末に保存されています/);
});
