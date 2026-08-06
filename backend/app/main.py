"""FastAPI application: local-only REST + WebSocket surface for the drone link.

Network posture
---------------
The service binds ``127.0.0.1`` by default and allows only the SuisuiNavi dev
origins through CORS. It commands an aircraft; it is not a LAN service.

There is deliberately **no** endpoint that forwards an arbitrary MAVLink
message, command id, or mode number. Every command endpoint maps to one named
operation in :class:`~app.mavlink.command_service.CommandService`, and the
allowed modes and streams are ``Literal`` types validated by Pydantic before
any handler runs.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Callable

from fastapi import Body, FastAPI, Request, Response, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import __version__
from .config import MODE_MOCK, Settings, load_settings
from .logging_config import configure_logging
from .mavlink.command_service import DISABLED_OPERATIONS, CommandRejected, CommandService
from .mavlink.interface import LinkError, MavlinkLink, PortBusyError, PortNotFoundError
from .mavlink.link_manager import LinkBusyError, LinkManager
from .mavlink.mock_connection import MockMavlinkLink
from .models import (
    CommandResponse,
    ConfigResponse,
    ConnectRequest,
    HealthResponse,
    ModeRequest,
    StreamRequest,
)

logger = logging.getLogger(__name__)

LinkFactory = Callable[[], MavlinkLink]


def default_link_factory(settings: Settings) -> LinkFactory:
    """Choose the transport for ``settings.mode``.

    In mock mode nothing about the real link is even imported, so a machine
    without pymavlink or without the telemetry radio runs the full stack.
    """
    if settings.mode == MODE_MOCK:
        def build_mock() -> MavlinkLink:
            return MockMavlinkLink(
                target_system=settings.target_system,
                target_component=settings.target_component,
            )

        return build_mock

    def build_real() -> MavlinkLink:
        from .mavlink.real_connection import RealMavlinkLink  # noqa: PLC0415 - lazy on purpose

        return RealMavlinkLink(
            port=settings.port,
            baud=settings.baud,
            source_system=settings.source_system,
            source_component=settings.source_component,
            target_system=settings.target_system,
            target_component=settings.target_component,
        )

    return build_real


def _rejection_response(rejection: CommandRejected, http_status: int) -> JSONResponse:
    return JSONResponse(
        status_code=http_status,
        content={
            "ok": False,
            "reason": rejection.reason,
            "message": rejection.message,
            "detail": rejection.detail,
        },
    )


def create_app(settings: Settings | None = None, link_factory: LinkFactory | None = None) -> FastAPI:
    """Build the application.

    Args:
        settings: Overrides the environment-derived configuration. Tests use
            this to run entirely in mock mode with short timeouts.
        link_factory: Overrides the transport, so a test can inject a mock link
            it holds a reference to and drive scenarios through.

    Building the app does **not** connect. ``POST /api/drone/connect`` does.
    """
    resolved = settings or load_settings()
    configure_logging(resolved.log_level)

    factory = link_factory or default_link_factory(resolved)
    manager = LinkManager(resolved, factory)
    commands = CommandService(manager, resolved)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        logger.info(
            "SuisuiNavi MAVLink backend %s starting: mode=%s host=%s:%d safe_commands=%s",
            __version__,
            resolved.mode,
            resolved.host,
            resolved.http_port,
            resolved.allow_safe_commands,
        )
        if resolved.is_real:
            logger.warning(
                "REAL mode: this backend will open %s at %d baud. QGroundControl must be closed.",
                resolved.port,
                resolved.baud,
            )
        try:
            yield
        finally:
            # Stops the heartbeat and closes the serial port deterministically.
            await asyncio.to_thread(manager.shutdown)
            logger.info("SuisuiNavi MAVLink backend stopped")

    app = FastAPI(
        title="SuisuiNavi MAVLink backend",
        version=__version__,
        summary="Read-mostly MAVLink telemetry bridge for SuisuiNavi. No arming, no takeoff.",
        lifespan=lifespan,
    )
    app.state.manager = manager
    app.state.commands = commands
    app.state.settings = resolved

    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(resolved.allowed_origins),
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
        max_age=600,
    )

    @app.middleware("http")
    async def limit_request_size(request: Request, call_next: Any) -> Response:
        """Reject oversized bodies before they are buffered or parsed."""
        declared = request.headers.get("content-length")
        if declared is not None:
            try:
                length = int(declared)
            except ValueError:
                return JSONResponse(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    content={"ok": False, "reason": "bad_request", "message": "Invalid Content-Length header."},
                )
            if length > resolved.max_request_bytes:
                return JSONResponse(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    content={
                        "ok": False,
                        "reason": "payload_too_large",
                        "message": f"Request body exceeds {resolved.max_request_bytes} bytes.",
                    },
                )
        return await call_next(request)

    # ------------------------------------------------------------------
    # Read-only endpoints
    # ------------------------------------------------------------------

    @app.get("/api/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        return HealthResponse(
            status="ok",
            version=__version__,
            mode=resolved.mode,
            linkRunning=manager.is_running(),
        )

    @app.get("/api/drone/status")
    async def drone_status() -> dict[str, Any]:
        """Complete normalized state. Works in mock and real mode, connected or not."""
        return manager.snapshot()

    @app.get("/api/drone/config", response_model=ConfigResponse)
    async def drone_config() -> ConfigResponse:
        return ConfigResponse(
            config=resolved.public_dict(),
            disabledOperations=DISABLED_OPERATIONS,
        )

    # ------------------------------------------------------------------
    # Connection
    # ------------------------------------------------------------------

    @app.post("/api/drone/connect")
    async def drone_connect(body: ConnectRequest = Body(default=ConnectRequest())) -> Any:
        # Requirement: never assume propellers are off. In real mode the
        # operator must say so at runtime, per connection.
        if resolved.is_real and resolved.require_props_removed_ack and not body.propellersRemoved:
            return JSONResponse(
                status_code=status.HTTP_412_PRECONDITION_FAILED,
                content={
                    "ok": False,
                    "reason": "props_not_confirmed",
                    "message": (
                        "Real-mode connection refused: confirm the propellers are removed. "
                        "This backend never assumes it."
                    ),
                    "detail": {"required": "propellersRemoved"},
                },
            )
        try:
            snapshot = await asyncio.to_thread(manager.connect)
        except LinkBusyError as error:
            return JSONResponse(
                status_code=status.HTTP_409_CONFLICT,
                content={"ok": False, "reason": "already_connected", "message": str(error)},
            )
        except PortBusyError as error:
            return JSONResponse(
                status_code=status.HTTP_409_CONFLICT,
                content={"ok": False, "reason": "port_busy", "message": str(error)},
            )
        except PortNotFoundError as error:
            return JSONResponse(
                status_code=status.HTTP_404_NOT_FOUND,
                content={"ok": False, "reason": "port_not_found", "message": str(error)},
            )
        except LinkError as error:
            return JSONResponse(
                status_code=status.HTTP_502_BAD_GATEWAY,
                content={"ok": False, "reason": "link_error", "message": str(error)},
            )

        # connect() settles asynchronously; a failure inside the worker shows up
        # in the snapshot rather than as an exception, and must not be reported
        # as success.
        if snapshot.get("error") and not snapshot.get("connected"):
            return JSONResponse(
                status_code=status.HTTP_502_BAD_GATEWAY,
                content={
                    "ok": False,
                    "reason": "link_error",
                    "message": snapshot["error"]["message"],
                    "detail": {"status": snapshot},
                },
            )
        return {"ok": True, "reason": "connected", "message": "MAVLink link started.", "detail": {"status": snapshot}}

    @app.post("/api/drone/disconnect")
    async def drone_disconnect() -> dict[str, Any]:
        snapshot = await asyncio.to_thread(manager.disconnect)
        return {
            "ok": True,
            "reason": "disconnected",
            "message": "MAVLink link stopped and the port released.",
            "detail": {"status": snapshot},
        }

    # ------------------------------------------------------------------
    # Safe commands
    # ------------------------------------------------------------------

    @app.post("/api/drone/request-version", response_model=CommandResponse)
    async def request_version() -> Any:
        try:
            result = await asyncio.to_thread(commands.request_autopilot_version)
        except CommandRejected as rejection:
            return _rejection_response(rejection, _status_for(rejection.reason))
        return result.to_dict()

    @app.post("/api/drone/request-streams", response_model=CommandResponse)
    async def request_streams(body: StreamRequest = Body(default=StreamRequest())) -> Any:
        try:
            result = await asyncio.to_thread(commands.request_streams, body.streams)
        except CommandRejected as rejection:
            return _rejection_response(rejection, _status_for(rejection.reason))
        return result.to_dict()

    @app.post("/api/drone/mode", response_model=CommandResponse)
    async def set_mode(body: ModeRequest) -> Any:
        if resolved.is_real and not body.confirmed:
            return JSONResponse(
                status_code=status.HTTP_412_PRECONDITION_FAILED,
                content={
                    "ok": False,
                    "reason": "confirmation_required",
                    "message": (
                        "A real-mode flight-mode change must be explicitly confirmed. "
                        "Re-send with confirmed=true after the operator acknowledges."
                    ),
                    "detail": {"requestedMode": body.mode},
                },
            )
        try:
            result = await asyncio.to_thread(commands.set_flight_mode, body.mode)
        except CommandRejected as rejection:
            return _rejection_response(rejection, _status_for(rejection.reason))
        return result.to_dict()

    # ------------------------------------------------------------------
    # Explicitly disabled operations
    # ------------------------------------------------------------------

    @app.post("/api/drone/disabled/{operation}", response_model=CommandResponse, status_code=501)
    async def disabled_operation(operation: str) -> Any:
        """Answer honestly for operations this backend refuses to implement.

        Every one of arm, disarm, takeoff, land, RTL, mission upload, GUIDED
        movement, RC override, MANUAL_CONTROL, motor test and parameter write
        lands here. Nothing is transmitted; there is no code path from this
        handler to the MAVLink transport.
        """
        result = commands.refuse(operation)
        return JSONResponse(status_code=status.HTTP_501_NOT_IMPLEMENTED, content=result.to_dict())

    # ------------------------------------------------------------------
    # WebSocket telemetry
    # ------------------------------------------------------------------

    @app.websocket("/api/drone/telemetry/ws")
    async def telemetry_ws(websocket: WebSocket) -> None:
        """Push a complete normalized snapshot at a fixed, controlled rate.

        A fixed cadence rather than push-on-every-message is deliberate: the
        vehicle emits well over 20 messages/second, and forwarding each one
        would flood the browser for no benefit. Every frame is a full snapshot,
        so a client that misses one is not left with a partial view.
        """
        await websocket.accept()
        logger.info("telemetry websocket client connected")
        reader: asyncio.Task[Any] | None = None
        try:
            # Read concurrently purely to notice a client going away promptly;
            # inbound messages carry no commands and are ignored.
            reader = asyncio.create_task(_drain_client(websocket))
            while True:
                await websocket.send_json({"type": "telemetry", "payload": manager.snapshot()})
                done, _ = await asyncio.wait({reader}, timeout=resolved.ws_interval)
                if done:
                    break
        except WebSocketDisconnect:
            pass
        except Exception:  # noqa: BLE001 - a broken socket must not kill the server
            logger.warning("telemetry websocket ended with an error", exc_info=True)
        finally:
            if reader is not None and not reader.done():
                reader.cancel()
            logger.info("telemetry websocket client disconnected")

    return app


async def _drain_client(websocket: WebSocket) -> None:
    """Consume and discard inbound frames until the client disconnects."""
    while True:
        await websocket.receive_text()


#: HTTP status for each rejection reason. Kept as a table so a new reason
#: cannot accidentally inherit a misleading 200.
_REASON_STATUS = {
    "commands_disabled": status.HTTP_403_FORBIDDEN,
    "not_connected": status.HTTP_409_CONFLICT,
    "link_stale": status.HTTP_409_CONFLICT,
    "armed": status.HTTP_409_CONFLICT,
    "arm_state_unknown": status.HTTP_409_CONFLICT,
    "mode_not_allowed": status.HTTP_400_BAD_REQUEST,
    "mode_forbidden": status.HTTP_403_FORBIDDEN,
    "stream_not_allowed": status.HTTP_400_BAD_REQUEST,
    "rejected_by_vehicle": status.HTTP_502_BAD_GATEWAY,
    "ack_timeout": status.HTTP_504_GATEWAY_TIMEOUT,
    "verify_timeout": status.HTTP_504_GATEWAY_TIMEOUT,
    "transmit_failed": status.HTTP_502_BAD_GATEWAY,
    "not_implemented": status.HTTP_501_NOT_IMPLEMENTED,
}


def _status_for(reason: str) -> int:
    return _REASON_STATUS.get(reason, status.HTTP_400_BAD_REQUEST)


def run() -> None:
    """Console entry point: ``python -m app.main``."""
    import uvicorn  # noqa: PLC0415 - only needed when actually serving

    settings = load_settings()
    configure_logging(settings.log_level)
    uvicorn.run(
        create_app(settings),
        host=settings.host,
        port=settings.http_port,
        log_level=settings.log_level.lower(),
        # Bounded so a stuck client cannot hold the process open at shutdown.
        timeout_graceful_shutdown=10,
    )


if __name__ == "__main__":
    run()
