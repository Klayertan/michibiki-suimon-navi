from __future__ import annotations

from tests.conftest import csrf_headers, register_and_login


async def test_get_profile_after_registration_returns_registered_display_name(client):
    await register_and_login(client, email="profile-a@example.com", display_name="Taro")

    r = await client.get("/api/profile")

    assert r.status_code == 200
    body = r.json()
    assert body["display_name"] == "Taro"
    assert "user_id" in body
    assert "created_at" in body
    assert "updated_at" in body


async def test_put_profile_without_csrf_header_is_rejected(client):
    await register_and_login(client, email="profile-b@example.com", display_name="Original")

    r = await client.put("/api/profile", json={"display_name": "New Name"})

    assert r.status_code == 403
    assert r.json() == {"detail": "csrf token missing or invalid"}


async def test_put_profile_with_csrf_header_updates_display_name(client):
    await register_and_login(client, email="profile-c@example.com", display_name="Original")

    r = await client.put(
        "/api/profile", json={"display_name": "Updated Name"}, headers=csrf_headers(client)
    )

    assert r.status_code == 200
    assert r.json()["display_name"] == "Updated Name"


async def test_get_profile_reflects_update_after_put(client):
    await register_and_login(client, email="profile-d@example.com", display_name="Original")
    await client.put(
        "/api/profile", json={"display_name": "Updated Name"}, headers=csrf_headers(client)
    )

    r = await client.get("/api/profile")

    assert r.status_code == 200
    assert r.json()["display_name"] == "Updated Name"


async def test_get_profile_without_auth_cookie_is_unauthorized(client):
    r = await client.get("/api/profile")

    assert r.status_code == 401
    assert r.json() == {"detail": "not authenticated"}
