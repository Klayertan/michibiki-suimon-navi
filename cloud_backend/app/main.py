"""FastAPI application: the SuisuiNavi cloud (accounts/fields) API.

This is a SEPARATE service from backend/ (the local MAVLink/drone backend —
see backend/README.md). It never imports from backend/, is never deployed to
the same host as it, and has no code path that reaches a serial port or a
Pixhawk. See docs/AUTH_ARCHITECTURE.md's "Security boundary" section and
app/api/future_ingestion.py's module docstring for the drone-safety
reasoning in full.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .api.field_observations import router as field_observations_router
from .api.field_water_targets import router as field_water_targets_router
from .api.fields import router as fields_router
from .api.future_ingestion import drone_router, gnss_router, sensors_router
from .api.profile import router as profile_router
from .api.water_control_points import router as water_control_points_router
from .auth.router import router as auth_router
from .config import Settings, get_settings
from .models.schemas import HealthResponse

logger = logging.getLogger(__name__)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    if settings.is_production and not settings.session_secret:
        # Refuse to boot rather than run a production deployment with an
        # empty session secret — see config.py's own comment on why this is
        # checked here (at startup) and not in the field validator (which
        # unit tests need to be able to skip).
        raise RuntimeError(
            "SUISUI_CLOUD_SESSION_SECRET must be set in production. "
            "See .env.example and docs/SAKURA_CLOUD_DEPLOYMENT.md."
        )

    if settings.is_production and settings.max_registered_users is None:
        # Fail closed: an unset registration cap in production must never be
        # silently treated as "unlimited." See config.py's comment and
        # docs/AUTH_ARCHITECTURE.md — "Registration cap".
        raise RuntimeError(
            "SUISUI_CLOUD_MAX_REGISTERED_USERS must be set in production "
            "(fail closed, never unlimited). See .env.example and "
            "docs/AUTH_ARCHITECTURE.md."
        )

    app = FastAPI(
        title="SuisuiNavi Cloud API",
        version="0.1.0",
        # No public interactive docs in production: this is an account/data
        # API, not a developer sandbox with a public attack surface to
        # advertise. Still available in development for local iteration.
        docs_url="/docs" if not settings.is_production else None,
        redoc_url=None,
        openapi_url="/openapi.json" if not settings.is_production else None,
    )

    # CORS: an explicit allow-list only, never a wildcard — Phase 10 is
    # explicit that wildcard + credentials must never be combined, and
    # FastAPI's CORSMiddleware itself refuses allow_origins=["*"] together
    # with allow_credentials=True, so this is enforced by the framework too,
    # not just by convention.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["content-type", settings.csrf_header_name],
    )

    @app.middleware("http")
    async def _limit_body_size(request: Request, call_next):  # noqa: ANN001
        content_length = request.headers.get("content-length")
        if content_length is not None and int(content_length) > settings.max_request_body_bytes:
            return JSONResponse(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                content={"detail": "request body too large"},
            )
        return await call_next(request)

    @app.middleware("http")
    async def _security_headers(request: Request, call_next):  # noqa: ANN001
        response: Response = await call_next(request)
        # A minimal, uncontroversial set for a JSON API with no HTML
        # responses of its own — this API never renders a page, so most of
        # the CSP surface a browser app would need does not apply here.
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        if settings.is_production:
            response.headers.setdefault(
                "Strict-Transport-Security", "max-age=63072000; includeSubDomains"
            )
        return response

    @app.exception_handler(Exception)
    async def _unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
        # Never leak a stack trace or an exception message to the client —
        # Phase 10 is explicit about this. The real detail goes to the
        # server log only, keyed so an operator can correlate a support
        # report with the log line.
        logger.exception("unhandled exception on %s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"detail": "internal server error"},
        )

    @app.get("/api/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        return HealthResponse(status="ok", environment=settings.environment)

    app.include_router(auth_router)
    app.include_router(fields_router)
    app.include_router(water_control_points_router)
    app.include_router(field_observations_router)
    app.include_router(field_water_targets_router)
    app.include_router(profile_router)
    app.include_router(gnss_router)
    app.include_router(sensors_router)
    app.include_router(drone_router)

    return app


app = create_app()
