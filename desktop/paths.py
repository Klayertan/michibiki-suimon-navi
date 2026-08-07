"""Filesystem layout for development and PyInstaller-frozen runs.

Two questions this module answers, and nothing else:

1. *Where are the bundled assets?* -- the frontend (``index.html``, ``css/``,
   ``js/``, ``data/``) and anything else read from disk at runtime. In a
   development checkout that is the repository root; in a frozen build it is
   PyInstaller's extraction directory (``sys._MEIPASS``).
2. *Where does user state go?* -- never the installation directory, which may
   be read-only (Program Files) or replaced wholesale by the next build.
   Windows user state belongs under ``%LOCALAPPDATA%``.

Deliberately free of hard-coded absolute paths: everything is derived from
``__file__`` or from environment variables, so the same code works from a
checkout at any location and from an installed ``.exe``.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path

from . import APP_NAME

#: Environment variable that overrides the user-data root. Set by tests so
#: they never read or write the developer's real configuration, and usable by
#: an operator who wants a portable install.
ENV_DATA_HOME = "SUISUI_DESKTOP_DATA_HOME"
#: Environment variable that overrides asset discovery. Set by the launcher
#: for a frozen build and by tests that stage a fake bundle.
ENV_ASSET_ROOT = "SUISUI_DESKTOP_ASSET_ROOT"


def is_frozen() -> bool:
    """Whether we are running from a PyInstaller bundle."""
    return getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS")


def asset_root() -> Path:
    """Directory containing the bundled frontend and data files.

    Order of preference:

    1. ``SUISUI_DESKTOP_ASSET_ROOT`` -- explicit override.
    2. ``sys._MEIPASS`` -- PyInstaller's extraction directory, in a frozen run.
    3. The repository root, two levels up from this file, in development.
    """
    override = os.environ.get(ENV_ASSET_ROOT)
    if override:
        return Path(override).resolve()
    if is_frozen():
        return Path(sys._MEIPASS).resolve()  # type: ignore[attr-defined]
    return Path(__file__).resolve().parent.parent


def frontend_root() -> Path:
    """Directory holding ``index.html`` and its sibling asset folders.

    The frontend is bundled flat at the asset root (that is how the spec file
    stages ``index.html``, ``css/``, ``js/`` and ``data/``), so this is the
    asset root itself -- named separately because the two concepts are only
    incidentally the same and one may move later.
    """
    return asset_root()


def data_home() -> Path:
    """Root of the user's writable state, e.g. ``%LOCALAPPDATA%\\SuisuiNavi``.

    Falls back sensibly when ``LOCALAPPDATA`` is absent (a stripped service
    account, or a non-Windows machine running the test suite).
    """
    override = os.environ.get(ENV_DATA_HOME)
    if override:
        return Path(override).resolve()

    local_appdata = os.environ.get("LOCALAPPDATA")
    if local_appdata:
        return Path(local_appdata) / APP_NAME
    # Non-Windows / unusual environments: keep the same shape under the home
    # directory rather than scattering files next to the executable.
    return Path.home() / ".local" / "share" / APP_NAME


@dataclass(frozen=True)
class DesktopPaths:
    """Resolved locations for one desktop run."""

    assets: Path
    frontend: Path
    data: Path
    config: Path
    logs: Path
    cache: Path
    calibration: Path
    diagnostics: Path

    @property
    def config_file(self) -> Path:
        return self.config / "desktop.json"

    @property
    def lock_file(self) -> Path:
        # Deliberately in the data root rather than config/: it is runtime
        # state, not user preference, and must not be backed up or synced.
        return self.data / "suisuinavi.lock"

    @property
    def log_file(self) -> Path:
        return self.logs / "suisuinavi-desktop.log"

    def ensure(self) -> "DesktopPaths":
        """Create every writable directory. Safe to call repeatedly.

        Asset directories are never created -- they either exist in the
        bundle or the build is broken, and silently creating an empty one
        would turn that into a confusing blank window instead of a clear
        error.
        """
        for directory in (self.data, self.config, self.logs, self.cache, self.calibration, self.diagnostics):
            directory.mkdir(parents=True, exist_ok=True)
        return self


def resolve_paths() -> DesktopPaths:
    """Build the full path set for this run, without creating anything."""
    assets = asset_root()
    data = data_home()
    return DesktopPaths(
        assets=assets,
        frontend=frontend_root(),
        data=data,
        config=data / "config",
        logs=data / "logs",
        cache=data / "cache",
        calibration=data / "calibration",
        diagnostics=data / "diagnostics",
    )


def frontend_index(paths: DesktopPaths | None = None) -> Path:
    """Absolute path to ``index.html``."""
    resolved = paths or resolve_paths()
    return resolved.frontend / "index.html"


def missing_frontend_assets(paths: DesktopPaths | None = None) -> list[str]:
    """Names of required frontend assets that are absent.

    Used by the launcher to fail with "the build is missing index.html"
    rather than opening a window onto a 404. Only the entry point and the
    directories it cannot run without are checked -- enumerating every file
    would make the bundle brittle for no benefit.
    """
    resolved = paths or resolve_paths()
    required = {
        "index.html": resolved.frontend / "index.html",
        "css": resolved.frontend / "css",
        "js": resolved.frontend / "js",
    }
    return sorted(name for name, path in required.items() if not path.exists())
