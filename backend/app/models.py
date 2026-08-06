"""Pydantic request/response models.

Request models use ``extra="forbid"`` so an unexpected field is a 422 rather
than being silently dropped. That matters here: a request carrying an
unrecognised key is a sign the caller believes it is asking for something this
API does not do, and answering "OK" to it would be misleading.

Response models are intentionally loose (``dict``) for the telemetry tree,
because the tree is built by
:meth:`~app.mavlink.telemetry_state.TelemetryState.snapshot` and duplicating
its shape here would create a second thing to keep in sync.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .config import ALLOWED_DISARMED_MODES
from .mavlink.constants import REQUESTABLE_STREAMS

#: Only these two literals are accepted. A numeric mode ID, or any other mode
#: name, fails validation at the API boundary and never reaches the vehicle.
AllowedMode = Literal["STABILIZE", "ALT_HOLD"]
AllowedStream = Literal["ATTITUDE", "GLOBAL_POSITION_INT", "GPS_RAW_INT", "SYS_STATUS", "VFR_HUD"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ConnectRequest(StrictModel):
    """Body for ``POST /api/drone/connect``. All fields optional."""

    #: Operator confirmation that propellers are off the aircraft. The backend
    #: never assumes this; in real mode a connection is refused without it
    #: unless the requirement is explicitly disabled in configuration.
    propellersRemoved: bool = False


class ModeRequest(StrictModel):
    """Body for ``POST /api/drone/mode``."""

    mode: AllowedMode
    #: Frontends must set this for a real-mode change, mirroring the
    #: confirmation dialog the operator saw. It is a second, server-side check
    #: that a mode change was intentional.
    confirmed: bool = False


class StreamRequest(StrictModel):
    """Body for ``POST /api/drone/request-streams``."""

    streams: Annotated[list[AllowedStream], Field(max_length=len(REQUESTABLE_STREAMS))] | None = None


class HealthResponse(BaseModel):
    status: Literal["ok"]
    version: str
    mode: str
    linkRunning: bool


class CommandResponse(BaseModel):
    ok: bool
    reason: str
    message: str
    detail: dict[str, Any] = Field(default_factory=dict)


class ConfigResponse(BaseModel):
    """Effective configuration, plus the fixed safety facts about this build."""

    config: dict[str, Any]
    allowedModes: list[str] = Field(default_factory=lambda: list(ALLOWED_DISARMED_MODES))
    allowedStreams: list[str] = Field(default_factory=lambda: sorted(REQUESTABLE_STREAMS))
    disabledOperations: dict[str, str]


class ErrorResponse(BaseModel):
    ok: Literal[False] = False
    reason: str
    message: str
    detail: dict[str, Any] = Field(default_factory=dict)
