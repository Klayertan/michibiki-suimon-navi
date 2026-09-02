"""/api/field-observations CRUD coverage.

Note: like /api/water-control-points, this router has no GET /{id} route
(see app/api/field_observations.py — only GET "", POST "", POST "/delete").
So "not found" and "deleted" are observed via the list endpoint and via the
404 an explicit-id upsert raises for an id that doesn't belong to the user,
not via a per-id GET.
"""

from __future__ import annotations

import uuid

from tests.conftest import csrf_headers, register_and_login


async def test_create_without_csrf_returns_403(client):
    await register_and_login(client, email="obs-nocsrf@example.com")
    r = await client.post(
        "/api/field-observations",
        json=[{"legacy_observation_id": "obs-001", "observation_type": "weed"}],
    )
    assert r.status_code == 403
    assert r.json() == {"detail": "csrf token missing or invalid"}


async def test_create_with_csrf_returns_200(client):
    await register_and_login(client, email="obs-create@example.com")
    payload = [
        {
            "legacy_observation_id": "obs-001",
            "legacy_field_id": "field-001",
            "observation_type": "weed",
            "severity": "high",
            "lat": 35.681236,
            "lon": 139.767125,
            "record": {"note": "weeds near north edge"},
        }
    ]
    r = await client.post("/api/field-observations", json=payload, headers=csrf_headers(client))
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body) == 1
    row = body[0]
    assert uuid.UUID(row["id"])
    assert row["field_id"] is None
    assert row["legacy_observation_id"] == "obs-001"
    assert row["legacy_field_id"] == "field-001"
    assert row["observation_type"] == "weed"
    assert row["severity"] == "high"
    assert row["lat"] == 35.681236
    assert row["lon"] == 139.767125
    assert row["record"] == {"note": "weeds near north edge"}
    assert row["local_updated_at"] is None
    assert "created_at" in row and "updated_at" in row


async def test_create_empty_payload_returns_empty_list(client):
    await register_and_login(client, email="obs-empty@example.com")
    r = await client.post("/api/field-observations", json=[], headers=csrf_headers(client))
    assert r.status_code == 200
    assert r.json() == []


async def test_list_observations_returns_created_rows(client):
    await register_and_login(client, email="obs-list@example.com")
    await client.post(
        "/api/field-observations",
        json=[
            {"legacy_observation_id": "obs-001", "observation_type": "weed"},
            {"legacy_observation_id": "obs-002", "observation_type": "pest"},
        ],
        headers=csrf_headers(client),
    )
    r = await client.get("/api/field-observations")
    assert r.status_code == 200
    body = r.json()
    assert len(body) == 2
    assert {row["legacy_observation_id"] for row in body} == {"obs-001", "obs-002"}


async def test_list_observations_empty_for_fresh_user(client):
    await register_and_login(client, email="obs-fresh@example.com")
    r = await client.get("/api/field-observations")
    assert r.status_code == 200
    assert r.json() == []


async def test_list_requires_authentication(client):
    r = await client.get("/api/field-observations")
    assert r.status_code == 401


async def test_reupsert_by_legacy_observation_id_updates_in_place(client):
    await register_and_login(client, email="obs-reupsert@example.com")
    headers = csrf_headers(client)
    first = await client.post(
        "/api/field-observations",
        json=[{"legacy_observation_id": "obs-001", "observation_type": "weed", "severity": "low"}],
        headers=headers,
    )
    original_id = first.json()[0]["id"]

    # No id in the payload — the on-conflict target is (owner_id, legacy_observation_id).
    second = await client.post(
        "/api/field-observations",
        json=[{"legacy_observation_id": "obs-001", "observation_type": "weed", "severity": "high"}],
        headers=headers,
    )
    assert second.status_code == 200, second.text
    updated = second.json()[0]
    assert updated["id"] == original_id
    assert updated["severity"] == "high"

    r = await client.get("/api/field-observations")
    assert len(r.json()) == 1  # updated in place, not duplicated


async def test_explicit_id_upsert_updates_in_place(client):
    await register_and_login(client, email="obs-explicit-id@example.com")
    headers = csrf_headers(client)
    created = await client.post(
        "/api/field-observations",
        json=[{"legacy_observation_id": "obs-001", "observation_type": "weed", "lat": 1.0}],
        headers=headers,
    )
    observation_id = created.json()[0]["id"]

    updated = await client.post(
        "/api/field-observations",
        json=[
            {
                "id": observation_id,
                "legacy_observation_id": "obs-001",
                "observation_type": "pest",
                "lat": 2.0,
            }
        ],
        headers=headers,
    )
    assert updated.status_code == 200, updated.text
    body = updated.json()[0]
    assert body["id"] == observation_id
    assert body["observation_type"] == "pest"
    assert body["lat"] == 2.0

    r = await client.get("/api/field-observations")
    assert len(r.json()) == 1


async def test_explicit_id_upsert_unknown_id_returns_404(client):
    await register_and_login(client, email="obs-unknown-id@example.com")
    unknown_id = str(uuid.uuid4())
    r = await client.post(
        "/api/field-observations",
        json=[{"id": unknown_id, "legacy_observation_id": "obs-999", "observation_type": "weed"}],
        headers=csrf_headers(client),
    )
    assert r.status_code == 404
    assert r.json() == {"detail": f"observation {unknown_id} not found"}


async def test_bulk_upsert_two_new_observations_in_one_call(client):
    await register_and_login(client, email="obs-bulk@example.com")
    r = await client.post(
        "/api/field-observations",
        json=[
            {"legacy_observation_id": "obs-001", "observation_type": "weed"},
            {"legacy_observation_id": "obs-002", "observation_type": "disease"},
        ],
        headers=csrf_headers(client),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body) == 2
    ids = {row["id"] for row in body}
    assert len(ids) == 2  # distinct rows, not one collapsed into the other
    types_by_legacy_id = {row["legacy_observation_id"]: row["observation_type"] for row in body}
    assert types_by_legacy_id == {"obs-001": "weed", "obs-002": "disease"}


async def test_delete_removes_observation(client):
    await register_and_login(client, email="obs-delete@example.com")
    headers = csrf_headers(client)
    created = await client.post(
        "/api/field-observations",
        json=[{"legacy_observation_id": "obs-001", "observation_type": "weed"}],
        headers=headers,
    )
    observation_id = created.json()[0]["id"]

    r = await client.post("/api/field-observations/delete", json={"ids": [observation_id]}, headers=headers)
    assert r.status_code == 204

    remaining = await client.get("/api/field-observations")
    assert remaining.json() == []

    # No GET /{id} route to re-check against directly — re-upserting the same
    # id is the equivalent proof that the row is actually gone, not merely
    # absent from a stale list.
    reupsert = await client.post(
        "/api/field-observations",
        json=[{"id": observation_id, "legacy_observation_id": "obs-001", "observation_type": "weed"}],
        headers=headers,
    )
    assert reupsert.status_code == 404


async def test_delete_without_csrf_returns_403(client):
    await register_and_login(client, email="obs-delete-nocsrf@example.com")
    headers = csrf_headers(client)
    created = await client.post(
        "/api/field-observations",
        json=[{"legacy_observation_id": "obs-001", "observation_type": "weed"}],
        headers=headers,
    )
    observation_id = created.json()[0]["id"]

    r = await client.post("/api/field-observations/delete", json={"ids": [observation_id]})
    assert r.status_code == 403

    remaining = await client.get("/api/field-observations")
    assert len(remaining.json()) == 1


async def test_delete_unknown_id_is_a_no_op(client):
    await register_and_login(client, email="obs-delete-unknown@example.com")
    headers = csrf_headers(client)
    r = await client.post("/api/field-observations/delete", json={"ids": [str(uuid.uuid4())]}, headers=headers)
    assert r.status_code == 204
