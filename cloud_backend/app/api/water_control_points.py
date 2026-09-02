"""/api/water-control-points — 水門/給水口/排水口/水位センサ/撮影地点.

Same ownership/CSRF/bulk-upsert shape as api/fields.py — see that file's
module docstring for the reasoning, not repeated here.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..dependencies import get_current_user, require_csrf
from ..models.db import User, WaterControlPoint
from ..models.schemas import BulkDeleteRequest, WaterControlPointOut, WaterControlPointUpsert

router = APIRouter(prefix="/api/water-control-points", tags=["water-control-points"])


@router.get("", response_model=list[WaterControlPointOut])
async def list_points(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    rows = await db.scalars(
        select(WaterControlPoint).where(WaterControlPoint.owner_id == user.id).order_by(WaterControlPoint.created_at)
    )
    return list(rows)


@router.post("", response_model=list[WaterControlPointOut])
async def upsert_points(
    payload: list[WaterControlPointUpsert],
    user: User = Depends(require_csrf),
    db: AsyncSession = Depends(get_db),
):
    if not payload:
        return []
    results: list[WaterControlPoint] = []
    for item in payload:
        values = item.model_dump(exclude={"id"})
        values["owner_id"] = user.id
        if item.id is not None:
            existing = await db.scalar(
                select(WaterControlPoint).where(WaterControlPoint.id == item.id, WaterControlPoint.owner_id == user.id)
            )
            if existing is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"point {item.id} not found")
            for key, value in values.items():
                setattr(existing, key, value)
            results.append(existing)
            continue
        stmt = (
            pg_insert(WaterControlPoint)
            .values(id=uuid.uuid4(), **values)
            .on_conflict_do_update(constraint="uq_water_points_owner_legacy_id", set_=values)
            .returning(WaterControlPoint)
        )
        row = (await db.execute(stmt)).scalar_one()
        results.append(row)
    await db.flush()
    for row in results:
        await db.refresh(row)
    return results


@router.post("/delete", status_code=status.HTTP_204_NO_CONTENT)
async def delete_points(
    payload: BulkDeleteRequest, user: User = Depends(require_csrf), db: AsyncSession = Depends(get_db)
):
    if not payload.ids:
        return
    await db.execute(
        WaterControlPoint.__table__.delete().where(
            WaterControlPoint.id.in_(payload.ids), WaterControlPoint.owner_id == user.id
        )
    )
