# SuisuiNavi Desktop — Release Checklist

Run top to bottom. Tick only what you have actually observed — a box ticked
from memory is worse than an unticked one.

> **Never open COM10 or power the aircraft during a build or a packaged smoke
> test.** Every item below is satisfiable in Preview mode.

---

## 1. Repository state

- [ ] `git status` reviewed; no unintended files
- [ ] `git diff --check` exits 0 (no whitespace errors)
- [ ] Version bumped in `desktop/__init__.py` and `packaging/version_info.txt` (they must agree)
- [ ] No secrets, tokens, or absolute developer paths in the diff

## 2. Tests — all green before building

- [ ] `npm.cmd test` — JavaScript unit tests
- [ ] `npm.cmd run test:backend` — backend pytest
- [ ] `.venv\Scripts\python.exe -m pytest desktop_tests -q` — desktop shell
- [ ] `npx playwright test tests/browser/desktop.spec.js` — desktop frontend
- [ ] `npx playwright test` — full browser suite; any failure understood and
      documented as pre-existing, not hand-waved

Last recorded: **148 JS · 218 backend · 112 desktop (+1 skipped) · 16 desktop-spec · 162/164 full suite** (2 known-flaky pre-existing).

## 3. Build

- [ ] `powershell -ExecutionPolicy Bypass -File .\scripts\build-windows.ps1`
      run **without** `-SkipTests`
- [ ] Build completed with no PyInstaller errors
- [ ] `Test-Path .\dist\SuisuiNavi\SuisuiNavi.exe` → **True**
- [ ] Executable size recorded: ____________ (last: 9,452,362 B / 9.01 MB)
- [ ] Bundle size recorded: ____________ (last: 43,810,781 B / 41.78 MB)
- [ ] `dist\SuisuiNavi\_internal\index.html`, `\css`, `\js`, `\data` present

## 4. Packaged smoke test — first launch

- [ ] `Start-Process .\dist\SuisuiNavi\SuisuiNavi.exe`
- [ ] A native window opens titled `SuisuiNavi — Preview`
- [ ] **No browser opened**
- [ ] Backend became healthy; startup time recorded: ______ s (last: 1.4–4.1 s)
- [ ] Frontend rendered; CSS and JS modules loaded (no blank/unstyled page)
- [ ] A WebView2 process is a child of `SuisuiNavi.exe`
- [ ] `/api/drone/status` reports `mode: mock`, `connectionState: disconnected`, empty serial port
- [ ] **COM10 not opened** — no serial modules loaded in the process

## 5. Input

- [ ] Input source selector offers None / Keyboard / Browser / Simulated
- [ ] Keyboard capture is off until the button is pressed
- [ ] W/A/S/D and arrows move the correct axes **only while Left Shift is held**
- [ ] Releasing Left Shift zeroes every value immediately
- [ ] `Escape` neutralises and stops capture
- [ ] Typing in a text field does not trigger flight keys
- [ ] Simulated gamepad connects, moves the preview, and shows `SIMULATION`
- [ ] Disconnecting the simulated pad reports **Not detected / unavailable / no /
      inactive — source unavailable** (never "Neutral: active")
- [ ] Switching source zeroes output

## 6. Single instance

- [ ] Launch a second `SuisuiNavi.exe`
- [ ] It shows "SuisuiNavi is already running" and exits with **code 3**
- [ ] Only **one** SuisuiNavi process remains
- [ ] Only **one** backend listener exists
- [ ] The first instance is still healthy and untouched

## 7. Shutdown

- [ ] Close the window
- [ ] Log shows: MAVLink shutdown → backend stopped cleanly → mutex released → shutdown complete
- [ ] `Get-Process SuisuiNavi` returns nothing
- [ ] The backend port is no longer listening
- [ ] No orphaned `msedgewebview2.exe` children remain
- [ ] `suisuinavi.lock` removed
- [ ] Shutdown time recorded: ______ s (last: 2.69 s)

## 8. Relaunch

- [ ] Launch again after closing — starts normally (mutex was released)
- [ ] Preview mode again; no state carried over from the previous session

## 9. Safety audit — must all be true

- [ ] No arm, takeoff, land, RTL, motor-test, RC-override, manual-control or
      setpoint path exists anywhere in the desktop shell
- [ ] `allow_safe_commands` is `False` in every runtime mode
- [ ] Preview and SITL map to the mock transport and cannot reach hardware
- [ ] Real mode does not auto-connect and does not auto-reconnect
- [ ] Runtime mode is not persisted (a restart cannot come back in Real)
- [ ] Dead-man state, pressed keys, control values and armed state are not persisted
- [ ] `os.kill` appears nowhere in single-instance logic
- [ ] Backend binds loopback only, CORS pinned to its own origin
- [ ] The JS-callable API exposes no file, shell or MAVLink access

## 10. Documentation

- [ ] `DESKTOP_APPLICATION_ARCHITECTURE.md` matches what was built
- [ ] `DESKTOP_BUILD_GUIDE.md` build command and paths are correct
- [ ] `DESKTOP_OPERATOR_GUIDE.md` reflects the actual UI
- [ ] Known limitations are stated honestly, including anything untested
- [ ] Nothing claims code signing

## 11. Release notes must state plainly

- [ ] Keyboard and gamepad manual flight control of the real aircraft is **not enabled**
- [ ] The application starts in Preview mode and never auto-connects
- [ ] WebView2 Runtime is required on the target machine
- [ ] The build is **not code signed**; SmartScreen will warn
- [ ] Which gamepad path was actually tested, and which was not

---

## Currently untested — carry forward

State these in every release until resolved:

1. **Browser Gamepad API with a physical controller inside WebView2** — no pad
   was attached. Only the simulated and keyboard providers were verified in the
   packaged app. No native (SDL/pygame) fallback was implemented, because no
   failure has been demonstrated that would justify one.
2. **Real-mode packaged run against hardware** — never exercised; COM10 was
   deliberately not opened.
3. **One-file build** — not produced.
4. **Installer** — not produced.
5. **Machines other than the build machine** — startup timings and WebView2
   presence are from one Windows 11 workstation.
