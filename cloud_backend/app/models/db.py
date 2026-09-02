"""SQLAlchemy ORM models.

Ownership model
----------------
There is no database-level Row Level Security here (that was Supabase's
mechanism, driven by ``auth.uid()`` inside Postgres itself — see
supabase/migrations/001_accounts_fields.sql for the system this replaces).
Without a hosted auth/JWT layer feeding the database session, the equivalent
boundary is enforced entirely at the APPLICATION layer instead: every
service-layer query in ``app/services/`` filters explicitly by
``owner_id == current_user.id``, and ``owner_id`` is NEVER accepted from a
request body — it is always taken from the authenticated session. See
docs/AUTH_ARCHITECTURE.md — "Multi-user isolation" for the full argument and
the test suite (``tests/test_multi_user_isolation.py``) that exercises it the
same way ``supabase/tests/rls_verification.sql`` did for the old system.

Each user-owned table keeps the device's own record verbatim in a ``record``
JSONB column, exactly like the Supabase schema did — the frontend
reconstructs a local record from ``record`` and never from the individual
columns, so this stays a drop-in replacement for the sync service's existing
expectations (see js/cloud/field-sync-core.js).
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    String,
    TypeDecorator,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..database import Base

JSONType = JSONB().with_variant(JSON(), "sqlite")


class UTCDateTime(TypeDecorator):
    """DateTime(timezone=True) that is actually tz-aware on every dialect.

    PostgreSQL (the production database) round-trips ``timestamptz`` as
    aware UTC datetimes already, so this is a no-op there. SQLite (the test
    suite's database — see cloud_backend/tests/conftest.py) has no native
    timezone-aware storage: a value written through here is always UTC (rows
    are only ever written with ``datetime.now(timezone.utc)`` or
    ``func.now()``, which SQLite compiles to ``CURRENT_TIMESTAMP``, itself
    UTC) but comes back naive, which made session-expiry comparisons in
    auth/service.py raise ``TypeError: can't compare offset-naive and
    offset-aware datetimes`` under SQLite. Re-attaching UTC on the way out
    (and on the way in, for symmetry) fixes that without touching any
    call site or changing production behavior at all.
    """

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is not None and value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value

    def process_result_value(self, value, dialect):
        if value is not None and value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value


def _uuid_pk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = _uuid_pk()
    # Stored lowercased/trimmed (see app/security.py normalize_email) so
    # "Farmer@Example.com" and "farmer@example.com" are the same account —
    # the unique index below is what actually enforces that at the DB level.
    email: Mapped[str] = mapped_column(String(320), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    email_verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime, server_default=func.now(), onupdate=func.now()
    )

    profile: Mapped["Profile"] = relationship(back_populates="user", uselist=False, cascade="all, delete-orphan")

    __table_args__ = (Index("ix_users_email_unique", "email", unique=True),)


class Session(Base):
    __tablename__ = "sessions"

    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    # SHA-256 of the opaque bearer token that lives in the cookie. The
    # plaintext token is never stored — see app/security.py. A stolen
    # database backup therefore cannot be replayed as a live session.
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, server_default=func.now())
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    last_seen_at: Mapped[datetime] = mapped_column(UTCDateTime, server_default=func.now())
    user_agent: Mapped[str | None] = mapped_column(String(512), nullable=True)
    # The double-submit CSRF value minted alongside this session (see
    # app/security.py). Rotated whenever the session is; never sent to the
    # client except as the readable csrf cookie set at the same time.
    csrf_token: Mapped[str] = mapped_column(String(64), nullable=False)

    __table_args__ = (
        Index("ix_sessions_token_hash_unique", "token_hash", unique=True),
        Index("ix_sessions_user_id", "user_id"),
    )


class Profile(Base):
    __tablename__ = "profiles"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    display_name: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime, server_default=func.now(), onupdate=func.now()
    )

    user: Mapped["User"] = relationship(back_populates="profile")


class Field(Base):
    __tablename__ = "fields"

    id: Mapped[uuid.UUID] = _uuid_pk()
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    legacy_field_id: Mapped[str] = mapped_column(String(200), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    area_m2: Mapped[float | None] = mapped_column(Float, nullable=True)
    source_nmea_filename: Mapped[str | None] = mapped_column(String(300), nullable=True)
    boundary: Mapped[list] = mapped_column(JSONType, nullable=False, default=list)
    record: Mapped[dict] = mapped_column(JSONType, nullable=False, default=dict)
    local_updated_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        # The load-bearing constraint for Phase 4/8: two different owners can
        # both use legacy_field_id "paddy-001" without colliding, because the
        # uniqueness is scoped to (owner_id, legacy_field_id), not to
        # legacy_field_id alone. See tests/test_multi_user_isolation.py.
        UniqueConstraint("owner_id", "legacy_field_id", name="uq_fields_owner_legacy_id"),
        Index("ix_fields_owner_id", "owner_id"),
    )


class WaterControlPoint(Base):
    __tablename__ = "water_control_points"

    id: Mapped[uuid.UUID] = _uuid_pk()
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    # Nullable: the device's own record links by relatedFieldId, which may
    # legitimately be null, and a point must not be lost because its field
    # has not been uploaded yet (same reasoning as the Supabase schema).
    field_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("fields.id", ondelete="CASCADE"), nullable=True
    )
    legacy_point_id: Mapped[str] = mapped_column(String(200), nullable=False)
    legacy_field_id: Mapped[str | None] = mapped_column(String(200), nullable=True)
    point_type: Mapped[str] = mapped_column(String(64), nullable=False)
    lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    lon: Mapped[float | None] = mapped_column(Float, nullable=True)
    record: Mapped[dict] = mapped_column(JSONType, nullable=False, default=dict)
    local_updated_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        UniqueConstraint("owner_id", "legacy_point_id", name="uq_water_points_owner_legacy_id"),
        Index("ix_water_points_owner_id", "owner_id"),
        Index("ix_water_points_field_id", "field_id"),
    )


class FieldObservation(Base):
    __tablename__ = "field_observations"

    id: Mapped[uuid.UUID] = _uuid_pk()
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    field_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("fields.id", ondelete="CASCADE"), nullable=True
    )
    legacy_observation_id: Mapped[str] = mapped_column(String(200), nullable=False)
    legacy_field_id: Mapped[str | None] = mapped_column(String(200), nullable=True)
    observation_type: Mapped[str] = mapped_column(String(64), nullable=False)
    severity: Mapped[str | None] = mapped_column(String(32), nullable=True)
    lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    lon: Mapped[float | None] = mapped_column(Float, nullable=True)
    record: Mapped[dict] = mapped_column(JSONType, nullable=False, default=dict)
    local_updated_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        UniqueConstraint("owner_id", "legacy_observation_id", name="uq_observations_owner_legacy_id"),
        Index("ix_observations_owner_id", "owner_id"),
        Index("ix_observations_field_id", "field_id"),
    )


class FieldWaterTarget(Base):
    __tablename__ = "field_water_targets"

    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    legacy_field_id: Mapped[str] = mapped_column(String(200), primary_key=True)
    field_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("fields.id", ondelete="CASCADE"), nullable=True
    )
    target_water_level_cm: Mapped[float | None] = mapped_column(Float, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime, server_default=func.now(), onupdate=func.now()
    )
