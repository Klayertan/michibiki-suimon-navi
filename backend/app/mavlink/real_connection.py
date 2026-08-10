"""The real serial MAVLink link, backed by pymavlink.

Design notes that matter for safety:

* :mod:`pymavlink` is imported inside :meth:`RealMavlinkLink.open`, never at
  module import time. Importing this module therefore never opens a port,
  never enumerates hardware, and works on a machine without pymavlink
  installed -- which is what lets the mock-mode test suite import the whole
  application.
* The transmit paths are deliberately narrow: a GCS heartbeat,
  ``COMMAND_LONG`` for an allowlisted command id, the separately retained
  GUIDED velocity setpoint, manual ``RC_CHANNELS_OVERRIDE``, and read-only
  ``PARAM_REQUEST_READ``. There is no generic send or parameter-write path.
* ``OSError``/``PermissionError`` from the serial layer is translated into
  :class:`~app.mavlink.interface.PortBusyError` so the operator is told to
  close QGroundControl rather than being shown a raw errno.
"""

from __future__ import annotations

import logging
from typing import Any, Iterator

from . import constants, pilot_limits
from .interface import (
    LinkClosedError,
    LinkError,
    MavlinkLink,
    PortBusyError,
    PortNotFoundError,
    ReceivedMessage,
)

logger = logging.getLogger(__name__)

#: Windows error text that means "another process holds this COM port".
#: On this project's workstation that is almost always QGroundControl.
_BUSY_MARKERS = (
    "access is denied",
    "permissionerror",
    "resource busy",
    "device or resource busy",
    "could not open port",
    "semaphore timeout",
)
_NOT_FOUND_MARKERS = (
    "could not find",
    "no such file or directory",
    "filenotfounderror",
    "the system cannot find the file",
)


def classify_serial_error(error: BaseException, port: str) -> LinkError:
    """Turn a pyserial/pymavlink exception into an actionable link error.

    Kept as a module-level function so it can be unit-tested without a port.
    """
    text = f"{type(error).__name__}: {error}".lower()
    if any(marker in text for marker in _NOT_FOUND_MARKERS):
        return PortNotFoundError(
            f"Serial port {port} was not found. Check the telemetry radio is plugged in and "
            f"that the port name is correct (Device Manager > Ports)."
        )
    if any(marker in text for marker in _BUSY_MARKERS) or isinstance(error, PermissionError):
        return PortBusyError(
            f"Serial port {port} is already in use by another program. QGroundControl and this "
            f"backend cannot both own {port} — close QGroundControl (or any other GCS / serial "
            f"terminal) and try again."
        )
    return LinkError(f"Could not open {port}: {error}")


class RealMavlinkLink(MavlinkLink):
    """MAVLink 2 over a serial telemetry radio."""

    def __init__(
        self,
        *,
        port: str,
        baud: int,
        source_system: int,
        source_component: int,
        target_system: int,
        target_component: int,
    ) -> None:
        self._port = port
        self._baud = baud
        self._source_system = source_system
        self._source_component = source_component
        self._target_system = target_system
        self._target_component = target_component
        self._connection: Any | None = None
        self._mavutil: Any | None = None

    @property
    def is_open(self) -> bool:
        return self._connection is not None

    def open(self) -> None:
        if self._connection is not None:
            return
        try:
            from pymavlink import mavutil  # noqa: PLC0415 - deliberately lazy
        except ImportError as exc:  # pragma: no cover - depends on environment
            raise LinkError(
                "pymavlink is not installed in the active environment. Install the backend "
                "requirements (backend/requirements.txt) into the project virtual environment."
            ) from exc

        self._mavutil = mavutil
        logger.info("opening serial MAVLink link on %s at %d baud", self._port, self._baud)
        try:
            connection = mavutil.mavlink_connection(
                self._port,
                baud=self._baud,
                source_system=self._source_system,
                source_component=self._source_component,
                # MAVLink 2 matches SERIAL2_PROTOCOL=2 on the airframe.
                dialect="ardupilotmega",
                autoreconnect=False,
            )
        except Exception as exc:  # noqa: BLE001 - normalized immediately below
            raise classify_serial_error(exc, self._port) from exc

        self._connection = connection
        logger.info("serial MAVLink link open on %s", self._port)

    def close(self) -> None:
        connection, self._connection = self._connection, None
        if connection is None:
            return
        try:
            connection.close()
        except Exception:  # noqa: BLE001 - shutdown must never raise
            logger.warning("error while closing %s (ignored during shutdown)", self._port, exc_info=True)
        else:
            logger.info("serial MAVLink link on %s closed", self._port)

    def receive(self, timeout: float) -> Iterator[ReceivedMessage]:
        connection = self._require_open()
        messages: list[ReceivedMessage] = []
        try:
            message = connection.recv_match(blocking=True, timeout=max(0.01, timeout))
            while message is not None:
                if message.get_type() != "BAD_DATA":
                    header = getattr(message, "_header", None)
                    messages.append(
                        ReceivedMessage(
                            message=message,
                            system_id=getattr(header, "srcSystem", None),
                            component_id=getattr(header, "srcComponent", None),
                        )
                    )
                # Drain whatever else already arrived without blocking again,
                # so a burst does not build latency.
                message = connection.recv_match(blocking=False)
        except Exception as exc:  # noqa: BLE001 - surfaced as a link error
            raise classify_serial_error(exc, self._port) from exc
        return iter(messages)

    def send_gcs_heartbeat(self) -> None:
        connection = self._require_open()
        try:
            connection.mav.heartbeat_send(
                constants.MAV_TYPE_GCS,
                constants.MAV_AUTOPILOT_INVALID,
                0,  # base_mode: a GCS has no flight mode
                0,  # custom_mode
                constants.MAV_STATE_ACTIVE,
            )
        except Exception as exc:  # noqa: BLE001
            raise classify_serial_error(exc, self._port) from exc

    def send_command_long(
        self,
        *,
        target_system: int,
        target_component: int,
        command: int,
        params: tuple[float, float, float, float, float, float, float],
    ) -> None:
        connection = self._require_open()
        try:
            connection.mav.command_long_send(
                target_system,
                target_component,
                command,
                0,  # confirmation
                *params,
            )
        except Exception as exc:  # noqa: BLE001
            raise classify_serial_error(exc, self._port) from exc

    def send_velocity_setpoint(
        self,
        *,
        target_system: int,
        target_component: int,
        vx: float,
        vy: float,
        vz: float,
        yaw_rate: float,
    ) -> None:
        connection = self._require_open()
        try:
            connection.mav.set_position_target_local_ned_send(
                0,  # time_boot_ms: ArduPilot ignores it on this message
                target_system,
                target_component,
                pilot_limits.MAV_FRAME_BODY_NED,
                pilot_limits.TYPE_MASK_VELOCITY_YAW_RATE,
                0.0, 0.0, 0.0,  # x, y, z position: ignored by the type mask
                float(vx), float(vy), float(vz),
                0.0, 0.0, 0.0,  # afx, afy, afz: ignored by the type mask
                0.0,  # yaw: ignored by the type mask
                float(yaw_rate),
            )
        except Exception as exc:  # noqa: BLE001
            raise classify_serial_error(exc, self._port) from exc

    def send_rc_channels_override(
        self,
        *,
        target_system: int,
        target_component: int,
        channels: tuple[int, int, int, int, int, int, int, int],
    ) -> None:
        connection = self._require_open()
        if len(channels) != 8:
            raise ValueError("RC_CHANNELS_OVERRIDE requires exactly channels 1-8")
        if any(isinstance(value, bool) or not isinstance(value, int) for value in channels):
            raise ValueError("RC_CHANNELS_OVERRIDE values must be integers")
        channel_values = tuple(channels)
        if any(value < 0 or value > constants.RC_CHANNEL_IGNORE for value in channel_values):
            raise ValueError("RC_CHANNELS_OVERRIDE values must be unsigned 16-bit integers")
        try:
            # The pymavlink dialect defaults extension channels 9-18 to zero.
            # For those extension fields zero means "ignore", while the eight
            # fields supplied here retain the MAVLink v1 semantics documented
            # by MavlinkLink (zero releases, UINT16_MAX ignores).
            connection.mav.rc_channels_override_send(
                target_system,
                target_component,
                *channel_values,
            )
        except Exception as exc:  # noqa: BLE001
            raise classify_serial_error(exc, self._port) from exc

    def send_parameter_request(
        self,
        *,
        target_system: int,
        target_component: int,
        name: str,
    ) -> None:
        connection = self._require_open()
        clean_name = name.strip()
        if not clean_name or len(clean_name) > 16:
            raise ValueError("MAVLink parameter names must contain 1-16 characters")
        try:
            encoded_name = clean_name.encode("ascii")
        except UnicodeEncodeError as exc:
            raise ValueError("MAVLink parameter names must be ASCII") from exc
        try:
            connection.mav.param_request_read_send(
                target_system,
                target_component,
                encoded_name,
                -1,  # request by param_id, never by array index
            )
        except Exception as exc:  # noqa: BLE001
            raise classify_serial_error(exc, self._port) from exc

    def _require_open(self) -> Any:
        if self._connection is None:
            raise LinkClosedError("The serial MAVLink link is not open.")
        return self._connection

    def describe(self) -> dict[str, Any]:
        return {
            "transport": "serial",
            "port": self._port,
            "baud": self._baud,
            "sourceSystem": self._source_system,
            "sourceComponent": self._source_component,
            "targetSystem": self._target_system,
            "targetComponent": self._target_component,
        }
