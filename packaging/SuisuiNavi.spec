# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for SuisuiNavi.exe (one-directory build).

Build with the wrapper script rather than calling PyInstaller directly:

    powershell -ExecutionPolicy Bypass -File .\\scripts\\build-windows.ps1

Output: ``dist\\SuisuiNavi\\SuisuiNavi.exe``

One-directory (``COLLECT``) rather than one-file is deliberate for the primary
build: startup is faster (no per-launch extraction of the whole bundle to a
temp directory), crashes are far easier to diagnose because the tree is
inspectable, and the frontend assets stay visible as ordinary files.

The frontend is bundled *flat* at the bundle root -- ``index.html``, ``css/``,
``js/``, ``data/`` -- which is exactly what ``desktop.paths.frontend_root()``
expects when it resolves ``sys._MEIPASS``. Changing this layout means changing
that function too.
"""

import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules

# SPECPATH is injected by PyInstaller; the repository root is its parent.
REPO_ROOT = Path(SPECPATH).parent  # noqa: F821 - PyInstaller global
BACKEND_ROOT = REPO_ROOT / "backend"


def _git_revision() -> str:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=str(REPO_ROOT), capture_output=True, text=True, timeout=10, check=False,
        )
        return result.stdout.strip() or "unknown"
    except Exception:
        return "unknown"


# Build stamp read back by desktop.diagnostics.build_stamp() at runtime, so the
# packaged app can report which revision it came from (a frozen build has no
# .git directory to ask).
_build_info = REPO_ROOT / "build" / "build-info.json"
_build_info.parent.mkdir(parents=True, exist_ok=True)
_build_info.write_text(
    json.dumps(
        {
            "gitRevision": _git_revision(),
            "builtAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "oneFile": False,
        },
        indent=2,
    ),
    encoding="utf-8",
)


def _frontend_data() -> list[tuple[str, str]]:
    """(source, destination) pairs for the existing web frontend.

    Only the directories the app actually serves are bundled -- see
    ``backend/app/desktop_assets.SERVED_DIRECTORIES``. The repository's
    ``backend/``, ``.venv/``, ``tests/`` and ``node_modules/`` are never
    included: they are not needed at runtime and shipping source would bloat
    the build for no benefit.
    """
    entries: list[tuple[str, str]] = [(str(REPO_ROOT / "index.html"), ".")]
    for name in ("css", "js", "data"):
        directory = REPO_ROOT / name
        if directory.is_dir():
            entries.append((str(directory), name))
    for optional in ("favicon.ico", ".nojekyll"):
        candidate = REPO_ROOT / optional
        if candidate.is_file():
            entries.append((str(candidate), "."))
    entries.append((str(_build_info), "."))
    return entries


# uvicorn and pymavlink resolve much of their surface dynamically, so static
# analysis alone misses them and the frozen app fails at import time.
hidden = [
    *collect_submodules("uvicorn"),
    *collect_submodules("webview"),
    # The desktop package is reached only through the entry wrapper's absolute
    # import, and the backend only through lazy imports inside BackendProcess,
    # so neither is fully discoverable by static analysis.
    *collect_submodules("desktop"),
    *collect_submodules("app"),
    "app.main",
    "app.desktop_assets",
    "app.mavlink.real_connection",
    "pymavlink.dialects.v20.ardupilotmega",
    "pymavlink.dialects.v20.common",
    "serial",
    "serial.tools",
    "serial.tools.list_ports",
    "serial.tools.list_ports_windows",
    "encodings.idna",
]

icon_path = REPO_ROOT / "packaging" / "SuisuiNavi.ico"

a = Analysis(  # noqa: F821
    # Not desktop/launcher.py directly: PyInstaller runs the entry script as
    # __main__, which breaks that module's relative imports. The wrapper is
    # __main__ instead and imports desktop.launcher absolutely.
    [str(REPO_ROOT / "packaging" / "suisuinavi_entry.py")],
    pathex=[str(REPO_ROOT), str(BACKEND_ROOT)],
    binaries=[],
    datas=_frontend_data(),
    hiddenimports=hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # Excluded to keep the bundle lean: none is imported at runtime, and
    # PyInstaller would otherwise pull in large scientific/GUI stacks that
    # happen to be importable in the build environment.
    excludes=[
        "tkinter", "matplotlib", "numpy", "scipy", "pandas", "PIL",
        "pytest", "playwright", "PyQt5", "PyQt6", "PySide2", "PySide6",
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)  # noqa: F821

exe = EXE(  # noqa: F821
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="SuisuiNavi",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,  # UPX-compressed binaries are a common false-positive for AV
    console=False,  # a double-clicked GUI app must not flash a console window
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(icon_path) if icon_path.is_file() else None,
    version=str(REPO_ROOT / "packaging" / "version_info.txt"),
)

coll = COLLECT(  # noqa: F821
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="SuisuiNavi",
)
