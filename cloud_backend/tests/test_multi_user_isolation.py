"""Cross-user isolation: two independent farmers must never see, delete, or
hijack each other's rows.

There is no database-level RLS in this service (see app/models/db.py's
module docstring) — the entire boundary is `owner_id == current_user.id`
filtering in the service/route layer. Every test below creates two
independent, cookie-isolated clients (`client_factory()` called twice,
simulating two different browsers) against the SAME shared in-memory
database and exercises exactly that boundary.
"""

from __future__ import annotations

from contextlib import AsyncExitStack

from tests.conftest import csrf_headers, register_and_login


async def _two_users(client_factory, stack: AsyncExitStack):
    client_a = await stack.enter_async_context(client_factory())
    client_b = await stack.enter_async_context(client_factory())
    auth_a = await register_and_login(client_a, email="a@example.com")
    auth_b = await register_and_login(client_b, email="b@example.com")
    return client_a, client_b, auth_a, auth_b


def _field_payload(legacy_field_id="paddy-001", **overrides):
    payload = {"legacy_field_id": legacy_field_id}
    payload.update(overrides)
    return payload


def _point_payload(legacy_point_id="paddy-001", **overrides):
    payload = {"legacy_point_id": legacy_point_id, "point_type": "intake_gate"}
    payload.update(overrides)
    return payload


def _observation_payload(legacy_observation_id="paddy-001", **overrides):
    payload = {"legacy_observation_id": legacy_observation_id, "observation_type": "weed"}
    payload.update(overrides)
    return payload


def _target_payload(legacy_field_id="paddy-001", target_water_level_cm=5.0, **overrides):
    payload = {"legacy_field_id": legacy_field_id, "target_water_level_cm": target_water_level_cm}
    payload.update(overrides)
    return payload


# ---------------------------------------------------------------------------
# fields
# ---------------------------------------------------------------------------


async def test_fields_legacy_id_uniqueness_is_scoped_per_owner(client_factory):
    async with AsyncExitStack() as stack:
        client_a, client_b, _, _ = await _two_users(client_factory, stack)

        r_a = await client_a.post("/api/fields", json=[_field_payload()], headers=csrf_headers(client_a))
        r_b = await client_b.post("/api/fields", json=[_field_payload()], headers=csrf_headers(client_b))

        assert r_a.status_code == 200
        assert r_b.status_code == 200
        # same legacy_field_id on both sides — uniqueness is (owner_id, legacy_field_id), not global
        assert r_a.json()[0]["id"] != r_b.json()[0]["id"]


async def test_fields_list_shows_only_own_rows(client_factory):
    async with AsyncExitStack() as stack:
        client_a, client_b, _, _ = await _two_users(client_factory, stack)
        id_a = (await client_a.post("/api/fields", json=[_field_payload()], headers=csrf_headers(client_a))).json()[0]["id"]
        id_b = (await client_b.post("/api/fields", json=[_field_payload()], headers=csrf_headers(client_b))).json()[0]["id"]

        list_a = await client_a.get("/api/fields")
        list_b = await client_b.get("/api/fields")
        assert [f["id"] for f in list_a.json()] == [id_a]
        assert [f["id"] for f in list_b.json()] == [id_b]


async def test_fields_get_by_id_is_404_not_403_for_other_owner(client_factory):
    async with AsyncExitStack() as stack:
        client_a, client_b, _, _ = await _two_users(client_factory, stack)
        id_a = (await client_a.post("/api/fields", json=[_field_payload()], headers=csrf_headers(client_a))).json()[0]["id"]

        r = await client_b.get(f"/api/fields/{id_a}")
        assert r.status_code == 404


async def test_fields_delete_by_other_owner_is_a_silent_noop(client_factory):
    async with AsyncExitStack() as stack:
        client_a, client_b, _, _ = await _two_users(client_factory, stack)
        id_a = (await client_a.post("/api/fields", json=[_field_payload()], headers=csrf_headers(client_a))).json()[0]["id"]

        r = await client_b.post("/api/fields/delete", json={"ids": [id_a]}, headers=csrf_headers(client_b))
        assert r.status_code == 204  # no-op delete of 0 matching rows, not an error

        still_there = await client_a.get(f"/api/fields/{id_a}")
        assert still_there.status_code == 200


async def test_fields_upsert_with_other_owners_id_returns_404(client_factory):
    async with AsyncExitStack() as stack:
        client_a, client_b, _, _ = await _two_users(client_factory, stack)
        id_a = (await client_a.post("/api/fields", json=[_field_payload()], headers=csrf_headers(client_a))).json()[0]["id"]

        r = await client_b.post(
            "/api/fields",
            json=[_field_payload(legacy_field_id="other-legacy-id", id=id_a)],
            headers=csrf_headers(client_b),
        )
        assert r.status_code == 404


async def test_fields_browser_supplied_owner_id_is_ignored(client_factory):
    async with AsyncExitStack() as stack:
        client_a, client_b, auth_a, _ = await _two_users(client_factory, stack)
        user_a_id = auth_a["user"]["id"]

        r = await client_b.post(
            "/api/fields",
            json=[_field_payload(legacy_field_id="hijack-attempt", owner_id=user_a_id)],
            headers=csrf_headers(client_b),
        )
        assert r.status_code == 200  # FieldUpsert has no owner_id field — pydantic v2 silently ignores it

        list_b = (await client_b.get("/api/fields")).json()
        assert any(f["legacy_field_id"] == "hijack-attempt" for f in list_b)

        list_a = (await client_a.get("/api/fields")).json()
        assert all(f["legacy_field_id"] != "hijack-attempt" for f in list_a)


# ---------------------------------------------------------------------------
# water control points
# ---------------------------------------------------------------------------


async def test_water_control_points_legacy_id_uniqueness_is_scoped_per_owner(client_factory):
    async with AsyncExitStack() as stack:
        client_a, client_b, _, _ = await _two_users(client_factory, stack)

        r_a = await client_a.post(
            "/api/water-control-points", json=[_point_payload()], headers=csrf_headers(client_a)
        )
        r_b = await client_b.post(
            "/api/water-control-points", json=[_point_payload()], headers=csrf_headers(client_b)
        )

        assert r_a.status_code == 200
        assert r_b.status_code == 200
        assert r_a.json()[0]["id"] != r_b.json()[0]["id"]


async def test_water_control_points_list_shows_only_own_rows(client_factory):
    async with AsyncExitStack() as stack:
        client_a, client_b, _, _ = await _two_users(client_factory, stack)
        id_a = (
            await client_a.post("/api/water-control-points", json=[_point_payload()], headers=csrf_headers(client_a))
        ).json()[0]["id"]
        id_b = (
            await client_b.post("/api/water-control-points", json=[_point_payload()], headers=csrf_headers(client_b))
        ).json()[0]["id"]

        list_a = await client_a.get("/api/water-control-points")
        list_b = await client_b.get("/api/water-control-points")
        assert [p["id"] for p in list_a.json()] == [id_a]
        assert [p["id"] for p in list_b.json()] == [id_b]


async def test_water_control_points_delete_by_other_owner_is_a_silent_noop(client_factory):
    async with AsyncExitStack() as stack:
        client_a, client_b, _, _ = await _two_users(client_factory, stack)
        id_a = (
            await client_a.post("/api/water-control-points", json=[_point_payload()], headers=csrf_headers(client_a))
        ).json()[0]["id"]

        r = await client_b.post(
            "/api/water-control-points/delete", json={"ids": [id_a]}, headers=csrf_headers(client_b)
        )
        assert r.status_code == 204

        # this router has no GET /{id} route — verify survival via A's own list instead
        list_a = await client_a.get("/api/water-control-points")
        assert [p["id"] for p in list_a.json()] == [id_a]


async def test_water_control_points_upsert_with_other_owners_id_returns_404(client_factory):
    async with AsyncExitStack() as stack:
        client_a, client_b, _, _ = await _two_users(client_factory, stack)
        id_a = (
            await client_a.post("/api/water-control-points", json=[_point_payload()], headers=csrf_headers(client_a))
        ).json()[0]["id"]

        r = await client_b.post(
            "/api/water-control-points",
            json=[_point_payload(legacy_point_id="other-legacy-id", id=id_a)],
            headers=csrf_headers(client_b),
        )
        assert r.status_code == 404


async def test_water_control_points_browser_supplied_owner_id_is_ignored(client_factory):
    async with AsyncExitStack() as stack:
        client_a, client_b, auth_a, _ = await _two_users(client_factory, stack)
        user_a_id = auth_a["user"]["id"]

        r = await client_b.post(
            "/api/water-control-points",
            json=[_point_payload(legacy_point_id="hijack-attempt", owner_id=user_a_id)],
            headers=csrf_headers(client_b),
        )
        assert r.status_code == 200

        list_b = (await client_b.get("/api/water-control-points")).json()
        assert any(p["legacy_point_id"] == "hijack-attempt" for p in list_b)

        list_a = (await client_a.get("/api/water-control-points")).json()
        assert all(p["legacy_point_id"] != "hijack-attempt" for p in list_a)


# ---------------------------------------------------------------------------
# field observations
# ---------------------------------------------------------------------------


async def test_field_observations_legacy_id_uniqueness_is_scoped_per_owner(client_factory):
    async with AsyncExitStack() as stack:
        client_a, client_b, _, _ = await _two_users(client_factory, stack)

        r_a = await client_a.post(
            "/api/field-observations", json=[_observation_payload()], headers=csrf_headers(client_a)
        )
        r_b = await client_b.post(
            "/api/field-observations", json=[_observation_payload()], headers=csrf_headers(client_b)
        )

        assert r_a.status_code == 200
        assert r_b.status_code == 200
        assert r_a.json()[0]["id"] != r_b.json()[0]["id"]


async def test_field_observations_list_shows_only_own_rows(client_factory):
    async with AsyncExitStack() as stack:
        client_a, client_b, _, _ = await _two_users(client_factory, stack)
        id_a = (
            await client_a.post(
                "/api/field-observations", json=[_observation_payload()], headers=csrf_headers(client_a)
            )
        ).json()[0]["id"]
        id_b = (
            await client_b.post(
                "/api/field-observations", json=[_observation_payload()], headers=csrf_headers(client_b)
            )
        ).json()[0]["id"]

        list_a = await client_a.get("/api/field-observations")
        list_b = await client_b.get("/api/field-observations")
        assert [o["id"] for o in list_a.json()] == [id_a]
        assert [o["id"] for o in list_b.json()] == [id_b]


async def test_field_observations_delete_by_other_owner_is_a_silent_noop(client_factory):
    async with AsyncExitStack() as stack:
        client_a, client_b, _, _ = await _two_users(client_factory, stack)
        id_a = (
            await client_a.post(
                "/api/field-observations", json=[_observation_payload()], headers=csrf_headers(client_a)
            )
        ).json()[0]["id"]

        r = await client_b.post(
            "/api/field-observations/delete", json={"ids": [id_a]}, headers=csrf_headers(client_b)
        )
        assert r.status_code == 204

        # this router has no GET /{id} route — verify survival via A's own list instead
        list_a = await client_a.get("/api/field-observations")
        assert [o["id"] for o in list_a.json()] == [id_a]


async def test_field_observations_upsert_with_other_owners_id_returns_404(client_factory):
    async with AsyncExitStack() as stack:
        client_a, client_b, _, _ = await _two_users(client_factory, stack)
        id_a = (
            await client_a.post(
                "/api/field-observations", json=[_observation_payload()], headers=csrf_headers(client_a)
            )
        ).json()[0]["id"]

        r = await client_b.post(
            "/api/field-observations",
            json=[_observation_payload(legacy_observation_id="other-legacy-id", id=id_a)],
            headers=csrf_headers(client_b),
        )
        assert r.status_code == 404


async def test_field_observations_browser_supplied_owner_id_is_ignored(client_factory):
    async with AsyncExitStack() as stack:
        client_a, client_b, auth_a, _ = await _two_users(client_factory, stack)
        user_a_id = auth_a["user"]["id"]

        r = await client_b.post(
            "/api/field-observations",
            json=[_observation_payload(legacy_observation_id="hijack-attempt", owner_id=user_a_id)],
            headers=csrf_headers(client_b),
        )
        assert r.status_code == 200

        list_b = (await client_b.get("/api/field-observations")).json()
        assert any(o["legacy_observation_id"] == "hijack-attempt" for o in list_b)

        list_a = (await client_a.get("/api/field-observations")).json()
        assert all(o["legacy_observation_id"] != "hijack-attempt" for o in list_a)


# ---------------------------------------------------------------------------
# field water targets — composite primary key (owner_id, legacy_field_id),
# no cloud id and no delete route (see app/api/field_water_targets.py)
# ---------------------------------------------------------------------------


async def test_field_water_targets_composite_key_is_scoped_per_owner(client_factory):
    async with AsyncExitStack() as stack:
        client_a, client_b, _, _ = await _two_users(client_factory, stack)

        r_a = await client_a.post(
            "/api/field-water-targets",
            json=[_target_payload(target_water_level_cm=5.0)],
            headers=csrf_headers(client_a),
        )
        r_b = await client_b.post(
            "/api/field-water-targets",
            json=[_target_payload(target_water_level_cm=12.0)],
            headers=csrf_headers(client_b),
        )
        assert r_a.status_code == 200
        assert r_b.status_code == 200

        list_a = (await client_a.get("/api/field-water-targets")).json()
        list_b = (await client_b.get("/api/field-water-targets")).json()

        # same legacy_field_id on both sides never collides or overwrites the other owner's row
        assert len(list_a) == 1
        assert list_a[0]["legacy_field_id"] == "paddy-001"
        assert list_a[0]["target_water_level_cm"] == 5.0

        assert len(list_b) == 1
        assert list_b[0]["legacy_field_id"] == "paddy-001"
        assert list_b[0]["target_water_level_cm"] == 12.0
