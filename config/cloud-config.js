/* スイスイナビ — クラウド（アカウント）設定 / SuisuiNavi cloud configuration
 *
 * This file is loaded by index.html before the app boots. It is COMMITTED on
 * purpose: SuisuiNavi is served as static assets with no build-time
 * substitution and no server rendering, so there is nowhere else for a
 * frontend configuration value to live.
 *
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
 *   - the service_role / secret key   (it bypasses every RLS policy)
 *   - the database password
 *   - a personal access token
 *   - any user's password
 * The app refuses to start the cloud feature if it detects a service_role key
 * here, but that check is a seatbelt, not a substitute for care.
 *
 * WHILE THIS FILE IS LEFT UNSET (the shipped state) the app runs exactly as it
 * always has: fully offline, all data on the device, no login screen. Filling
 * it in is what turns the account feature on.
 *
 * Setup instructions: docs/SUPABASE_SETUP.md
 */

/* `??=` rather than `=` so anything that has already assigned this global
 * wins: the browser test suite injects a `provider: "mock"` config before the
 * page loads, and a deployment that prefers to inject configuration some other
 * way (a wrapper page, a desktop shell) can do the same without editing this
 * file. In every normal load nothing has assigned it, so the object below is
 * what the app reads. */
window.SUISUI_CLOUD_CONFIG ??= {
  // "supabase" to enable accounts. Leave null for device-only operation.
  provider: null,

  // e.g. "https://abcdefghijklmnop.supabase.co"
  url: "",

  // The anon / publishable key. NOT the service_role key.
  anonKey: "",

  // Where Supabase should send the farmer back after an email-confirmation or
  // password-recovery link. Leave null to derive it from the page's own URL,
  // which works for the Cloudflare origin root, for a sub-path deployment and
  // for the local dev server alike. Set it explicitly only for a custom
  // domain. Whatever it resolves to must also be in Supabase's Redirect URLs
  // allow-list — see docs/SUPABASE_SETUP.md.
  redirectTo: null
};
