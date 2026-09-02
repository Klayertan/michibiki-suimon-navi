"""/api/field-water-targets — composite-keyed (owner_id, legacy_field_id).

No delete endpoint and no cloud `id`: matches SupabaseCloudStore's own
listWaterTargets()/upsertWaterTargets(rows) exactly — a target is cleared by
upserting a null target_water_level_cm, never removed as a row (see
models/schemas.py's FieldWaterTargetUpsert).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..dependencies import get_current_user, require_csrf
from ..models.db import FieldWaterTarget, User
from ..models.schemas import FieldWaterTargetOut, FieldWaterTargetUpsert

router = APIRouter(prefix="/api/field-water-targets", tags=["field-water-targets"])


@router.get("", response_model=list[FieldWaterTargetOut])
async def list_targets(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    rows = await db.scalars(select(FieldWaterTarget).where(FieldWaterTarget.owner_id == user.id))
    return list(rows)


@router.post("", response_model=list[FieldWaterTargetOut])
async def upsert_targets(
    payload: list[FieldWaterTargetUpsert],
    user: User = Depends(require_csrf),
    db: AsyncSession = Depends(get_db),
):
    if not payload:
        return []
    results: list[FieldWaterTarget] = []
    for item in payload:
        values = item.model_dump()
        values["owner_id"] = user.id
        stmt = (
            pg_insert(FieldWaterTarget)
            .values(**values)
            .on_conflict_do_update(
                index_elements=[FieldWaterTarget.owner_id, FieldWaterTarget.legacy_field_id],
                set_=values,
            )
            .returning(FieldWaterTarget)
        )
        row = (await db.execute(stmt)).scalar_one()
        results.append(row)
    await db.flush()
    return results
