/* スイスイナビ — クラウド（アカウント）設定 / SuisuiNavi cloud configuration
 *
 * This file is loaded by index.html before the app boots. It is COMMITTED on
 * purpose: this is a static site with no build step and no server, so there
 * is nowhere else for a frontend configuration value to live.
 *
 * WHILE THIS FILE IS LEFT UNSET (the shipped state, provider: null) the app
 * runs exactly as it always has: fully offline, all data on the device, no
 * login screen. Filling it in is what turns the account feature on.
 *
 * Two providers are supported. Set EXACTLY ONE, or leave both effectively
 * empty (provider: null) for device-only operation.
 *
 * ---------------------------------------------------------------------------
 * provider: "sakura"   — the self-hosted cloud_backend/ API on Sakura Cloud.
 *                         This is the intended PRODUCTION choice. See
 *                         docs/SAKURA_CLOUD_BACKEND.md, docs/AUTH_ARCHITECTURE.md.
 * ---------------------------------------------------------------------------
 * ONLY ONE value belongs here:
 *
 *   apiBaseUrl   e.g. "https://api.suisuinavi.sakura.ne.jp"
 *
 * No key, token, or credential of any kind — cloud_backend authenticates the
 * browser via an HttpOnly session cookie set at login, never a value shipped
 * in this file. There is nothing secret here to leak.
 *
 * This file still ships with provider: null (below) because no real Sakura
 * Cloud VM has been provisioned yet for this repository — see
 * docs/SAKURA_CLOUD_DEPLOYMENT.md's manual setup checklist for exactly what
 * to create and what apiBaseUrl to fill in once it exists. Do not guess at a
 * hostname here.
 *
 * requireAuth (sakura provider only): when true, an unauthenticated visitor
 * sees ONLY the login/registration screen — no 「ログインせずに使う」, no way to
 * close it — until they sign in. This is the presentation/limited-access
 * mode (see docs/AUTH_ARCHITECTURE.md — "Production login gate"), meant to
 * be turned on ONLY once a real Sakura Cloud API is actually live at
 * apiBaseUrl; turning it on with no working apiBaseUrl would lock every
 * visitor out of an app that has nothing behind it. Ships false here for
 * exactly that reason — flip it only alongside filling in apiBaseUrl above,
 * never before. Never a secret: this is frontend UX behavior only, the real
 * access control is the cloud API's own session check on every request.
 *
 * ---------------------------------------------------------------------------
 * provider: "supabase" — the earlier Supabase-backed implementation. Kept
 *                         working and tested as a documented alternative;
 *                         see docs/SAKURA_CLOUD_BACKEND.md's "Supabase
 *                         provider status" section for why it was not
 *                         deleted, and docs/SUPABASE_SETUP.md for setup.
 * ---------------------------------------------------------------------------
 * ONLY these two values belong here:
 *
 *   url      https://<project-ref>.supabase.co
 *   anonKey  the project's **anon / publishable** key
 *
 * The anon key is safe to publish. It identifies the project, not a user, and
 * every request it authorizes is still checked by Row Level Security against
 * auth.uid() inside the database. See supabase/migrations/001_accounts_fields.sql.
 *
 * NEVER put any of the following in this file (or anywhere in this repo):
 *   - a Supabase service_role / secret key   (it bypasses every RLS policy)
 *   - any database password
 *   - a personal access token, SSH key, or session secret
 *   - any user's password
 * The app refuses to start the cloud feature if it detects a Supabase
 * service_role key here, but that check is a seatbelt, not a substitute for
 * care — and it has nothing to check for the sakura provider, which has no
 * key at all by design.
 */

/* `??=` rather than `=` so anything that has already assigned this global
 * wins: the browser test suite injects a `provider: "mock"` config before the
 * page loads, and a deployment that prefers to inject configuration some other
 * way (a wrapper page, a desktop shell) can do the same without editing this
 * file. In every normal load nothing has assigned it, so the object below is
 * what the app reads. */
window.SUISUI_CLOUD_CONFIG ??= {
  // "sakura" or "supabase" to enable accounts. Leave null for device-only
  // operation — the shipped state, since no real backend of either kind is
  // deployed for this repository yet.
  provider: null,

  // -- sakura provider ---------------------------------------------------
  // e.g. "https://api.suisuinavi.sakura.ne.jp" — see docs/SAKURA_CLOUD_DEPLOYMENT.md.
  apiBaseUrl: "",

  // Presentation/limited-access login gate — see the module comment above.
  // Stays false until a real apiBaseUrl is filled in above; do not flip
  // this on its own.
  requireAuth: false,

  // -- supabase provider ---------------------------------------------------
  // e.g. "https://abcdefghijklmnop.supabase.co"
  url: "",

  // The anon / publishable key. NOT the service_role key.
  anonKey: "",

  // Where Supabase should send the farmer back after an email-confirmation or
  // password-recovery link. Leave null to derive it from the page's own URL.
  // Set it explicitly only for a custom domain. Unused by the sakura provider
  // (cloud_backend has no email-link redirect flow yet — see
  // docs/AUTH_ARCHITECTURE.md's "Email verification and password reset").
  redirectTo: null
};
