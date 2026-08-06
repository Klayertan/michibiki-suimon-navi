// Starts the MAVLink backend from the repository-local virtual environment.
//
//   npm run backend:mock    simulated aircraft, safe commands enabled
//   npm run backend:real    real COM10 link, read-only unless you opt in
//   npm run backend -- --mode mock --port COM7 --baud 57600
//
// Flags map onto SUISUI_MAVLINK_* environment variables. Anything already set
// in the environment wins, so a shell export still overrides a flag.

import { spawn } from "node:child_process";
import { BACKEND_DIR, requireVenv } from "./venv.mjs";

const FLAGS = {
  "--mode": "SUISUI_MAVLINK_MODE",
  "--port": "SUISUI_MAVLINK_PORT",
  "--baud": "SUISUI_MAVLINK_BAUD",
  "--host": "SUISUI_MAVLINK_HOST",
  "--http-port": "SUISUI_MAVLINK_HTTP_PORT",
  "--log-level": "SUISUI_MAVLINK_LOG_LEVEL"
};

const BOOLEAN_FLAGS = {
  "--allow-safe-commands": "SUISUI_MAVLINK_ALLOW_SAFE_COMMANDS",
  "--no-auto-reconnect": "SUISUI_MAVLINK_AUTO_RECONNECT"
};

const overrides = {};
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  const flag = argv[index];
  if (FLAGS[flag]) {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      console.error(`${flag} needs a value`);
      process.exit(1);
    }
    overrides[FLAGS[flag]] = value;
    index += 1;
  } else if (BOOLEAN_FLAGS[flag]) {
    overrides[BOOLEAN_FLAGS[flag]] = flag.startsWith("--no-") ? "0" : "1";
  } else {
    console.error(`Unknown option: ${flag}`);
    console.error(`Known options: ${[...Object.keys(FLAGS), ...Object.keys(BOOLEAN_FLAGS)].join(", ")}`);
    process.exit(1);
  }
}

const python = requireVenv();
// Environment first, flags second: an explicit export must not be overridden
// by a script default.
const env = { ...overrides, ...process.env };
const mode = env.SUISUI_MAVLINK_MODE ?? "mock";

if (mode === "real") {
  console.log(
    [
      "",
      "──────────────────────────────────────────────────────────────",
      " REAL MODE — this will open the serial telemetry link.",
      "",
      `   Port: ${env.SUISUI_MAVLINK_PORT ?? "COM10"} @ ${env.SUISUI_MAVLINK_BAUD ?? 57600} baud`,
      "",
      " Before connecting, confirm:",
      "   • propellers are removed",
      "   • the aircraft is disarmed",
      "   • QGroundControl is CLOSED (it cannot share the port)",
      "",
      " Arming and takeoff are not implemented in this backend.",
      "──────────────────────────────────────────────────────────────",
      ""
    ].join("\n")
  );
}

const child = spawn(python, ["-m", "app.main"], { cwd: BACKEND_DIR, stdio: "inherit", env });

// Forward the signal so the backend runs its shutdown hook: stop the heartbeat,
// close the port, then exit. Killing it hard would leave the port held until
// the OS reclaims it.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code) => process.exit(code ?? 0));
