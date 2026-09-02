from tests.conftest import csrf_headers, register_and_login

_FORBIDDEN_DRONE_SUBSTRINGS = (
    "arm",
    "disarm",
    "takeoff",
    "land",
    "rtl",
    "mode",
    "override",
    "motor",
    "mission",
    "param",
)


async def test_gnss_sessions_returns_501_with_valid_body_and_csrf(client):
    await register_and_login(client, email="a@example.com")
    r = await client.post(
        "/api/gnss/sessions",
        json={"started_at": "2026-01-01T00:00:00Z"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 501


async def test_gnss_sessions_requires_csrf(client):
    await register_and_login(client, email="a@example.com")
    r = await client.post("/api/gnss/sessions", json={"started_at": "2026-01-01T00:00:00Z"})
    assert r.status_code == 403
    assert r.json() == {"detail": "csrf token missing or invalid"}


async def test_gnss_observations_returns_501_with_valid_body_and_csrf(client):
    await register_and_login(client, email="a@example.com")
    r = await client.post(
        "/api/gnss/observations",
        json={
            "session_id": "session-1",
            "lat": 35.0,
            "lon": 139.0,
            "recorded_at": "2026-01-01T00:00:00Z",
        },
        headers=csrf_headers(client),
    )
    assert r.status_code == 501


async def test_gnss_observations_requires_csrf(client):
    await register_and_login(client, email="a@example.com")
    r = await client.post(
        "/api/gnss/observations",
        json={
            "session_id": "session-1",
            "lat": 35.0,
            "lon": 139.0,
            "recorded_at": "2026-01-01T00:00:00Z",
        },
    )
    assert r.status_code == 403
    assert r.json() == {"detail": "csrf token missing or invalid"}


async def test_sensors_water_level_returns_501_with_valid_body_and_csrf(client):
    await register_and_login(client, email="a@example.com")
    r = await client.post(
        "/api/sensors/water-level",
        json={
            "legacy_field_id": "field-1",
            "level_cm": 12.5,
            "recorded_at": "2026-01-01T00:00:00Z",
        },
        headers=csrf_headers(client),
    )
    assert r.status_code == 501


async def test_sensors_water_level_requires_csrf(client):
    await register_and_login(client, email="a@example.com")
    r = await client.post(
        "/api/sensors/water-level",
        json={
            "legacy_field_id": "field-1",
            "level_cm": 12.5,
            "recorded_at": "2026-01-01T00:00:00Z",
        },
    )
    assert r.status_code == 403
    assert r.json() == {"detail": "csrf token missing or invalid"}


async def test_drone_telemetry_returns_501_with_valid_body_and_csrf(client):
    await register_and_login(client, email="a@example.com")
    r = await client.post(
        "/api/drone/telemetry",
        json={"recorded_at": "2026-01-01T00:00:00Z"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 501


async def test_drone_telemetry_requires_csrf(client):
    await register_and_login(client, email="a@example.com")
    r = await client.post("/api/drone/telemetry", json={"recorded_at": "2026-01-01T00:00:00Z"})
    assert r.status_code == 403
    assert r.json() == {"detail": "csrf token missing or invalid"}


async def test_no_drone_route_exposes_flight_control_surface(client_factory):
    # Regression guard: /api/drone is ingestion-only (see this module's
    # docstring in app/api/future_ingestion.py) and must never grow a route
    # that could arm, move, or otherwise command a vehicle.
    app = client_factory.app
    drone_paths = [route.path for route in app.routes if getattr(route, "path", "").startswith("/api/drone")]
    assert drone_paths == ["/api/drone/telemetry"]
    for path in drone_paths:
        lowered = path.lower()
        for forbidden in _FORBIDDEN_DRONE_SUBSTRINGS:
            assert forbidden not in lowered
