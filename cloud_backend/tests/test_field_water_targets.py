from conftest import csrf_headers, register_and_login


async def test_upsert_without_csrf_forbidden(client):
    await register_and_login(client, email="a@example.com")
    r = await client.post(
        "/api/field-water-targets",
        json=[{"legacy_field_id": "field-1", "target_water_level_cm": 5.0}],
    )
    assert r.status_code == 403
    assert r.json() == {"detail": "csrf token missing or invalid"}


async def test_upsert_with_csrf_succeeds(client):
    await register_and_login(client, email="a@example.com")
    r = await client.post(
        "/api/field-water-targets",
        json=[{"legacy_field_id": "field-1", "target_water_level_cm": 5.0}],
        headers=csrf_headers(client),
    )
    assert r.status_code == 200
    body = r.json()
    assert len(body) == 1
    assert body[0]["legacy_field_id"] == "field-1"
    assert body[0]["target_water_level_cm"] == 5.0
    assert body[0]["field_id"] is None


async def test_list_shows_created_target(client):
    await register_and_login(client, email="a@example.com")
    await client.post(
        "/api/field-water-targets",
        json=[{"legacy_field_id": "field-1", "target_water_level_cm": 5.0}],
        headers=csrf_headers(client),
    )
    r = await client.get("/api/field-water-targets")
    assert r.status_code == 200
    body = r.json()
    assert len(body) == 1
    assert body[0]["legacy_field_id"] == "field-1"
    assert body[0]["target_water_level_cm"] == 5.0


async def test_reupsert_same_legacy_field_id_updates_in_place(client):
    await register_and_login(client, email="a@example.com")
    headers = csrf_headers(client)
    await client.post(
        "/api/field-water-targets",
        json=[{"legacy_field_id": "field-1", "target_water_level_cm": 5.0}],
        headers=headers,
    )
    r = await client.post(
        "/api/field-water-targets",
        json=[{"legacy_field_id": "field-1", "target_water_level_cm": 9.0}],
        headers=headers,
    )
    assert r.status_code == 200
    assert r.json()[0]["target_water_level_cm"] == 9.0

    list_r = await client.get("/api/field-water-targets")
    body = list_r.json()
    # updating the same legacy_field_id must update the row in place, not add a second one
    assert len(body) == 1
    assert body[0]["target_water_level_cm"] == 9.0


async def test_upsert_null_clears_target_without_removing_row(client):
    await register_and_login(client, email="a@example.com")
    headers = csrf_headers(client)
    await client.post(
        "/api/field-water-targets",
        json=[{"legacy_field_id": "field-1", "target_water_level_cm": 5.0}],
        headers=headers,
    )
    r = await client.post(
        "/api/field-water-targets",
        json=[{"legacy_field_id": "field-1", "target_water_level_cm": None}],
        headers=headers,
    )
    assert r.status_code == 200
    assert r.json()[0]["target_water_level_cm"] is None

    list_r = await client.get("/api/field-water-targets")
    body = list_r.json()
    # cleared to null, not deleted as a row
    assert len(body) == 1
    assert body[0]["legacy_field_id"] == "field-1"
    assert body[0]["target_water_level_cm"] is None


async def test_bulk_upsert_two_targets_in_one_call(client):
    await register_and_login(client, email="a@example.com")
    r = await client.post(
        "/api/field-water-targets",
        json=[
            {"legacy_field_id": "field-1", "target_water_level_cm": 3.0},
            {"legacy_field_id": "field-2", "target_water_level_cm": 7.5},
        ],
        headers=csrf_headers(client),
    )
    assert r.status_code == 200
    body = r.json()
    assert len(body) == 2
    by_legacy_id = {row["legacy_field_id"]: row for row in body}
    assert by_legacy_id["field-1"]["target_water_level_cm"] == 3.0
    assert by_legacy_id["field-2"]["target_water_level_cm"] == 7.5

    list_r = await client.get("/api/field-water-targets")
    list_body = list_r.json()
    assert len(list_body) == 2
    list_by_legacy_id = {row["legacy_field_id"]: row for row in list_body}
    assert list_by_legacy_id["field-1"]["target_water_level_cm"] == 3.0
    assert list_by_legacy_id["field-2"]["target_water_level_cm"] == 7.5
