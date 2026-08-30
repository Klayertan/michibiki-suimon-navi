// Assembles the deployable frontend into `dist/` for Cloudflare Workers.
//
// The repository root is a development checkout, not a web root: `backend/`,
// `.venv/`, `docs/`, `tests/` and `node_modules/` all live beside
// `index.html`. GitHub Pages tolerated that because it published the branch
// as-is and nobody linked to those paths. A Workers deployment uploads
// whatever directory it is pointed at, so the deployable files are copied out
// explicitly instead -- the same allow-list idea the desktop packager already
// uses (see packaging/SuisuiNavi.spec).
//
// The file list comes from `git ls-files`, deliberately:
//
//   * .gitignore is the project's existing record of what must not leave this
//     machine, and `data/*.nmea` is on it. A raw GNSS log is a timestamped
//     record of where a person actually stood; a build that globbed `data/`
//     would publish one field capture at a time, silently. Tracked files only
//     means an untracked capture cannot reach the internet by accident.
//   * Cloudflare Workers Builds clones the repository, so git is always
//     present where this runs in CI.
//
// No dependencies, no bundler, no transform: the files served are byte-for-byte
// the files in the repository, which is what keeps `node scripts/dev-server.mjs`
// and production the same application.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Everything the browser can ask for at runtime, and nothing else.
 *
 * Derived from the actual references in index.html:
 *   index.html  the application
 *   config/     cloud-config.js, loaded by a <script> tag before boot
 *   css/        the stylesheets <link>ed from <head>
 *   js/         every dynamic import() target
 *   data/       field.json, gate_rules.json, weather.json and samples/
 */
export const ASSET_ROOTS = ["index.html", "config", "css", "js", "data"];

/** Where wrangler.jsonc expects to find the assets. Keep the two in step. */
export const OUTPUT_DIR = "dist";

// Cloudflare's static-asset limits. Checked at build time so an over-limit
// deploy fails here, with a readable message, rather than at upload.
// https://developers.cloudflare.com/workers/platform/limits/
export const MAX_FILES = 20_000;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * Tracked, deployable files as repo-relative POSIX paths.
 *
 * Dotfiles are dropped: `data/.gitkeep` exists to keep an empty directory in
 * git and has no meaning to a browser.
 */
export function listAssetFiles({ cwd = REPO_ROOT, roots = ASSET_ROOTS } = {}) {
  const output = execFileSync("git", ["ls-files", "-z", "--", ...roots], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  return output
    .split("\0")
    .filter(Boolean)
    .filter((file) => !posix.basename(file).startsWith("."))
    .sort();
}

/**
 * Every same-origin path index.html asks the browser to load: <script src>,
 * <link href>, the dynamic import() targets, and the fetch()ed data files.
 * External URLs, data: URIs and in-page anchors are not our problem.
 */
export function findLocalReferences(html) {
  const found = new Set();
  for (const [, path] of html.matchAll(/(?:src|href)="(?!https?:|data:|#|mailto:)([^"]+)"/g)) {
    found.add(path.replace(/^\.\//, "").split(/[?#]/)[0]);
  }
  for (const [, path] of html.matchAll(/import\(\s*["'](\.\/[^"']+)["']/g)) {
    found.add(path.replace(/^\.\//, ""));
  }
  for (const [, path] of html.matchAll(/fetch\(\s*["'](data\/[^"']+)["']/g)) {
    found.add(path);
  }
  return found;
}

/**
 * References index.html makes that the build would not ship -- which in
 * production is a 404 and, for a module, a browser error about a MIME type
 * that says nothing about the real cause.
 *
 * This has bitten the project before: the usual way in is to write a new
 * module, wire it into index.html, and commit only index.html. `git ls-files`
 * is the source of truth for what ships, so an uncommitted module is an
 * invisible module. Failing the build is the point -- a working tree in this
 * state is genuinely not deployable, and the fix is `git add`.
 */
export function missingReferences(html, shipped) {
  const have = new Set(shipped);
  return [...findLocalReferences(html)].filter((path) => !have.has(path)).sort();
}

function build() {
  const files = listAssetFiles();
  if (files.length === 0) {
    throw new Error("no deployable files found -- is this a git checkout?");
  }
  if (files.length > MAX_FILES) {
    throw new Error(`${files.length} files exceeds Cloudflare's ${MAX_FILES}-file limit`);
  }

  const missing = missingReferences(readFileSync(join(REPO_ROOT, "index.html"), "utf8"), files);
  if (missing.length > 0) {
    throw new Error(
      `index.html loads files the build cannot ship:\n  ${missing.join("\n  ")}\n` +
        "They are untracked, so they would 404 in production. `git add` them (or drop the reference)."
    );
  }

  const outputRoot = join(REPO_ROOT, OUTPUT_DIR);
  rmSync(outputRoot, { recursive: true, force: true });

  let bytes = 0;
  for (const file of files) {
    const source = join(REPO_ROOT, file);
    const size = statSync(source).size;
    if (size > MAX_FILE_BYTES) {
      throw new Error(`${file} is ${size} bytes, over Cloudflare's ${MAX_FILE_BYTES}-byte per-file limit`);
    }
    bytes += size;
    const destination = join(outputRoot, file);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination);
  }

  const kib = Math.round(bytes / 1024);
  console.log(`${OUTPUT_DIR}/: ${files.length} files, ${kib} KiB`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build();
}
