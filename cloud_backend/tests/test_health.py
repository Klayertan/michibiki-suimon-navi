import httpx

from app.main import create_app
from tests.conftest import make_test_settings


async def test_health_ok(client):
    r = await client.get("/api/health")
    assert r.status_code == 200
    # Exact body, not just "status is ok": this is the contract an external
    # uptime monitor (and the Article 1 deployment check) relies on.
    assert r.json() == {"status": "ok", "service": "sui-sui-navi-api"}


async def test_health_needs_no_login_and_no_csrf(client):
    # A fresh client has no session cookie. The health check must work without
    # one, otherwise a monitor could never tell "server up" from "logged out".
    assert not client.cookies
    r = await client.get("/api/health")
    assert r.status_code == 200


async def test_health_does_not_disclose_environment():
    # Production mode refuses to boot without a session secret and a
    # registration cap, so supply both; the point is only what /api/health says.
    settings = make_test_settings(
        environment="production", session_secret="x" * 32, max_registered_users=10
    )
    app = create_app(settings)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as c:
        r = await c.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "service": "sui-sui-navi-api"}
    assert "production" not in r.text
