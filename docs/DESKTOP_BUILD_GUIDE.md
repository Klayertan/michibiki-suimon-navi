# SuisuiNavi Desktop — Build Guide

How to build `SuisuiNavi.exe` from a checkout.

---

## 1. Requirements

| Item | Version used |
|---|---|
| Windows | 10 / 11 (64-bit). Built and tested on Windows 11 Pro 10.0.26200 |
| Python | 3.13.13 (build machine only — **not** needed on the target machine) |
| Node.js | 24.19.0 (build machine only, to run the JS unit tests) |
| Microsoft Edge WebView2 Runtime | **Required on the machine that runs the app.** Verified with 151.0.4129.59 |

The target machine needs **neither Python nor Node.js**. It needs the WebView2
Runtime, which ships with current Windows 10/11 and with Microsoft Edge.

---

## 2. One-time setup

```powershell
npm install
```

```powershell
npm run backend:setup
```

That creates `.venv` and installs `backend/requirements-dev.txt`. Then add the
two desktop/packaging dependencies:

```powershell
.venv\Scripts\python.exe -m pip install pywebview==5.3.2 pyinstaller==6.11.1
```

Verify:

```powershell
.venv\Scripts\python.exe -c "import webview, PyInstaller; print('ok')"
```

---

## 3. Build

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-windows.ps1
```

Output:

```
dist\SuisuiNavi\SuisuiNavi.exe
```

The script runs seven steps and stops at the first failure:

1. Verify the virtual environment
2. Verify build dependencies (`PyInstaller`, `webview`, `fastapi`, `uvicorn`, `pymavlink`, `serial`)
3. Verify the frontend assets exist
4. **Run the tests** — Python (`backend` + `desktop_tests`) and JavaScript (`npm test`)
5. Remove stale `dist\SuisuiNavi` and `build\` (only those two paths)
6. Run PyInstaller against `packaging\SuisuiNavi.spec`
7. Verify the executable exists and report its size

### Options

| Flag | Effect |
|---|---|
| `-SkipTests` | Skip step 4. Quick iteration only — do not ship such a build. |
| `-KeepBuild` | Keep `build\` for diagnosing a bundle that misses a module. |

### Measured output

| | |
|---|---|
| `SuisuiNavi.exe` | 9,452,362 bytes (9.01 MB) |
| Bundle total | 43,810,781 bytes (41.78 MB) |
| Build time | ~30–50 s after the first run |

---

## 4. Run without building

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-desktop.ps1 -Dev
```

Starts the same launcher, backend and window straight from the checkout —
useful for frontend or backend changes without waiting for PyInstaller.
`-Dev` enables DevTools and DEBUG logging. Equivalent to
`python -m desktop.launcher`.

Other switches: `-Mode preview|sitl|real`, `-Diagnostics`, `-NoWindow`.

---

## 5. Clean rebuild

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\clean-desktop-build.ps1
```

Removes `dist\SuisuiNavi`, `build\`, and `__pycache__` under `desktop/` and
`backend/`. Source, `.venv`, the frontend and user data are never touched.

Add `-IncludeUserData` to also clear `%LOCALAPPDATA%\SuisuiNavi` (window
settings, logs, diagnostics, gamepad calibration). It prompts first.

Then rebuild with the command in §3.

---

## 6. Why the entry point is a wrapper

The spec's entry script is `packaging\suisuinavi_entry.py`, **not**
`desktop\launcher.py`.

PyInstaller executes its entry script as `__main__`, not as a module inside its
package. Pointing the spec at `desktop\launcher.py` therefore breaks every
relative import in it:

```
ImportError: attempted relative import with no known parent package
```

This produced a packaged `.exe` that died before it could even open its log
file — the only symptom was a bare *"Unhandled exception in script"* dialog.
The wrapper runs as `__main__` and imports `desktop.launcher` absolutely, so
the package imports normally. `python -m desktop.launcher` is unaffected.

Two tests enforce this (`test_entry_wrapper_uses_absolute_imports_not_relative`,
`test_spec_entry_point_is_the_wrapper_not_the_launcher_module`).

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| **"Unhandled exception in script"** on launch, no log written | The bundle fails during import, before logging starts | Rebuild with `-KeepBuild`, then check `build\SuisuiNavi\warn-SuisuiNavi.txt` for missing modules. Add them to `hidden` in the spec. |
| **`ValueError: Unable to configure formatter 'default'`** | Uvicorn's `dictConfig` cannot resolve its formatter by dotted string in a frozen bundle | Already fixed: `uvicorn.Config(..., log_config=None)`. The launcher configures logging itself. |
| **`ImportError: attempted relative import…`** | The spec points at `desktop\launcher.py` | Use `packaging\suisuinavi_entry.py` — see §6. |
| **Window never appears, log ends at "WebView2 runtime … detected"** | WebView2 failed to create | Confirm the runtime version in the log; reinstall the Evergreen WebView2 Runtime. |
| **"The Microsoft Edge WebView2 Runtime is required…"** | Runtime absent | Install it from Microsoft. The app never downloads it automatically. |
| **"SuisuiNavi is already running"** | Another instance holds the named mutex | Switch to the existing window. Exit code is 3. If no window exists, the previous process is still terminating — wait a moment. |
| **Backend never becomes healthy** | Port taken, or the app failed to build | Check the log for `starting backend on 127.0.0.1:<port>`; it retries up to 3 times on different ports. |
| **SmartScreen warning on first run** | The build is **not code signed** | Expected. "More info" → "Run anyway", or sign it yourself. Do not describe this build as signed. |
| **Frontend loads but CSS/JS 404** | Assets missing from the bundle | Confirm `dist\SuisuiNavi\_internal\index.html`, `\css`, `\js` exist. `_frontend_data()` in the spec stages them. |

### Reading build logs

```powershell
# Missing-module warnings from the last build (needs -KeepBuild)
Get-Content .\build\SuisuiNavi\warn-SuisuiNavi.txt | Select-String "missing module"
```

```powershell
# Runtime log from the packaged app
Get-Content "$env:LOCALAPPDATA\SuisuiNavi\logs\suisuinavi-desktop.log" -Tail 40
```

```powershell
# Full diagnostics without opening a window
.\dist\SuisuiNavi\SuisuiNavi.exe --diagnostics
```

---

## 8. What the build does not do

* **No code signing.** Not claimed, not configured.
* **No installer.** The portable one-directory build comes first.
* **No one-file build** yet. One-directory is the primary format: faster
  startup (no per-launch extraction) and far easier to diagnose.
* **Never opens COM10.** The build script does not, and the built application
  starts in Preview mode with no serial access.
