"""Diagnostics the operator can read when something is wrong.

Collects only facts that are actually known. In particular it reports the
*backend's* view of the MAVLink link rather than inferring anything about
hardware: a running backend says nothing about whether a radio is attached,
and this module must never imply that it does.
"""

from __future__ import annotations

import json
import logging
import platform
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import urlopen

from . import APP_NAME, __version__
from .paths import DesktopPaths, is_frozen

logger = logging.getLogger(__name__)

UNKNOWN = "unknown"


def git_revision(repo_root: Path) -> str:
    """Short git revision of the working tree, or ``unknown``.

    Only meaningful in a development checkout; a frozen build has no ``.git``
    and the revision is instead baked in at build time (see
    :func:`build_stamp`).
    """
    if is_frozen():
        return UNKNOWN
    try:
        result = subprocess.run(  # noqa: S603 - fixed argv, no shell
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=str(repo_root),
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return UNKNOWN
    revision = result.stdout.strip()
    return revision or UNKNOWN


def build_stamp(paths: DesktopPaths) -> dict[str, Any]:
    """Build metadata written by the packaging script, when present."""
    stamp_path = paths.assets / "build-info.json"
    try:
        raw = json.loads(stamp_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return {}
    return raw if isinstance(raw, dict) else {}


def webview_info() -> dict[str, Any]:
    """Which WebView engine pywebview will use, and whether it is available.

    Imports pywebview lazily: the diagnostics payload must still be
    obtainable in a headless test run where no GUI toolkit is present.
    """
    info: dict[str, Any] = {"library": "pywebview", "version": UNKNOWN, "renderer": UNKNOWN, "available": False}
    try:
        import importlib.metadata as metadata  # noqa: PLC0415

        info["version"] = metadata.version("pywebview")
    except Exception:  # noqa: BLE001 - diagnostics must never raise
        pass

    try:
        import webview.platforms.edgechromium as edgechromium  # noqa: PLC0415

        info["renderer"] = getattr(edgechromium, "renderer", "edgechromium")
        info["available"] = True
    except Exception as error:  # noqa: BLE001
        info["error"] = f"{type(error).__name__}: {error}"
    return info


def webview2_runtime_version() -> str:
    """Installed Microsoft WebView2 Runtime version, or ``unknown``.

    Read from the registry rather than by launching anything. A missing
    runtime is the single most likely reason the window fails to appear on a
    clean Windows machine, so it is worth reporting precisely.
    """
    if platform.system() != "Windows":
        return UNKNOWN
    try:
        import winreg  # noqa: PLC0415 - Windows only
    except ImportError:  # pragma: no cover - non-Windows
        return UNKNOWN

    client = r"{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    candidates = (
        (winreg.HKEY_LOCAL_MACHINE, rf"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{client}"),
        (winreg.HKEY_LOCAL_MACHINE, rf"SOFTWARE\Microsoft\EdgeUpdate\Clients\{client}"),
        (winreg.HKEY_CURRENT_USER, rf"SOFTWARE\Microsoft\EdgeUpdate\Clients\{client}"),
    )
    for hive, subkey in candidates:
        try:
            with winreg.OpenKey(hive, subkey) as key:
                version, _ = winreg.QueryValueEx(key, "pv")
                if version:
                    return str(version)
        except OSError:
            continue
    return UNKNOWN


def webview2_available() -> bool:
    return webview2_runtime_version() != UNKNOWN


def backend_health(base_url: str, *, timeout: float = 2.0) -> dict[str, Any]:
    """Ask the backend how it is. Never raises."""
    try:
        with urlopen(f"{base_url}/api/health", timeout=timeout) as response:  # noqa: S310 - loopback
            payload = json.loads(response.read().decode("utf-8"))
    except (URLError, OSError, ValueError, json.JSONDecodeError) as error:
        return {"reachable": False, "error": f"{type(error).__name__}: {error}"}
    return {"reachable": True, **(payload if isinstance(payload, dict) else {})}


def mavlink_status(base_url: str, *, timeout: float = 2.0) -> dict[str, Any]:
    """The backend's own view of the MAVLink link.

    Reports exactly what the backend says. It does **not** claim hardware is
    present: ``connectionState: disconnected`` with a healthy backend means
    "no link has been opened", which is the normal, expected state at
    startup.
    """
    try:
        with urlopen(f"{base_url}/api/drone/status", timeout=timeout) as response:  # noqa: S310 - loopback
            payload = json.loads(response.read().decode("utf-8"))
    except (URLError, OSError, ValueError, json.JSONDecodeError) as error:
        return {"available": False, "error": f"{type(error).__name__}: {error}"}
    if not isinstance(payload, dict):
        return {"available": False, "error": "unexpected status payload"}

    transport = payload.get("transport") or {}
    return {
        "available": True,
        "connectionState": payload.get("connectionState"),
        "mode": payload.get("mode"),
        "serialPort": transport.get("port"),
        "baud": transport.get("baud"),
        "hardwareDetected": None,  # never inferred from backend liveness
        "note": "connectionState reflects the backend only; it does not prove a radio is attached.",
    }


@dataclass
class DiagnosticsReport:
    """Everything the diagnostics action shows."""

    data: dict[str, Any]

    def to_json(self) -> str:
        return json.dumps(self.data, indent=2, ensure_ascii=False)

    def to_text(self) -> str:
        lines = [f"{APP_NAME} diagnostics", "=" * 40]

        def emit(section: str, values: dict[str, Any], indent: str = "  ") -> None:
            lines.append(f"\n[{section}]")
            for key, value in values.items():
                lines.append(f"{indent}{key}: {value}")

        for section, values in self.data.items():
            if isinstance(values, dict):
                emit(section, values)
            else:
                lines.append(f"{section}: {values}")
        return "\n".join(lines)


def collect(
    *,
    paths: DesktopPaths,
    runtime_mode: str,
    backend_url: str | None,
    include_backend: bool = True,
) -> DiagnosticsReport:
    """Gather the full diagnostics payload."""
    stamp = build_stamp(paths)
    report: dict[str, Any] = {
        "application": {
            "name": APP_NAME,
            "desktopVersion": __version__,
            "runtimeMode": runtime_mode,
            "frozen": is_frozen(),
            "gitRevision": stamp.get("gitRevision") or git_revision(paths.assets),
            "builtAt": stamp.get("builtAt", UNKNOWN),
        },
        "python": {
            "version": sys.version.split()[0],
            "executable": sys.executable,
            "platform": platform.platform(),
        },
        "webview": {
            **webview_info(),
            "webview2Runtime": webview2_runtime_version(),
            "webview2Available": webview2_available(),
        },
        "paths": {
            "assets": str(paths.assets),
            "frontend": str(paths.frontend),
            "data": str(paths.data),
            "config": str(paths.config),
            "logs": str(paths.logs),
            "diagnostics": str(paths.diagnostics),
        },
        "backend": {"url": backend_url or UNKNOWN},
    }

    if include_backend and backend_url:
        report["backend"].update(backend_health(backend_url))
        report["mavlink"] = mavlink_status(backend_url)
    else:
        report["mavlink"] = {"available": False, "note": "backend not started"}

    return DiagnosticsReport(report)


def write_report(report: DiagnosticsReport, paths: DesktopPaths, *, name: str = "diagnostics.json") -> Path | None:
    """Persist a diagnostics snapshot. Returns the path, or ``None``."""
    try:
        paths.diagnostics.mkdir(parents=True, exist_ok=True)
        target = paths.diagnostics / name
        target.write_text(report.to_json(), encoding="utf-8")
    except OSError as error:
        logger.warning("could not write the diagnostics report: %s", error)
        return None
    return target
