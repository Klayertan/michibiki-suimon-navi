// Starts the static frontend server and the mock MAVLink backend together.
//   npm run dev
//
// Deliberately a ~50-line supervisor rather than a process-manager dependency:
// two children, prefixed output, and one shutdown path that stops both.
//
// This never starts the backend in real mode. Use `npm run backend:real` in its
// own terminal when you actually want the serial link, so opening COM10 is
// always a conscious act.

import { spawn } from "node:child_process";
import { join } from "node:path";
import { BACKEND_DIR, REPO_ROOT, requireVenv } from "./venv.mjs";

const python = requireVenv();
const children = [];
let shuttingDown = false;

function start(name, command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  const write = (stream, chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line.length) stream.write(`[${name}] ${line}\n`);
    }
  };
  child.stdout.on("data", (chunk) => write(process.stdout, chunk));
  child.stderr.on("data", (chunk) => write(process.stderr, chunk));
  child.on("exit", (code) => {
    if (shuttingDown) return;
    console.error(`[dev] ${name} exited with code ${code}; stopping everything.`);
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    // SIGTERM so the backend runs its shutdown hook and releases the port.
    child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 500);
}

start("frontend", process.execPath, [join(REPO_ROOT, "scripts", "dev-server.mjs")], { cwd: REPO_ROOT });
start("backend", python, ["-m", "app.main"], {
  cwd: BACKEND_DIR,
  env: {
    ...process.env,
    SUISUI_MAVLINK_MODE: process.env.SUISUI_MAVLINK_MODE ?? "mock",
    SUISUI_MAVLINK_ALLOW_SAFE_COMMANDS: process.env.SUISUI_MAVLINK_ALLOW_SAFE_COMMANDS ?? "1"
  }
});

console.log(
  [
    "",
    "  frontend  http://localhost:4173/",
    "  backend   http://127.0.0.1:8787/  (mock mode)",
    "",
    "  Ctrl+C stops both.",
    ""
  ].join("\n")
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(0));
}
