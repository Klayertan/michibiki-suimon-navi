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

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, model_validator

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


#: A normalized pilot axis. Pydantic rejects anything outside -1..+1 at the
#: API boundary, before any handler runs, so an out-of-range value can never
#: reach the calibrated PWM conversion. NaN/inf are rejected too (Pydantic's
#: ``allow_inf_nan=False``), because a non-finite stick value would be a
#: genuinely dangerous thing to hand an autopilot.
PilotAxis = Annotated[float, Field(ge=-1.0, le=1.0, allow_inf_nan=False)]


class PilotInputRequest(StrictModel):
    """Body for ``POST /api/drone/pilot/input``.

    Four normalized axes from the browser's pilot provider. The browser never
    sends a speed, a MAVLink frame, or a message name -- only intent between
    -1 and +1. Limits and units are applied server-side in
    :mod:`app.mavlink.pilot_limits`.
    """

    #: +1 forward, -1 backward (Arrow Up / Arrow Down).
    pitch: PilotAxis | None = None
    #: +1 right, -1 left (Arrow Right / Arrow Left).
    roll: PilotAxis | None = None
    #: Common throttle/climb intent, centred at zero.
    throttle: PilotAxis | None = None
    #: +1 yaw right, -1 yaw left (D / A).
    yaw: PilotAxis = 0.0
    #: Space, blur, tab-hidden: release the override regardless of the axes.
    neutral: StrictBool = False
    #: Dead-man state from the selected provider. Required on every active
    #: manual frame in both normal and bench modes.
    deadman: StrictBool = False
    #: Provider diagnostic only; backend safety does not trust button indexes.
    source: Annotated[str, Field(min_length=1, max_length=64)] = "keyboard"
    #: Concrete provider implementation identity. ``mock`` is simulator-only
    #: and cannot produce active output when the backend is in real mode.
    provider: Literal["keyboard", "browser", "mock", "gamepad", "unknown"] | None = None
    #: Monotonic client sequence. Delayed or replayed values are rejected by
    #: PilotService so an older movement request cannot overtake a panic stop.
    sequence: Annotated[StrictInt, Field(ge=0, le=9_007_199_254_740_991)]

    # Compatibility input names used by the previous browser contract. They
    # are resolved once here; snapshots and all downstream code remain
    # canonical pitch/roll/throttle/yaw.
    forward: PilotAxis | None = None
    right: PilotAxis | None = None
    up: PilotAxis | None = None

    @model_validator(mode="after")
    def resolve_legacy_axes(self) -> "PilotInputRequest":
        pairs = (
            ("pitch", "forward"),
            ("roll", "right"),
            ("throttle", "up"),
        )
        for canonical_name, legacy_name in pairs:
            canonical = getattr(self, canonical_name)
            legacy = getattr(self, legacy_name)
            if canonical is not None and legacy is not None and canonical != legacy:
                raise ValueError(
                    f"{canonical_name} and legacy alias {legacy_name} disagree"
                )
            setattr(self, canonical_name, 0.0 if canonical is None and legacy is None else (
                legacy if canonical is None else canonical
            ))
        return self


class PilotNeutralRequest(StrictModel):
    """Sequence barrier for the legacy explicit-neutral endpoint."""

    sequence: Annotated[StrictInt, Field(ge=0, le=9_007_199_254_740_991)]


class ArmDisarmRequest(StrictModel):
    """Explicit operator action required by ARM and DISARM endpoints."""

    confirmed: Literal[True]


class PilotBenchEnableRequest(StrictModel):
    """Body for ``POST /api/drone/pilot/bench/enable``.

    ``propsRemovedAck`` must be exactly ``true`` -- Pydantic's ``Literal[True]``
    rejects ``false``, an omitted field, or any other value, so the operator's
    propellers-removed confirmation cannot be defaulted or silently skipped by
    a caller. The backend still cannot verify propellers are physically off;
    this only makes the confirmation mandatory at the API boundary.
    """

    propsRemovedAck: Literal[True]


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
