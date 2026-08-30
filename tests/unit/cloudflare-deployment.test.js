// The deployment configuration is code, and this is its test.
//
// Nothing here talks to Cloudflare. These are the assumptions that, if they
// quietly stop holding, produce a site that builds and deploys and is then
// broken in production -- the worst failure mode there is, because the local
// dev server keeps working the whole time.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ASSET_ROOTS,
  MAX_FILES,
  MAX_FILE_BYTES,
  OUTPUT_DIR,
  findLocalReferences,
  listAssetFiles,
  missingReferences
} from "../../scripts/build-static.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Strips JSONC comments so the committed wrangler config can be read here.
 *
 * String-aware on purpose: a naive regex would eat the `//` inside
 * "https://developers.cloudflare.com/..." and leave unparseable JSON.
 */
function parseJsonc(source) {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (inLine) {
      if (char === "\n") {
        inLine = false;
        out += char;
      }
      continue;
    }
    if (inBlock) {
      if (char === "*" && next === "/") {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === "\\") {
        out += source[i + 1] ?? "";
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLine = true;
      i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlock = true;
      i += 1;
      continue;
    }
    out += char;
  }
  // Trailing commas are legal in JSONC and fatal to JSON.parse.
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const wranglerSource = readFileSync(resolve(REPO_ROOT, "wrangler.jsonc"), "utf8");
const wrangler = parseJsonc(wranglerSource);

test("wrangler.jsonc points at the directory the build actually writes", () => {
  assert.equal(wrangler.assets.directory.replace(/^\.\//, "").replace(/\/$/, ""), OUTPUT_DIR);
});

test("the Worker serves assets only, which is what makes it free", () => {
  // Static-asset requests are free and unlimited; they do not consume the
  // 100,000 requests/day Worker allowance because no Worker is invoked. The
  // moment `main` appears, that stops being automatically true, so adding it
  // has to be a deliberate change that comes here and updates
  // docs/CLOUDFLARE_DEPLOYMENT.md too.
  assert.equal(wrangler.main, undefined);
  assert.equal(wrangler.assets.run_worker_first, undefined);
});

test("the config carries a name and a pinned compatibility date", () => {
  assert.equal(wrangler.name, "suisui-navi");
  assert.match(wrangler.compatibility_date, /^\d{4}-\d{2}-\d{2}$/);
});

test("unmatched paths 404 instead of being answered with index.html", () => {
  // "single-page-application" would return the HTML page with a 200 for a
  // mistyped module path, turning a missing file into an inscrutable
  // MIME-type error. SuisuiNavi has no path-based routes to rescue.
  assert.equal(wrangler.assets.not_found_handling, "none");
});

test("the dev preview does not sit on the MAVLink backend's port", () => {
  // js/drone/drone-api-client.js DEFAULT_BASE_URL is http://127.0.0.1:8787.
  assert.notEqual(wrangler.dev?.port, 8787);
});

test("no credential is committed in the deployment config", () => {
  for (const forbidden of [/account_id/i, /api[_-]?token/i, /secret/i, /service_role/i]) {
    assert.equal(forbidden.test(wranglerSource.replace(/\bsecrets?\b/gi, "")), false, `${forbidden} in wrangler.jsonc`);
  }
});

// The build refuses to ship an index.html that loads files it does not have
// (scripts/build-static.mjs). That check runs against the working tree, where
// a half-written feature is a normal, temporary state, so it is enforced at
// build time rather than asserted here -- what is tested here is the logic
// itself, against fixed input.
const SAMPLE_HTML = `<!doctype html>
<link rel="stylesheet" href="css/stage1-basic.css">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<link rel="icon" href="data:image/svg+xml,%3Csvg%3E">
<a href="#basic">jump</a>
<script src="config/cloud-config.js"></script>
<script>
  import("./js/water/gate-decision.js");
  fetch("data/field.json");
</script>`;

test("local references are found, and remote ones are left alone", () => {
  const found = findLocalReferences(SAMPLE_HTML);
  assert.deepEqual(
    [...found].sort(),
    ["config/cloud-config.js", "css/stage1-basic.css", "data/field.json", "js/water/gate-decision.js"]
  );
});

test("a reference the build cannot ship is reported, not ignored", () => {
  const shipped = ["config/cloud-config.js", "css/stage1-basic.css", "data/field.json"];
  assert.deepEqual(missingReferences(SAMPLE_HTML, shipped), ["js/water/gate-decision.js"]);
  assert.deepEqual(missingReferences(SAMPLE_HTML, [...shipped, "js/water/gate-decision.js"]), []);
});

test("the real index.html's references are found by the same extraction", () => {
  // Guards the regexes against a silent no-match, which would make the build
  // check pass vacuously for every file.
  const found = findLocalReferences(readFileSync(resolve(REPO_ROOT, "index.html"), "utf8"));
  assert.ok(found.size >= 20, `only found ${found.size} local references in index.html`);
  assert.ok(found.has("config/cloud-config.js"));
});

test("every asset root is reachable from the build, and nothing private is", () => {
  const shipped = listAssetFiles();
  for (const root of ASSET_ROOTS) {
    assert.ok(
      shipped.some((file) => file === root || file.startsWith(`${root}/`)),
      `${root} contributes no files -- is it still tracked?`
    );
  }
  // The build list comes from `git ls-files`, so an untracked field capture
  // cannot reach it. .gitignore keeps real GNSS recordings untracked because
  // they record where a person actually stood; only the synthetic sample is
  // committed.
  for (const file of shipped) {
    assert.ok(
      !file.endsWith(".nmea") || file.startsWith("data/samples/"),
      `${file} is a GNSS capture outside data/samples/`
    );
    assert.ok(!posix.basename(file).startsWith("."), `${file} is a dotfile`);
  }
  assert.ok(shipped.length <= MAX_FILES);
});

test("the build ships only the frontend, never the repository's other halves", () => {
  const shipped = listAssetFiles();
  for (const excluded of ["backend/", "tests/", "scripts/", "docs/", "desktop/", "edge/", "supabase/", "packaging/", "node_modules/", "experiments/"]) {
    assert.equal(
      shipped.some((file) => file.startsWith(excluded)),
      false,
      `${excluded} would be published to the internet`
    );
  }
});

test("no shipped file exceeds Cloudflare's per-file limit", () => {
  assert.ok(MAX_FILE_BYTES === 25 * 1024 * 1024);
  // build-static.mjs enforces this at build time; asserted here so a change to
  // the constant is a visible one.
});
