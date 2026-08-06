// One-time setup: create .venv and install the backend dependencies into it.
//   npm run backend:setup
//
// Never installs anything globally, and never touches the user's system
// Python packages.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { BACKEND_DIR, REPO_ROOT, VENV_DIR, systemPython, systemPythonArgs, venvExists, venvPython } from "./venv.mjs";

function run(command, args, label) {
  console.log(`\n> ${label}\n  ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: REPO_ROOT, stdio: "inherit", shell: false });
  if (result.error) {
    console.error(`\n${label} failed to start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`\n${label} exited with code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

if (!venvExists()) {
  run(systemPython(), [...systemPythonArgs(), "-m", "venv", VENV_DIR], "Creating .venv");
} else {
  console.log(`Reusing the existing virtual environment at ${VENV_DIR}`);
}

const python = venvPython();
run(python, ["-m", "pip", "install", "--upgrade", "pip"], "Upgrading pip");
run(python, ["-m", "pip", "install", "-r", join(BACKEND_DIR, "requirements-dev.txt")], "Installing backend dependencies");

console.log(
  [
    "",
    "Backend environment ready.",
    "",
    "  npm run backend:mock   start the backend with a simulated aircraft",
    "  npm run test:backend   run the backend test suite",
    ""
  ].join("\n")
);
