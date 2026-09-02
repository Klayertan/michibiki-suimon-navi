"""Pydantic request/response schemas.

Field names on the *Upsert* models below are chosen to match
js/cloud/field-sync-core.js's ``fieldToCloudRow`` / ``waterControlPointToCloudRow``
/ ``observationToCloudRow`` byte-for-byte (same keys, same optionality) — the
frontend adapter (js/cloud/sakura-cloud-store.js) sends these rows unchanged
from what the existing sync service already builds, so this API is a drop-in
replacement target for SupabaseCloudStore's contract, not a new one the
frontend has to be redesigned around.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str
    display_name: str = ""

    @field_validator("password")
    @classmethod
    def _min_length(cls, value: str) -> str:
        # The authoritative minimum is enforced again in the service layer
        # against Settings.min_password_length; this is the fast, cheap
        # rejection before a password ever reaches Argon2.
        if len(value) < 8:
            raise ValueError("password must be at least 8 characters")
        return value


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    email_verified: bool
    display_name: str = ""


class AuthResponse(BaseModel):
    user: UserOut | None = None
    needs_email_confirmation: bool = False


# ---------------------------------------------------------------------------
# Fields
# ---------------------------------------------------------------------------


class FieldUpsert(BaseModel):
    # Present (a cloud UUID) when updating an existing row; absent/None for a
    # brand-new one, exactly like fieldToCloudRow's `id: cloudId || undefined`.
    id: uuid.UUID | None = None
    legacy_field_id: str
    name: str = ""
    area_m2: float | None = None
    source_nmea_filename: str | None = None
    boundary: list[Any] = Field(default_factory=list)
    record: dict[str, Any] = Field(default_factory=dict)
    local_updated_at: datetime | None = None


class FieldOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    legacy_field_id: str
    name: str
    area_m2: float | None
    source_nmea_filename: str | None
    boundary: list[Any]
    record: dict[str, Any]
    local_updated_at: datetime | None
    created_at: datetime
    updated_at: datetime


class BulkDeleteRequest(BaseModel):
    ids: list[uuid.UUID]


# ---------------------------------------------------------------------------
# Water control points
# ---------------------------------------------------------------------------


class WaterControlPointUpsert(BaseModel):
    id: uuid.UUID | None = None
    field_id: uuid.UUID | None = None
    legacy_point_id: str
    legacy_field_id: str | None = None
    point_type: str
    lat: float | None = None
    lon: float | None = None
    record: dict[str, Any] = Field(default_factory=dict)
    local_updated_at: datetime | None = None


class WaterControlPointOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    field_id: uuid.UUID | None
    legacy_point_id: str
    legacy_field_id: str | None
    point_type: str
    lat: float | None
    lon: float | None
    record: dict[str, Any]
    local_updated_at: datetime | None
    created_at: datetime
    updated_at: datetime


# ---------------------------------------------------------------------------
# Field observations
# ---------------------------------------------------------------------------


class FieldObservationUpsert(BaseModel):
    id: uuid.UUID | None = None
    field_id: uuid.UUID | None = None
    legacy_observation_id: str
    legacy_field_id: str | None = None
    observation_type: str
    severity: str | None = None
    lat: float | None = None
    lon: float | None = None
    record: dict[str, Any] = Field(default_factory=dict)
    local_updated_at: datetime | None = None


class FieldObservationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    field_id: uuid.UUID | None
    legacy_observation_id: str
    legacy_field_id: str | None
    observation_type: str
    severity: str | None
    lat: float | None
    lon: float | None
    record: dict[str, Any]
    local_updated_at: datetime | None
    created_at: datetime
    updated_at: datetime


# ---------------------------------------------------------------------------
# Field water targets — composite-keyed (owner_id, legacy_field_id), no
# separate cloud id and no delete endpoint, matching the Supabase-era
# contract's own upsertWaterTargets()/listWaterTargets() shape exactly (a
# target is cleared by upserting a null value, never deleted as a row).
# ---------------------------------------------------------------------------


class FieldWaterTargetUpsert(BaseModel):
    legacy_field_id: str
    field_id: uuid.UUID | None = None
    target_water_level_cm: float | None = None


class FieldWaterTargetOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    legacy_field_id: str
    field_id: uuid.UUID | None
    target_water_level_cm: float | None
    updated_at: datetime


# ---------------------------------------------------------------------------
# Profile
# ---------------------------------------------------------------------------


class ProfileUpsert(BaseModel):
    display_name: str = ""


class ProfileOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    user_id: uuid.UUID
    display_name: str
    created_at: datetime
    updated_at: datetime


# ---------------------------------------------------------------------------
# Misc
# ---------------------------------------------------------------------------


class HealthResponse(BaseModel):
    status: str = "ok"
    environment: str
