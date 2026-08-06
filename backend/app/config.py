"""Environment-driven configuration for the MAVLink backend.

Every value is read from ``SUISUI_MAVLINK_*`` environment variables so that
nothing about a particular workstation (COM port, Windows username, paths) is
baked into source. Reading configuration has no side effects: no serial port is
opened, no thread is started.

Safety-relevant defaults are deliberately the restrictive ones:

* ``mode`` defaults to ``mock`` -- the real radio is never used by accident.
* ``allow_safe_commands`` defaults to false -- a real connection is read-only
  until the operator opts in.
* ``allow_arm`` / ``allow_takeoff`` are parsed only so the running
  configuration can be reported and a warning logged. They do not enable
  anything: arming and takeoff are not implemented in this backend at all.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from typing import Final

logger = logging.getLogger(__name__)

ENV_PREFIX: Final = "SUISUI_MAVLINK_"

#: Modes the backend understands. ``real`` is the only one that touches serial.
MODE_MOCK: Final = "mock"
MODE_REAL: Final = "real"
VALID_MODES: Final = (MODE_MOCK, MODE_REAL)


class ConfigError(ValueError):
    """Raised when an environment variable holds an unusable value."""


def _raw(name: str, default: str) -> str:
    return os.environ.get(f"{ENV_PREFIX}{name}", default).strip()


def _env_str(name: str, default: str) -> str:
    return _raw(name, default)


def _env_bool(name: str, default: bool) -> bool:
    raw = _raw(name, "1" if default else "0").lower()
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off", ""):
        return False
    raise ConfigError(f"{ENV_PREFIX}{name} must be a boolean-ish value, got {raw!r}")


def _env_int(name: str, default: int, *, minimum: int, maximum: int) -> int:
    raw = _raw(name, str(default))
    try:
        value = int(raw)
    except ValueError as exc:
        raise ConfigError(f"{ENV_PREFIX}{name} must be an integer, got {raw!r}") from exc
    if not minimum <= value <= maximum:
        raise ConfigError(f"{ENV_PREFIX}{name} must be between {minimum} and {maximum}, got {value}")
    return value


def _env_float(name: str, default: float, *, minimum: float, maximum: float) -> float:
    raw = _raw(name, str(default))
    try:
        value = float(raw)
    except ValueError as exc:
        raise ConfigError(f"{ENV_PREFIX}{name} must be a number, got {raw!r}") from exc
    if not minimum <= value <= maximum:
        raise ConfigError(f"{ENV_PREFIX}{name} must be between {minimum} and {maximum}, got {value}")
    return value


def _env_csv(name: str, default: str) -> tuple[str, ...]:
    raw = _raw(name, default)
    return tuple(item.strip() for item in raw.split(",") if item.strip())


@dataclass(frozen=True)
class Settings:
    """Immutable snapshot of the backend configuration."""

    # -- Link -------------------------------------------------------------
    mode: str = MODE_MOCK
    port: str = "COM10"
    baud: int = 57600
    source_system: int = 255
    source_component: int = 190
    target_system: int = 1
    #: Component the autopilot is addressed on. ArduPilot normally answers on
    #: 1 (MAV_COMP_ID_AUTOPILOT1); some ground stations report 0. The link
    #: prefers the component actually seen in the vehicle HEARTBEAT and only
    #: falls back to this value.
    target_component: int = 1

    # -- Timing -----------------------------------------------------------
    heartbeat_interval: float = 1.0
    stale_timeout: float = 3.0
    link_lost_timeout: float = 10.0
    connect_timeout: float = 10.0
    command_timeout: float = 5.0
    mode_verify_timeout: float = 5.0
    reconnect_delay: float = 3.0
    auto_reconnect: bool = True

    # -- Safety gates -----------------------------------------------------
    allow_safe_commands: bool = False
    #: Parsed for reporting only. Arming is not implemented; see
    #: :mod:`app.mavlink.command_service`.
    allow_arm: bool = False
    #: Parsed for reporting only. Takeoff is not implemented.
    allow_takeoff: bool = False
    require_props_removed_ack: bool = True

    # -- HTTP -------------------------------------------------------------
    host: str = "127.0.0.1"
    http_port: int = 8787
    allowed_origins: tuple[str, ...] = (
        "http://localhost:4173",
        "http://127.0.0.1:4173",
    )
    ws_interval: float = 0.5
    max_request_bytes: int = 8192
    max_statustext: int = 50
    log_level: str = "INFO"

    @property
    def is_mock(self) -> bool:
        return self.mode == MODE_MOCK

    @property
    def is_real(self) -> bool:
        return self.mode == MODE_REAL

    def public_dict(self) -> dict[str, object]:
        """Configuration safe to hand to the browser.

        There are no secrets in this configuration, but the method exists so
        that adding one later cannot leak by default.
        """
        return {
            "mode": self.mode,
            "port": self.port if self.is_real else None,
            "baud": self.baud if self.is_real else None,
            "sourceSystem": self.source_system,
            "sourceComponent": self.source_component,
            "targetSystem": self.target_system,
            "targetComponent": self.target_component,
            "heartbeatInterval": self.heartbeat_interval,
            "staleTimeout": self.stale_timeout,
            "linkLostTimeout": self.link_lost_timeout,
            "autoReconnect": self.auto_reconnect,
            "reconnectDelay": self.reconnect_delay,
            "commandTimeout": self.command_timeout,
            "modeVerifyTimeout": self.mode_verify_timeout,
            "wsInterval": self.ws_interval,
            "allowSafeCommands": self.allow_safe_commands,
            "armSupported": False,
            "takeoffSupported": False,
            "allowedModes": list(ALLOWED_DISARMED_MODES),
        }


#: Flight modes a disarmed ArduCopter may be switched into through this API.
#: This is the whole allowlist -- no other mode name and no numeric mode ID
#: from the browser is ever forwarded to the vehicle.
ALLOWED_DISARMED_MODES: Final = ("STABILIZE", "ALT_HOLD")


def load_settings() -> Settings:
    """Build :class:`Settings` from the process environment.

    Raises:
        ConfigError: if any variable is present but unusable. Failing loudly at
            startup is preferred over silently running with a default that the
            operator did not intend.
    """
    mode = _env_str("MODE", MODE_MOCK).lower()
    if mode not in VALID_MODES:
        raise ConfigError(f"{ENV_PREFIX}MODE must be one of {VALID_MODES}, got {mode!r}")

    settings = Settings(
        mode=mode,
        port=_env_str("PORT", "COM10"),
        baud=_env_int("BAUD", 57600, minimum=1200, maximum=3_000_000),
        source_system=_env_int("SOURCE_SYSTEM", 255, minimum=1, maximum=255),
        source_component=_env_int("SOURCE_COMPONENT", 190, minimum=1, maximum=255),
        target_system=_env_int("TARGET_SYSTEM", 1, minimum=1, maximum=255),
        target_component=_env_int("TARGET_COMPONENT", 1, minimum=0, maximum=255),
        heartbeat_interval=_env_float("HEARTBEAT_INTERVAL", 1.0, minimum=0.1, maximum=10.0),
        stale_timeout=_env_float("STALE_TIMEOUT", 3.0, minimum=0.5, maximum=120.0),
        link_lost_timeout=_env_float("LINK_LOST_TIMEOUT", 10.0, minimum=1.0, maximum=600.0),
        connect_timeout=_env_float("CONNECT_TIMEOUT", 10.0, minimum=1.0, maximum=120.0),
        command_timeout=_env_float("COMMAND_TIMEOUT", 5.0, minimum=0.5, maximum=60.0),
        mode_verify_timeout=_env_float("MODE_VERIFY_TIMEOUT", 5.0, minimum=0.5, maximum=60.0),
        reconnect_delay=_env_float("RECONNECT_DELAY", 3.0, minimum=0.5, maximum=120.0),
        auto_reconnect=_env_bool("AUTO_RECONNECT", True),
        allow_safe_commands=_env_bool("ALLOW_SAFE_COMMANDS", False),
        allow_arm=_env_bool("ALLOW_ARM", False),
        allow_takeoff=_env_bool("ALLOW_TAKEOFF", False),
        require_props_removed_ack=_env_bool("REQUIRE_PROPS_REMOVED_ACK", True),
        host=_env_str("HOST", "127.0.0.1"),
        http_port=_env_int("HTTP_PORT", 8787, minimum=1, maximum=65535),
        allowed_origins=_env_csv("ALLOWED_ORIGINS", "http://localhost:4173,http://127.0.0.1:4173"),
        ws_interval=_env_float("WS_INTERVAL", 0.5, minimum=0.05, maximum=10.0),
        max_request_bytes=_env_int("MAX_REQUEST_BYTES", 8192, minimum=256, maximum=1_048_576),
        max_statustext=_env_int("MAX_STATUSTEXT", 50, minimum=1, maximum=500),
        log_level=_env_str("LOG_LEVEL", "INFO").upper(),
    )

    if settings.link_lost_timeout < settings.stale_timeout:
        raise ConfigError(
            f"{ENV_PREFIX}LINK_LOST_TIMEOUT ({settings.link_lost_timeout}) must be >= "
            f"{ENV_PREFIX}STALE_TIMEOUT ({settings.stale_timeout})"
        )

    if settings.allow_arm or settings.allow_takeoff:
        logger.warning(
            "%sALLOW_ARM/%sALLOW_TAKEOFF are set but arming and takeoff are not implemented "
            "in this backend. The flags have no effect; the endpoints refuse unconditionally.",
            ENV_PREFIX,
            ENV_PREFIX,
        )
    if settings.host not in ("127.0.0.1", "localhost", "::1"):
        logger.warning(
            "%sHOST is %r. This backend commands an aircraft and is intended to listen on "
            "loopback only. Exposing it to a network is not supported.",
            ENV_PREFIX,
            settings.host,
        )
    return settings
