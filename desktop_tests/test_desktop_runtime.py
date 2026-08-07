"""Desktop shell unit tests.

Deliberately GUI-free: nothing here imports pywebview's window layer, starts a
real GUI loop, or opens a serial port. Everything that touches hardware or a
display is either injected or asserted *not* to happen.
"""

from __future__ import annotations

import json
import os
import socket
import sys
import threading
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
for candidate in (REPO_ROOT, REPO_ROOT / "backend"):
    if str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

from desktop import APP_NAME, paths as paths_module  # noqa: E402
from desktop.diagnostics import collect, mavlink_status  # noqa: E402
from desktop.runtime import (  # noqa: E402
    DEFAULT_RUNTIME_MODE,
    FORBIDDEN_CONFIG_KEYS,
    MIN_WINDOW_HEIGHT,
    MIN_WINDOW_WIDTH,
    BackendProcess,
    DesktopConfig,
    RuntimeMode,
    find_free_port,
    load_config,
    parse_runtime_mode,
    port_is_free,
    save_config,
    wait_for_health,
)
from desktop.single_instance import (  # noqa: E402
    EXIT_ALREADY_RUNNING,
    MUTEX_NAME,
    AlreadyRunningError,
    GuardUnavailableError,
    PosixFlockGuard,
    SingleInstanceLock,
    WindowsMutexGuard,
    read_state,
)


@pytest.fixture
def temp_paths(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Isolated data home so tests never read/write the real %LOCALAPPDATA%."""
    monkeypatch.setenv(paths_module.ENV_DATA_HOME, str(tmp_path / "data"))
    monkeypatch.setenv(paths_module.ENV_ASSET_ROOT, str(tmp_path / "assets"))
    (tmp_path / "assets").mkdir(parents=True, exist_ok=True)
    return paths_module.resolve_paths().ensure()


# ======================================================================
# Resource path resolution: development and frozen
# ======================================================================


def test_development_asset_root_is_the_repository(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(paths_module.ENV_ASSET_ROOT, raising=False)
    monkeypatch.setattr(sys, "frozen", False, raising=False)
    assert (paths_module.asset_root() / "index.html").is_file()


def test_frozen_asset_root_uses_meipass(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """A PyInstaller build reads its assets from sys._MEIPASS."""
    monkeypatch.delenv(paths_module.ENV_ASSET_ROOT, raising=False)
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path), raising=False)

    assert paths_module.is_frozen() is True
    assert paths_module.asset_root() == tmp_path.resolve()


def test_asset_root_override_wins(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv(paths_module.ENV_ASSET_ROOT, str(tmp_path))
    assert paths_module.asset_root() == tmp_path.resolve()


def test_missing_frontend_assets_is_reported_not_silently_tolerated(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv(paths_module.ENV_ASSET_ROOT, str(tmp_path))
    monkeypatch.setenv(paths_module.ENV_DATA_HOME, str(tmp_path / "data"))
    resolved = paths_module.resolve_paths()

    assert set(paths_module.missing_frontend_assets(resolved)) == {"index.html", "css", "js"}

    (tmp_path / "index.html").write_text("<html><head></head></html>", encoding="utf-8")
    (tmp_path / "css").mkdir()
    (tmp_path / "js").mkdir()
    assert paths_module.missing_frontend_assets(resolved) == []


def test_real_repository_bundle_has_every_required_asset() -> None:
    """The development checkout must satisfy the same check the launcher runs."""
    assert paths_module.missing_frontend_assets(paths_module.resolve_paths()) == []


def test_data_home_uses_localappdata(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv(paths_module.ENV_DATA_HOME, raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    assert paths_module.data_home() == tmp_path / APP_NAME


def test_ensure_creates_every_writable_directory(temp_paths) -> None:
    for directory in (
        temp_paths.data, temp_paths.config, temp_paths.logs,
        temp_paths.cache, temp_paths.calibration, temp_paths.diagnostics,
    ):
        assert directory.is_dir()


# ======================================================================
# Free loopback port selection
# ======================================================================


def test_find_free_port_returns_a_bindable_loopback_port() -> None:
    port = find_free_port()
    assert 1024 < port <= 65535
    assert port_is_free(port) is True


def test_find_free_port_does_not_repeat_a_bound_port() -> None:
    """A port currently in use must not be handed out."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as held:
        held.bind(("127.0.0.1", 0))
        held.listen(1)
        taken = held.getsockname()[1]
        assert port_is_free(taken) is False
        assert find_free_port() != taken


# ======================================================================
# Backend health waiting and startup timeout
# ======================================================================


class _FakeResponse:
    def __init__(self, status: int) -> None:
        self.status = status

    def close(self) -> None:
        pass


def test_wait_for_health_succeeds_once_the_endpoint_answers() -> None:
    calls = {"n": 0}

    def opener(url: str, timeout: float):
        calls["n"] += 1
        if calls["n"] < 3:
            raise OSError("connection refused")
        return _FakeResponse(200)

    assert wait_for_health("http://127.0.0.1:1/api/health", timeout=5.0, interval=0.01, opener=opener) is True
    assert calls["n"] == 3


def test_wait_for_health_times_out_without_hanging() -> None:
    def always_refused(url: str, timeout: float):
        raise OSError("connection refused")

    assert wait_for_health("http://127.0.0.1:1/api/health", timeout=0.3, interval=0.01, opener=always_refused) is False


def test_wait_for_health_aborts_early_when_the_server_died() -> None:
    """A crashed backend must not burn the whole timeout."""
    def always_refused(url: str, timeout: float):
        raise OSError("connection refused")

    assert wait_for_health(
        "http://127.0.0.1:1/api/health",
        timeout=30.0,
        interval=0.01,
        opener=always_refused,
        is_alive=lambda: False,
    ) is False


# ======================================================================
# Runtime modes
# ======================================================================


def test_preview_is_the_default_runtime_mode() -> None:
    assert DEFAULT_RUNTIME_MODE is RuntimeMode.PREVIEW
    assert parse_runtime_mode(None) is RuntimeMode.PREVIEW
    assert parse_runtime_mode("") is RuntimeMode.PREVIEW


def test_unknown_mode_falls_back_to_preview_never_to_real() -> None:
    assert parse_runtime_mode("nonsense") is RuntimeMode.PREVIEW
    assert parse_runtime_mode("REAL ") is RuntimeMode.REAL  # explicit is honoured


@pytest.mark.parametrize(
    ("mode", "allows_serial", "backend_mode"),
    [
        (RuntimeMode.PREVIEW, False, "mock"),
        (RuntimeMode.SITL, False, "mock"),
        (RuntimeMode.REAL, True, "real"),
    ],
)
def test_only_real_mode_permits_serial(mode: RuntimeMode, allows_serial: bool, backend_mode: str) -> None:
    assert mode.allows_serial is allows_serial
    assert mode.backend_mavlink_mode == backend_mode


def test_preview_and_sitl_map_to_the_mock_transport() -> None:
    """SITL must not reach hardware until a real simulator transport exists."""
    assert RuntimeMode.SITL.backend_mavlink_mode == "mock"


# ======================================================================
# Backend settings: safety posture of the desktop session
# ======================================================================


def test_desktop_backend_never_enables_commands_by_itself() -> None:
    for mode in RuntimeMode:
        settings = BackendProcess(mode=mode).build_settings(12345)
        assert settings.allow_safe_commands is False, f"{mode} must not widen the command surface"
        assert settings.allow_arm is False
        assert settings.allow_takeoff is False


def test_real_mode_disables_auto_reconnect_so_com_is_not_reopened() -> None:
    real = BackendProcess(mode=RuntimeMode.REAL).build_settings(12345)
    assert real.auto_reconnect is False
    preview = BackendProcess(mode=RuntimeMode.PREVIEW).build_settings(12345)
    assert preview.auto_reconnect is True


def test_desktop_backend_binds_loopback_and_pins_its_own_origin() -> None:
    settings = BackendProcess(mode=RuntimeMode.PREVIEW).build_settings(45678)
    assert settings.host == "127.0.0.1"
    assert settings.allowed_origins == ("http://127.0.0.1:45678",)


def test_preview_mode_backend_uses_the_mock_transport_so_no_com_port_is_opened() -> None:
    settings = BackendProcess(mode=RuntimeMode.PREVIEW).build_settings(1234)
    assert settings.mode == "mock"
    assert settings.is_real is False


# ======================================================================
# Configuration: persistence, validation, and what must never be stored
# ======================================================================


def test_config_round_trips(temp_paths) -> None:
    config = DesktopConfig(windowWidth=1600, windowHeight=1000, workspace="analysis")
    assert save_config(temp_paths.config_file, config) is True
    assert load_config(temp_paths.config_file).windowWidth == 1600
    assert load_config(temp_paths.config_file).workspace == "analysis"


def test_missing_config_yields_defaults(temp_paths) -> None:
    assert load_config(temp_paths.config_file / "absent.json").windowWidth == 1440


@pytest.mark.parametrize("content", ["{not json", "[]", "null", '"a string"', ""])
def test_malformed_config_falls_back_to_defaults_instead_of_crashing(temp_paths, content: str) -> None:
    temp_paths.config_file.write_text(content, encoding="utf-8")
    config = load_config(temp_paths.config_file)
    assert config.windowWidth == 1440
    assert config.windowHeight == 900


def test_config_clamps_absurd_window_sizes_to_the_minimum() -> None:
    config = DesktopConfig.from_dict({"windowWidth": 10, "windowHeight": 5})
    assert config.windowWidth == MIN_WINDOW_WIDTH
    assert config.windowHeight == MIN_WINDOW_HEIGHT


def test_config_ignores_wrong_typed_fields() -> None:
    config = DesktopConfig.from_dict({"windowWidth": "wide", "maximized": "yes", "workspace": 42})
    assert config.windowWidth == 1440
    assert config.maximized is False
    assert config.workspace == "survey"


@pytest.mark.parametrize("unsafe", sorted(FORBIDDEN_CONFIG_KEYS))
def test_unsafe_state_is_never_restored_from_a_config_file(unsafe: str) -> None:
    """A hand-edited or hostile config must not restore a held dead-man, a
    pressed key, an armed state, or a command authorisation."""
    config = DesktopConfig.from_dict({unsafe: True, "windowWidth": 1500})
    assert not hasattr(config, unsafe) or getattr(config, unsafe, None) is not True
    assert unsafe not in config.to_dict()
    assert config.windowWidth == 1500  # the safe fields still load


def test_runtime_mode_is_not_persisted_so_real_cannot_be_restored(temp_paths) -> None:
    """Every launch decides its own mode; Real is never 'remembered'."""
    temp_paths.config_file.write_text(json.dumps({"runtimeMode": "real"}), encoding="utf-8")
    config = load_config(temp_paths.config_file)
    assert "runtimeMode" not in config.to_dict()


def test_saving_config_to_an_unwritable_location_does_not_raise(tmp_path: Path) -> None:
    """A full or read-only disk must not stop the application from closing."""
    target = tmp_path / "definitely" / "missing" / "\x00invalid" / "desktop.json"
    assert save_config(target, DesktopConfig()) is False


# ======================================================================
# Shutdown coordination
# ======================================================================


class _FakeServer:
    def __init__(self) -> None:
        self.should_exit = False
        self.force_exit = False


class _FakeThread:
    def __init__(self, *, alive_after_join: bool = False) -> None:
        self._alive = True
        self.alive_after_join = alive_after_join
        self.joined: list[float] = []

    def is_alive(self) -> bool:
        return self._alive

    def join(self, timeout: float | None = None) -> None:
        self.joined.append(timeout or 0.0)
        if not self.alive_after_join:
            self._alive = False


def _handle(server, thread):
    from desktop.runtime import BackendHandle

    return BackendHandle(host="127.0.0.1", port=1234, thread=thread, server=server)


def test_stop_signals_uvicorn_and_joins_the_thread() -> None:
    server, thread = _FakeServer(), _FakeThread()
    backend = BackendProcess(mode=RuntimeMode.PREVIEW)
    backend._handle = _handle(server, thread)

    assert backend.stop(timeout=2.0) is True
    assert server.should_exit is True
    assert thread.joined  # actually waited


def test_stop_is_bounded_and_forces_exit_when_the_thread_hangs() -> None:
    """A wedged backend must not hang the application's exit."""
    server, thread = _FakeServer(), _FakeThread(alive_after_join=True)
    backend = BackendProcess(mode=RuntimeMode.PREVIEW)
    backend._handle = _handle(server, thread)

    assert backend.stop(timeout=0.2) is False
    assert server.force_exit is True


def test_stopping_a_backend_that_never_started_is_a_no_op() -> None:
    assert BackendProcess(mode=RuntimeMode.PREVIEW).stop() is True


def test_stop_is_idempotent() -> None:
    server, thread = _FakeServer(), _FakeThread()
    backend = BackendProcess(mode=RuntimeMode.PREVIEW)
    backend._handle = _handle(server, thread)
    assert backend.stop() is True
    assert backend.stop() is True  # second call must not raise


# ======================================================================
# Diagnostics honesty
# ======================================================================


def test_diagnostics_never_claims_hardware_from_a_running_backend(temp_paths) -> None:
    report = collect(paths=temp_paths, runtime_mode="preview", backend_url=None, include_backend=False)
    assert report.data["mavlink"]["available"] is False
    assert "not started" in report.data["mavlink"]["note"]


def test_mavlink_status_reports_unreachable_without_inventing_a_connection() -> None:
    status = mavlink_status("http://127.0.0.1:1", timeout=0.2)
    assert status["available"] is False
    assert "error" in status


def test_diagnostics_includes_the_facts_an_operator_needs(temp_paths) -> None:
    report = collect(paths=temp_paths, runtime_mode="preview", backend_url=None, include_backend=False)
    assert report.data["application"]["runtimeMode"] == "preview"
    assert report.data["paths"]["logs"] == str(temp_paths.logs)
    assert "webview2Runtime" in report.data["webview"]
    assert report.to_text().startswith(f"{APP_NAME} diagnostics")


# ======================================================================
# The desktop shell must not open a serial port at startup
# ======================================================================


def test_importing_the_desktop_package_opens_nothing() -> None:
    """Importing must not construct a serial link. A regression here would
    mean merely launching the app touches COM10.

    Run in a subprocess rather than with importlib.reload(): reloading swaps
    the module-level classes and exception types other test modules already
    hold references to, which silently breaks their isinstance/raises checks.
    A clean interpreter is both isolated and a truer reproduction of startup.
    """
    import subprocess  # noqa: PLC0415

    probe = (
        "import serial, sys;"
        "opened=[];"
        "serial.Serial=lambda *a, **k: opened.append(a);"
        "import desktop, desktop.paths, desktop.runtime, desktop.single_instance, desktop.diagnostics;"
        "print('OPENED' if opened else 'CLEAN')"
    )
    result = subprocess.run(
        [sys.executable, "-c", probe],
        capture_output=True,
        text=True,
        timeout=90,
        cwd=str(REPO_ROOT),
        env={**os.environ, "PYTHONPATH": f"{REPO_ROOT}{os.pathsep}{REPO_ROOT / 'backend'}"},
    )
    assert result.returncode == 0, result.stderr
    assert "CLEAN" in result.stdout, f"importing the desktop package opened a serial port: {result.stdout}"


def test_building_the_preview_app_does_not_construct_a_real_link(monkeypatch: pytest.MonkeyPatch) -> None:
    """Creating the FastAPI app in Preview mode must select the mock
    transport, so no code path can reach pyserial."""
    from app.mavlink.real_connection import RealMavlinkLink  # noqa: PLC0415

    def explode(*args, **kwargs):
        raise AssertionError("Preview mode must never construct a real serial link")

    monkeypatch.setattr(RealMavlinkLink, "__init__", explode)

    app = BackendProcess(mode=RuntimeMode.PREVIEW, frontend_root=None).build_app(23456)
    assert app is not None


def test_threading_is_used_rather_than_a_child_process() -> None:
    """The backend runs in-process, so no orphaned python.exe can survive the
    window closing."""
    import inspect  # noqa: PLC0415

    source = inspect.getsource(BackendProcess.start)
    assert "threading.Thread" in source
    assert "subprocess" not in source
    assert issubclass(threading.Thread, object)


# ======================================================================
# Frozen entry point
# ======================================================================


def test_entry_wrapper_uses_absolute_imports_not_relative() -> None:
    """PyInstaller runs the entry script as __main__, where a relative import
    raises 'attempted relative import with no known parent package'. The
    wrapper must therefore import desktop.launcher absolutely.

    This exact mistake produced a packaged .exe that died before it could even
    open its log file, so the guard is worth keeping.
    """
    entry = REPO_ROOT / "packaging" / "suisuinavi_entry.py"
    assert entry.is_file(), "the PyInstaller entry wrapper is missing"

    source = entry.read_text(encoding="utf-8")
    assert "from desktop.launcher import main" in source
    # No relative imports at all in a file that runs as __main__.
    for line in source.splitlines():
        stripped = line.strip()
        assert not stripped.startswith("from ."), f"relative import in the entry wrapper: {stripped}"


def test_spec_entry_point_is_the_wrapper_not_the_launcher_module() -> None:
    spec = (REPO_ROOT / "packaging" / "SuisuiNavi.spec").read_text(encoding="utf-8")
    assert "suisuinavi_entry.py" in spec
    assert '"desktop" / "launcher.py"' not in spec.replace("'", '"')


def test_entry_wrapper_runs_as_main_without_import_errors() -> None:
    """Execute the wrapper the way PyInstaller does -- as a script -- and
    confirm it reaches the launcher's own CLI rather than dying on import."""
    import subprocess  # noqa: PLC0415

    result = subprocess.run(
        [sys.executable, str(REPO_ROOT / "packaging" / "suisuinavi_entry.py"), "--help"],
        capture_output=True,
        text=True,
        timeout=90,
        cwd=str(REPO_ROOT),
        env={**os.environ, "PYTHONPATH": f"{REPO_ROOT}{os.pathsep}{REPO_ROOT / 'backend'}"},
    )
    assert result.returncode == 0, f"entry wrapper failed:\n{result.stderr}"
    assert "SuisuiNavi" in result.stdout
    assert "--mode" in result.stdout


# ======================================================================
# Window teardown must not call back into the WebView
# ======================================================================


def _method_body_without_docstring(method) -> str:
    """A method's executable source, with its docstring removed.

    The methods under test document *why* the forbidden call is dangerous, so
    a raw substring scan would match their own warning.
    """
    import ast  # noqa: PLC0415
    import inspect  # noqa: PLC0415
    import textwrap  # noqa: PLC0415

    source = textwrap.dedent(inspect.getsource(method))
    tree = ast.parse(source)
    function = tree.body[0]
    body = list(getattr(function, "body", []))
    if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
        if isinstance(body[0].value.value, str):
            body = body[1:]
    return "\n".join(ast.unparse(node) for node in body)


def test_closing_handler_never_calls_back_into_the_window() -> None:
    """Regression: `_on_closing` originally called into the WebView, which
    deadlocks while it is being destroyed -- the call waits for a JavaScript
    result that can never arrive. The packaged executable hung on close and
    had to be killed. The handler must only log."""
    from desktop.launcher import DesktopApplication  # noqa: PLC0415

    code = _method_body_without_docstring(DesktopApplication._on_closing)
    for forbidden in ("evaluate_js", "notify_frontend_blur", "self.window"):
        assert forbidden not in code, f"_on_closing must not touch the window ({forbidden})"


def test_persist_window_state_reads_only_in_memory_config() -> None:
    """It runs during shutdown, when the window may already be destroyed."""
    from desktop.launcher import DesktopApplication  # noqa: PLC0415

    code = _method_body_without_docstring(DesktopApplication.persist_window_state)
    assert "self.window" not in code
    assert "save_config" in code


def test_resize_and_move_events_update_the_config_in_memory(tmp_path: Path, monkeypatch) -> None:
    """Geometry is captured as it changes so close-time needs no window access."""
    from desktop.launcher import DesktopApplication  # noqa: PLC0415

    monkeypatch.setenv(paths_module.ENV_DATA_HOME, str(tmp_path / "data"))
    monkeypatch.setenv(paths_module.ENV_ASSET_ROOT, str(REPO_ROOT))
    application = DesktopApplication(mode=RuntimeMode.PREVIEW)

    application._on_resized(1600, 1000)
    assert (application.config.windowWidth, application.config.windowHeight) == (1600, 1000)

    application._on_moved(120, 80)
    assert (application.config.windowX, application.config.windowY) == (120, 80)

    # An absurd size from a minimised/odd event must not be persisted.
    application._on_resized(10, 10)
    assert application.config.windowWidth == 1600


def test_shutdown_persists_geometry_and_is_idempotent(tmp_path: Path, monkeypatch) -> None:
    from desktop.launcher import DesktopApplication  # noqa: PLC0415

    monkeypatch.setenv(paths_module.ENV_DATA_HOME, str(tmp_path / "data"))
    monkeypatch.setenv(paths_module.ENV_ASSET_ROOT, str(REPO_ROOT))
    application = DesktopApplication(mode=RuntimeMode.PREVIEW)
    application._on_resized(1500, 950)

    application.shutdown()
    saved = load_config(application.paths.config_file)
    assert saved.windowWidth == 1500

    application.shutdown()  # second call must be a no-op, not an error
