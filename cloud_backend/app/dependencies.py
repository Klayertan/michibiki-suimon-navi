"""FastAPI dependencies: session authentication and CSRF enforcement.

Two separate dependencies rather than one, so a route can opt into exactly
what it needs:

- ``get_current_user``       any authenticated request (GET included).
- ``require_csrf``            layered on top, for state-changing requests
                               only (POST/PUT/DELETE). Read requests do not
                               need CSRF protection — there is nothing for a
                               forged GET to change.
"""

from __future__ import annotations

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from .auth.service import SessionInvalid, resolve_session
from .config import Settings, get_settings
from .database import get_db
from .models.db import User
from .security import constant_time_equals


async def get_current_user(
    request: Request,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> User:
    token = request.cookies.get(settings.session_cookie_name)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="not authenticated")
    try:
        user, session = await resolve_session(db, token=token)
    except SessionInvalid as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="session expired or invalid") from exc
    # Stashed on request.state so require_csrf below (and the logout route,
    # which needs the raw token to revoke the right row) do not have to
    # resolve the session a second time.
    request.state.session = session
    request.state.session_token = token
    return user


async def require_csrf(
    request: Request,
    user: User = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> User:
    """Double-submit cookie check: the csrf cookie (readable by JS) must match
    the X-Suisui-Csrf header the frontend adapter copies it into. A
    cross-site form post or an attacker page issuing fetch() with
    credentials:"include" can make the session cookie ride along
    automatically, but it cannot read the csrf cookie's value (blocked by
    Same-Origin Policy) to also send as a matching header — so it cannot
    construct a request this check accepts.
    """
    session = getattr(request.state, "session", None)
    if session is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="not authenticated")
    header_value = request.headers.get(settings.csrf_header_name, "")
    if not header_value or not constant_time_equals(header_value, session.csrf_token):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="csrf token missing or invalid")
    return user
