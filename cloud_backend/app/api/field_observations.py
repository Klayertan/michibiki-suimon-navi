"""/api/field-observations — 現地観察メモ (雑草/害虫/病気/水不足 …).

Same ownership/CSRF/bulk-upsert shape as api/fields.py.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..dependencies import get_current_user, require_csrf
from ..models.db import FieldObservation, User
from ..models.schemas import BulkDeleteRequest, FieldObservationOut, FieldObservationUpsert

router = APIRouter(prefix="/api/field-observations", tags=["field-observations"])


@router.get("", response_model=list[FieldObservationOut])
async def list_observations(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    rows = await db.scalars(
        select(FieldObservation).where(FieldObservation.owner_id == user.id).order_by(FieldObservation.created_at)
    )
    return list(rows)


@router.post("", response_model=list[FieldObservationOut])
async def upsert_observations(
    payload: list[FieldObservationUpsert],
    user: User = Depends(require_csrf),
    db: AsyncSession = Depends(get_db),
):
    if not payload:
        return []
    results: list[FieldObservation] = []
    for item in payload:
        values = item.model_dump(exclude={"id"})
        values["owner_id"] = user.id
        if item.id is not None:
            existing = await db.scalar(
                select(FieldObservation).where(
                    FieldObservation.id == item.id, FieldObservation.owner_id == user.id
                )
            )
            if existing is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"observation {item.id} not found")
            for key, value in values.items():
                setattr(existing, key, value)
            results.append(existing)
            continue
        stmt = (
            pg_insert(FieldObservation)
            .values(id=uuid.uuid4(), **values)
            .on_conflict_do_update(constraint="uq_observations_owner_legacy_id", set_=values)
            .returning(FieldObservation)
        )
        row = (await db.execute(stmt)).scalar_one()
        results.append(row)
    await db.flush()
    for row in results:
        await db.refresh(row)
    return results


@router.post("/delete", status_code=status.HTTP_204_NO_CONTENT)
async def delete_observations(
    payload: BulkDeleteRequest, user: User = Depends(require_csrf), db: AsyncSession = Depends(get_db)
):
    if not payload.ids:
        return
    await db.execute(
        FieldObservation.__table__.delete().where(
            FieldObservation.id.in_(payload.ids), FieldObservation.owner_id == user.id
        )
    )
