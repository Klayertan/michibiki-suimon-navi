"""/api/water-control-points CRUD coverage.

Note: unlike /api/fields, this router has no GET /{id} route (see
app/api/water_control_points.py — only GET "", POST "", POST "/delete").
So "not found" and "deleted" are observed via the list endpoint and via the
404 an explicit-id upsert raises for an id that doesn't belong to the user,
not via a per-id GET.
"""

from __future__ import annotations

import uuid

from conftest import csrf_headers, register_and_login


async def test_create_without_csrf_returns_403(client):
    await register_and_login(client, email="wcp-nocsrf@example.com")
    r = await client.post(
        "/api/water-control-points",
        json=[{"legacy_point_id": "gate-001", "point_type": "intake_gate"}],
    )
    assert r.status_code == 403
    assert r.json() == {"detail": "csrf token missing or invalid"}


async def test_create_with_csrf_returns_200(client):
    await register_and_login(client, email="wcp-create@example.com")
    payload = [
        {
            "legacy_point_id": "gate-001",
            "legacy_field_id": "paddy-001",
            "point_type": "intake_gate",
            "lat": 35.123,
            "lon": 136.456,
            "record": {"note": "north gate"},
        }
    ]
    r = await client.post("/api/water-control-points", json=payload, headers=csrf_headers(client))
    assert r.status_code == 200
    body = r.json()
    assert len(body) == 1
    point = body[0]
    assert uuid.UUID(point["id"])
    assert point["field_id"] is None
    assert point["legacy_point_id"] == "gate-001"
    assert point["legacy_field_id"] == "paddy-001"
    assert point["point_type"] == "intake_gate"
    assert point["lat"] == 35.123
    assert point["lon"] == 136.456
    assert point["record"] == {"note": "north gate"}
    assert point["local_updated_at"] is None
    assert "created_at" in point and "updated_at" in point


async def test_create_empty_payload_returns_empty_list(client):
    await register_and_login(client, email="wcp-empty@example.com")
    r = await client.post("/api/water-control-points", json=[], headers=csrf_headers(client))
    assert r.status_code == 200
    assert r.json() == []


async def test_list_points_returns_created_rows(client):
    await register_and_login(client, email="wcp-list@example.com")
    await client.post(
        "/api/water-control-points",
        json=[
            {"legacy_point_id": "gate-001", "point_type": "intake_gate"},
            {"legacy_point_id": "drain-001", "point_type": "drain_outlet"},
        ],
        headers=csrf_headers(client),
    )
    r = await client.get("/api/water-control-points")
    assert r.status_code == 200
    body = r.json()
    assert len(body) == 2
    assert {p["legacy_point_id"] for p in body} == {"gate-001", "drain-001"}


async def test_list_points_empty_for_fresh_user(client):
    await register_and_login(client, email="wcp-fresh@example.com")
    r = await client.get("/api/water-control-points")
    assert r.status_code == 200
    assert r.json() == []


async def test_reupsert_by_legacy_point_id_updates_in_place(client):
    await register_and_login(client, email="wcp-reupsert@example.com")
    headers = csrf_headers(client)
    first = await client.post(
        "/api/water-control-points",
        json=[{"legacy_point_id": "gate-001", "point_type": "intake_gate", "lat": 35.0}],
        headers=headers,
    )
    original_id = first.json()[0]["id"]

    second = await client.post(
        "/api/water-control-points",
        json=[{"legacy_point_id": "gate-001", "point_type": "intake_gate", "lat": 35.5}],
        headers=headers,
    )
    assert second.status_code == 200
    updated = second.json()[0]
    assert updated["id"] == original_id
    assert updated["lat"] == 35.5

    r = await client.get("/api/water-control-points")
    assert len(r.json()) == 1


async def test_explicit_id_upsert_updates_in_place(client):
    await register_and_login(client, email="wcp-explicit-id@example.com")
    headers = csrf_headers(client)
    created = await client.post(
        "/api/water-control-points",
        json=[{"legacy_point_id": "sensor-001", "point_type": "water_level_sensor", "lat": 35.0, "lon": 136.0}],
        headers=headers,
    )
    point_id = created.json()[0]["id"]

    updated = await client.post(
        "/api/water-control-points",
        json=[
            {
                "id": point_id,
                "legacy_point_id": "sensor-001",
                "point_type": "water_level_sensor",
                "lat": 40.0,
                "lon": 140.0,
            }
        ],
        headers=headers,
    )
    assert updated.status_code == 200
    body = updated.json()[0]
    assert body["id"] == point_id
    assert body["lat"] == 40.0
    assert body["lon"] == 140.0

    r = await client.get("/api/water-control-points")
    assert len(r.json()) == 1


async def test_explicit_id_upsert_unknown_id_returns_404(client):
    await register_and_login(client, email="wcp-unknown-id@example.com")
    unknown_id = str(uuid.uuid4())
    r = await client.post(
        "/api/water-control-points",
        json=[{"id": unknown_id, "legacy_point_id": "gate-999", "point_type": "intake_gate"}],
        headers=csrf_headers(client),
    )
    assert r.status_code == 404
    assert r.json() == {"detail": f"point {unknown_id} not found"}


async def test_bulk_upsert_two_new_points_in_one_call(client):
    await register_and_login(client, email="wcp-bulk@example.com")
    r = await client.post(
        "/api/water-control-points",
        json=[
            {"legacy_point_id": "gate-001", "point_type": "intake_gate"},
            {"legacy_point_id": "cam-001", "point_type": "camera"},
        ],
        headers=csrf_headers(client),
    )
    assert r.status_code == 200
    body = r.json()
    assert len(body) == 2
    ids = {p["id"] for p in body}
    assert len(ids) == 2  # distinct rows, not one collapsed into the other
    types_by_legacy_id = {p["legacy_point_id"]: p["point_type"] for p in body}
    assert types_by_legacy_id == {"gate-001": "intake_gate", "cam-001": "camera"}


async def test_delete_removes_point(client):
    await register_and_login(client, email="wcp-delete@example.com")
    headers = csrf_headers(client)
    created = await client.post(
        "/api/water-control-points",
        json=[{"legacy_point_id": "gate-001", "point_type": "intake_gate"}],
        headers=headers,
    )
    point_id = created.json()[0]["id"]

    r = await client.post("/api/water-control-points/delete", json={"ids": [point_id]}, headers=headers)
    assert r.status_code == 204

    remaining = await client.get("/api/water-control-points")
    assert remaining.json() == []


async def test_delete_without_csrf_returns_403(client):
    await register_and_login(client, email="wcp-delete-nocsrf@example.com")
    headers = csrf_headers(client)
    created = await client.post(
        "/api/water-control-points",
        json=[{"legacy_point_id": "gate-001", "point_type": "intake_gate"}],
        headers=headers,
    )
    point_id = created.json()[0]["id"]

    r = await client.post("/api/water-control-points/delete", json={"ids": [point_id]})
    assert r.status_code == 403

    remaining = await client.get("/api/water-control-points")
    assert len(remaining.json()) == 1


async def test_delete_unknown_id_is_a_no_op(client):
    await register_and_login(client, email="wcp-delete-unknown@example.com")
    headers = csrf_headers(client)
    r = await client.post("/api/water-control-points/delete", json={"ids": [str(uuid.uuid4())]}, headers=headers)
    assert r.status_code == 204


async def test_list_requires_authentication(client):
    r = await client.get("/api/water-control-points")
    assert r.status_code == 401
