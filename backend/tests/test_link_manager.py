"""Link lifecycle: connect, heartbeat, staleness, reconnect, shutdown."""

from __future__ import annotations

import threading

import pytest

from app.config import MODE_MOCK, Settings
from app.mavlink.interface import LinkError, PortBusyError
from app.mavlink.link_manager import LinkBusyError, LinkManager
from app.mavlink.mock_connection import MockMavlinkLink, MockScenario
from app.mavlink.telemetry_state import ConnectionState

from .conftest import wait_until


def test_connect_reaches_connected_and_populates_telemetry(manager: LinkManager) -> None:
    manager.connect()
    assert wait_until(lambda: manager.state.get_connection_state() is ConnectionState.CONNECTED)

    snapshot = wait_until_snapshot(manager, lambda s: s["battery"]["voltage"] is not None)
    assert snapshot["vehicle"]["flightMode"] == "STABILIZE"
    assert snapshot["vehicle"]["armed"] is False
    assert snapshot["vehicle"]["vehicleTypeName"] == "QUADROTOR"
    assert 10.0 < snapshot["battery"]["voltage"] < 20.0
    assert snapshot["gps"]["fixTypeName"] == "3D_FIX"
    assert snapshot["link"]["stale"] is False


def test_gcs_heartbeat_is_sent_continuously_while_connected(manager: LinkManager) -> None:
    manager.connect()
    assert wait_until(lambda: manager.snapshot()["link"]["gcsHeartbeatsSent"] >= 3, timeout=4.0)

    transport = manager.snapshot()["transport"]
    assert transport["gcsHeartbeatsSent"] >= 3


def test_importing_modules_never_opens_a_link(manager: LinkManager) -> None:
    """Constructing a manager must not start anything."""
    assert manager.is_running() is False
    assert manager.snapshot()["connectionState"] == ConnectionState.DISCONNECTED.value


def test_second_connect_is_refused_so_one_owner_holds_the_port(manager: LinkManager) -> None:
    manager.connect()
    assert wait_until(lambda: manager.is_running())
    with pytest.raises(LinkBusyError):
        manager.connect()


def test_disconnect_stops_the_worker_and_clears_vehicle_data(manager: LinkManager) -> None:
    manager.connect()
    assert wait_until(lambda: manager.snapshot()["battery"]["voltage"] is not None)

    snapshot = manager.disconnect()
    assert manager.is_running() is False
    assert snapshot["connectionState"] == ConnectionState.DISCONNECTED.value
    assert snapshot["battery"]["voltage"] is None, "stale telemetry must not survive a disconnect"


def test_disconnect_is_idempotent(manager: LinkManager) -> None:
    manager.connect()
    manager.disconnect()
    second = manager.disconnect()
    assert second["connectionState"] == ConnectionState.DISCONNECTED.value


def test_shutdown_closes_the_transport(settings: Settings) -> None:
    link = MockMavlinkLink(target_system=1, target_component=1)
    manager = LinkManager(settings, lambda: link)
    manager.connect()
    assert wait_until(lambda: link.is_open)

    manager.shutdown()
    assert link.is_open is False, "the port must be released on shutdown"
    assert manager.is_running() is False


def test_port_busy_error_is_surfaced_with_the_qgc_hint(settings: Settings) -> None:
    busy = PortBusyError("Serial port COM10 is already in use by another program. QGroundControl ...")
    link = MockMavlinkLink(scenario=MockScenario(fail_open_with=busy))
    manager = LinkManager(settings, lambda: link)
    try:
        manager.connect()
        assert wait_until(lambda: manager.state.get_connection_state() is ConnectionState.ERROR)
        error = manager.snapshot()["error"]
        assert error["kind"] == "PortBusyError"
        assert "QGroundControl" in error["message"]
    finally:
        manager.shutdown()


def test_telemetry_goes_stale_when_the_radio_falls_silent(settings: Settings) -> None:
    link = MockMavlinkLink()
    manager = LinkManager(settings, lambda: link)
    try:
        manager.connect()
        assert wait_until(lambda: manager.state.get_connection_state() is ConnectionState.CONNECTED)

        link.inject_link_loss(2.5)
        assert wait_until(
            lambda: manager.state.get_connection_state() is ConnectionState.TELEMETRY_STALE,
            timeout=4.0,
        )
        assert manager.snapshot()["link"]["stale"] is True
        assert manager.snapshot()["commandable"] is False
    finally:
        manager.shutdown()


def test_link_recovers_from_a_temporary_dropout(settings: Settings) -> None:
    link = MockMavlinkLink()
    manager = LinkManager(settings, lambda: link)
    try:
        manager.connect()
        assert wait_until(lambda: manager.state.get_connection_state() is ConnectionState.CONNECTED)

        link.inject_link_loss(1.5)
        assert wait_until(
            lambda: manager.state.get_connection_state() is ConnectionState.TELEMETRY_STALE,
            timeout=4.0,
        )
        assert wait_until(
            lambda: manager.state.get_connection_state() is ConnectionState.CONNECTED,
            timeout=5.0,
        ), "the link must return to connected once telemetry resumes"
    finally:
        manager.shutdown()


def test_link_goes_lost_when_silence_exceeds_the_longer_timeout(settings: Settings) -> None:
    link = MockMavlinkLink()
    manager = LinkManager(settings, lambda: link)
    try:
        manager.connect()
        assert wait_until(lambda: manager.state.get_connection_state() is ConnectionState.CONNECTED)

        link.inject_link_loss(6.0)
        assert wait_until(
            lambda: manager.state.get_connection_state() is ConnectionState.LINK_LOST,
            timeout=6.0,
        )
    finally:
        manager.shutdown()


def test_auto_reconnect_retries_after_a_failed_open() -> None:
    settings = Settings(
        mode=MODE_MOCK,
        heartbeat_interval=0.2,
        stale_timeout=1.0,
        link_lost_timeout=2.0,
        connect_timeout=2.0,
        reconnect_delay=0.2,
        auto_reconnect=True,
        allow_safe_commands=True,
    )
    attempts: list[int] = []
    barrier = threading.Event()

    def factory():
        attempts.append(1)
        if len(attempts) == 1:
            return MockMavlinkLink(scenario=MockScenario(fail_open_with=LinkError("radio not ready")))
        barrier.set()
        return MockMavlinkLink()

    manager = LinkManager(settings, factory)
    try:
        manager.connect(settle_timeout=0.5)
        assert barrier.wait(5.0), "the worker must retry after a failed open"
        assert wait_until(
            lambda: manager.state.get_connection_state() is ConnectionState.CONNECTED,
            timeout=5.0,
        )
        assert len(attempts) >= 2
    finally:
        manager.shutdown()


def test_no_reconnect_when_auto_reconnect_is_disabled(settings: Settings) -> None:
    attempts: list[int] = []

    def factory():
        attempts.append(1)
        return MockMavlinkLink(scenario=MockScenario(fail_open_with=LinkError("radio not ready")))

    manager = LinkManager(settings, factory)  # settings fixture has auto_reconnect=False
    try:
        manager.connect(settle_timeout=1.0)
        assert wait_until(lambda: not manager.is_running(), timeout=3.0)
        assert len(attempts) == 1
        assert manager.snapshot()["connectionState"] == ConnectionState.ERROR.value
    finally:
        manager.shutdown()


def test_submitting_a_job_without_a_link_fails_fast(manager: LinkManager) -> None:
    future = manager.submit(lambda link: None)
    with pytest.raises(LinkError):
        future.result(timeout=1.0)


def wait_until_snapshot(manager: LinkManager, predicate, timeout: float = 5.0) -> dict:
    """Wait for a snapshot satisfying ``predicate`` and return it."""
    holder: dict = {}

    def check() -> bool:
        holder["value"] = manager.snapshot()
        return predicate(holder["value"])

    assert wait_until(check, timeout=timeout), f"condition never held; last snapshot: {holder.get('value')}"
    return holder["value"]
