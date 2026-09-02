"""Registration cap (Settings.registration_open / max_registered_users) —
see app/auth/service.py's register_user()/_serialize_registration() and
docs/AUTH_ARCHITECTURE.md "Registration cap".

Overrides conftest.py's `settings` fixture for this module only (pytest
resolves same-named fixtures to the closest definition, so client_factory/
client here automatically build against THIS module's settings, not
conftest's unrestricted default) — every other test file's registration
calls stay unaffected.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import func, select

from app.models.db import Field, Profile, Session as SessionModel, User
from app.security import hash_password
from tests.conftest import csrf_headers, make_test_settings, register_and_login


@pytest.fixture
def settings():
    return make_test_settings(max_registered_users=10, registration_open=True)


async def _seed_users(session_factory, count: int) -> None:
    async with session_factory() as db:
        for i in range(count):
            db.add(
                User(
                    id=uuid.uuid4(),
                    email=f"seed{i}@example.com",
                    password_hash=hash_password("password123"),
                    is_active=True,
                    email_verified=True,
                )
            )
        await db.commit()


async def _user_count(session_factory) -> int:
    async with session_factory() as db:
        return await db.scalar(select(func.count()).select_from(User))


async def test_registration_succeeds_with_zero_users(client):
    r = await client.post("/api/auth/register", json={"email": "first@example.com", "password": "password123"})
    assert r.status_code == 200, r.text


async def test_registration_succeeds_with_nine_users_and_creates_the_tenth(client, client_factory):
    await _seed_users(client_factory.session_factory, 9)
    r = await client.post("/api/auth/register", json={"email": "tenth@example.com", "password": "password123"})
    assert r.status_code == 200, r.text
    assert await _user_count(client_factory.session_factory) == 10


async def test_registration_with_ten_existing_users_fails(client, client_factory):
    await _seed_users(client_factory.session_factory, 10)
    r = await client.post("/api/auth/register", json={"email": "eleventh@example.com", "password": "password123"})
    assert r.status_code == 403
    assert r.json() == {"detail": "現在、新しいアカウントの登録を受け付けていません。"}


async def test_account_eleven_is_never_created(client, client_factory):
    await _seed_users(client_factory.session_factory, 10)
    r = await client.post("/api/auth/register", json={"email": "eleventh@example.com", "password": "password123"})
    assert r.status_code == 403
    assert await _user_count(client_factory.session_factory) == 10
    async with client_factory.session_factory() as db:
        existing = await db.scalar(select(User).where(User.email == "eleventh@example.com"))
        assert existing is None


async def test_registration_open_false_rejects_registration(client_factory):
    # client_factory (and this module's `settings` fixture override) bakes
    # in registration_open=True at fixture-build time, so a genuinely
    # different `registration_open` value needs its own app instance built
    # directly here — same pattern conftest.py's client_factory itself uses.
    closed_settings = make_test_settings(max_registered_users=10, registration_open=False)
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from sqlalchemy.pool import StaticPool

    from app.config import get_settings
    from app.database import Base, get_db
    from app.main import create_app

    engine = create_async_engine("sqlite+aiosqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async def override_get_db():
        async with session_factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    import httpx

    app = create_app(closed_settings)
    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_settings] = lambda: closed_settings
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        r = await client.post("/api/auth/register", json={"email": "closed@example.com", "password": "password123"})
        assert r.status_code == 403
        assert r.json() == {"detail": "現在、新しいアカウントの登録を受け付けていません。"}
    await engine.dispose()


async def test_registration_open_false_still_allows_existing_user_login(client_factory):
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from sqlalchemy.pool import StaticPool

    from app.config import get_settings
    from app.database import Base, get_db
    from app.main import create_app

    engine = create_async_engine("sqlite+aiosqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    # Seed the user directly — login must work purely off Settings.registration_open,
    # never off how the account was created.
    user_id = uuid.uuid4()
    async with session_factory() as db:
        db.add(User(id=user_id, email="already-here@example.com", password_hash=hash_password("password123"),
                     is_active=True, email_verified=True))
        db.add(Profile(user_id=user_id, display_name="Existing Farmer"))
        await db.commit()

    async def override_get_db():
        async with session_factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    import httpx

    closed_settings = make_test_settings(max_registered_users=10, registration_open=False)
    app = create_app(closed_settings)
    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_settings] = lambda: closed_settings
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        r = await client.post("/api/auth/login", json={"email": "already-here@example.com", "password": "password123"})
        assert r.status_code == 200, r.text
        assert r.json()["user"]["email"] == "already-here@example.com"

        r2 = await client.post("/api/auth/register", json={"email": "brandnew@example.com", "password": "password123"})
        assert r2.status_code == 403
    await engine.dispose()


async def test_duplicate_email_still_behaves_correctly_with_capacity_available(client):
    r1 = await client.post("/api/auth/register", json={"email": "dup@example.com", "password": "password123"})
    assert r1.status_code == 200
    r2 = await client.post("/api/auth/register", json={"email": "dup@example.com", "password": "password123"})
    assert r2.status_code == 409
    assert r2.json() == {"detail": "email already registered"}


async def test_password_hashing_remains_correct(client, client_factory):
    r = await client.post("/api/auth/register", json={"email": "hashed@example.com", "password": "password123"})
    assert r.status_code == 200
    async with client_factory.session_factory() as db:
        user = await db.scalar(select(User).where(User.email == "hashed@example.com"))
        assert user.password_hash.startswith("$argon2")
        assert user.password_hash != "password123"

    # And login still works against that hash.
    async with client_factory() as second_login_client:
        r2 = await second_login_client.post("/api/auth/login", json={"email": "hashed@example.com", "password": "password123"})
        assert r2.status_code == 200


async def test_rejected_registration_creates_no_partial_rows(client, client_factory):
    await _seed_users(client_factory.session_factory, 10)
    r = await client.post("/api/auth/register", json={"email": "rejected@example.com", "password": "password123"})
    assert r.status_code == 403
    async with client_factory.session_factory() as db:
        user = await db.scalar(select(User).where(User.email == "rejected@example.com"))
        assert user is None
        # No orphaned Profile/Session/Field rows at all — _seed_users() only
        # ever inserts User rows directly, and the rejected registration
        # attempt must not have created a Profile either.
        assert await db.scalar(select(func.count()).select_from(Profile)) == 0
        assert await db.scalar(select(func.count()).select_from(SessionModel)) == 0
        assert await db.scalar(select(func.count()).select_from(Field)) == 0
