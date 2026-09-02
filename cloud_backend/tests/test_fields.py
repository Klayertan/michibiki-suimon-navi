import uuid

from tests.conftest import csrf_headers, register_and_login


def _field_payload(**overrides):
    payload = {
        "legacy_field_id": "field-1",
        "name": "North Paddy",
        "area_m2": 1234.5,
        "boundary": [[35.0, 139.0], [35.001, 139.0], [35.001, 139.001], [35.0, 139.001]],
        "record": {"crop": "rice", "note": "original"},
    }
    payload.update(overrides)
    return payload


async def test_post_empty_list_returns_empty_list(client):
    await register_and_login(client, email="a@example.com")
    r = await client.post("/api/fields", json=[], headers=csrf_headers(client))
    assert r.status_code == 200
    assert r.json() == []


async def test_create_field_requires_csrf_then_succeeds_with_it(client):
    await register_and_login(client, email="a@example.com")
    payload = _field_payload()

    r = await client.post("/api/fields", json=[payload])
    assert r.status_code == 403
    assert r.json() == {"detail": "csrf token missing or invalid"}

    r = await client.post("/api/fields", json=[payload], headers=csrf_headers(client))
    assert r.status_code == 200
    body = r.json()
    assert len(body) == 1
    field = body[0]
    uuid.UUID(field["id"])  # generated server-side, must be a valid uuid
    assert field["name"] == payload["name"]
    assert field["area_m2"] == payload["area_m2"]
    assert field["boundary"] == payload["boundary"]
    assert field["record"] == payload["record"]


async def test_get_list_and_get_by_id(client):
    await register_and_login(client, email="a@example.com")
    headers = csrf_headers(client)
    create_r = await client.post("/api/fields", json=[_field_payload()], headers=headers)
    field_id = create_r.json()[0]["id"]

    list_r = await client.get("/api/fields")
    assert list_r.status_code == 200
    list_body = list_r.json()
    assert len(list_body) == 1
    assert list_body[0]["id"] == field_id

    get_r = await client.get(f"/api/fields/{field_id}")
    assert get_r.status_code == 200
    assert get_r.json()["id"] == field_id
    assert get_r.json()["legacy_field_id"] == "field-1"


async def test_get_unknown_field_id_returns_404(client):
    await register_and_login(client, email="a@example.com")
    r = await client.get(f"/api/fields/{uuid.uuid4()}")
    assert r.status_code == 404
    assert r.json() == {"detail": "field not found"}


async def test_reupsert_same_legacy_field_id_updates_existing_row(client):
    await register_and_login(client, email="a@example.com")
    headers = csrf_headers(client)
    create_r = await client.post("/api/fields", json=[_field_payload()], headers=headers)
    field_id = create_r.json()[0]["id"]

    updated_payload = _field_payload(name="Renamed Paddy", record={"crop": "rice", "note": "updated"})
    r = await client.post("/api/fields", json=[updated_payload], headers=headers)
    assert r.status_code == 200
    body = r.json()
    assert len(body) == 1
    # ON CONFLICT DO UPDATE on (owner_id, legacy_field_id) — not a new row
    assert body[0]["id"] == field_id
    assert body[0]["name"] == "Renamed Paddy"
    assert body[0]["record"] == {"crop": "rice", "note": "updated"}

    list_r = await client.get("/api/fields")
    assert len(list_r.json()) == 1


async def test_upsert_with_explicit_id_updates_in_place(client):
    await register_and_login(client, email="a@example.com")
    headers = csrf_headers(client)
    create_r = await client.post("/api/fields", json=[_field_payload()], headers=headers)
    field_id = create_r.json()[0]["id"]

    payload = _field_payload(name="Explicit Id Update", area_m2=999.0)
    payload["id"] = field_id
    r = await client.post("/api/fields", json=[payload], headers=headers)
    assert r.status_code == 200
    body = r.json()
    assert len(body) == 1
    assert body[0]["id"] == field_id
    assert body[0]["name"] == "Explicit Id Update"
    assert body[0]["area_m2"] == 999.0

    list_r = await client.get("/api/fields")
    assert len(list_r.json()) == 1


async def test_bulk_upsert_two_new_fields_in_one_call(client):
    await register_and_login(client, email="a@example.com")
    headers = csrf_headers(client)
    await client.post("/api/fields", json=[_field_payload()], headers=headers)

    r = await client.post(
        "/api/fields",
        json=[
            _field_payload(legacy_field_id="field-2", name="Second Field"),
            _field_payload(legacy_field_id="field-3", name="Third Field"),
        ],
        headers=headers,
    )
    assert r.status_code == 200
    body = r.json()
    assert len(body) == 2
    by_legacy_id = {row["legacy_field_id"]: row for row in body}
    assert by_legacy_id["field-2"]["name"] == "Second Field"
    assert by_legacy_id["field-3"]["name"] == "Third Field"

    list_r = await client.get("/api/fields")
    list_body = list_r.json()
    # the field created in setup plus the 2 just bulk-upserted
    assert len(list_body) == 3
    assert {row["legacy_field_id"] for row in list_body} == {"field-1", "field-2", "field-3"}


async def test_delete_field_by_id(client):
    await register_and_login(client, email="a@example.com")
    headers = csrf_headers(client)
    create_r = await client.post("/api/fields", json=[_field_payload()], headers=headers)
    field_id = create_r.json()[0]["id"]

    r = await client.post("/api/fields/delete", json={"ids": [field_id]}, headers=headers)
    assert r.status_code == 204

    get_r = await client.get(f"/api/fields/{field_id}")
    assert get_r.status_code == 404


async def test_delete_with_empty_ids_is_noop(client):
    await register_and_login(client, email="a@example.com")
    headers = csrf_headers(client)
    create_r = await client.post("/api/fields", json=[_field_payload()], headers=headers)
    field_id = create_r.json()[0]["id"]

    r = await client.post("/api/fields/delete", json={"ids": []}, headers=headers)
    assert r.status_code == 204

    get_r = await client.get(f"/api/fields/{field_id}")
    assert get_r.status_code == 200
