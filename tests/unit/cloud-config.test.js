import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SUPABASE_SDK_URL,
  looksLikeServiceRoleKey,
  normalizeCloudConfig,
  readCloudConfig,
  resolveRedirectUrl,
  unconfiguredReasonText
} from "../../js/cloud/cloud-config.js";

test("sakura needs an apiBaseUrl", () => {
  const config = normalizeCloudConfig({ provider: "sakura" });
  assert.equal(config.configured, false);
  assert.equal(config.reason, "api_base_url");
  assert.match(unconfiguredReasonText("api_base_url"), /apiBaseUrl/);
});

test("a sakura config with only apiBaseUrl is configured, with a trailing slash trimmed, and needs no key", () => {
  const config = normalizeCloudConfig({ provider: "sakura", apiBaseUrl: "https://api.suisuinavi.sakura.ne.jp/" });
  assert.equal(config.configured, true);
  assert.equal(config.reason, null);
  assert.equal(config.apiBaseUrl, "https://api.suisuinavi.sakura.ne.jp");
  assert.equal(config.url, "");
  assert.equal(config.anonKey, "");
});

test("sakura ignores a stray url/anonKey rather than requiring or rejecting them", () => {
  const config = normalizeCloudConfig({
    provider: "sakura",
    apiBaseUrl: "https://api.suisuinavi.sakura.ne.jp",
    url: "https://leftover.supabase.co",
    anonKey: "leftover-key"
  });
  assert.equal(config.configured, true);
  assert.equal(config.url, "");
  assert.equal(config.anonKey, "");
});

test("requireAuth defaults to false and is only ever true on an exact boolean true", () => {
  const configured = normalizeCloudConfig({ provider: "sakura", apiBaseUrl: "https://api.example.jp" });
  assert.equal(configured.requireAuth, false);

  const explicitFalse = normalizeCloudConfig({ provider: "sakura", apiBaseUrl: "https://api.example.jp", requireAuth: false });
  assert.equal(explicitFalse.requireAuth, false);

  const truthyButNotTrue = normalizeCloudConfig({ provider: "sakura", apiBaseUrl: "https://api.example.jp", requireAuth: "true" });
  assert.equal(truthyButNotTrue.requireAuth, false, "a string 'true' must not coerce to enabled");

  const explicitTrue = normalizeCloudConfig({ provider: "sakura", apiBaseUrl: "https://api.example.jp", requireAuth: true });
  assert.equal(explicitTrue.requireAuth, true);
});

test("requireAuth is always false on any unconfigured/misconfigured result, even if raw.requireAuth was true", () => {
  // Never let a stray requireAuth: true lock a farmer out of an app that
  // isn't even cloud-configured.
  assert.equal(normalizeCloudConfig({ provider: "sakura", requireAuth: true }).requireAuth, false); // missing apiBaseUrl
  assert.equal(normalizeCloudConfig({ provider: "supabase", requireAuth: true }).requireAuth, false); // missing url/anonKey
  assert.equal(normalizeCloudConfig({ provider: "nope", requireAuth: true }).requireAuth, false); // unknown provider
  assert.equal(
    normalizeCloudConfig({ provider: "supabase", url: "https://a.supabase.co", anonKey: jwtWithRole("service_role"), requireAuth: true })
      .requireAuth,
    false
  ); // rejected service_role key
});

test("the mock provider honors requireAuth, for browser-testing the production login gate without a real backend", () => {
  assert.equal(normalizeCloudConfig({ provider: "mock", requireAuth: true }).requireAuth, true);
  assert.equal(normalizeCloudConfig({ provider: "mock" }).requireAuth, false);
});

test("a supabase config never carries a stray apiBaseUrl", () => {
  const config = normalizeCloudConfig({
    provider: "supabase",
    url: "https://abc.supabase.co",
    anonKey: jwtWithRole("anon"),
    apiBaseUrl: "https://leftover.example.com"
  });
  assert.equal(config.configured, true);
  assert.equal(config.apiBaseUrl, "");
});

/** A JWT-shaped key with the given role claim, built the way Supabase does. */
function jwtWithRole(role) {
  const payload = Buffer.from(JSON.stringify({ iss: "supabase", role })).toString("base64url");
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.signature-not-verified-here`;
}

test("the shipped, unfilled config leaves the account feature off", () => {
  const config = normalizeCloudConfig({ provider: null, url: "", anonKey: "", redirectTo: null });
  assert.equal(config.configured, false);
  assert.equal(config.reason, "provider");
});

test("a missing config object is not an error, just unconfigured", () => {
  for (const input of [undefined, null, "", 42, []]) {
    const config = normalizeCloudConfig(input);
    assert.equal(config.configured, false, `input ${JSON.stringify(input)}`);
  }
});

test("supabase needs both a url and an anon key", () => {
  assert.equal(normalizeCloudConfig({ provider: "supabase", url: "https://x.supabase.co" }).reason, "credentials");
  assert.equal(normalizeCloudConfig({ provider: "supabase", anonKey: jwtWithRole("anon") }).reason, "credentials");
});

test("a fully specified supabase config is configured, with a trailing slash trimmed", () => {
  const config = normalizeCloudConfig({
    provider: "supabase",
    url: "https://abc.supabase.co/",
    anonKey: jwtWithRole("anon")
  });
  assert.equal(config.configured, true);
  assert.equal(config.url, "https://abc.supabase.co");
  assert.equal(config.sdkUrl, DEFAULT_SUPABASE_SDK_URL);
});

test("a service_role key is refused rather than shipped to a browser", () => {
  // This is the footgun that would bypass every RLS policy in the migration.
  const config = normalizeCloudConfig({
    provider: "supabase",
    url: "https://abc.supabase.co",
    anonKey: jwtWithRole("service_role")
  });
  assert.equal(config.configured, false);
  assert.equal(config.reason, "service_role_key");
  // The key is not carried forward either, so it cannot be read back off the
  // config object by anything downstream.
  assert.equal(config.anonKey, "");
  assert.match(unconfiguredReasonText("service_role_key"), /公開/);
});

test("both service-role key formats are recognised, and an anon key is not", () => {
  assert.equal(looksLikeServiceRoleKey(jwtWithRole("service_role")), true);
  assert.equal(looksLikeServiceRoleKey("sb_secret_abcdef123456"), true);
  assert.equal(looksLikeServiceRoleKey(jwtWithRole("anon")), false);
  assert.equal(looksLikeServiceRoleKey("sb_publishable_abcdef123456"), false);
  assert.equal(looksLikeServiceRoleKey(""), false);
  assert.equal(looksLikeServiceRoleKey(null), false);
});

test("an unknown provider does not enable anything", () => {
  const config = normalizeCloudConfig({ provider: "firebase", url: "https://x", anonKey: "k" });
  assert.equal(config.configured, false);
  assert.equal(config.reason, "provider");
});

test("the mock provider needs no credentials and is only reachable when named explicitly", () => {
  assert.equal(normalizeCloudConfig({ provider: "mock" }).configured, true);
  // Nothing about an empty/absent config can produce it.
  assert.notEqual(normalizeCloudConfig({}).provider, "mock");
  assert.notEqual(normalizeCloudConfig({ provider: "supabase", url: "u", anonKey: "k" }).provider, "mock");
});

test("the redirect URL keeps the GitHub Pages repository sub-path", () => {
  const url = resolveRedirectUrl({
    origin: "https://klayertan.github.io",
    pathname: "/michibiki-suimon-navi/index.html"
  });
  assert.equal(url, "https://klayertan.github.io/michibiki-suimon-navi/");
});

test("the redirect URL works for a directory URL and for local dev", () => {
  assert.equal(
    resolveRedirectUrl({ origin: "https://klayertan.github.io", pathname: "/michibiki-suimon-navi/" }),
    "https://klayertan.github.io/michibiki-suimon-navi/"
  );
  // Never hard-coded to localhost, and never hard-coded away from it either.
  assert.equal(resolveRedirectUrl({ origin: "http://127.0.0.1:4173", pathname: "/" }), "http://127.0.0.1:4173/");
});

test("an explicit redirectTo wins, for a custom domain", () => {
  const url = resolveRedirectUrl(
    { origin: "https://klayertan.github.io", pathname: "/michibiki-suimon-navi/" },
    "https://suisui.example.jp/app/"
  );
  assert.equal(url, "https://suisui.example.jp/app/");
});

test("readCloudConfig reads the global the config file assigns", () => {
  const scope = { SUISUI_CLOUD_CONFIG: { provider: "supabase", url: "https://a.supabase.co", anonKey: jwtWithRole("anon") } };
  assert.equal(readCloudConfig(scope).configured, true);
  assert.equal(readCloudConfig({}).configured, false);
});
