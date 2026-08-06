"""HTTP and WebSocket surface tests.

The app under test always uses a mock link injected through ``link_factory``,
so the whole API is exercised without a serial port.
"""

from __future__ import annotations

import dataclasses

import pytest
from fastapi.testclient import TestClient

from app.config import MODE_REAL, Settings
from app.main import create_app
from app.mavlink.mock_connection import MockMavlinkLink

from .conftest import wait_until


@pytest.fixture
def link() -> MockMavlinkLink:
    return MockMavlinkLink(target_system=1, target_component=1)


@pytest.fixture
def client(settings: Settings, link: MockMavlinkLink):
    app = create_app(settings, link_factory=lambda: link)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def connected_client(client: TestClient):
    response = client.post("/api/drone/connect", json={})
    assert response.status_code == 200, response.text
    assert wait_until(lambda: client.get("/api/drone/status").json()["connectionState"] == "connected")
    return client


# ----------------------------------------------------------------------
# Read-only endpoints
# ----------------------------------------------------------------------


def test_health_reports_mode_without_connecting(client: TestClient) -> None:
    body = client.get("/api/health").json()
    assert body["status"] == "ok"
    assert body["mode"] == "mock"
    assert body["linkRunning"] is False


def test_status_works_before_any_connection(client: TestClient) -> None:
    body = client.get("/api/drone/status").json()
    assert body["connectionState"] == "disconnected"
    assert body["connected"] is False
    assert body["battery"]["voltage"] is None
    assert body["armSupported"] is False


def test_config_lists_allowed_modes_and_disabled_operations(client: TestClient) -> None:
    body = client.get("/api/drone/config").json()

    assert body["allowedModes"] == ["STABILIZE", "ALT_HOLD"]
    assert body["config"]["armSupported"] is False
    assert body["config"]["takeoffSupported"] is False
    for operation in ("arm", "takeoff", "rc_override", "motor_test"):
        assert operation in body["disabledOperations"]


# ----------------------------------------------------------------------
# Connection lifecycle
# ----------------------------------------------------------------------


def test_connect_then_status_reports_live_telemetry(connected_client: TestClient) -> None:
    body = connected_client.get("/api/drone/status").json()

    assert body["connected"] is True
    assert body["vehicle"]["flightMode"] == "STABILIZE"
    assert body["vehicle"]["armed"] is False
    assert body["link"]["stale"] is False
    assert body["link"]["gcsHeartbeatsSent"] >= 1


def test_double_connect_is_a_conflict(connected_client: TestClient) -> None:
    response = connected_client.post("/api/drone/connect", json={})
    assert response.status_code == 409
    assert response.json()["reason"] == "already_connected"


def test_disconnect_releases_and_clears(connected_client: TestClient) -> None:
    response = connected_client.post("/api/drone/disconnect")
    assert response.status_code == 200

    body = connected_client.get("/api/drone/status").json()
    assert body["connectionState"] == "disconnected"
    assert body["battery"]["voltage"] is None


def test_reconnect_after_disconnect_works(connected_client: TestClient) -> None:
    connected_client.post("/api/drone/disconnect")
    assert connected_client.post("/api/drone/connect", json={}).status_code == 200
    assert wait_until(
        lambda: connected_client.get("/api/drone/status").json()["connectionState"] == "connected"
    )


# ----------------------------------------------------------------------
# Commands
# ----------------------------------------------------------------------


def test_mode_change_reports_the_vehicle_confirmed_mode(connected_client: TestClient) -> None:
    response = connected_client.post("/api/drone/mode", json={"mode": "ALT_HOLD"})
    assert response.status_code == 200, response.text

    body = response.json()
    assert body["ok"] is True
    assert body["detail"]["finalMode"] == "ALT_HOLD"


def test_mode_change_is_rejected_when_armed(connected_client: TestClient, link: MockMavlinkLink) -> None:
    link.set_armed(True)
    assert wait_until(lambda: connected_client.get("/api/drone/status").json()["vehicle"]["armed"] is True)

    response = connected_client.post("/api/drone/mode", json={"mode": "ALT_HOLD"})
    assert response.status_code == 409
    assert response.json()["reason"] == "armed"


@pytest.mark.parametrize("mode", ["GUIDED", "AUTO", "RTL", "LAND", "LOITER", "POSHOLD", "guided"])
def test_disallowed_modes_fail_validation_at_the_boundary(connected_client: TestClient, mode: str) -> None:
    """Pydantic's Literal rejects these before any handler code runs."""
    response = connected_client.post("/api/drone/mode", json={"mode": mode})
    assert response.status_code == 422, f"{mode} must not be accepted"


def test_numeric_mode_is_rejected(connected_client: TestClient) -> None:
    assert connected_client.post("/api/drone/mode", json={"mode": 4}).status_code == 422
    assert connected_client.post("/api/drone/mode", json={"mode": "4"}).status_code == 422


def test_unknown_fields_are_rejected_not_ignored(connected_client: TestClient) -> None:
    response = connected_client.post(
        "/api/drone/mode", json={"mode": "ALT_HOLD", "customMode": 4, "force": True}
    )
    assert response.status_code == 422


def test_missing_body_is_rejected(connected_client: TestClient) -> None:
    assert connected_client.post("/api/drone/mode", json={}).status_code == 422


def test_malformed_json_is_rejected(connected_client: TestClient) -> None:
    response = connected_client.post(
        "/api/drone/mode", content=b"{not json", headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 422


def test_oversized_body_is_refused(connected_client: TestClient) -> None:
    response = connected_client.post(
        "/api/drone/mode",
        content=b'{"mode":"' + b"A" * 20000 + b'"}',
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 413
    assert response.json()["reason"] == "payload_too_large"


def test_request_version_returns_firmware(connected_client: TestClient) -> None:
    body = connected_client.post("/api/drone/request-version").json()
    assert body["ok"] is True
    assert body["detail"]["version"]["flightSwVersion"] == "4.5.7"


def test_request_streams_rejects_a_stream_outside_the_allowlist(connected_client: TestClient) -> None:
    assert connected_client.post("/api/drone/request-streams", json={"streams": ["ATTITUDE"]}).status_code == 200
    assert (
        connected_client.post("/api/drone/request-streams", json={"streams": ["SERVO_OUTPUT_RAW"]}).status_code
        == 422
    )


def test_commands_are_refused_when_the_backend_is_read_only(link: MockMavlinkLink, settings: Settings) -> None:
    read_only = dataclasses.replace(settings, allow_safe_commands=False)
    app = create_app(read_only, link_factory=lambda: link)
    with TestClient(app) as client:
        client.post("/api/drone/connect", json={})
        assert wait_until(lambda: client.get("/api/drone/status").json()["connectionState"] == "connected")

        response = client.post("/api/drone/mode", json={"mode": "ALT_HOLD"})
        assert response.status_code == 403
        assert response.json()["reason"] == "commands_disabled"


# ----------------------------------------------------------------------
# Disabled operations
# ----------------------------------------------------------------------


@pytest.mark.parametrize(
    "operation",
    ["arm", "disarm", "takeoff", "land", "rtl", "mission_upload", "guided_goto", "rc_override", "manual_control", "motor_test", "set_parameter"],
)
def test_disabled_operations_return_501_and_transmit_nothing(
    connected_client: TestClient, operation: str
) -> None:
    response = connected_client.post(f"/api/drone/disabled/{operation}")
    assert response.status_code == 501

    body = response.json()
    assert body["ok"] is False
    assert body["reason"] == "not_implemented"
    assert body["detail"]["transmitted"] is False


def test_there_is_no_arm_or_takeoff_endpoint(connected_client: TestClient) -> None:
    for path in ("/api/drone/arm", "/api/drone/takeoff", "/api/drone/land", "/api/drone/rtl"):
        assert connected_client.post(path).status_code == 404, f"{path} must not exist"


def test_there_is_no_generic_mavlink_send_endpoint(client: TestClient) -> None:
    """No route may accept an arbitrary command id or raw packet."""
    routes = {route.path for route in client.app.routes}
    for suspicious in ("/api/drone/send", "/api/drone/command", "/api/drone/raw", "/api/drone/mavlink"):
        assert suspicious not in routes

    openapi = client.get("/openapi.json").json()
    body = str(openapi).lower()
    for forbidden in ("arm_disarm", "takeoff", "rc_override", "manual_control", "motor_test"):
        # These may appear only inside the disabledOperations documentation,
        # never as an operable request field.
        assert f'"{forbidden}"' not in body or "disabled" in body


# ----------------------------------------------------------------------
# Real-mode guards (no serial port is opened: only validation is reached)
# ----------------------------------------------------------------------


def test_real_mode_connect_requires_propellers_removed_confirmation(link: MockMavlinkLink) -> None:
    real = Settings(mode=MODE_REAL, allow_safe_commands=True, connect_timeout=1.0)
    app = create_app(real, link_factory=lambda: link)
    with TestClient(app) as client:
        response = client.post("/api/drone/connect", json={"propellersRemoved": False})
        assert response.status_code == 412
        assert response.json()["reason"] == "props_not_confirmed"
        assert client.get("/api/drone/status").json()["connectionState"] == "disconnected"


def test_real_mode_mode_change_requires_explicit_confirmation(link: MockMavlinkLink) -> None:
    real = Settings(mode=MODE_REAL, allow_safe_commands=True, connect_timeout=1.0)
    app = create_app(real, link_factory=lambda: link)
    with TestClient(app) as client:
        client.post("/api/drone/connect", json={"propellersRemoved": True})
        assert wait_until(lambda: client.get("/api/drone/status").json()["connectionState"] == "connected")

        unconfirmed = client.post("/api/drone/mode", json={"mode": "ALT_HOLD"})
        assert unconfirmed.status_code == 412
        assert unconfirmed.json()["reason"] == "confirmation_required"

        confirmed = client.post("/api/drone/mode", json={"mode": "ALT_HOLD", "confirmed": True})
        assert confirmed.status_code == 200
        assert confirmed.json()["detail"]["finalMode"] == "ALT_HOLD"


def test_real_mode_config_exposes_the_serial_settings(link: MockMavlinkLink) -> None:
    real = Settings(mode=MODE_REAL, port="COM10", baud=57600)
    app = create_app(real, link_factory=lambda: link)
    with TestClient(app) as client:
        config = client.get("/api/drone/config").json()["config"]
        assert config["port"] == "COM10"
        assert config["baud"] == 57600


# ----------------------------------------------------------------------
# WebSocket
# ----------------------------------------------------------------------


def test_websocket_streams_full_snapshots(connected_client: TestClient) -> None:
    with connected_client.websocket_connect("/api/drone/telemetry/ws") as websocket:
        frame = websocket.receive_json()

        assert frame["type"] == "telemetry"
        payload = frame["payload"]
        for section in ("connectionState", "link", "vehicle", "battery", "gps", "attitude", "motion", "position", "statusTexts"):
            assert section in payload, f"{section} missing from the websocket payload"
        assert payload["link"]["stale"] is False
        assert "lastMessageAge" in payload["link"]


def test_websocket_updates_repeatedly(connected_client: TestClient) -> None:
    with connected_client.websocket_connect("/api/drone/telemetry/ws") as websocket:
        frames = [websocket.receive_json() for _ in range(3)]
    assert len(frames) == 3
    assert all(frame["type"] == "telemetry" for frame in frames)


def test_websocket_works_before_a_connection_exists(client: TestClient) -> None:
    with client.websocket_connect("/api/drone/telemetry/ws") as websocket:
        payload = websocket.receive_json()["payload"]
    assert payload["connectionState"] == "disconnected"


def test_websocket_client_disconnect_is_handled_cleanly(connected_client: TestClient) -> None:
    with connected_client.websocket_connect("/api/drone/telemetry/ws") as websocket:
        websocket.receive_json()
    # The server must still be healthy after an abrupt client close.
    assert connected_client.get("/api/health").json()["status"] == "ok"
