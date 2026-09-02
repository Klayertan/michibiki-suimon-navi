"""POST /api/auth/register, /login, /logout, GET /api/auth/me.

Response shape matches what js/auth/sakura-auth-client.js expects, which in
turn matches the same {user, session, needsEmailConfirmation} shape
js/auth/supabase-auth-client.js already returns to auth-controller.js — see
that file's signUp()/signIn() for the contract this mirrors.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import Settings, get_settings
from ..database import get_db
from ..dependencies import get_current_user, require_csrf
from ..models.db import Profile, User
from ..models.schemas import AuthResponse, LoginRequest, RegisterRequest, UserOut
from ..security import RateLimiter
from .service import (
    AccountDisabled,
    AuthError,
    EmailAlreadyRegistered,
    InvalidCredentials,
    authenticate,
    create_session,
    register_user,
    revoke_session,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])

# Per-process, in-memory (see security.RateLimiter's own docstring on why
# that is the correct scope for a single-VM deployment). Keyed by client IP;
# a second key on the submitted email is added in the route itself so a
# credential-stuffing run against one address cannot hide behind many IPs
# rotating through NAT without ALSO tripping the per-IP limit. Built lazily
# from Settings on first use (not at import time) so tests that construct
# Settings with different limits are respected instead of a frozen default.
_login_limiter: RateLimiter | None = None
_register_limiter: RateLimiter | None = None


def _get_login_limiter(settings: Settings) -> RateLimiter:
    global _login_limiter
    if _login_limiter is None:
        _login_limiter = RateLimiter(
            max_attempts=settings.login_rate_limit_attempts,
            window_seconds=settings.login_rate_limit_window_seconds,
        )
    return _login_limiter


def _get_register_limiter(settings: Settings) -> RateLimiter:
    global _register_limiter
    if _register_limiter is None:
        _register_limiter = RateLimiter(
            max_attempts=settings.register_rate_limit_attempts,
            window_seconds=settings.register_rate_limit_window_seconds,
        )
    return _register_limiter


def _client_key(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _set_session_cookies(response: Response, settings: Settings, *, token: str, csrf_token: str, max_age: int) -> None:
    common = dict(
        domain=settings.session_cookie_domain or None,
        secure=settings.cookie_secure,
        samesite=settings.session_cookie_samesite,
        path="/",
        max_age=max_age,
    )
    response.set_cookie(settings.session_cookie_name, token, httponly=True, **common)
    # NOT httpOnly — the frontend adapter reads this and echoes it back as a
    # header (see dependencies.require_csrf). That is the entire mechanism;
    # it is safe specifically because it is readable only same-origin.
    response.set_cookie(settings.csrf_cookie_name, csrf_token, httponly=False, **common)


def _clear_session_cookies(response: Response, settings: Settings) -> None:
    for name in (settings.session_cookie_name, settings.csrf_cookie_name):
        response.delete_cookie(name, domain=settings.session_cookie_domain or None, path="/")


@router.post("/register", response_model=AuthResponse)
async def register(
    payload: RegisterRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> AuthResponse:
    key = _client_key(request)
    limiter = _get_register_limiter(settings)
    if not limiter.check(key) or not limiter.check(f"email:{payload.email.lower()}"):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="too many attempts")
    try:
        user = await register_user(
            db, settings, email=payload.email, password=payload.password, display_name=payload.display_name
        )
    except EmailAlreadyRegistered as exc:
        # 409, not a generic 400 — signup DOES need to tell a farmer their
        # address is already registered so they know to log in instead
        # (matches the existing auth-errors.js frontend message). This is
        # the one deliberate exception to "do not disclose account
        # existence" (Phase 5): a *login* failure never says which of
        # email/password was wrong, but a duplicate *signup* honestly must.
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="email already registered") from exc
    except AuthError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    if settings.require_email_verification and not user.email_verified:
        await db.commit()
        # No session yet — the frontend shows 確認メールを送信しました and asks
        # the farmer to log in again after confirming, exactly like the
        # existing Supabase-backed flow (see auth-controller.js's handling of
        # needsEmailConfirmation).
        return AuthResponse(user=None, needs_email_confirmation=True)

    new_session = await create_session(db, settings, user=user, user_agent=request.headers.get("user-agent"))
    await db.commit()
    _set_session_cookies(
        response, settings, token=new_session.token, csrf_token=new_session.csrf_token,
        max_age=settings.session_ttl_days * 86400,
    )
    return AuthResponse(user=UserOut(id=user.id, email=user.email, email_verified=user.email_verified,
                                      display_name=payload.display_name.strip()))


@router.post("/login", response_model=AuthResponse)
async def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> AuthResponse:
    key = _client_key(request)
    limiter = _get_login_limiter(settings)
    if not limiter.check(key) or not limiter.check(f"email:{payload.email.lower()}"):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="too many attempts")
    try:
        user = await authenticate(db, email=payload.email, password=payload.password)
    except (InvalidCredentials, AccountDisabled) as exc:
        # Same generic message either way — see authenticate()'s own comment.
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid email or password") from exc

    if not user.email_verified and settings.require_email_verification:
        await db.commit()
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="email not confirmed")

    new_session = await create_session(db, settings, user=user, user_agent=request.headers.get("user-agent"))
    profile = await db.get(Profile, user.id)
    await db.commit()
    _set_session_cookies(
        response, settings, token=new_session.token, csrf_token=new_session.csrf_token,
        max_age=settings.session_ttl_days * 86400,
    )
    return AuthResponse(user=UserOut(id=user.id, email=user.email, email_verified=user.email_verified,
                                      display_name=(profile.display_name if profile else "")))


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    request: Request,
    response: Response,
    user: User = Depends(require_csrf),
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> Response:
    token = getattr(request.state, "session_token", None)
    if token:
        await revoke_session(db, token=token)
        await db.commit()
    _clear_session_cookies(response, settings)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/me", response_model=AuthResponse)
async def me(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)) -> AuthResponse:
    profile = await db.get(Profile, user.id)
    return AuthResponse(
        user=UserOut(
            id=user.id, email=user.email, email_verified=user.email_verified,
            display_name=(profile.display_name if profile else ""),
        )
    )
