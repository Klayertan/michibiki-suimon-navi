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

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
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


class InvalidCredentials(AuthError):
    pass


class AccountDisabled(AuthError):
    pass


class SessionInvalid(AuthError):
    pass


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
    normalized = normalize_email(email)
    existing = await db.scalar(select(User).where(User.email == normalized))
    if existing is not None:
        # Deliberately the SAME exception (and, in the router, the same HTTP
        # response) as any other registration failure would be vague about —
        # see auth/router.py's comment on not disclosing account existence
        # any more than the frontend's own UX already requires. Signup is the
        # one place Supabase's own behavior (and this app's existing
        # auth-errors.js message "このメールアドレスは既に登録されています") does
        # disclose it, so this mirrors that rather than inventing stricter
        # behavior the frontend does not expect.
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
