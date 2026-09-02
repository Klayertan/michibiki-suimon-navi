"""/api/fields — CRUD scoped to the authenticated user.

Every query below is filtered by ``Field.owner_id == user.id``. That
condition is not optional decoration: it is the entire multi-user isolation
boundary now that there is no database-level RLS (see models/db.py's module
docstring). ``owner_id`` is never read from the request body — the upsert
schema does not even have that field (see models/schemas.py's FieldUpsert) —
so there is no payload shape that could claim another farmer's rows.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..dependencies import get_current_user, require_csrf
from ..models.db import Field, User
from ..models.schemas import BulkDeleteRequest, FieldOut, FieldUpsert

router = APIRouter(prefix="/api/fields", tags=["fields"])


@router.get("", response_model=list[FieldOut])
async def list_fields(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    rows = await db.scalars(select(Field).where(Field.owner_id == user.id).order_by(Field.created_at))
    return list(rows)


@router.get("/{field_id}", response_model=FieldOut)
async def get_field(field_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    row = await db.scalar(select(Field).where(Field.id == field_id, Field.owner_id == user.id))
    if row is None:
        # 404, never 403: confirming "this id exists but isn't yours" is
        # exactly the information leak RLS's USING clause was built to deny
        # (see the Supabase migration's own comment on this). A row that
        # belongs to another owner must look identical to a row that does
        # not exist.
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="field not found")
    return row


@router.post("", response_model=list[FieldOut])
async def upsert_fields(
    payload: list[FieldUpsert], user: User = Depends(require_csrf), db: AsyncSession = Depends(get_db)
):
    """Bulk upsert, matching js/cloud/field-sync-core.js's per-collection
    batch shape (SupabaseCloudStore.upsertFields(rows)) rather than a
    one-row-at-a-time REST convention — see docs/AUTH_ARCHITECTURE.md's API
    section for why."""
    if not payload:
        return []
    results: list[Field] = []
    for item in payload:
        values = item.model_dump(exclude={"id"})
        values["owner_id"] = user.id
        if item.id is not None:
            # Ownership re-checked here too, not just implied by the
            # conflict target: an id that exists but belongs to someone else
            # must not silently adopt this owner_id via ON CONFLICT.
            existing = await db.scalar(select(Field).where(Field.id == item.id, Field.owner_id == user.id))
            if existing is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"field {item.id} not found")
            for key, value in values.items():
                setattr(existing, key, value)
            results.append(existing)
            continue
        stmt = (
            pg_insert(Field)
            .values(id=uuid.uuid4(), **values)
            .on_conflict_do_update(
                constraint="uq_fields_owner_legacy_id",
                set_=values,
            )
            .returning(Field)
        )
        row = (await db.execute(stmt)).scalar_one()
        results.append(row)
    await db.flush()
    for row in results:
        await db.refresh(row)
    return results


@router.post("/delete", status_code=status.HTTP_204_NO_CONTENT)
async def delete_fields(
    payload: BulkDeleteRequest, user: User = Depends(require_csrf), db: AsyncSession = Depends(get_db)
):
    if not payload.ids:
        return
    await db.execute(
        Field.__table__.delete().where(Field.id.in_(payload.ids), Field.owner_id == user.id)
    )
