import uuid
from datetime import timedelta

from tests.conftest import csrf_headers, insert_expired_session, register_and_login


def _set_cookie_lines(response, cookie_name):
    return [
        value
        for key, value in response.headers.multi_items()
        if key.lower() == "set-cookie" and value.startswith(f"{cookie_name}=")
    ]


async def test_register_success_sets_cookies_and_returns_auth_response(client):
    r = await client.post(
        "/api/auth/register",
        json={"email": "Taro@Example.com", "password": "password123", "display_name": "Taro"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["needs_email_confirmation"] is False
    user = body["user"]
    assert user["email"] == "taro@example.com"  # normalize_email trims + lowercases
    assert user["email_verified"] is True  # require_email_verification defaults False
    assert user["display_name"] == "Taro"
    uuid.UUID(user["id"])  # server-generated, must be a valid uuid

    assert r.cookies.get("suisui_session")
    assert r.cookies.get("suisui_csrf")
    session_lines = _set_cookie_lines(r, "suisui_session")
    assert session_lines and "httponly" in session_lines[0].lower()
    csrf_lines = _set_cookie_lines(r, "suisui_csrf")
    assert csrf_lines and "httponly" not in csrf_lines[0].lower()


async def test_duplicate_email_registration_rejected_case_insensitively(client):
    await register_and_login(client, email="Farmer@Example.com")
    r = await client.post(
        "/api/auth/register",
        json={"email": "farmer@example.com", "password": "password123", "display_name": ""},
    )
    assert r.status_code == 409
    assert r.json() == {"detail": "email already registered"}


async def test_register_password_too_short_returns_422(client):
    r = await client.post(
        "/api/auth/register",
        json={"email": "shortpw@example.com", "password": "short1", "display_name": ""},
    )
    assert r.status_code == 422
    assert "password must be at least 8 characters" in r.text


async def test_register_missing_password_field_returns_422(client):
    r = await client.post(
        "/api/auth/register",
        json={"email": "nopassword@example.com", "display_name": ""},
    )
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert detail[0]["msg"] == "Field required"
    assert "password" in detail[0]["loc"]


async def test_login_success_returns_registered_profile_display_name(client_factory):
    async with client_factory() as registering_client:
        await register_and_login(registering_client, email="login@example.com", display_name="Login Person")

    async with client_factory() as c:
        r = await c.post("/api/auth/login", json={"email": "login@example.com", "password": "password123"})
        assert r.status_code == 200
        body = r.json()
        assert body["user"]["email"] == "login@example.com"
        assert body["user"]["display_name"] == "Login Person"
        assert c.cookies.get("suisui_session")
        assert c.cookies.get("suisui_csrf")


async def test_login_wrong_password_returns_generic_401(client_factory):
    async with client_factory() as registering_client:
        await register_and_login(registering_client, email="wrongpw@example.com")

    async with client_factory() as c:
        r = await c.post("/api/auth/login", json={"email": "wrongpw@example.com", "password": "notthepassword"})
        assert r.status_code == 401
        assert r.json() == {"detail": "invalid email or password"}


async def test_login_unknown_email_matches_wrong_password_error_body(client_factory):
    async with client_factory() as registering_client:
        await register_and_login(registering_client, email="known@example.com")

    async with client_factory() as wrong_password_client:
        wrong_password_r = await wrong_password_client.post(
            "/api/auth/login", json={"email": "known@example.com", "password": "notthepassword"}
        )

    async with client_factory() as unknown_email_client:
        unknown_email_r = await unknown_email_client.post(
            "/api/auth/login", json={"email": "neverregistered@example.com", "password": "whatever123"}
        )

    assert wrong_password_r.status_code == 401
    assert unknown_email_r.status_code == 401
    # byte-identical bodies — a login failure must not disclose account existence
    assert wrong_password_r.content == unknown_email_r.content


async def test_me_without_cookie_returns_401(client):
    r = await client.get("/api/auth/me")
    assert r.status_code == 401
    assert r.json() == {"detail": "not authenticated"}


async def test_me_with_valid_cookie_returns_user(client):
    registered = await register_and_login(client, email="me@example.com", display_name="Me Person")
    r = await client.get("/api/auth/me")
    assert r.status_code == 200
    body = r.json()
    assert body["user"]["id"] == registered["user"]["id"]
    assert body["user"]["email"] == "me@example.com"
    assert body["user"]["display_name"] == "Me Person"


async def test_logout_with_csrf_revokes_session(client):
    await register_and_login(client, email="logout@example.com")
    r = await client.post("/api/auth/logout", headers=csrf_headers(client))
    assert r.status_code == 204

    r2 = await client.get("/api/auth/me")
    assert r2.status_code == 401


async def test_logout_without_csrf_header_forbidden_and_session_stays_alive(client):
    await register_and_login(client, email="nocsrf@example.com")
    r = await client.post("/api/auth/logout")
    assert r.status_code == 403
    assert r.json() == {"detail": "csrf token missing or invalid"}

    # the session must NOT have been revoked by the rejected logout attempt
    r2 = await client.get("/api/auth/me")
    assert r2.status_code == 200


async def test_expired_session_rejected(client, session_factory_direct):
    registered = await register_and_login(client, email="expired@example.com")
    user_id = uuid.UUID(registered["user"]["id"])
    token = await insert_expired_session(session_factory_direct, user_id=user_id, expires_delta=timedelta(days=-1))

    client.cookies.set("suisui_session", token)
    r = await client.get("/api/auth/me")
    assert r.status_code == 401


async def test_revoked_session_rejected(client):
    await register_and_login(client, email="revoked@example.com")
    logout_r = await client.post("/api/auth/logout", headers=csrf_headers(client))
    assert logout_r.status_code == 204

    r = await client.get("/api/auth/me")
    assert r.status_code == 401
