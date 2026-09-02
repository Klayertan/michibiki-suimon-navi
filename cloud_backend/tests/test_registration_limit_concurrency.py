"""Concurrent registration at the account-cap boundary.

TWO DISTINCT TIERS OF VERIFICATION — do not conflate them:

- ``test_concurrent_registration_never_exceeds_cap_sqlite_tier`` always runs
  (SQLite, in-memory). It proves the APPLICATION-LEVEL orchestration in
  app/auth/service.py's register_user() — the "acquire lock -> check open ->
  count -> check cap -> ..." sequence is correctly serialized end to end.
  Its lock is a plain in-process ``asyncio.Lock`` (see
  ``_serialize_registration()`` in app/auth/service.py) — correct only
  within one Python process, NOT a proof of real multi-connection database
  locking.

- ``test_concurrent_registration_never_exceeds_cap_postgresql_tier`` is the
  one that actually proves the production guarantee: PostgreSQL's
  ``pg_advisory_xact_lock`` serializing two independent connections/
  transactions. It is SKIPPED unless ``SUISUI_CLOUD_TEST_DATABASE_URL``
  points at a real PostgreSQL instance — i.e. it only actually runs in CI's
  "integration" job (see .github/workflows/deploy-cloud-backend.yml) or
  against a real local PostgreSQL, never by default. This repository's
  local development environment has no PostgreSQL available, so this test
  was written carefully but has NOT been observed passing anywhere yet —
  see docs/SAKURA_CLOUD_BACKEND.md §10 for this project's honesty
  convention about verification tiers.
"""
from __future__ import annotations

import asyncio
import os
import uuid

import httpx
import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.config import get_settings
from app.database import Base, get_db
from app.main import create_app
from app.models.db import User
from app.security import hash_password
from tests.conftest import make_test_settings


async def _run_boundary_race(engine, *, drop_first: bool) -> tuple[list[int], int]:
    """Seeds 9 users, fires two concurrent registrations at a cap of 10, and
    returns (status_codes, final_user_count)."""
    if drop_first:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with session_factory() as db:
        for i in range(9):
            db.add(
                User(
                    id=uuid.uuid4(),
                    email=f"boundary-seed{i}@example.com",
                    password_hash=hash_password("password123"),
                    is_active=True,
                    email_verified=True,
                )
            )
        await db.commit()

    settings = make_test_settings(max_registered_users=10, registration_open=True)

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
    transport = httpx.ASGITransport(app=app)

    async def attempt(email: str) -> int:
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            r = await client.post("/api/auth/register", json={"email": email, "password": "password123"})
            return r.status_code

    statuses = await asyncio.gather(
        attempt("boundary-racer-1@example.com"),
        attempt("boundary-racer-2@example.com"),
    )

    async with session_factory() as db:
        final_count = await db.scalar(select(func.count()).select_from(User))

    return list(statuses), final_count


async def test_concurrent_registration_never_exceeds_cap_sqlite_tier():
    """Application-level lock ordering only — see this module's docstring."""
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    try:
        statuses, final_count = await _run_boundary_race(engine, drop_first=False)
    finally:
        await engine.dispose()

    assert sorted(statuses) == [200, 403], f"expected exactly one success and one rejection, got {statuses}"
    assert final_count == 10, f"account cap violated: expected exactly 10, got {final_count}"


async def test_concurrent_registration_never_exceeds_cap_postgresql_tier():
    """The real guarantee: PostgreSQL's pg_advisory_xact_lock serializing two
    independent connections. See this module's docstring — skipped unless
    SUISUI_CLOUD_TEST_DATABASE_URL points at a real PostgreSQL instance."""
    test_db_url = os.environ.get("SUISUI_CLOUD_TEST_DATABASE_URL")
    if not test_db_url:
        pytest.skip(
            "SUISUI_CLOUD_TEST_DATABASE_URL is not set — this test only runs against a real "
            "PostgreSQL instance (see .github/workflows/deploy-cloud-backend.yml's 'integration' job)."
        )

    engine = create_async_engine(test_db_url)
    try:
        statuses, final_count = await _run_boundary_race(engine, drop_first=True)
    finally:
        await engine.dispose()

    assert sorted(statuses) == [200, 403], f"expected exactly one success and one rejection, got {statuses}"
    assert final_count == 10, f"account cap violated: expected exactly 10, got {final_count}"
