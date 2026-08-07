"""SuisuiNavi desktop entry point.

    python -m desktop.launcher                # Preview mode (default)
    python -m desktop.launcher --mode real    # real MAVLink permitted, still
                                              # read-only and never auto-connected
    python -m desktop.launcher --diagnostics  # print diagnostics and exit

Startup sequence
----------------
1. Resolve paths (development checkout or frozen bundle) and create the
   ``%LOCALAPPDATA%\\SuisuiNavi`` tree.
2. Start rotating file logging.
3. Take the single-instance lock, or exit with a clear message.
4. Verify the frontend assets are present.
5. Start Uvicorn on a free loopback port and wait for ``/api/health``.
6. Verify the WebView2 runtime, then open the window.
7. Block in the GUI loop until the window closes.

Shutdown is the reverse, bounded, and runs even after a failed start.

This module never opens a serial port. Real mode only *permits* the operator
to open one from the UI, exactly as the browser workflow does.
"""

from __future__ import annotations

import argparse
import contextlib
import logging
import logging.handlers
import sys
import threading
import traceback
from pathlib import Path
from typing import Any

from . import APP_NAME, __version__
from .diagnostics import collect, webview2_available, webview2_runtime_version, write_report
from .paths import DesktopPaths, missing_frontend_assets, resolve_paths
from .runtime import (
    DEFAULT_RUNTIME_MODE,
    MIN_WINDOW_HEIGHT,
    MIN_WINDOW_WIDTH,
    BackendProcess,
    BackendStartupError,
    DesktopConfig,
    RuntimeMode,
    load_config,
    parse_runtime_mode,
    save_config,
)
from .single_instance import (
    EXIT_ALREADY_RUNNING,
    AlreadyRunningError,
    GuardUnavailableError,
    SingleInstanceLock,
)

logger = logging.getLogger("desktop.launcher")

WINDOW_TITLE = APP_NAME
DEFAULT_WIDTH = 1440
DEFAULT_HEIGHT = 900

#: Bounded so a wedged backend or WebView cannot hang the exit.
SHUTDOWN_TIMEOUT_SECONDS = 8.0


# --------------------------------------------------------------------------
# Logging
# --------------------------------------------------------------------------


def configure_logging(paths: DesktopPaths, *, level: str = "INFO", to_console: bool = True) -> None:
    """Rotating file logging under ``%LOCALAPPDATA%\\SuisuiNavi\\logs``.

    Telemetry is deliberately not logged here: the backend's own loggers stay
    at their configured level, and this handler is for lifecycle events. High
    rate telemetry at INFO would make the log useless and large.
    """
    root = logging.getLogger()
    root.setLevel(getattr(logging, level.upper(), logging.INFO))

    for handler in list(root.handlers):
        if getattr(handler, "_suisui_desktop", False):
            root.removeHandler(handler)

    formatter = logging.Formatter(
        "%(asctime)s %(levelname)-8s %(name)-28s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )

    try:
        paths.logs.mkdir(parents=True, exist_ok=True)
        file_handler = logging.handlers.RotatingFileHandler(
            paths.log_file,
            maxBytes=2_000_000,
            backupCount=5,
            encoding="utf-8",
        )
        file_handler.setFormatter(formatter)
        file_handler._suisui_desktop = True  # type: ignore[attr-defined]
        root.addHandler(file_handler)
    except OSError as error:  # pragma: no cover - permissions/disk
        print(f"warning: could not open the log file ({error}); continuing with console logging", file=sys.stderr)

    if to_console:
        console = logging.StreamHandler(stream=sys.stderr)
        console.setFormatter(formatter)
        console._suisui_desktop = True  # type: ignore[attr-defined]
        root.addHandler(console)

    # Uvicorn's access log is disabled at config level; keep its error logger
    # but stop it duplicating our formatting.
    logging.getLogger("uvicorn.access").propagate = False


# --------------------------------------------------------------------------
# The application
# --------------------------------------------------------------------------


class DesktopApplication:
    """Owns the backend, the window, and the shutdown sequence."""

    def __init__(
        self,
        *,
        mode: RuntimeMode = DEFAULT_RUNTIME_MODE,
        paths: DesktopPaths | None = None,
        development: bool = False,
    ) -> None:
        self.mode = mode
        self.paths = (paths or resolve_paths()).ensure()
        self.development = development
        self.config: DesktopConfig = DesktopConfig()
        self.backend = BackendProcess(
            mode=mode,
            frontend_root=self.paths.frontend,
            desktop_context={
                "desktopVersion": __version__,
                "appName": APP_NAME,
                "development": development,
            },
        )
        self.lock: SingleInstanceLock | None = None
        self.window: Any = None
        self._shutdown_done = threading.Event()

    # -- startup -------------------------------------------------------

    def acquire_lock(self) -> None:
        self.lock = SingleInstanceLock(
            self.paths.lock_file,
            version=__version__,
            payload={"mode": self.mode.value},
        )
        self.lock.acquire()

    def verify_frontend(self) -> None:
        missing = missing_frontend_assets(self.paths)
        if missing:
            raise FileNotFoundError(
                f"The SuisuiNavi frontend is incomplete in {self.paths.frontend}: missing {', '.join(missing)}. "
                "This usually means the build did not bundle the web assets."
            )

    def start_backend(self) -> str:
        handle = self.backend.start()
        if self.lock is not None:
            self.lock.update(backendUrl=handle.base_url, port=handle.port)
        return handle.base_url

    # -- window --------------------------------------------------------

    def create_window(self, url: str) -> Any:
        """Create the PyWebView window (does not start the GUI loop)."""
        import webview  # noqa: PLC0415 - deliberately lazy

        self.config = load_config(self.paths.config_file)
        width = max(MIN_WINDOW_WIDTH, self.config.windowWidth or DEFAULT_WIDTH)
        height = max(MIN_WINDOW_HEIGHT, self.config.windowHeight or DEFAULT_HEIGHT)

        title = f"{WINDOW_TITLE} — {self.mode.label}"
        if self.development:
            title += " [DEV]"

        self.window = webview.create_window(
            title,
            url,
            width=width,
            height=height,
            min_size=(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT),
            resizable=True,
            confirm_close=False,
            text_select=True,
            js_api=DesktopApi(self),
        )
        self.window.events.closing += self._on_closing
        with contextlib.suppress(Exception):
            self.window.events.loaded += self._on_loaded
        # Geometry is tracked as it changes rather than read at close time --
        # see _on_closing for why the window must not be touched during
        # teardown.
        with contextlib.suppress(Exception):
            self.window.events.resized += self._on_resized
        with contextlib.suppress(Exception):
            self.window.events.moved += self._on_moved
        return self.window

    def _on_loaded(self) -> None:
        logger.info("frontend loaded in the desktop window")

    def _on_resized(self, width: int, height: int) -> None:
        """Record the new size in memory; nothing is written until shutdown."""
        if width >= MIN_WINDOW_WIDTH and height >= MIN_WINDOW_HEIGHT:
            self.config.windowWidth = int(width)
            self.config.windowHeight = int(height)

    def _on_moved(self, x: int, y: int) -> None:
        self.config.windowX, self.config.windowY = int(x), int(y)

    def _on_closing(self) -> None:
        """Runs on the GUI thread as the window tears down.

        Deliberately does nothing but log. Anything that calls back into the
        window here -- ``evaluate_js`` most of all -- can deadlock: the WebView
        is already being destroyed, so a request for a JavaScript result waits
        for a reply that will never come, and the process hangs instead of
        exiting. (Observed exactly that: the log stopped at this line and the
        executable had to be killed.)

        Zeroing frontend input at this point would be pointless anyway -- the
        page is about to cease existing. Focus loss *during* a session is
        handled inside the WebView by the frontend's own blur/visibilitychange
        listeners.

        Window geometry is already in ``self.config`` via the resized/moved
        events, and is written by :meth:`shutdown`, which runs off this thread.
        """
        logger.info("window closing; beginning shutdown")

    def notify_frontend_blur(self) -> None:
        """Ask the frontend to zero any held input.

        Safe to call while the window is alive and running. Must **not** be
        called from the ``closing`` handler -- see :meth:`_on_closing`.
        """
        if self.window is None:
            return
        with contextlib.suppress(Exception):
            self.window.evaluate_js("window.suisuiDesktopBlur && window.suisuiDesktopBlur();")

    def persist_window_state(self) -> None:
        """Write the geometry captured by the resize/move events.

        Reads only in-memory state -- never the live window object -- so it is
        safe to call during shutdown.
        """
        save_config(self.paths.config_file, self.config)

    def run_gui(self) -> None:
        """Block in the WebView loop until the window closes."""
        import webview  # noqa: PLC0415

        logger.info("starting the desktop GUI loop (debug=%s)", self.development)
        # debug=True enables DevTools and is release-disabled on purpose.
        webview.start(debug=self.development, private_mode=False)

    # -- shutdown ------------------------------------------------------

    def shutdown(self) -> None:
        """Stop everything, bounded, in dependency order. Idempotent."""
        if self._shutdown_done.is_set():
            return
        self._shutdown_done.set()
        logger.info("shutdown: stopping backend and releasing resources")

        # 0. Window geometry, from the in-memory values the resize/move events
        #    recorded. Never touches the window object -- by the time shutdown
        #    runs it may already be destroyed.
        try:
            self.persist_window_state()
        except Exception:  # noqa: BLE001 - preferences must not block exit
            logger.exception("error saving window state")

        # 1. Backend (its lifespan hook closes the MAVLink link and the serial
        #    port). Bounded so a stuck link cannot hang the exit.
        try:
            clean = self.backend.stop(timeout=SHUTDOWN_TIMEOUT_SECONDS)
            if not clean:
                logger.error("backend did not stop cleanly within the timeout")
        except Exception:  # noqa: BLE001 - continue shutting down regardless
            logger.exception("error while stopping the backend")

        # 2. Single-instance lock.
        try:
            if self.lock is not None:
                self.lock.release()
        except Exception:  # noqa: BLE001
            logger.exception("error while releasing the single-instance lock")

        # 3. Flush logs.
        for handler in logging.getLogger().handlers:
            with contextlib.suppress(Exception):
                handler.flush()
        logger.info("shutdown complete")


class DesktopApi:
    """The JavaScript-callable API surface, deliberately tiny.

    Exposes diagnostics and folder-opening only. There is no file read/write,
    no command execution, and nothing MAVLink-related: the frontend talks to
    the backend over HTTP for that, through the same validated endpoints the
    browser uses, so the desktop shell adds no new path to the aircraft.
    """

    def __init__(self, application: "DesktopApplication") -> None:
        self._app = application

    def get_diagnostics(self) -> dict[str, Any]:
        handle = self._app.backend.handle
        report = collect(
            paths=self._app.paths,
            runtime_mode=self._app.mode.value,
            backend_url=handle.base_url if handle else None,
        )
        write_report(report, self._app.paths)
        return report.data

    def open_logs_folder(self) -> bool:
        """Open the log directory in Explorer. Returns whether it worked."""
        return _open_in_file_manager(self._app.paths.logs)

    def get_runtime(self) -> dict[str, Any]:
        handle = self._app.backend.handle
        return {
            "mode": self._app.mode.value,
            "modeLabel": self._app.mode.label,
            "development": self._app.development,
            "desktopVersion": __version__,
            "backendUrl": handle.base_url if handle else None,
            "logsPath": str(self._app.paths.logs),
        }


def _open_in_file_manager(path: Path) -> bool:
    """Reveal ``path`` in the platform file manager. Never raises."""
    try:
        if sys.platform == "win32":
            import os  # noqa: PLC0415

            os.startfile(str(path))  # noqa: S606 - a directory we own
            return True
        import subprocess  # noqa: PLC0415

        opener = "open" if sys.platform == "darwin" else "xdg-open"
        subprocess.Popen([opener, str(path)])  # noqa: S603
        return True
    except Exception as error:  # noqa: BLE001
        logger.warning("could not open %s: %s", path, error)
        return False


# --------------------------------------------------------------------------
# Error reporting
# --------------------------------------------------------------------------


def report_startup_failure(message: str, paths: DesktopPaths | None, *, detail: str = "") -> None:
    """Tell the operator what went wrong, on screen where possible.

    Always writes to the log and stderr; additionally tries a native dialog,
    because a double-clicked ``.exe`` has no console to read.
    """
    logger.error("startup failed: %s%s", message, f"\n{detail}" if detail else "")
    log_hint = f"\n\nLogs: {paths.logs}" if paths else ""
    full = f"{message}{log_hint}"
    print(f"\n{APP_NAME}: {message}{log_hint}\n", file=sys.stderr)

    if sys.platform == "win32":
        with contextlib.suppress(Exception):
            import ctypes  # noqa: PLC0415

            # MB_ICONERROR | MB_OK, and MB_SETFOREGROUND so it is not hidden.
            ctypes.windll.user32.MessageBoxW(None, full, f"{APP_NAME} — startup error", 0x10 | 0x0 | 0x10000)


def install_crash_handler(application: "DesktopApplication | None", paths: DesktopPaths) -> None:
    """Log unhandled exceptions and shut down safely rather than vanishing."""
    previous_hook = sys.excepthook

    def handle(exc_type: type[BaseException], exc: BaseException, tb: Any) -> None:
        if issubclass(exc_type, KeyboardInterrupt):
            previous_hook(exc_type, exc, tb)
            return
        text = "".join(traceback.format_exception(exc_type, exc, tb))
        logger.critical("unhandled exception:\n%s", text)
        with contextlib.suppress(Exception):
            crash_path = paths.diagnostics / "crash.log"
            crash_path.parent.mkdir(parents=True, exist_ok=True)
            crash_path.write_text(text, encoding="utf-8")
        if application is not None:
            with contextlib.suppress(Exception):
                application.shutdown()
        report_startup_failure(
            f"{APP_NAME} stopped because of an unexpected error:\n\n{exc_type.__name__}: {exc}",
            paths,
        )
        previous_hook(exc_type, exc, tb)

    sys.excepthook = handle


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="SuisuiNavi", description=f"{APP_NAME} desktop application")
    parser.add_argument(
        "--mode",
        default=None,
        choices=[m.value for m in RuntimeMode],
        help="runtime mode (default: preview; real never auto-connects)",
    )
    parser.add_argument("--dev", action="store_true", help="development build: DevTools and verbose logging")
    parser.add_argument("--diagnostics", action="store_true", help="print diagnostics and exit")
    parser.add_argument("--log-level", default=None, help="logging level (default INFO, or DEBUG with --dev)")
    parser.add_argument(
        "--no-window",
        action="store_true",
        help="start the backend and wait, without opening a window (smoke tests)",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """Entry point. Returns a process exit code."""
    args = build_parser().parse_args(argv)
    mode = parse_runtime_mode(args.mode)
    development = bool(args.dev)
    level = args.log_level or ("DEBUG" if development else "INFO")

    paths = resolve_paths().ensure()
    configure_logging(paths, level=level)

    logger.info(
        "%s desktop %s starting: mode=%s development=%s frozen=%s",
        APP_NAME,
        __version__,
        mode.value,
        development,
        getattr(sys, "frozen", False),
    )

    if args.diagnostics:
        report = collect(paths=paths, runtime_mode=mode.value, backend_url=None, include_backend=False)
        print(report.to_text())
        write_report(report, paths)
        return 0

    application = DesktopApplication(mode=mode, paths=paths, development=development)
    install_crash_handler(application, paths)

    try:
        application.acquire_lock()
    except AlreadyRunningError as error:
        # Deterministic exit code, documented in the operator guide. Nothing
        # has been started at this point: no backend, no port, no window, no
        # serial access, and the running instance is left completely alone.
        logger.info("second instance declined: %s", error)
        report_startup_failure(str(error), paths)
        return EXIT_ALREADY_RUNNING
    except GuardUnavailableError as error:
        # The guard itself could not be established. Refusing to start is the
        # safe direction for an application that can own a serial link.
        application.shutdown()
        report_startup_failure(str(error), paths)
        return 8

    try:
        application.verify_frontend()
    except FileNotFoundError as error:
        application.shutdown()
        report_startup_failure(str(error), paths)
        return 4

    try:
        url = application.start_backend()
    except BackendStartupError as error:
        application.shutdown()
        report_startup_failure(
            f"The SuisuiNavi backend did not start.\n\n{error}", paths, detail=traceback.format_exc()
        )
        return 5
    except Exception as error:  # noqa: BLE001 - any startup failure must be reported, not silent
        application.shutdown()
        report_startup_failure(
            f"Unexpected error while starting the backend:\n\n{type(error).__name__}: {error}",
            paths,
            detail=traceback.format_exc(),
        )
        return 5

    logger.info("backend ready at %s", url)

    if args.no_window:
        # Smoke-test path: the backend is up and healthy; hold it until
        # interrupted, then shut down through the same sequence as the GUI.
        logger.info("--no-window: holding the backend open (Ctrl+C to stop)")
        try:
            while True:
                threading.Event().wait(0.5)
        except KeyboardInterrupt:
            logger.info("interrupted; shutting down")
        finally:
            application.shutdown()
        return 0

    if not webview2_available():
        application.shutdown()
        report_startup_failure(
            "The Microsoft Edge WebView2 Runtime is required but was not found.\n\n"
            "Install the Evergreen WebView2 Runtime from Microsoft, then start "
            f"{APP_NAME} again.\n\n"
            "This application does not download or install it for you.",
            paths,
        )
        return 6

    logger.info("WebView2 runtime %s detected", webview2_runtime_version())

    try:
        application.create_window(url)
        application.run_gui()
    except Exception as error:  # noqa: BLE001 - report, then shut down cleanly
        report_startup_failure(
            f"The {APP_NAME} window could not be displayed:\n\n{type(error).__name__}: {error}",
            paths,
            detail=traceback.format_exc(),
        )
        return 7
    finally:
        application.shutdown()

    logger.info("%s exited normally", APP_NAME)
    return 0


if __name__ == "__main__":
    sys.exit(main())
