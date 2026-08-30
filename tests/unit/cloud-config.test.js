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

test("the redirect URL is the origin root when the app is served from one", () => {
  // Cloudflare Workers serves SuisuiNavi from the root of its own hostname,
  // so the redirect is the bare origin -- no sub-path to preserve.
  assert.equal(
    resolveRedirectUrl({ origin: "https://suisui-navi.workers.dev", pathname: "/" }),
    "https://suisui-navi.workers.dev/"
  );
  assert.equal(
    resolveRedirectUrl({ origin: "https://suisui-navi.workers.dev", pathname: "/index.html" }),
    "https://suisui-navi.workers.dev/"
  );
});

test("the redirect URL keeps a repository-style sub-path when there is one", () => {
  // Not the production host any more, but the desktop shell and any future
  // sub-path deployment still depend on the filename being dropped without
  // the directory going with it.
  const url = resolveRedirectUrl({
    origin: "https://example.test",
    pathname: "/michibiki-suimon-navi/index.html"
  });
  assert.equal(url, "https://example.test/michibiki-suimon-navi/");
});

test("the redirect URL works for a directory URL and for local dev", () => {
  assert.equal(
    resolveRedirectUrl({ origin: "https://example.test", pathname: "/michibiki-suimon-navi/" }),
    "https://example.test/michibiki-suimon-navi/"
  );
  // Never hard-coded to localhost, and never hard-coded away from it either.
  assert.equal(resolveRedirectUrl({ origin: "http://127.0.0.1:4173", pathname: "/" }), "http://127.0.0.1:4173/");
});

test("an explicit redirectTo wins, for a custom domain", () => {
  const url = resolveRedirectUrl(
    { origin: "https://suisui-navi.workers.dev", pathname: "/" },
    "https://suisui.example.jp/app/"
  );
  assert.equal(url, "https://suisui.example.jp/app/");
});

test("readCloudConfig reads the global the config file assigns", () => {
  const scope = { SUISUI_CLOUD_CONFIG: { provider: "supabase", url: "https://a.supabase.co", anonKey: jwtWithRole("anon") } };
  assert.equal(readCloudConfig(scope).configured, true);
  assert.equal(readCloudConfig({}).configured, false);
});
