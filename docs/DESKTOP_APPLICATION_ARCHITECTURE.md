# SuisuiNavi Desktop Application — Architecture

How `SuisuiNavi.exe` wraps the existing web application in a Windows desktop
shell, and why each piece is built the way it is.

> **The desktop conversion adds no new path to the aircraft.** It starts the
> same FastAPI backend on a loopback port and points a WebView at it. Arming,
> takeoff, and manual flight control are not implemented anywhere in this
> application.

---

## 1. Shape

```
SuisuiNavi.exe  (PyInstaller one-directory bundle)
│
├── packaging/suisuinavi_entry.py      ← the frozen entry point (__main__)
│      └── imports desktop.launcher absolutely
│
├── desktop/                            ← the shell (new)
│   ├── launcher.py       orchestration, logging, window, shutdown, crash handling
│   ├── runtime.py        runtime modes, config, free port, Uvicorn lifecycle
│   ├── paths.py          dev vs frozen assets; %LOCALAPPDATA% layout
│   ├── single_instance.py named-mutex guard (Windows) / flock (POSIX)
│   └── diagnostics.py    version, WebView2, backend and MAVLink status
│
├── backend/app/                        ← unchanged, plus one new module
│   ├── main.py           the same FastAPI app the browser workflow uses
│   └── desktop_assets.py serves the existing frontend + injects desktop context
│
└── index.html, css/, js/, data/        ← the existing frontend, unmodified
```

Nothing about the frontend was duplicated or rewritten. The browser workflow
(`npm run dev`, `http://localhost:4173`) still works exactly as before; the
desktop path simply serves the same files from FastAPI instead of from
`scripts/dev-server.mjs`.

---

## 2. Why PyWebView

Selected. No incompatibility was found.

| Consideration | Outcome |
|---|---|
| Existing stack | The backend is already a loopback FastAPI/Uvicorn app and the frontend is plain ES modules. A WebView shell wraps both without touching either. |
| Rendering engine | Windows WebView2 (Chromium). Verified present: runtime **151.0.4129.59**. Same engine family the app is already developed against. |
| Packaging | pywebview 5.3.2 freezes cleanly with PyInstaller once `webview` submodules are collected. |
| Cost of alternatives | Electron would mean a second runtime, a Node build step, and a duplicated frontend pipeline. Qt would mean rewriting the UI. Neither is justified when the existing web UI is the product. |

Rejected without prejudice: if a future phase needs deep OS integration
(tray, global hotkeys, native gamepad at a lower level), revisiting is
reasonable — but not for this conversion.

---

## 3. Startup sequence

1. **Resolve paths.** `desktop.paths` picks `sys._MEIPASS` when frozen, the
   repository root otherwise, and creates `%LOCALAPPDATA%\SuisuiNavi\`.
2. **Start logging.** Rotating file handler (2 MB × 5) before anything can
   fail, so a startup crash is still diagnosable.
3. **Take the single-instance guard** (§5). A second launch stops here.
4. **Verify frontend assets.** Missing `index.html`/`css`/`js` fails loudly
   rather than opening a window onto a 404.
5. **Start the backend.** A free loopback port is chosen by binding port 0;
   Uvicorn runs on a daemon thread inside this process; `/api/health` is
   polled until it answers (or the server dies, which aborts the wait early).
6. **Check WebView2.** Missing runtime produces an actionable dialog. Nothing
   is ever downloaded automatically.
7. **Open the window** and enter the GUI loop.

Measured on the development machine: **1.4–4.1 s** from launch to a healthy
backend.

### Why the backend is a thread, not a subprocess

An orphaned `python.exe` after the window closes would keep COM10 locked. A
thread cannot outlive its process, so that failure mode does not exist.
Shutdown is a flag plus a join rather than a signal plus a wait.

---

## 4. Shutdown sequence

Triggered by the window closing, and by the crash handler.

1. Window geometry is written from **in-memory** values.
2. Backend stops: `server.should_exit = True`, then a bounded join. Uvicorn's
   lifespan hook runs `manager.shutdown()`, which stops the MAVLink heartbeat
   and closes the serial port.
3. Single-instance guard released.
4. Log handlers flushed.

Every step is bounded (8 s) and wrapped so a failure in one still runs the
rest. Verified: **2.69 s** from close to exit, 0 processes, 0 listeners, 0
orphaned WebView2 children.

### The `closing` handler must not touch the window

`_on_closing` only logs. Calling `evaluate_js()` there deadlocks: the WebView
is already being destroyed, so a request for a JavaScript result waits for a
reply that never comes and the process hangs. This was observed — the log
stopped mid-shutdown and the executable had to be killed. Window geometry is
therefore captured from `resized`/`moved` events while the app runs, and
written during shutdown, which runs off the GUI thread.

---

## 5. Single-instance protection

**Authority: a named kernel object.** Windows: a mutex named
`Local\SuisuiNavi.Desktop.<app-guid>` via `CreateMutexW`;
`ERROR_ALREADY_EXISTS` means another instance owns the application. POSIX:
`flock` on a lock file, for development and CI.

The handle is held for the whole process lifetime — holding it *is* the
exclusion — and closed during shutdown. A crash releases it automatically
because the kernel destroys the object when the last handle closes: there is
no stale state and nothing to reclaim.

A second launch shows a concise message and exits with **code 3**
(`EXIT_ALREADY_RUNNING`). It starts no backend, selects no port, opens no
window, touches no serial port, and never disturbs the running instance.

A small JSON file (`suisuinavi.lock`) records the chosen port and start time
**for diagnostics only**. Nothing reads it to decide whether to start.

### Why not a PID file

The first implementation stored a PID and probed it with `os.kill(pid, 0)`.
On POSIX that is a valid no-op probe. **On Windows it is not a probe at all** —
CPython implements it as `OpenProcess(PROCESS_ALL_ACCESS)` followed by
`TerminateProcess`. Observed: `OpenProcess` was denied, the resulting
`OSError` was read as "the process is gone", the lock was reclaimed as stale,
and a second full application started with two windows. Had `OpenProcess`
succeeded it would have **terminated the running instance** instead. The call
appears nowhere in the desktop package now, and a test enforces that against
executable code (docstrings excluded via AST).

---

## 6. Frontend delivery

`backend/app/desktop_assets.mount_frontend()` serves the existing files and
injects a `<script>` immediately after `<head>`:

```js
window.SUISUI_DESKTOP = Object.freeze({ mode, modeLabel, allowsSerial, ... });
window.SUISUI_DRONE_BACKEND_URL = window.location.origin;
```

* The injection happens on the **response**, never on the file — `index.html`
  on disk is untouched and still works in a browser, where the global is
  simply absent.
* It is inside `<head>` because the page's own bootstrap reads
  `SUISUI_DRONE_BACKEND_URL` while evaluating; a tag at the end of `<body>`
  would be too late.
* Same-origin is required: in the desktop the backend *is* the web server, so
  the development default `http://127.0.0.1:8787` would point at a different,
  probably absent, server.

Only `css/`, `js/`, `data/`, `assets/`, `icons/`, `img/` are mounted, plus an
allow-list of root files. `backend/`, `.venv/`, `tests/` and `package.json`
are not reachable — verified by test.

---

## 7. Runtime modes

| Mode | Backend transport | Serial | Notes |
|---|---|---|---|
| **Preview** (default) | mock | never | Mock telemetry, keyboard and simulated gamepad preview |
| **SITL** | mock | never | Reserved for a future simulator; cannot reach hardware today |
| **Real** | real | only on an explicit UI action | Read-only, no auto-connect, no auto-reconnect |

The mode is a per-launch decision and is **never** restored from stored
configuration — `runtimeMode` is on the forbidden-config key list, so a
hand-edited or hostile file cannot make the app start in Real.

Real mode additionally sets `auto_reconnect=False`, so the app cannot re-open
a serial port the operator deliberately disconnected.

---

## 8. Configuration and logs

`%LOCALAPPDATA%\SuisuiNavi\` — outside the installation directory, which may
be read-only or replaced by the next build.

```
config\desktop.json     window geometry, workspace, UI preferences
logs\                   rotating desktop log (2 MB × 5)
cache\
calibration\            gamepad calibration
diagnostics\            diagnostics.json, crash.log
suisuinavi.lock         diagnostics only (port, start time)
```

**Never persisted**, enforced in `DesktopConfig.from_dict` rather than merely
"not written", so a hand-edited file cannot inject them either: `deadman`,
`pressedKeys`, `controlValues`, `armed`, `activeSession`, `flightSession`,
`sitlControlSession`, `commandAuthorization`, `allowSafeCommands`,
`runtimeMode`.

A malformed config yields defaults with a warning — refusing to start over a
bad preferences file would be a worse failure than losing the preferences.

---

## 9. Input

One source at a time: **None / Keyboard / Browser gamepad / Simulated
gamepad**. Switching zeroes all output first.

The keyboard provider emits the *same sample shape* as the gamepad providers,
so it flows through the identical normalization, calibration and dead-man
gating in `gamepad-normalization.js`. There is deliberately no separate
control path.

Zeroing happens on: dead-man release, `Escape`, window blur, tab hidden,
`pagehide`, source switch, and the native shell's `window.suisuiDesktopBlur()`
hook.

---

## 10. Security posture

* Backend binds `127.0.0.1` on an unpredictable port; the CORS allow-list is
  pinned to that exact origin.
* The desktop shell never widens the backend's command surface —
  `allow_safe_commands=False` in every mode.
* The JS-callable API is three read-only methods (diagnostics, runtime info,
  open-logs-folder). No file read/write, no command execution, nothing
  MAVLink-related; the frontend uses the same validated HTTP endpoints as the
  browser.
* DevTools only in development builds (`--dev`).
* The build is **not code signed**; SmartScreen will warn on first run.

---

## 11. Known limitations

1. **Browser Gamepad API inside WebView2 is untested with a physical
   controller.** No pad was attached during this work. The simulated provider
   and the keyboard provider were verified in the packaged app. A native
   fallback (SDL/pygame) was therefore **not** implemented — adding one
   speculatively would be guessing at a problem not yet shown to exist.
2. **One-file build not produced.** The one-directory build is the primary
   format, per plan; one-file remains optional future work.
3. **No installer**, by instruction — the portable directory build comes first.
4. **SITL is a placeholder.** It maps to the mock transport and does not
   connect to a simulator yet.
5. **Startup measured only on this machine** (1.4–4.1 s); a cold first run on
   another machine will be slower.
