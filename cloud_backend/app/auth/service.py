"""Registration, login, logout and session lifecycle.

Session model
-------------
Opaque, server-side sessions — not JWTs. The cookie carries a random,
high-entropy token; the database stores only its SHA-256 hash (see
app/security.py). Validating a request means looking that hash up and
checking ``revoked_at``/``expires_at`` — which is also what makes server-side
revocation (logout, "sign out everywhere") actually work, unlike a signed JWT
that stays valid until it expires no matter what the server does.
"""

from __future__ import annotations

import asyncio
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import Settings
from ..models.db import Profile, Session as SessionModel, User
from ..security import (
    hash_password,
    hash_session_token,
    needs_rehash,
    new_csrf_token,
    new_session_token,
    normalize_email,
    verify_password,
)


class AuthError(Exception):
    """Base for every auth failure the router turns into a generic 401/400."""


class EmailAlreadyRegistered(AuthError):
    pass


class RegistrationClosed(AuthError):
    """Registration is unavailable — either Settings.registration_open is
    false, or the account cap (Settings.max_registered_users) has been
    reached. Deliberately one exception, one public message, for both
    causes (see auth/router.py's register()) — a visitor is never told
    which, and never told how many slots remain. See
    docs/AUTH_ARCHITECTURE.md — "Registration cap"."""


class InvalidCredentials(AuthError):
    pass


class AccountDisabled(AuthError):
    pass


class SessionInvalid(AuthError):
    pass


# Arbitrary, fixed key namespacing this one advisory lock so it can never
# collide with an unrelated pg_advisory_xact_lock elsewhere in a shared
# database — any stable 64-bit constant works; this one has no meaning
# beyond being memorable and unlikely to be reused by accident.
_REGISTRATION_LOCK_KEY = 0x53554953_55495200  # "SUISUI\x00" as an int

# Process-local fallback used only against SQLite — see
# _serialize_registration()'s own docstring for why this is not the real
# guarantee.
_sqlite_registration_lock = asyncio.Lock()


@asynccontextmanager
async def _serialize_registration(db: AsyncSession):
    """Ensures at most one registration transaction proceeds past the
    account-limit check (register_user(), below) at a time — the fix for
    the classic "SELECT COUNT then INSERT" race, where two concurrent
    requests can both observe count=9 and both insert, producing 11 rows
    for a cap of 10.

    PostgreSQL (production): a transaction-scoped advisory lock
    (``pg_advisory_xact_lock``). A second concurrent call blocks here until
    the first registration's transaction commits or rolls back, at which
    point PostgreSQL releases the lock automatically — so the second
    request's subsequent COUNT is guaranteed to see the first request's
    already-committed row under the default READ COMMITTED isolation
    level. Chosen over a dedicated lock row + ``SELECT ... FOR UPDATE``
    (would need a new table for one lock) or a unique constraint trick
    (can't cleanly express "at most N rows," only "at most 1 of a value")
    — an advisory lock needs no schema at all and is the standard
    PostgreSQL answer to exactly this "serialize a critical section across
    connections" problem. See docs/AUTH_ARCHITECTURE.md — "Registration
    cap" for the full reasoning, and
    tests/test_registration_limit_concurrency.py for the PostgreSQL-only
    test that actually proves this (gated on
    SUISUI_CLOUD_TEST_DATABASE_URL pointing at a real PostgreSQL — see that
    test module's own docstring).

    SQLite (tests by default, local dev without Docker): PostgreSQL's
    advisory-lock function does not exist, so this falls back to a plain
    in-process ``asyncio.Lock`` — correct only within one Python process,
    the same single-process tradeoff app/security.py's RateLimiter already
    accepts for the same underlying reason (no distributed coordination
    primitive available without adding infrastructure this deployment
    doesn't have). It is enough to make the SQLite-backed unit tests
    meaningful for the *application-level* orchestration (lock → check
    open → count → check cap → …), but it is NOT what protects a real
    multi-connection PostgreSQL deployment — that is the branch above.
    """
    dialect = db.bind.dialect.name if db.bind is not None else ""
    if dialect == "postgresql":
        await db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": _REGISTRATION_LOCK_KEY})
        yield
    else:
        async with _sqlite_registration_lock:
            yield


class NewSession:
    """What the router needs to set the two cookies and build the response."""

    def __init__(self, user: User, token: str, csrf_token: str, expires_at: datetime) -> None:
        self.user = user
        self.token = token
        self.csrf_token = csrf_token
        self.expires_at = expires_at


async def register_user(
    db: AsyncSession, settings: Settings, *, email: str, password: str, display_name: str
) -> User:
    async with _serialize_registration(db):
        # Gates checked first, cheapest first, before ever touching the
        # email uniqueness lookup or paying for an Argon2 hash — see
        # docs/AUTH_ARCHITECTURE.md — "Registration cap" for the exact
        # ordering this mirrors (acquire lock → check open → count → check
        # cap → check duplicate email → hash → create → commit).
        if not settings.registration_open:
            raise RegistrationClosed()
        if settings.max_registered_users is not None:
            # Counts every row in `users` — there is no separate
            # administrative/service-account class in this schema (see
            # docs/AUTH_ARCHITECTURE.md), so this is genuinely "every
            # account, including the presenter's own." Read inside the
            # locked section so a second waiting request only sees this
            # count after the first request's own commit/rollback has
            # already happened — see _serialize_registration()'s docstring.
            registered_count = await db.scalar(select(func.count()).select_from(User))
            if (registered_count or 0) >= settings.max_registered_users:
                raise RegistrationClosed()

        normalized = normalize_email(email)
        existing = await db.scalar(select(User).where(User.email == normalized))
        if existing is not None:
            # Deliberately the SAME exception (and, in the router, the same
            # HTTP response) as any other registration failure would be
            # vague about — see auth/router.py's comment on not disclosing
            # account existence any more than the frontend's own UX already
            # requires. Signup is the one place Supabase's own behavior
            # (and this app's existing auth-errors.js message
            # "このメールアドレスは既に登録されています") does disclose it, so
            # this mirrors that rather than inventing stricter behavior the
            # frontend does not expect.
            raise EmailAlreadyRegistered()
        if len(password) < settings.min_password_length:
            raise AuthError(f"password must be at least {settings.min_password_length} characters")

        user = User(
            id=uuid.uuid4(),
            email=normalized,
            password_hash=hash_password(password),
            is_active=True,
            email_verified=not settings.require_email_verification,
        )
        db.add(user)
        await db.flush()
        db.add(Profile(user_id=user.id, display_name=display_name.strip()))
        await db.flush()
        return user


async def authenticate(db: AsyncSession, *, email: str, password: str) -> User:
    normalized = normalize_email(email)
    user = await db.scalar(select(User).where(User.email == normalized))
    if user is None:
        # Same InvalidCredentials for "no such user" and "wrong password" —
        # this is what auth-errors.js's existing 「メールアドレスまたはパスワードが
        # 違います」 message already assumes on the frontend, and is what Phase 5
        # asks for explicitly (generic errors that do not disclose account
        # existence).
        raise InvalidCredentials()
    if not verify_password(user.password_hash, password):
        raise InvalidCredentials()
    if not user.is_active:
        raise AccountDisabled()
    if needs_rehash(user.password_hash):
        # Transparent upgrade path if Argon2's recommended parameters change
        # in a future library version — never a reason to fail a login.
        user.password_hash = hash_password(password)
    return user


async def create_session(
    db: AsyncSession, settings: Settings, *, user: User, user_agent: str | None
) -> NewSession:
    token = new_session_token()
    expires_at = datetime.now(timezone.utc) + timedelta(days=settings.session_ttl_days)
    session = SessionModel(
        id=uuid.uuid4(),
        user_id=user.id,
        token_hash=hash_session_token(token),
        expires_at=expires_at,
        csrf_token=new_csrf_token(),
        user_agent=(user_agent or "")[:512] or None,
    )
    db.add(session)
    await db.flush()
    return NewSession(user=user, token=token, csrf_token=session.csrf_token, expires_at=expires_at)


async def resolve_session(db: AsyncSession, *, token: str) -> tuple[User, SessionModel]:
    token_hash = hash_session_token(token)
    session = await db.scalar(select(SessionModel).where(SessionModel.token_hash == token_hash))
    if session is None:
        raise SessionInvalid()
    now = datetime.now(timezone.utc)
    if session.revoked_at is not None:
        raise SessionInvalid()
    if session.expires_at <= now:
        raise SessionInvalid()
    user = await db.get(User, session.user_id)
    if user is None or not user.is_active:
        raise SessionInvalid()
    session.last_seen_at = now
    return user, session


async def revoke_session(db: AsyncSession, *, token: str) -> None:
    token_hash = hash_session_token(token)
    session = await db.scalar(select(SessionModel).where(SessionModel.token_hash == token_hash))
    if session is not None and session.revoked_at is None:
        session.revoked_at = datetime.now(timezone.utc)
