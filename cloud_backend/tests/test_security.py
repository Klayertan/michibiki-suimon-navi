ALLOWED_ORIGIN = "https://suisuinavi.sakura.ne.jp"
DISALLOWED_ORIGIN = "https://evil.example.com"


def _preflight_headers(origin: str) -> dict:
    return {"Origin": origin, "Access-Control-Request-Method": "POST"}


async def test_cors_preflight_from_allowed_origin_is_accepted(client):
    r = await client.options("/api/fields", headers=_preflight_headers(ALLOWED_ORIGIN))
    assert r.status_code == 200
    assert r.headers.get("access-control-allow-origin") == ALLOWED_ORIGIN


async def test_cors_preflight_from_disallowed_origin_is_rejected(client):
    r = await client.options("/api/fields", headers=_preflight_headers(DISALLOWED_ORIGIN))
    assert r.status_code == 400
    assert r.headers.get("access-control-allow-origin") is None


async def test_malformed_json_body_returns_422_json_invalid(client):
    r = await client.post(
        "/api/auth/register",
        content=b"{not json",
        headers={"content-type": "application/json"},
    )
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert detail[0]["type"] == "json_invalid"


async def test_oversized_request_body_returns_413(client):
    # Comfortably over Settings.max_request_body_bytes (1_000_000).
    payload = {
        "email": "big@example.com",
        "password": "a" * 2_000_000,
        "display_name": "",
    }
    r = await client.post("/api/auth/register", json=payload)
    assert r.status_code == 413
    assert r.json() == {"detail": "request body too large"}


def _set_cookie_line(response, cookie_name: str) -> str:
    lines = [
        value
        for key, value in response.headers.multi_items()
        if key.lower() == "set-cookie" and value.startswith(f"{cookie_name}=")
    ]
    assert lines, f"no set-cookie line found for {cookie_name}"
    return lines[0]


async def test_session_cookie_is_httponly_samesite_lax_not_secure(client):
    r = await client.post(
        "/api/auth/register",
        json={"email": "cookies@example.com", "password": "password123", "display_name": ""},
    )
    assert r.status_code == 200
    line = _set_cookie_line(r, "suisui_session").lower()
    assert "httponly" in line
    assert "samesite=lax" in line
    # environment defaults to "development" in tests, so cookie_secure is False
    assert "secure" not in line


async def test_csrf_cookie_is_readable_by_frontend_not_httponly(client):
    r = await client.post(
        "/api/auth/register",
        json={"email": "csrfcookie@example.com", "password": "password123", "display_name": ""},
    )
    assert r.status_code == 200
    line = _set_cookie_line(r, "suisui_csrf").lower()
    assert "httponly" not in line


async def test_unauthenticated_get_requests_return_401(client):
    for path in (
        "/api/fields",
        "/api/water-control-points",
        "/api/field-observations",
        "/api/field-water-targets",
        "/api/profile",
    ):
        r = await client.get(path)
        assert r.status_code == 401, f"{path} did not return 401"


async def test_bogus_session_cookie_is_treated_as_invalid_not_a_crash(client):
    client.cookies.set("suisui_session", "this-token-was-never-issued-by-the-server")
    r = await client.get("/api/auth/me")
    assert r.status_code == 401
