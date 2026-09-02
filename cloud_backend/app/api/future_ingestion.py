"""Phase 8 — namespaces reserved for future GNSS/sensor/drone-telemetry
ingestion. Not overbuilt: no database tables exist for these yet, so every
route here validates its input shape and returns 501, rather than silently
accepting data it cannot actually store or pretending success. Wiring real
persistence is future work, once an actual data shape is needed.

DRONE SAFETY BOUNDARY — READ BEFORE ADDING ANYTHING TO drone_router.
=====================================================================
This module, and everything under /api/drone, is INGESTION-ONLY by design
and must stay that way:

  - POST /api/drone/telemetry accepts a read-only telemetry snapshot a field
    computer chooses to upload. It has no ability to reach a vehicle.
  - There is deliberately no route here for arm, disarm, takeoff, land, RTL,
    a flight-mode change, RC override, a motor test, a mission upload, or a
    parameter write. None of those concepts appear in this file at all.
  - This cloud API has no network path to a Pixhawk. The serial MAVLink
    connection is owned exclusively by backend/app/mavlink/ on the local
    field computer (see backend/README.md and docs/AUTH_ARCHITECTURE.md's
    "Security boundary" section) — that module is not imported here, not
    deployed to the same host as this API, and not reachable from it.
  - If a future change adds a route that could cause a vehicle to move,
    arm, or change mode, it does not belong in this file, this backend, or
    this deployment target — see docs/SAKURA_CLOUD_BACKEND.md.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from ..dependencies import require_csrf
from ..models.db import User

gnss_router = APIRouter(prefix="/api/gnss", tags=["gnss (reserved)"])
sensors_router = APIRouter(prefix="/api/sensors", tags=["sensors (reserved)"])
drone_router = APIRouter(prefix="/api/drone", tags=["drone telemetry (ingestion-only)"])

_NOT_IMPLEMENTED = "reserved for future work — validated but not yet persisted, see cloud_backend/app/api/future_ingestion.py"


class GnssSessionCreate(BaseModel):
    legacy_field_id: str | None = None
    started_at: datetime
    source_filename: str | None = None
    metadata: dict[str, Any] = {}


class GnssObservationCreate(BaseModel):
    session_id: str
    lat: float
    lon: float
    fix_quality: int | None = None
    recorded_at: datetime


class WaterLevelSensorReading(BaseModel):
    legacy_field_id: str
    level_cm: float
    recorded_at: datetime
    sensor_id: str | None = None


class DroneTelemetrySnapshot(BaseModel):
    """Read-only. Whatever the local backend/app/mavlink stack already
    normalizes for its own UI (see backend/app/mavlink/normalizers.py) is the
    intended shape here once this is wired up — this endpoint receives a
    copy of that state for storage, never a command headed the other way."""

    legacy_field_id: str | None = None
    recorded_at: datetime
    lat: float | None = None
    lon: float | None = None
    altitude_m: float | None = None
    battery_percent: float | None = None
    armed: bool | None = None
    flight_mode: str | None = None


@gnss_router.post("/sessions", status_code=status.HTTP_501_NOT_IMPLEMENTED)
async def create_gnss_session(payload: GnssSessionCreate, user: User = Depends(require_csrf)):
    raise HTTPException(status_code=status.HTTP_501_NOT_IMPLEMENTED, detail=_NOT_IMPLEMENTED)


@gnss_router.post("/observations", status_code=status.HTTP_501_NOT_IMPLEMENTED)
async def create_gnss_observation(payload: GnssObservationCreate, user: User = Depends(require_csrf)):
    raise HTTPException(status_code=status.HTTP_501_NOT_IMPLEMENTED, detail=_NOT_IMPLEMENTED)


@sensors_router.post("/water-level", status_code=status.HTTP_501_NOT_IMPLEMENTED)
async def create_water_level_reading(payload: WaterLevelSensorReading, user: User = Depends(require_csrf)):
    raise HTTPException(status_code=status.HTTP_501_NOT_IMPLEMENTED, detail=_NOT_IMPLEMENTED)


@drone_router.post("/telemetry", status_code=status.HTTP_501_NOT_IMPLEMENTED)
async def ingest_drone_telemetry(payload: DroneTelemetrySnapshot, user: User = Depends(require_csrf)):
    """Ingestion only — see this module's docstring. There is not, and must
    never be, a corresponding control endpoint."""
    raise HTTPException(status_code=status.HTTP_501_NOT_IMPLEMENTED, detail=_NOT_IMPLEMENTED)
