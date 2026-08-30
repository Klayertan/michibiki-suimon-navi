// Cloud/auth configuration resolution.
//
// This app is a static site served as Cloudflare Workers static assets: there
// is no build step and no server to inject environment variables, so
// configuration arrives as a plain committed file (`config/cloud-config.js`)
// that assigns `window.SUISUI_CLOUD_CONFIG`. See docs/SUPABASE_SETUP.md.
//
// WHAT MAY GO IN THAT FILE: the Supabase project URL and the *anon /
// publishable* key only. Those two values are designed to be shipped to
// browsers — every request they authorize is still evaluated by Row Level
// Security against auth.uid(). The `service_role` key, database passwords and
// any admin credential must NEVER appear here or anywhere else in this repo;
// they bypass RLS entirely.
//
// Pure module: no DOM, no network, no side effects. Everything here is a
// function of the object it is handed, so it is unit-testable and cannot
// depend on load order.

export const PROVIDER_SUPABASE = "supabase";
export const PROVIDER_MOCK = "mock";

/** Providers the app knows how to build a client for. */
export const KNOWN_PROVIDERS = [PROVIDER_SUPABASE, PROVIDER_MOCK];

/**
 * Where the Supabase JS SDK is fetched from when a Supabase project is
 * configured. Overridable via `sdkUrl` so an operator who does not want a
 * third-party CDN in the critical path can vendor the ESM bundle into this
 * repository and point at it — a dynamic `import()` cannot carry an
 * integrity attribute, so self-hosting is the only way to pin it.
 */
export const DEFAULT_SUPABASE_SDK_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.58.0/+esm";

const EMPTY_CONFIG = Object.freeze({
  provider: null,
  url: "",
  anonKey: "",
  redirectTo: null,
  sdkUrl: DEFAULT_SUPABASE_SDK_URL,
  configured: false,
  reason: "missing"
});

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Normalizes whatever `window.SUISUI_CLOUD_CONFIG` happens to contain into a
 * predictable shape. Never throws: a malformed or half-filled config degrades
 * to `configured: false`, which the app treats exactly like "no account
 * feature available" — guest/local mode, unchanged behavior.
 *
 * `reason` explains an unconfigured result so Settings can say something more
 * useful than "off":
 *   - "missing"          no config object at all
 *   - "provider"         provider unset or not one we can build
 *   - "credentials"      supabase provider without url/anonKey
 *   - "service_role_key" a service_role key was pasted in by mistake
 */
export function normalizeCloudConfig(raw) {
  if (!raw || typeof raw !== "object") {
    return EMPTY_CONFIG;
  }
  const provider = text(raw.provider).toLowerCase() || null;
  const url = text(raw.url).replace(/\/+$/, "");
  const anonKey = text(raw.anonKey);
  const redirectTo = text(raw.redirectTo) || null;
  const sdkUrl = text(raw.sdkUrl) || DEFAULT_SUPABASE_SDK_URL;

  if (!provider || !KNOWN_PROVIDERS.includes(provider)) {
    return { ...EMPTY_CONFIG, provider, url, anonKey, redirectTo, sdkUrl, reason: "provider" };
  }
  if (provider === PROVIDER_MOCK) {
    // The in-memory provider used by the browser tests. It needs no
    // credentials and is only ever reachable when a caller has explicitly
    // written `provider: "mock"` into the config, which the shipped file
    // does not do.
    return { provider, url: "", anonKey: "", redirectTo, sdkUrl, configured: true, reason: null };
  }
  if (!url || !anonKey) {
    return { ...EMPTY_CONFIG, provider, url, anonKey, redirectTo, sdkUrl, reason: "credentials" };
  }
  if (looksLikeServiceRoleKey(anonKey)) {
    // Refusing to start is the right failure here: a service_role key in a
    // browser bundle bypasses every RLS policy in docs/SUPABASE_SETUP.md.
    return { ...EMPTY_CONFIG, provider, url, anonKey: "", redirectTo, sdkUrl, reason: "service_role_key" };
  }
  return { provider, url, anonKey, redirectTo, sdkUrl, configured: true, reason: null };
}

/**
 * True when a key is (or claims to be) a Supabase service_role key.
 *
 * Supabase JWT keys carry their role in the payload; the legacy `anon` and
 * `service_role` keys are both unsigned-readable JWTs, and the newer
 * publishable/secret keys are prefixed strings. Both forms are checked
 * without decoding anything cryptographically — this is a footgun guard, not
 * a security boundary.
 */
export function looksLikeServiceRoleKey(key) {
  const value = text(key);
  if (!value) {
    return false;
  }
  if (value.startsWith("sb_secret_") || value.startsWith("service_role")) {
    return true;
  }
  const parts = value.split(".");
  if (parts.length !== 3) {
    return false;
  }
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload?.role === "service_role";
  } catch {
    return false;
  }
}

/**
 * The URL Supabase Auth must redirect back to after an email confirmation or
 * password-recovery link.
 *
 * Derived from where the page is actually being served rather than hard-coded,
 * so the same committed config works for:
 *   - the Cloudflare origin root (https://<worker>.workers.dev/)
 *   - a deployment under a sub-path (https://example/app/)
 *   - a local dev server at http://127.0.0.1:4173/
 *   - the packaged desktop shell
 *
 * The filename is dropped so the result is always a directory URL; a hash
 * route is dropped so the farmer does not land back on an inner panel.
 * An explicit `redirectTo` in the config always wins — that is the escape
 * hatch for a custom domain.
 */
export function resolveRedirectUrl(location, configuredRedirect = null) {
  const explicit = text(configuredRedirect);
  if (explicit) {
    return explicit;
  }
  if (!location || typeof location.origin !== "string") {
    return null;
  }
  const path = typeof location.pathname === "string" ? location.pathname : "/";
  const directory = path.endsWith("/") ? path : path.replace(/[^/]*$/, "");
  return `${location.origin}${directory || "/"}`;
}

/** Reads and normalizes the config off a global scope (defaults to `window`). */
export function readCloudConfig(globalScope = typeof window !== "undefined" ? window : {}) {
  return normalizeCloudConfig(globalScope?.SUISUI_CLOUD_CONFIG);
}

/** Japanese one-liner for why the account feature is unavailable. */
export function unconfiguredReasonText(reason) {
  switch (reason) {
    case "provider":
      return "クラウド接続先が設定されていません。";
    case "credentials":
      return "クラウドのURLまたは公開キーが設定されていません。";
    case "service_role_key":
      return "設定されたキーは公開してはいけない種類のキーです。公開用（anon / publishable）キーを設定してください。";
    default:
      return "クラウド設定が見つかりません。";
  }
}
