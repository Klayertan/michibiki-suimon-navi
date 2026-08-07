"""WebSocket disconnect handling.

Observed defect: refreshing/closing the browser, or stopping the backend
while a client was connected, produced

    Task exception was never retrieved
    starlette.websockets.WebSocketDisconnect
    ... inside backend/app/main.py::_drain_client

Root cause: `_drain_client` ran as its own ``asyncio.Task`` with no
try/except of its own. `WebSocketDisconnect` raised inside it whenever the
client went away. The main handler's `await asyncio.wait({reader}, ...)`
notices the task finished but does **not** propagate or retrieve its
exception -- that is exactly what `asyncio.wait()` documents it will not do.
Nothing else ever called `.result()`/`.exception()` on the task or awaited
it, so the exception sat on the Task object until Python's garbage collector
reclaimed it, at which point asyncio's default exception handler logged
"Task exception was never retrieved" through the standard `logging.getLogger
("asyncio")` logger.

Two layers of tests:

* Direct, deterministic unit tests of `_drain_client` and `_consume_reader`
  against fake WebSocket-like objects and hand-built asyncio Tasks -- these
  do not depend on garbage-collection timing at all.
* End-to-end tests through `TestClient` and a real (in-process) WebSocket
  connection, covering every required disconnect shape, plus a GC-based
  check (using the same `logging.getLogger("asyncio")` path the real defect
  used) that no "Task exception was never retrieved" record is ever produced.
"""

from __future__ import annotations

import asyncio
import gc
import logging

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.config import Settings
from app.main import _consume_reader, _drain_client, create_app
from app.mavlink.mock_connection import MockMavlinkLink

from .conftest import wait_until


# ==========================================================================
# Direct unit tests: _drain_client and _consume_reader in isolation
# ==========================================================================


class _FakeWebSocket:
    """Minimal stand-in exposing only what `_drain_client` calls."""

    def __init__(self, *, raise_after: int = 0, to_raise: Exception) -> None:
        self._calls = 0
        self._raise_after = raise_after
        self._to_raise = to_raise

    async def receive_text(self) -> str:
        self._calls += 1
        if self._calls > self._raise_after:
            raise self._to_raise
        return "ignored: inbound frames carry no commands"


@pytest.mark.anyio
@pytest.mark.parametrize("code", [1000, 1001, 1006], ids=["normal-1000", "navigation-1001", "abnormal-1006"])
async def test_drain_client_returns_normally_for_every_ordinary_close_code(code: int) -> None:
    ws = _FakeWebSocket(to_raise=WebSocketDisconnect(code=code))
    await _drain_client(ws)  # must not raise


@pytest.mark.anyio
async def test_drain_client_does_not_swallow_a_genuine_programming_error() -> None:
    ws = _FakeWebSocket(to_raise=ValueError("a real bug, not a disconnect"))
    with pytest.raises(ValueError, match="a real bug"):
        await _drain_client(ws)


@pytest.mark.anyio
async def test_consume_reader_is_silent_for_a_client_disconnect(caplog: pytest.LogCaptureFixture) -> None:
    async def _raise_disconnect() -> None:
        raise WebSocketDisconnect(code=1001)

    task = asyncio.create_task(_raise_disconnect())
    with caplog.at_level(logging.WARNING):
        await _consume_reader(task)  # must not raise, must not warn
    assert "unexpected" not in caplog.text.lower()


@pytest.mark.anyio
async def test_consume_reader_is_silent_when_we_cancelled_the_task_ourselves() -> None:
    async def _hang() -> None:
        await asyncio.sleep(30)

    task = asyncio.create_task(_hang())
    await asyncio.sleep(0)  # let it actually start
    task.cancel()
    await _consume_reader(task)  # must not raise CancelledError


@pytest.mark.anyio
async def test_consume_reader_logs_a_genuine_unexpected_error_instead_of_swallowing_it(
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def _raise_value_error() -> None:
        raise ValueError("a real bug in the reader")

    task = asyncio.create_task(_raise_value_error())
    with caplog.at_level(logging.WARNING):
        await _consume_reader(task)  # must not raise -- the caller (finally block) cannot break
    assert "unexpected error" in caplog.text.lower()
    assert "a real bug in the reader" in caplog.text


# ==========================================================================
# End-to-end: TestClient + a real in-process WebSocket connection
# ==========================================================================


@pytest.fixture
def link() -> MockMavlinkLink:
    return MockMavlinkLink(target_system=1, target_component=1)


@pytest.fixture
def ws_settings(settings: Settings) -> Settings:
    """Fast telemetry cadence so a handful of frames is a short wait."""
    return Settings(
        mode=settings.mode,
        heartbeat_interval=settings.heartbeat_interval,
        stale_timeout=settings.stale_timeout,
        link_lost_timeout=settings.link_lost_timeout,
        allow_safe_commands=settings.allow_safe_commands,
        ws_interval=0.05,
    )


@pytest.fixture
def ws_client(ws_settings: Settings, link: MockMavlinkLink):
    app = create_app(ws_settings, link_factory=lambda: link)
    with TestClient(app) as test_client:
        yield test_client


class _AsyncioErrorCapture:
    """Attaches a handler to logging.getLogger("asyncio") for the duration of
    a `with` block and records every ERROR-level message -- the exact path
    "Task exception was never retrieved" is logged through."""

    def __init__(self) -> None:
        self.records: list[str] = []
        self._logger = logging.getLogger("asyncio")
        self._handler = logging.Handler()
        self._handler.emit = lambda record: self.records.append(record.getMessage())  # type: ignore[method-assign]

    def __enter__(self) -> "_AsyncioErrorCapture":
        self._logger.addHandler(self._handler)
        return self

    def __exit__(self, *exc_info: object) -> None:
        # Force any orphaned Task's __del__ to run now rather than whenever
        # the interpreter next feels like it, so the assertion is
        # deterministic instead of racing the garbage collector.
        gc.collect()
        self._logger.removeHandler(self._handler)

    @property
    def leaked_task_exceptions(self) -> list[str]:
        return [msg for msg in self.records if "never retrieved" in msg.lower()]


def test_normal_websocket_close(ws_client: TestClient, caplog: pytest.LogCaptureFixture) -> None:
    with _AsyncioErrorCapture() as capture:
        with caplog.at_level(logging.INFO, logger="app.main"):
            with ws_client.websocket_connect("/api/drone/telemetry/ws") as websocket:
                websocket.receive_json()
                websocket.close(code=1000)

    assert capture.leaked_task_exceptions == []
    assert "telemetry websocket client connected" in caplog.text
    assert "telemetry websocket client disconnected" in caplog.text
    # A normal, expected disconnect must not be logged as a warning/error.
    assert not any(record.levelno >= logging.WARNING for record in caplog.records)


def test_browser_navigation_1001_close(ws_client: TestClient, caplog: pytest.LogCaptureFixture) -> None:
    with _AsyncioErrorCapture() as capture:
        with caplog.at_level(logging.INFO, logger="app.main"):
            with ws_client.websocket_connect("/api/drone/telemetry/ws") as websocket:
                websocket.receive_json()
                websocket.close(code=1001)

    assert capture.leaked_task_exceptions == []
    assert "telemetry websocket client disconnected" in caplog.text
    assert not any(record.levelno >= logging.WARNING for record in caplog.records)


def test_abnormal_client_disconnect(ws_client: TestClient, caplog: pytest.LogCaptureFixture) -> None:
    """Code 1006 is technically never sent over the wire by a well-behaved
    peer (it is what the *receiver* infers from a dead connection), but from
    this server's point of view it is just another code arriving on the
    disconnect event -- exactly what a client-side abrupt drop looks like."""
    with _AsyncioErrorCapture() as capture:
        with caplog.at_level(logging.INFO, logger="app.main"):
            with ws_client.websocket_connect("/api/drone/telemetry/ws") as websocket:
                websocket.receive_json()
                websocket.close(code=1006)

    assert capture.leaked_task_exceptions == []
    assert "telemetry websocket client disconnected" in caplog.text
    assert not any(record.levelno >= logging.WARNING for record in caplog.records)


def test_backend_shutdown_while_websocket_is_connected(ws_client: TestClient, caplog: pytest.LogCaptureFixture) -> None:
    """Simulates what the app's lifespan shutdown hook does
    (`manager.shutdown()`) while a browser tab still has the socket open --
    must not hang, raise, or leak a task."""
    manager = ws_client.app.state.manager
    with _AsyncioErrorCapture() as capture:
        with caplog.at_level(logging.INFO, logger="app.main"):
            with ws_client.websocket_connect("/api/drone/telemetry/ws") as websocket:
                websocket.receive_json()

                manager.shutdown()  # the exact call the lifespan finally block makes
                assert manager.is_running() is False

                # The link is gone but the socket itself is still open and
                # must keep streaming (now-disconnected) snapshots without
                # erroring.
                frame = websocket.receive_json()
                assert frame["payload"]["connectionState"] == "disconnected"

    assert capture.leaked_task_exceptions == []
    assert not any(record.levelno >= logging.WARNING for record in caplog.records)


def test_repeated_connect_and_disconnect_leaks_nothing(ws_client: TestClient) -> None:
    with _AsyncioErrorCapture() as capture:
        for _ in range(8):
            with ws_client.websocket_connect("/api/drone/telemetry/ws") as websocket:
                websocket.receive_json()

    assert capture.leaked_task_exceptions == []
    # The server must still be completely healthy afterwards.
    assert ws_client.get("/api/health").json()["status"] == "ok"


def test_no_leaked_task_or_unhandled_exception_warning_across_mixed_close_codes(
    ws_client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    """One combined pass over every disconnect shape this fix covers."""
    with _AsyncioErrorCapture() as capture:
        with caplog.at_level(logging.WARNING):
            for code in (1000, 1001, 1006, 1000):
                with ws_client.websocket_connect("/api/drone/telemetry/ws") as websocket:
                    websocket.receive_json()
                    websocket.close(code=code)

    assert capture.leaked_task_exceptions == []
    assert not any(
        "task exception was never retrieved" in record.message.lower() for record in caplog.records
    )


def test_websocket_still_streams_telemetry_and_reconnects_after_prior_disconnects(
    ws_client: TestClient,
) -> None:
    """The fix must not break the ordinary streaming/reconnect behaviour it
    wraps -- connect, disconnect, and connect again must all still work and
    still deliver live frames."""
    with ws_client.websocket_connect("/api/drone/telemetry/ws") as first:
        first.receive_json()

    ws_client.post("/api/drone/connect", json={})
    assert wait_until(lambda: ws_client.get("/api/drone/status").json()["connectionState"] == "connected")

    with ws_client.websocket_connect("/api/drone/telemetry/ws") as second:
        frames = [second.receive_json() for _ in range(3)]
    assert all(frame["type"] == "telemetry" for frame in frames)
    assert frames[-1]["payload"]["connectionState"] == "connected"
