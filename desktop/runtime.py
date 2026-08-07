"""Desktop runtime: modes, stored configuration, and the backend process.

Three responsibilities, kept in one module because they are the moving parts
of "start the app" and they share the same lifecycle:

* :class:`RuntimeMode` -- Preview / SITL / Real, and the safety rules each
  implies. Preview is always the default; nothing here ever selects Real
  automatically.
* :class:`DesktopConfig` -- window geometry and UI preferences persisted under
  ``%LOCALAPPDATA%``. Deliberately refuses to persist anything that could
  restore an unsafe state on the next launch.
* :class:`BackendProcess` -- an in-process Uvicorn server on a free loopback
  port, with a health wait and a bounded shutdown.

The backend runs in a thread inside this process rather than as a child
process: it is the same FastAPI app the browser workflow uses, and keeping it
in-process means shutdown is a flag rather than a signal, with no orphaned
``python.exe`` possible if the window dies unexpectedly.
"""

from __future__ import annotations

import contextlib
import json
import logging
import socket
import threading
import time
from dataclasses import asdict, dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Callable
from urllib.error import URLError
from urllib.request import urlopen

logger = logging.getLogger(__name__)


# --------------------------------------------------------------------------
# Runtime modes
# --------------------------------------------------------------------------


class RuntimeMode(str, Enum):
    """How this desktop session may talk to a vehicle.

    The mode never unlocks manual flight control -- that does not exist in
    this application at all (see ``backend/app/mavlink/command_service.py``).
    It governs whether a serial link may be opened, and what the UI shows.
    """

    PREVIEW = "preview"
    SITL = "sitl"
    REAL = "real"

    @property
    def allows_serial(self) -> bool:
        """Whether this mode may ever open a COM port -- and only on an
        explicit operator action, never automatically."""
        return self is RuntimeMode.REAL

    @property
    def backend_mavlink_mode(self) -> str:
        """The ``SUISUI_MAVLINK_MODE`` the backend should run with.

        Preview and SITL both map to the backend's ``mock`` transport: SITL
        is reserved for a future simulator connection and, until that exists,
        must not be able to reach hardware either.
        """
        return "real" if self is RuntimeMode.REAL else "mock"

    @property
    def label(self) -> str:
        return {
            RuntimeMode.PREVIEW: "Preview",
            RuntimeMode.SITL: "SITL",
            RuntimeMode.REAL: "Real",
        }[self]


#: The mode the executable starts in unless the operator explicitly asks for
#: another one on the command line. Never read from stored configuration --
#: see DesktopConfig.
DEFAULT_RUNTIME_MODE = RuntimeMode.PREVIEW


def parse_runtime_mode(value: str | None) -> RuntimeMode:
    """Parse a CLI/env mode name, defaulting to Preview.

    An unrecognised value falls back to Preview with a warning rather than
    raising: the safe direction for a typo is the safe mode, not a crash and
    not Real.
    """
    if not value:
        return DEFAULT_RUNTIME_MODE
    try:
        return RuntimeMode(str(value).strip().lower())
    except ValueError:
        logger.warning("unknown runtime mode %r; falling back to %s", value, DEFAULT_RUNTIME_MODE.value)
        return DEFAULT_RUNTIME_MODE


# --------------------------------------------------------------------------
# Persisted desktop configuration
# --------------------------------------------------------------------------

CONFIG_SCHEMA_VERSION = 1

#: Keys that must never be written to disk, however they arrive. Restoring
#: any of them would let a previous session's unsafe state survive a restart:
#: a held dead-man, a pressed key, a live control authorisation. Enforced in
#: DesktopConfig.from_dict rather than merely "not written", so a
#: hand-edited or malicious config file cannot inject them either.
FORBIDDEN_CONFIG_KEYS = frozenset(
    {
        "deadman",
        "deadmanHeld",
        "pressedKeys",
        "controlValues",
        "armed",
        "armedState",
        "activeSession",
        "flightSession",
        "sitlControlSession",
        "commandAuthorization",
        "allowSafeCommands",
        "runtimeMode",  # the mode is a per-launch decision, never restored
    }
)


@dataclass
class DesktopConfig:
    """Window geometry and non-sensitive UI preferences."""

    schemaVersion: int = CONFIG_SCHEMA_VERSION
    windowWidth: int = 1440
    windowHeight: int = 900
    windowX: int | None = None
    windowY: int | None = None
    maximized: bool = False
    workspace: str = "survey"
    keyboardMapping: dict[str, Any] = field(default_factory=dict)
    uiPreferences: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, raw: Any) -> "DesktopConfig":
        """Build a config from parsed JSON, ignoring anything unusable.

        Never raises: a malformed or hostile file yields defaults, because
        refusing to start over a bad preferences file would be a worse
        failure than losing the preferences.
        """
        if not isinstance(raw, dict):
            logger.warning("desktop config is not an object; using defaults")
            return cls()

        dropped = FORBIDDEN_CONFIG_KEYS.intersection(raw)
        if dropped:
            logger.warning("ignoring unsafe key(s) in stored desktop config: %s", ", ".join(sorted(dropped)))

        config = cls()
        config.schemaVersion = CONFIG_SCHEMA_VERSION

        def _int(key: str, current: int, *, minimum: int) -> int:
            value = raw.get(key)
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                return current
            return max(minimum, int(value))

        config.windowWidth = _int("windowWidth", config.windowWidth, minimum=MIN_WINDOW_WIDTH)
        config.windowHeight = _int("windowHeight", config.windowHeight, minimum=MIN_WINDOW_HEIGHT)

        for key in ("windowX", "windowY"):
            value = raw.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                setattr(config, key, int(value))

        if isinstance(raw.get("maximized"), bool):
            config.maximized = raw["maximized"]
        if isinstance(raw.get("workspace"), str):
            config.workspace = raw["workspace"]
        for key in ("keyboardMapping", "uiPreferences"):
            value = raw.get(key)
            if isinstance(value, dict):
                setattr(config, key, {k: v for k, v in value.items() if k not in FORBIDDEN_CONFIG_KEYS})
        return config

    def to_dict(self) -> dict[str, Any]:
        document = asdict(self)
        for key in FORBIDDEN_CONFIG_KEYS:
            document.pop(key, None)
        return document


MIN_WINDOW_WIDTH = 1000
MIN_WINDOW_HEIGHT = 650


def load_config(path: Path) -> DesktopConfig:
    """Read the stored desktop config, tolerating every failure mode."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return DesktopConfig()
    except (OSError, json.JSONDecodeError, UnicodeDecodeError) as error:
        logger.warning("could not read desktop config at %s (%s); using defaults", path, error)
        return DesktopConfig()
    return DesktopConfig.from_dict(raw)


def save_config(path: Path, config: DesktopConfig) -> bool:
    """Persist the desktop config. Returns whether it was written.

    Best-effort by design: a read-only or full disk must not prevent the
    application from closing.
    """
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(config.to_dict(), indent=2), encoding="utf-8")
    except (OSError, ValueError) as error:
        # ValueError as well as OSError: a path containing a null byte raises
        # ValueError from mkdir rather than OSError, and this runs during
        # shutdown, where nothing is allowed to propagate.
        logger.warning("could not save desktop config to %s: %s", path, error)
        return False
    return True


# --------------------------------------------------------------------------
# Loopback port selection
# --------------------------------------------------------------------------


def find_free_port(host: str = "127.0.0.1") -> int:
    """Ask the OS for an unused loopback port.

    Binding to port 0 and reading back the assignment is the only race-free
    way to do this; a hard-coded port could already belong to another
    application (including a second SuisuiNavi, or the 8787 dev backend).

    There is still a small window between closing this socket and Uvicorn
    binding it -- unavoidable without passing the socket itself to the
    server. :class:`BackendProcess` retries on a bind failure to cover it.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind((host, 0))
        return int(probe.getsockname()[1])


def port_is_free(port: int, host: str = "127.0.0.1") -> bool:
    """Whether ``port`` can currently be bound on ``host``."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind((host, port))
        except OSError:
            return False
    return True


# --------------------------------------------------------------------------
# Backend lifecycle
# --------------------------------------------------------------------------


class BackendStartupError(RuntimeError):
    """The backend did not become healthy in time."""


@dataclass
class BackendHandle:
    """A running backend: where it is, and how to stop it."""

    host: str
    port: int
    thread: threading.Thread
    server: Any  # uvicorn.Server -- typed loosely to keep uvicorn out of imports

    @property
    def base_url(self) -> str:
        return f"http://{self.host}:{self.port}"

    @property
    def health_url(self) -> str:
        return f"{self.base_url}/api/health"


def wait_for_health(
    url: str,
    *,
    timeout: float = 30.0,
    interval: float = 0.1,
    opener: Callable[[str, float], Any] | None = None,
    is_alive: Callable[[], bool] | None = None,
) -> bool:
    """Poll ``url`` until it answers, the deadline passes, or the server dies.

    Args:
        opener: Injected for tests; defaults to ``urlopen``.
        is_alive: Optional liveness check. When it returns ``False`` the wait
            aborts immediately rather than burning the full timeout on a
            server that has already crashed.

    Returns:
        ``True`` if the endpoint answered with HTTP 200.
    """
    fetch = opener or (lambda target, to: urlopen(target, timeout=to))  # noqa: S310 - loopback only
    deadline = time.monotonic() + timeout

    while time.monotonic() < deadline:
        if is_alive is not None and not is_alive():
            logger.error("backend process stopped before it became healthy")
            return False
        try:
            response = fetch(url, min(2.0, interval + 1.0))
        except (URLError, OSError, ValueError):
            time.sleep(interval)
            continue
        try:
            status = getattr(response, "status", None) or response.getcode()
        finally:
            with contextlib.suppress(Exception):
                response.close()
        if status == 200:
            return True
        time.sleep(interval)
    return False


class BackendProcess:
    """Runs the SuisuiNavi FastAPI app on a loopback port, in this process.

    Not a subprocess: the app object is created here and served by a Uvicorn
    ``Server`` on a daemon thread. That keeps shutdown deterministic (set a
    flag, join the thread) and makes an orphaned backend impossible -- if this
    process dies, so does the server.
    """

    def __init__(
        self,
        *,
        mode: RuntimeMode,
        host: str = "127.0.0.1",
        frontend_root: Path | None = None,
        desktop_context: dict[str, Any] | None = None,
        log_level: str = "info",
    ) -> None:
        self.mode = mode
        self.host = host
        self.frontend_root = frontend_root
        self.desktop_context = desktop_context or {}
        self.log_level = log_level
        self._handle: BackendHandle | None = None

    @property
    def handle(self) -> BackendHandle | None:
        return self._handle

    def build_settings(self, port: int) -> Any:
        """Construct backend Settings for this desktop session.

        Imported lazily so that importing :mod:`desktop.runtime` does not pull
        in the whole MAVLink stack -- which matters for the fast unit tests and
        for PyInstaller's dependency graph.

        Safety-relevant choices, all deliberate:

        * ``allow_safe_commands=False`` -- the desktop shell never widens the
          backend's command surface. Enabling commands stays an explicit,
          separate operator decision exactly as in the browser workflow.
        * ``auto_reconnect=False`` in Real mode -- a desktop app that
          reconnects to a serial port by itself could re-open COM10 after the
          operator deliberately disconnected.
        * The origin allow-list is pinned to this session's own URL.
        """
        from app.config import Settings  # noqa: PLC0415 - deliberately lazy

        origin = f"http://{self.host}:{port}"
        return Settings(
            mode=self.mode.backend_mavlink_mode,
            host=self.host,
            http_port=port,
            allow_safe_commands=False,
            auto_reconnect=self.mode is not RuntimeMode.REAL,
            allowed_origins=(origin,),
            log_level=self.log_level.upper(),
        )

    def build_app(self, port: int) -> Any:
        """Create the FastAPI app, with the frontend attached for the desktop."""
        from app.main import create_app  # noqa: PLC0415 - deliberately lazy

        settings = self.build_settings(port)
        app = create_app(settings)

        if self.frontend_root is not None:
            from app.desktop_assets import mount_frontend  # noqa: PLC0415

            mount_frontend(
                app,
                self.frontend_root,
                desktop_context={
                    "mode": self.mode.value,
                    "modeLabel": self.mode.label,
                    "allowsSerial": self.mode.allows_serial,
                    **self.desktop_context,
                },
            )
        return app

    def start(self, *, port: int | None = None, health_timeout: float = 30.0, attempts: int = 3) -> BackendHandle:
        """Start Uvicorn and block until ``/api/health`` answers.

        Raises:
            BackendStartupError: the server never became healthy.
        """
        import uvicorn  # noqa: PLC0415 - deliberately lazy

        last_error: Exception | None = None
        for attempt in range(1, attempts + 1):
            chosen = port or find_free_port(self.host)
            logger.info("starting backend on %s:%d (attempt %d/%d)", self.host, chosen, attempt, attempts)

            try:
                app = self.build_app(chosen)
            except Exception as error:  # noqa: BLE001 - reported to the operator
                raise BackendStartupError(f"Could not build the SuisuiNavi backend: {error}") from error

            config = uvicorn.Config(
                app,
                host=self.host,
                port=chosen,
                log_level=self.log_level,
                access_log=False,
                # log_config=None for two reasons, both load-bearing:
                #
                # 1. Uvicorn's default config is a dictConfig that instantiates
                #    formatters by dotted string ("uvicorn.logging.DefaultFormatter").
                #    PyInstaller cannot always resolve that in a frozen bundle,
                #    and it fails with a bare "Unable to configure formatter
                #    'default'" -- which is exactly what killed the first
                #    packaged build.
                # 2. Even where it works, dictConfig would reconfigure the root
                #    logger and detach the rotating file handler the launcher
                #    just installed, so the desktop log would silently stop.
                #
                # The launcher has already configured logging; uvicorn should
                # inherit it rather than replace it.
                log_config=None,
                # Bounded so a stuck WebSocket cannot hold the app open on exit.
                timeout_graceful_shutdown=5,
            )
            server = uvicorn.Server(config)
            # Uvicorn installs SIGINT/SIGTERM handlers by default; on a
            # non-main thread that raises, and the desktop shell owns process
            # lifetime anyway.
            server.install_signal_handlers = False

            thread = threading.Thread(target=server.run, name=f"suisui-backend-{chosen}", daemon=True)
            thread.start()

            handle = BackendHandle(host=self.host, port=chosen, thread=thread, server=server)
            healthy = wait_for_health(
                handle.health_url,
                timeout=health_timeout,
                is_alive=lambda: thread.is_alive() and not getattr(server, "should_exit", False),
            )
            if healthy:
                self._handle = handle
                logger.info("backend healthy at %s", handle.base_url)
                return handle

            logger.error("backend on port %d did not become healthy; stopping it", chosen)
            self._stop_handle(handle, timeout=5.0)
            last_error = BackendStartupError(
                f"The backend did not respond at {handle.health_url} within {health_timeout:.0f}s."
            )
            if port is not None:
                break  # an explicitly requested port is not worth retrying elsewhere

        raise last_error or BackendStartupError("The backend could not be started.")

    def stop(self, *, timeout: float = 8.0) -> bool:
        """Stop the server and release its resources. Returns clean/unclean."""
        handle, self._handle = self._handle, None
        if handle is None:
            return True
        return self._stop_handle(handle, timeout=timeout)

    @staticmethod
    def _stop_handle(handle: BackendHandle, *, timeout: float) -> bool:
        """Ask Uvicorn to exit and wait, bounded.

        The MAVLink link is closed by the app's own lifespan hook
        (``manager.shutdown()``), which Uvicorn runs during graceful
        shutdown -- that is what releases the serial port.
        """
        logger.info("stopping backend on port %d", handle.port)
        with contextlib.suppress(Exception):
            handle.server.should_exit = True

        handle.thread.join(timeout)
        if handle.thread.is_alive():
            logger.error(
                "backend thread did not stop within %.1fs; forcing exit flag and continuing shutdown",
                timeout,
            )
            with contextlib.suppress(Exception):
                handle.server.force_exit = True
            handle.thread.join(min(3.0, timeout))
            return not handle.thread.is_alive()
        logger.info("backend stopped cleanly")
        return True
