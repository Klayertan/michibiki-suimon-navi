// Runs the backend test suite in the repository-local virtual environment.
//   npm run test:backend
//   npm run test:backend -- -k command_service -v
//
// The suite is mock-only: it never opens a serial port.

import { spawnSync } from "node:child_process";
import { BACKEND_DIR, requireVenv } from "./venv.mjs";

const python = requireVenv();
const result = spawnSync(python, ["-m", "pytest", ...process.argv.slice(2)], {
  cwd: BACKEND_DIR,
  stdio: "inherit",
  // Force mock mode regardless of the developer's shell, so a stray
  // SUISUI_MAVLINK_MODE=real export cannot influence a test run.
  env: { ...process.env, SUISUI_MAVLINK_MODE: "mock" }
});

if (result.error) {
  console.error(`pytest failed to start: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
