"""Shared fixtures for the cloud_backend test suite.

Runs against an in-memory SQLite database, never a real PostgreSQL instance
— see app/models/db.py's UTCDateTime and JSONType for the two places the
ORM already accounts for that dialect difference. This is deliberately the
"unit verified" tier only: it proves the route/service/ORM logic is
correct, not that it behaves identically under real PostgreSQL. See
docs/SAKURA_CLOUD_BACKEND.md's "Verification tiers" section for what still
needs a real Postgres (Alembic `upgrade head`, the Docker Compose
integration environment, and eventually a real Sakura Cloud VM) before this
is "integration verified" or "real Sakura Cloud verified".

Every test gets its own fresh app instance, its own fresh in-memory
database, and its own fresh rate-limiter state — see the `client_factory`
fixture. Tests that need two independent logged-in identities (almost every
multi-user isolation test) call `client_factory()` twice; each call is a
separate httpx.AsyncClient with its own cookie jar, simulating two
different browsers.
"""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

import app.auth.router as auth_router_module
from app.config import Settings, get_settings
from app.database import Base, get_db
from app.main import create_app
from app.models import db as models  # noqa: F401 - registers tables on Base.metadata
from app.security import hash_password, hash_session_token, new_csrf_token, new_session_token


def make_test_settings(**overrides) -> Settings:
    defaults = dict(
        environment="development",
        database_url="sqlite+aiosqlite:///:memory:",
        session_secret="test-session-secret-not-for-production",
        # High by default so tests that aren't specifically about rate
        # limiting never trip a 429 as an incidental side effect of sharing
        # a handful of email addresses across many assertions.
        login_rate_limit_attempts=1000,
        login_rate_limit_window_seconds=300,
        register_rate_limit_attempts=1000,
        register_rate_limit_window_seconds=3600,
    )
    defaults.update(overrides)
    return Settings(**defaults)


@pytest.fixture
async def engine():
    # Opt-in real-PostgreSQL mode: when SUISUI_CLOUD_TEST_DATABASE_URL is
    # set (see .github/workflows/deploy-cloud-backend.yml's
    # "cloud-backend-integration" job, which points this at a throwaway
    # postgres service container), the exact same test suite runs against
    # real PostgreSQL instead of SQLite — the only environment that
    # exercises the ORM's Postgres-specific paths for real: JSONB storage
    # and, in particular, the named `ON CONFLICT ON CONSTRAINT` upserts in
    # app/api/*.py (fields.py, water_control_points.py,
    # field_observations.py), which SQLAlchemy's SQLite dialect happens to
    # also accept but only because it is more permissive there, not because
    # SQLite has real named constraints the way Postgres does. Each test
    # still gets a clean slate: drop_all + create_all, since a real
    # Postgres instance (unlike an in-memory SQLite one) persists rows
    # across the fixture's per-test teardown/setup.
    test_db_url = os.environ.get("SUISUI_CLOUD_TEST_DATABASE_URL")
    if test_db_url:
        eng = create_async_engine(test_db_url)
        async with eng.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        yield eng
        await eng.dispose()
        return

    # Default: in-memory SQLite. StaticPool keeps a single shared connection
    # for the whole test, so every AsyncSession sees the same database (a
    # plain "sqlite+aiosqlite:///:memory:" engine hands each new connection
    # a *separate*, empty in-memory database, which would make every
    # request in a test look like a fresh, tableless database).
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
def settings():
    return make_test_settings()


@pytest.fixture(autouse=True)
def _reset_rate_limiters():
    # See auth/router.py: _login_limiter/_register_limiter are lazily-built
    # module-level singletons, keyed by in-memory attempt counters. Without
    # this reset, whichever test runs first "wins" the limiter's
    # configuration for the rest of the process, and attempt counts leak
    # across tests that happen to reuse the same email/client key.
    auth_router_module._login_limiter = None
    auth_router_module._register_limiter = None
    yield
    auth_router_module._login_limiter = None
    auth_router_module._register_limiter = None


@pytest.fixture
def client_factory(engine, settings):
    """Returns a factory: each call builds a fresh httpx.AsyncClient (its own
    cookie jar = its own simulated browser) wired to ONE shared app/database
    for this test. Callers are responsible for closing clients they create,
    or use it via `async with`."""
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async def override_get_db():
        async with session_factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app = create_app(settings)
    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_settings] = lambda: settings

    def _make(**client_kwargs) -> httpx.AsyncClient:
        transport = httpx.ASGITransport(app=app)
        return httpx.AsyncClient(transport=transport, base_url="http://testserver", **client_kwargs)

    _make.app = app
    _make.session_factory = session_factory
    return _make


@pytest.fixture
async def client(client_factory):
    async with client_factory() as c:
        yield c


async def register_and_login(client: httpx.AsyncClient, *, email: str, password: str = "password123", display_name: str = "") -> dict:
    """Convenience helper: registers (if needed) and returns the parsed
    /api/auth/register JSON body. The client's cookie jar now holds a valid
    session for this identity; read the CSRF token off
    client.cookies['suisui_csrf'] for state-changing requests."""
    r = await client.post(
        "/api/auth/register",
        json={"email": email, "password": password, "display_name": display_name},
    )
    assert r.status_code == 200, r.text
    return r.json()


def csrf_headers(client: httpx.AsyncClient) -> dict:
    token = client.cookies.get("suisui_csrf")
    assert token, "no csrf cookie on client — did you log in first?"
    return {"x-suisui-csrf": token}


@pytest.fixture
def session_factory_direct(client_factory):
    """Direct DB access for tests that need to set up or inspect rows the
    HTTP API has no route for (e.g. an expired/revoked session, or seeding a
    row with a specific timestamp)."""
    return client_factory.session_factory


async def insert_expired_session(session_factory, *, user_id: uuid.UUID, expires_delta: timedelta) -> str:
    """Directly inserts a Session row already expired/near-expiry, returning
    the plaintext token — used by tests that need an expired-but-otherwise-
    valid session cookie, which the public API has no way to manufacture on
    demand (sessions normally expire only after session_ttl_days)."""
    token = new_session_token()
    async with session_factory() as db:
        db.add(
            models.Session(
                id=uuid.uuid4(),
                user_id=user_id,
                token_hash=hash_session_token(token),
                expires_at=datetime.now(timezone.utc) + expires_delta,
                csrf_token=new_csrf_token(),
            )
        )
        await db.commit()
    return token
