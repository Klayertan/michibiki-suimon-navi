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
from app.mavlink import constants
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
    assert body["armSupported"] is True


def test_config_lists_allowed_modes_and_disabled_operations(client: TestClient) -> None:
    body = client.get("/api/drone/config").json()

    assert body["allowedModes"] == ["STABILIZE", "ALT_HOLD"]
    assert body["config"]["armSupported"] is True
    assert body["config"]["takeoffSupported"] is False
    assert "arm" not in body["disabledOperations"]
    assert "disarm" not in body["disabledOperations"]
    for operation in ("takeoff", "raw_rc_override", "motor_test"):
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
# Pilot bench-test endpoint
# ----------------------------------------------------------------------
#
# API-boundary coverage for /api/drone/pilot/bench/enable. The gate logic
# itself (dead-man, real-mode requirement, bench limits) is covered against
# PilotService directly in test_pilot_service.py; these tests exist to prove
# the HTTP layer actually enforces the propellers-removed acknowledgement
# before a request ever reaches that service.


def test_bench_enable_is_a_403_when_pilot_control_is_not_configured(client: TestClient) -> None:
    """Default settings: allow_pilot_control is False. Bench mode inherits
    the same off-by-default posture as general pilot control."""
    response = client.post("/api/drone/pilot/bench/enable", json={"propsRemovedAck": True})
    assert response.status_code == 403
    assert response.json()["reason"] == "pilot_control_disabled"


@pytest.mark.parametrize("body", [{"propsRemovedAck": False}, {}, {"propsRemovedAck": "yes"}])
def test_bench_enable_rejects_anything_other_than_ack_true(
    link: MockMavlinkLink, settings: Settings, body: dict
) -> None:
    """False, missing, or a truthy-looking string must all be a 422 -- the
    confirmation cannot be defaulted, omitted, or coerced."""
    enabled = dataclasses.replace(settings, allow_pilot_control=True)
    app = create_app(enabled, link_factory=lambda: link)
    with TestClient(app) as client:
        response = client.post("/api/drone/pilot/bench/enable", json=body)
        assert response.status_code == 422
        assert client.get("/api/drone/status").json()["pilot"]["benchMode"] is False


def test_bench_enable_with_ack_true_opens_bench_mode(link: MockMavlinkLink, settings: Settings) -> None:
    enabled = dataclasses.replace(settings, allow_pilot_control=True)
    app = create_app(enabled, link_factory=lambda: link)
    with TestClient(app) as client:
        response = client.post("/api/drone/pilot/bench/enable", json={"propsRemovedAck": True})
        assert response.status_code == 200
        body = response.json()["detail"]["pilot"]
        assert body["enabled"] is True
        assert body["benchMode"] is True
        assert body["propsRemovedAck"] is True
        # Mock mode deliberately simulates the complete browser acceptance
        # flow without opening real hardware.
        assert body["benchRequiresRealMode"] is False
        assert body["simulation"] is True


def test_pilot_input_carries_deadman_through_to_the_service(link: MockMavlinkLink, settings: Settings) -> None:
    """The plain /pilot/input endpoint (also used by bench mode) must forward
    the deadman flag rather than silently dropping it."""
    enabled = dataclasses.replace(settings, allow_pilot_control=True)
    app = create_app(enabled, link_factory=lambda: link)
    with TestClient(app) as client:
        client.post("/api/drone/pilot/bench/enable", json={"propsRemovedAck": True})
        response = client.post(
            "/api/drone/pilot/input",
            json={"pitch": 0.5, "deadman": True, "source": "keyboard", "sequence": 1},
        )
        assert response.json()["detail"]["pilot"]["deadman"] is True
        response = client.post(
            "/api/drone/pilot/input",
            json={"forward": 0.5, "deadman": False, "source": "keyboard", "sequence": 2},
        )
        assert response.json()["detail"]["pilot"]["deadman"] is False
        assert response.json()["detail"]["pilot"]["axes"] == {
            "pitch": 0.5,
            "roll": 0.0,
            "throttle": 0.0,
            "yaw": 0.0,
        }


def test_disable_closes_bench_mode_through_the_api(link: MockMavlinkLink, settings: Settings) -> None:
    enabled = dataclasses.replace(settings, allow_pilot_control=True)
    app = create_app(enabled, link_factory=lambda: link)
    with TestClient(app) as client:
        client.post("/api/drone/pilot/bench/enable", json={"propsRemovedAck": True})
        response = client.post("/api/drone/pilot/disable")
        body = response.json()["detail"]["pilot"]
        assert body["enabled"] is False
        assert body["benchMode"] is False
        assert body["propsRemovedAck"] is False


def test_out_of_order_pilot_input_is_a_conflict(link: MockMavlinkLink, settings: Settings) -> None:
    enabled = dataclasses.replace(settings, allow_pilot_control=True)
    app = create_app(enabled, link_factory=lambda: link)
    with TestClient(app) as client:
        client.post("/api/drone/pilot/enable")
        newer = client.post(
            "/api/drone/pilot/input",
            json={
                "pitch": 0,
                "roll": 0,
                "throttle": 0,
                "yaw": 0,
                "deadman": False,
                "neutral": True,
                "source": "keyboard",
                "sequence": 8,
            },
        )
        assert newer.status_code == 200
        delayed = client.post(
            "/api/drone/pilot/input",
            json={
                "pitch": 1,
                "deadman": True,
                "source": "keyboard",
                "sequence": 7,
            },
        )
        assert delayed.status_code == 409
        assert delayed.json()["reason"] == "stale_sequence"
        snapshot = client.get("/api/drone/status").json()["pilot"]
        assert snapshot["sequence"] == 8
        assert snapshot["nextSequence"] == 9
        assert snapshot["neutral"] is True


@pytest.mark.parametrize("sequence", [True, "1", 1.5])
def test_pilot_sequence_is_a_strict_json_integer(
    link: MockMavlinkLink, settings: Settings, sequence: object
) -> None:
    enabled = dataclasses.replace(settings, allow_pilot_control=True)
    app = create_app(enabled, link_factory=lambda: link)
    with TestClient(app) as client:
        response = client.post(
            "/api/drone/pilot/input",
            json={"pitch": 0.1, "deadman": True, "source": "keyboard", "sequence": sequence},
        )
        assert response.status_code == 422


def test_real_backend_rejects_active_mock_provider_but_accepts_release(
    link: MockMavlinkLink, settings: Settings
) -> None:
    real = dataclasses.replace(settings, mode="real", allow_pilot_control=True)
    app = create_app(real, link_factory=lambda: link)
    with TestClient(app) as client:
        rejected = client.post(
            "/api/drone/pilot/input",
            json={
                "pitch": 0.2,
                "deadman": True,
                "source": "ps5",
                "provider": "mock",
                "sequence": 1,
            },
        )
        assert rejected.status_code == 403
        assert rejected.json()["reason"] == "mock_provider_forbidden"
        assert rejected.json()["detail"]["pilot"]["outputActive"] is False

        released = client.post(
            "/api/drone/pilot/input",
            json={
                "neutral": True,
                "deadman": False,
                "source": "ps5",
                "provider": "mock",
                "sequence": 2,
            },
        )
        assert released.status_code == 200


@pytest.mark.parametrize("provider", ["browser", "gamepad", "unknown"])
def test_real_backend_accepts_nonmock_provider_identity(
    link: MockMavlinkLink, settings: Settings, provider: str
) -> None:
    real = dataclasses.replace(settings, mode="real", allow_pilot_control=True)
    app = create_app(real, link_factory=lambda: link)
    with TestClient(app) as client:
        response = client.post(
            "/api/drone/pilot/input",
            json={
                "pitch": 0.2,
                "deadman": True,
                "source": "ps5",
                "provider": provider,
                "sequence": 1,
            },
        )
        assert response.status_code == 200


def test_mock_backend_accepts_active_mock_provider(
    link: MockMavlinkLink, settings: Settings
) -> None:
    enabled = dataclasses.replace(settings, mode="mock", allow_pilot_control=True)
    app = create_app(enabled, link_factory=lambda: link)
    with TestClient(app) as client:
        response = client.post(
            "/api/drone/pilot/input",
            json={
                "pitch": 0.2,
                "deadman": True,
                "source": "ps5",
                "provider": "mock",
                "sequence": 1,
            },
        )
        assert response.status_code == 200
        assert response.json()["detail"]["pilot"]["provider"] == "mock"


def test_mock_bench_arm_manual_release_disarm_acceptance(
    link: MockMavlinkLink, settings: Settings
) -> None:
    """Complete no-hardware acceptance path used by keyboard and PS5."""
    enabled = dataclasses.replace(settings, allow_pilot_control=True, allow_safe_commands=True)
    app = create_app(enabled, link_factory=lambda: link)
    with TestClient(app) as client:
        assert client.post("/api/drone/connect", json={}).status_code == 200
        assert wait_until(
            lambda: client.get("/api/drone/status").json()["pilot"]["rcConfiguration"] is not None
        )

        bench = client.post(
            "/api/drone/pilot/bench/enable", json={"propsRemovedAck": True}
        )
        assert bench.status_code == 200
        assert bench.json()["detail"]["pilot"]["readyToArm"] is True

        armed = client.post("/api/drone/arm", json={"confirmed": True})
        assert armed.status_code == 200, armed.text
        assert armed.json()["detail"]["finalArmed"] is True
        assert armed.json()["detail"]["simulated"] is True
        arm_frame = next(
            entry
            for entry in reversed(link.command_long_log)
            if entry["command"] == constants.MAV_CMD_COMPONENT_ARM_DISARM
        )
        assert arm_frame["params"][:2] == (1.0, 0.0)

        next_sequence = client.get("/api/drone/status").json()["pilot"]["nextSequence"]
        barrier_release = client.post(
            "/api/drone/pilot/input",
            json={
                "pitch": 0,
                "roll": 0,
                "throttle": 0,
                "yaw": 0,
                "deadman": False,
                "neutral": False,
                "source": "keyboard",
                "sequence": next_sequence,
            },
        )
        assert barrier_release.status_code == 200
        assert barrier_release.json()["detail"]["pilot"]["armingInputBarrier"] is False
        active = client.post(
            "/api/drone/pilot/input",
            json={
                "pitch": 0,
                "roll": 0,
                "throttle": 0.1,
                "yaw": 0,
                "deadman": True,
                "source": "keyboard",
                "sequence": next_sequence + 1,
            },
        )
        assert active.status_code == 200
        assert wait_until(
            lambda: client.get("/api/drone/status").json()["pilot"]["transmitting"] is True
        )
        assert any(entry["channels"] != (0,) * 8 for entry in link.rc_override_log)

        released = client.post(
            "/api/drone/pilot/input",
            json={
                "pitch": 0,
                "roll": 0,
                "throttle": 0,
                "yaw": 0,
                "deadman": False,
                "neutral": False,
                "source": "keyboard",
                "sequence": next_sequence + 2,
            },
        )
        assert released.status_code == 200
        assert wait_until(
            lambda: bool(link.rc_override_log) and link.rc_override_log[-1]["channels"] == (0,) * 8
        )
        assert released.json()["detail"]["pilot"]["outputActive"] is False

        disarmed = client.post("/api/drone/disarm", json={"confirmed": True})
        assert disarmed.status_code == 200, disarmed.text
        assert disarmed.json()["detail"]["finalArmed"] is False
        disarm_frame = next(
            entry
            for entry in reversed(link.command_long_log)
            if entry["command"] == constants.MAV_CMD_COMPONENT_ARM_DISARM
        )
        assert disarm_frame["params"][:2] == (0.0, 0.0)


def test_arm_is_refused_until_pilot_channel_is_enabled(
    connected_client: TestClient,
) -> None:
    response = connected_client.post("/api/drone/arm", json={"confirmed": True})
    assert response.status_code == 403
    assert response.json()["reason"] == "pilot_control_disabled"


# ----------------------------------------------------------------------
# Disabled operations
# ----------------------------------------------------------------------


@pytest.mark.parametrize(
    "operation",
    ["takeoff", "land", "rtl", "mission_upload", "guided_goto", "raw_rc_override", "manual_control", "motor_test", "set_parameter"],
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


def test_arm_and_disarm_exist_but_require_explicit_true_confirmation(connected_client: TestClient) -> None:
    for path in ("/api/drone/arm", "/api/drone/disarm"):
        assert connected_client.post(path).status_code == 422
        assert connected_client.post(path, json={"confirmed": False}).status_code == 422
    for path in ("/api/drone/takeoff", "/api/drone/land", "/api/drone/rtl"):
        assert connected_client.post(path).status_code == 404, f"{path} must not exist"


def test_there_is_no_generic_mavlink_send_endpoint(client: TestClient) -> None:
    """No route may accept an arbitrary command id or raw packet."""
    routes = {route.path for route in client.app.routes}
    for suspicious in ("/api/drone/send", "/api/drone/command", "/api/drone/raw", "/api/drone/mavlink"):
        assert suspicious not in routes

    openapi = client.get("/openapi.json").json()
    body = str(openapi).lower()
    for forbidden in ("command_id", "raw_packet", "param2", "motor_test"):
        assert f'"{forbidden}"' not in body


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
        for section in ("connectionState", "link", "vehicle", "battery", "gps", "attitude", "motion", "position", "statusTexts", "pilot"):
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
