"""/api/profile — the signed-in farmer's own display name.

Keyed by user_id = the authenticated user's own id; there is no id in the
request path at all, so there is no ownership check to get wrong here.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..dependencies import get_current_user, require_csrf
from ..models.db import Profile, User
from ..models.schemas import ProfileOut, ProfileUpsert

router = APIRouter(prefix="/api/profile", tags=["profile"])


@router.get("", response_model=ProfileOut)
async def get_profile(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    profile = await db.get(Profile, user.id)
    if profile is None:
        # Created at registration (see auth/service.py:register_user); a
        # missing row here means something else deleted it out of band.
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="profile not found")
    return profile


@router.put("", response_model=ProfileOut)
async def upsert_profile(
    payload: ProfileUpsert, user: User = Depends(require_csrf), db: AsyncSession = Depends(get_db)
):
    profile = await db.get(Profile, user.id)
    if profile is None:
        profile = Profile(user_id=user.id, display_name=payload.display_name.strip())
        db.add(profile)
    else:
        profile.display_name = payload.display_name.strip()
    await db.flush()
    await db.refresh(profile)
    return profile
