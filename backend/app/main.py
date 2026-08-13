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
from .mavlink.pilot_service import (
    BlockReason,
    PilotProviderRejected,
    PilotSequenceRejected,
    PilotService,
)
from .models import (
    ArmDisarmRequest,
    CommandResponse,
    ConfigResponse,
    ConnectRequest,
    HealthResponse,
    ModeRequest,
    PilotBenchEnableRequest,
    PilotInputRequest,
    PilotNeutralRequest,
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
    # The pilot service is always constructed so the UI can report *why*
    # control is unavailable, but it refuses to produce a setpoint unless
    # SUISUI_MAVLINK_ALLOW_PILOT_CONTROL=1. Only then is it attached to the
    # link worker, so an unconfigured backend has no code path from an HTTP
    # request to an RC override frame at all.
    pilot = PilotService(resolved, manager.state)
    commands = CommandService(manager, resolved, pilot)
    if pilot.available:
        manager.attach_pilot_service(pilot)
        logger.warning(
            "manual RC pilot control is ENABLED (limits: %s). Dead-man, fresh telemetry, "
            "fresh input, an armed vehicle, and STABILIZE/ALT_HOLD are still required.",
            pilot.limits.to_dict(),
        )

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
        summary="Local MAVLink telemetry and fail-closed manual RC control for SuisuiNavi.",
        lifespan=lifespan,
    )
    app.state.manager = manager
    app.state.commands = commands
    app.state.pilot = pilot
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
        snapshot = manager.snapshot()
        snapshot["pilot"] = pilot.snapshot()
        return snapshot

    # ------------------------------------------------------------------
    # Manual pilot RC control
    # ------------------------------------------------------------------
    #
    # Every route here is a no-op unless SUISUI_MAVLINK_ALLOW_PILOT_CONTROL=1.
    # Enable never arms or changes mode. Input owns only the reviewed
    # RC_CHANNELS_OVERRIDE path and releases channels 1-8 on every closed gate.

    def _pilot_unavailable() -> JSONResponse:
        return JSONResponse(
            status_code=status.HTTP_403_FORBIDDEN,
            content={
                "ok": False,
                "reason": "pilot_control_disabled",
                "message": (
                    "Manual pilot control is disabled. Start the backend with "
                    "SUISUI_MAVLINK_ALLOW_PILOT_CONTROL=1 to enable it. This never arms the "
                    "aircraft or changes its flight mode."
                ),
                "detail": {"pilot": pilot.snapshot()},
            },
        )

    @app.post("/api/drone/pilot/enable")
    async def pilot_enable() -> Any:
        """Open the control channel. Does **not** arm anything."""
        if not pilot.available:
            return _pilot_unavailable()
        return {
            "ok": True,
            "reason": "enabled",
            "message": "Pilot control enabled. ARM remains a separate explicit action; "
                       "manual output supports STABILIZE and ALT_HOLD.",
            "detail": {"pilot": pilot.enable()},
        }

    @app.post("/api/drone/pilot/bench/enable")
    async def pilot_bench_enable(body: PilotBenchEnableRequest) -> Any:
        """Open the control channel for a PROPELLERS-REMOVED bench test.

        Stricter than ``/api/drone/pilot/enable``: uses smaller bench-specific limits, requires
        the props acknowledgement, and every
        ``/pilot/input`` frame must carry ``deadman: true`` or the setpoint
        releases the RC override. Still does not arm the aircraft or change its
        mode. Mock mode simulates this flow without touching hardware.
        """
        if not pilot.available:
            return _pilot_unavailable()
        return {
            "ok": True,
            "reason": "bench_enabled",
            "message": "Bench pilot enabled with reduced RC deflection. ARM separately, then "
                       "hold the selected input provider's dead-man continuously.",
            "detail": {"pilot": pilot.enable_bench(props_removed_ack=body.propsRemovedAck)},
        }

    @app.post("/api/drone/pilot/disable")
    async def pilot_disable() -> Any:
        """Close the control channel and release its RC override on the way out.

        Covers bench mode too -- there is one exit for both.
        """
        return {
            "ok": True,
            "reason": "disabled",
            "message": "Pilot control channel disabled; releasing RC override.",
            "detail": {"pilot": pilot.disable()},
        }

    @app.post("/api/drone/pilot/neutral")
    async def pilot_neutral(body: PilotNeutralRequest) -> Any:
        """Stop movement now (Space, focus loss, tab hidden, page unload).

        A movement command, not a motor kill: the channel stays open and the
        operator can fly again immediately.
        """
        try:
            snapshot = pilot.command_neutral(sequence=body.sequence)
        except PilotSequenceRejected as rejection:
            return JSONResponse(
                status_code=status.HTTP_409_CONFLICT,
                content={
                    "ok": False,
                    "reason": rejection.reason,
                    "message": str(rejection),
                    "detail": {
                        "sequence": rejection.sequence,
                        "lastClientSequence": rejection.last_sequence,
                    },
                },
            )
        return {
            "ok": True,
            "reason": "neutral",
            "message": "Manual RC override released.",
            "detail": {"pilot": snapshot},
        }

    @app.post("/api/drone/pilot/input")
    async def pilot_input(body: PilotInputRequest) -> Any:
        """Accept one normalized pilot command from the browser.

        Called continuously (~15 Hz) while control is active. The backend
        keeps only the latest command with a monotonic timestamp and stops
        moving on its own if these stop arriving.
        """
        if not pilot.available:
            return _pilot_unavailable()
        try:
            state = pilot.submit(
                pitch=body.pitch,
                roll=body.roll,
                throttle=body.throttle,
                yaw=body.yaw,
                neutral=body.neutral,
                deadman=body.deadman,
                source=body.source,
                provider=body.provider,
                sequence=body.sequence,
            )
        except PilotProviderRejected as rejection:
            return JSONResponse(
                status_code=status.HTTP_403_FORBIDDEN,
                content={
                    "ok": False,
                    "reason": rejection.reason,
                    "message": str(rejection),
                    "detail": {
                        "provider": rejection.provider,
                        "sequence": rejection.sequence,
                        "pilot": pilot.snapshot(),
                    },
                },
            )
        except PilotSequenceRejected as rejection:
            return JSONResponse(
                status_code=status.HTTP_409_CONFLICT,
                content={
                    "ok": False,
                    "reason": rejection.reason,
                    "message": str(rejection),
                    "detail": {
                        "sequence": rejection.sequence,
                        "lastClientSequence": rejection.last_sequence,
                    },
                },
            )
        return {"ok": True, "reason": "accepted", "message": "", "detail": {"pilot": state}}

    @app.get("/api/drone/config", response_model=ConfigResponse)
    async def drone_config() -> ConfigResponse:
        return ConfigResponse(
            config={
                **resolved.public_dict(),
                "armSupported": True,
                "armEnabled": bool(resolved.allow_safe_commands and pilot.available),
                "manualControlTransport": "RC_CHANNELS_OVERRIDE",
            },
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

    @app.post("/api/drone/arm", response_model=CommandResponse)
    async def arm(body: ArmDisarmRequest) -> Any:
        """Normal ARM command; ACK plus HEARTBEAT confirmation are required."""
        try:
            result = await asyncio.to_thread(commands.arm, confirmed=body.confirmed)
        except CommandRejected as rejection:
            return _rejection_response(rejection, _status_for(rejection.reason))
        return result.to_dict()

    @app.post("/api/drone/disarm", response_model=CommandResponse)
    async def disarm(body: ArmDisarmRequest) -> Any:
        """Normal DISARM command; available even after pilot disable."""
        try:
            result = await asyncio.to_thread(commands.disarm, confirmed=body.confirmed)
        except CommandRejected as rejection:
            return _rejection_response(rejection, _status_for(rejection.reason))
        return result.to_dict()

    # ------------------------------------------------------------------
    # Explicitly disabled operations
    # ------------------------------------------------------------------

    @app.post("/api/drone/disabled/{operation}", response_model=CommandResponse, status_code=501)
    async def disabled_operation(operation: str) -> Any:
        """Answer honestly for operations this backend refuses to implement.

        Takeoff, land, RTL, mission upload, raw RC frames, MANUAL_CONTROL,
        motor test and parameter writes land here. ARM/DISARM are separate,
        tightly gated endpoints and cannot be selected through this route.
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
        # Read concurrently purely to notice a client going away promptly;
        # inbound messages carry no commands and are ignored. `_drain_client`
        # catches its own WebSocketDisconnect, and `_consume_reader` below
        # always retrieves this task's result/exception exactly once -- an
        # asyncio Task whose exception is never fetched (e.g. via `.result()`
        # or awaiting it) gets logged by the event loop as "Task exception was
        # never retrieved" once garbage collected, which is what a plain
        # client disconnect used to produce here.
        reader: asyncio.Task[None] = asyncio.create_task(_drain_client(websocket))
        close_reason = "client"
        try:
            while True:
                payload = manager.snapshot()
                payload["pilot"] = pilot.snapshot()
                await websocket.send_json({"type": "telemetry", "payload": payload})
                done, _pending = await asyncio.wait({reader}, timeout=resolved.ws_interval)
                if done:
                    # The reader finished: the client disconnected (any close
                    # code -- 1000 normal, 1001 navigation/tab close, 1006
                    # abnormal) while we were between sends.
                    break
        except WebSocketDisconnect as disconnect:
            # The send (or the internal receive Starlette does to detect a
            # close) hit the disconnect directly, rather than the reader task
            # noticing it first. Same expected path, different order.
            close_reason = f"client, code={disconnect.code}"
        except (RuntimeError, ConnectionResetError) as error:
            # RuntimeError: Starlette raises this when send() is attempted
            # after the socket already closed -- a race between our send loop
            # and the client (or server shutdown) closing the connection.
            # ConnectionResetError: an abrupt, lower-level connection drop.
            # Both are ordinary disconnect paths here, not programming bugs.
            close_reason = f"{type(error).__name__}"
        except Exception:  # noqa: BLE001 - a broken socket must not kill the server
            logger.warning("telemetry websocket send loop ended with an unexpected error", exc_info=True)
            close_reason = "error"
        finally:
            # A lost status socket is treated as loss of the controlling
            # browser. The worker immediately begins the repeated CH1-8 release
            # window; a later input must carry a newer sequence to resume.
            pilot.command_failsafe(BlockReason.WEBSOCKET_DISCONNECTED)
            if not reader.done():
                # The send loop exited some other way (an exception, or the
                # process shutting down) while the client was still connected
                # from the reader's point of view -- stop it explicitly.
                reader.cancel()
            await _consume_reader(reader)
            logger.info("telemetry websocket client disconnected (%s)", close_reason)

    return app


async def _drain_client(websocket: WebSocket) -> None:
    """Consume and discard inbound frames until the client disconnects.

    Runs in its own task so the server notices the client going away promptly
    even while the main loop is asleep between telemetry frames; inbound
    frames carry no commands and are ignored.

    ``WebSocketDisconnect`` is how *every* ordinary disconnect surfaces here
    -- a clean browser close (code 1000), a tab/navigation close (1001), or an
    abrupt network drop the client reports as 1006 all raise it the same way,
    with only ``.code`` differing. Catching it here means this task always
    finishes normally on a client disconnect, so there is never an exception
    left for anything to retrieve.
    """
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass


async def _consume_reader(reader: "asyncio.Task[None]") -> None:
    """Await a finished (or just-cancelled) drain task exactly once.

    This is the other half of the fix: even with ``_drain_client`` catching
    its own disconnect, a task's result (or exception) must actually be
    retrieved -- by awaiting it, or calling ``.result()``/``.exception()`` --
    or asyncio logs "Task exception was never retrieved" when the Task object
    is garbage collected. ``asyncio.wait()`` in the caller does not do this
    for us; it only reports which tasks finished.

    A cancellation we ourselves triggered (server shutdown, or the send loop
    ending first) is expected and silent. Anything else genuinely unexpected
    is logged, never silently discarded -- a real programming error in this
    task must stay visible.
    """
    try:
        await reader
    except asyncio.CancelledError:
        pass
    except WebSocketDisconnect:
        # Defensive: _drain_client already catches this itself, but a future
        # edit to it must not silently reintroduce the original defect.
        pass
    except Exception:  # noqa: BLE001 - never let the drain task hide a bug
        logger.warning("telemetry websocket reader task ended with an unexpected error", exc_info=True)


#: HTTP status for each rejection reason. Kept as a table so a new reason
#: cannot accidentally inherit a misleading 200.
_REASON_STATUS = {
    "commands_disabled": status.HTTP_403_FORBIDDEN,
    "not_connected": status.HTTP_409_CONFLICT,
    "link_stale": status.HTTP_409_CONFLICT,
    "armed": status.HTTP_409_CONFLICT,
    "arm_state_unknown": status.HTTP_409_CONFLICT,
    "confirmation_required": status.HTTP_412_PRECONDITION_FAILED,
    "pilot_control_disabled": status.HTTP_403_FORBIDDEN,
    "pilot_not_enabled": status.HTTP_409_CONFLICT,
    "pilot_not_ready": status.HTTP_409_CONFLICT,
    "command_in_progress": status.HTTP_409_CONFLICT,
    "props_not_confirmed": status.HTTP_412_PRECONDITION_FAILED,
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
