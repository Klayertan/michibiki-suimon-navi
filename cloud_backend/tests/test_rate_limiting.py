"""Login/register rate limiting (app/auth/router.py + app/security.py's RateLimiter).

Needs much lower limits than conftest.make_test_settings' defaults (which
are deliberately huge so every other test file never trips the limiter), so
this file builds its own low-limit Settings and its own client_factory/
client fixtures, mirroring conftest.py's pattern rather than importing it.
The autouse `_reset_rate_limiters` fixture from conftest.py still applies
here (autouse fixtures apply repo-wide), so each test below still starts
from fresh limiter state.
"""

from __future__ import annotations

import httpx
import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.config import Settings, get_settings
from app.database import Base, get_db
from app.main import create_app

LOGIN_LIMIT = 3
REGISTER_LIMIT = 2


def _make_low_limit_settings(**overrides) -> Settings:
    defaults = dict(
        environment="development",
        database_url="sqlite+aiosqlite:///:memory:",
        session_secret="test-session-secret-not-for-production",
        login_rate_limit_attempts=LOGIN_LIMIT,
        login_rate_limit_window_seconds=300,
        register_rate_limit_attempts=REGISTER_LIMIT,
        register_rate_limit_window_seconds=3600,
    )
    defaults.update(overrides)
    return Settings(**defaults)


@pytest.fixture
async def rl_engine():
    eng = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield eng
    await eng.dispose()


@pytest.fixture
def rl_settings():
    return _make_low_limit_settings()


@pytest.fixture
def rl_client_factory(rl_engine, rl_settings):
    session_factory = async_sessionmaker(rl_engine, expire_on_commit=False)

    async def override_get_db():
        async with session_factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app = create_app(rl_settings)
    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_settings] = lambda: rl_settings

    def _make(**client_kwargs) -> httpx.AsyncClient:
        transport = httpx.ASGITransport(app=app)
        return httpx.AsyncClient(transport=transport, base_url="http://testserver", **client_kwargs)

    _make.app = app
    _make.session_factory = session_factory
    return _make


@pytest.fixture
async def rl_client(rl_client_factory):
    async with rl_client_factory() as c:
        yield c


async def test_login_rate_limit_returns_429_after_max_attempts_from_same_client(rl_client):
    await rl_client.post(
        "/api/auth/register",
        json={"email": "ratelimited@example.com", "password": "password123", "display_name": ""},
    )

    for _ in range(LOGIN_LIMIT):
        r = await rl_client.post(
            "/api/auth/login",
            json={"email": "ratelimited@example.com", "password": "wrong-password"},
        )
        assert r.status_code == 401
        assert r.json() == {"detail": "invalid email or password"}

    r = await rl_client.post(
        "/api/auth/login",
        json={"email": "ratelimited@example.com", "password": "wrong-password"},
    )
    assert r.status_code == 429
    assert r.json() == {"detail": "too many attempts"}


async def test_login_rate_limit_blocks_even_correct_password_once_exhausted(rl_client):
    await rl_client.post(
        "/api/auth/register",
        json={"email": "stillblocked@example.com", "password": "password123", "display_name": ""},
    )

    for _ in range(LOGIN_LIMIT):
        r = await rl_client.post(
            "/api/auth/login",
            json={"email": "stillblocked@example.com", "password": "wrong-password"},
        )
        assert r.status_code == 401

    # the limiter check happens before authenticate(), so even a correct
    # password is rejected once the bucket is exhausted
    r = await rl_client.post(
        "/api/auth/login",
        json={"email": "stillblocked@example.com", "password": "password123"},
    )
    assert r.status_code == 429
    assert r.json() == {"detail": "too many attempts"}


async def test_register_rate_limit_returns_429_after_max_attempts_from_same_ip(rl_client):
    for i in range(REGISTER_LIMIT):
        r = await rl_client.post(
            "/api/auth/register",
            json={"email": f"newfarmer{i}@example.com", "password": "password123", "display_name": ""},
        )
        assert r.status_code == 200, r.text

    # a brand-new, never-before-seen email still gets blocked — this is the
    # per-IP bucket tripping, not the per-email one
    r = await rl_client.post(
        "/api/auth/register",
        json={"email": "yetanotherfarmer@example.com", "password": "password123", "display_name": ""},
    )
    assert r.status_code == 429
    assert r.json() == {"detail": "too many attempts"}
