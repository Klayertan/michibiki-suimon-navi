// Locates the repository-local Python virtual environment.
//
// The backend must never depend on globally installed Python packages, so
// every script goes through here rather than calling `python` directly. If the
// venv is missing, the error tells the operator exactly how to create it
// instead of failing with a confusing ENOENT.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const VENV_DIR = join(REPO_ROOT, ".venv");
export const BACKEND_DIR = join(REPO_ROOT, "backend");

const isWindows = process.platform === "win32";

/** Path to the venv interpreter (may not exist yet). */
export function venvPython() {
  return isWindows ? join(VENV_DIR, "Scripts", "python.exe") : join(VENV_DIR, "bin", "python");
}

export function venvExists() {
  return existsSync(venvPython());
}

/** Interpreter used to *create* the venv. Override with SUISUI_PYTHON. */
export function systemPython() {
  if (process.env.SUISUI_PYTHON) return process.env.SUISUI_PYTHON;
  return isWindows ? "py" : "python3";
}

export function systemPythonArgs() {
  // The Windows launcher needs an explicit -3 to avoid picking up a stray
  // Python 2 association.
  return isWindows && !process.env.SUISUI_PYTHON ? ["-3"] : [];
}

/** Exit with an actionable message when the venv has not been created yet. */
export function requireVenv() {
  if (venvExists()) return venvPython();
  console.error(
    [
      "",
      "Python virtual environment not found at .venv",
      "",
      "Create it once with:",
      "  npm run backend:setup",
      "",
      "or manually:",
      isWindows
        ? "  py -3 -m venv .venv && .venv\\Scripts\\python.exe -m pip install -r backend\\requirements-dev.txt"
        : "  python3 -m venv .venv && .venv/bin/python -m pip install -r backend/requirements-dev.txt",
      ""
    ].join("\n")
  );
  process.exit(1);
}
