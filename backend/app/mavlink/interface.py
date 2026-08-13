"""The transport contract shared by the real and mock MAVLink links.

Everything above this layer -- the link manager, command service, API -- is
written against :class:`MavlinkLink` only. That is what makes it possible to
develop and test the whole backend, including command acknowledgement and
failure handling, with no aircraft powered and no serial port open.

Implementations are used from exactly one thread (the link worker), so they do
not need internal locking; the manager guarantees it.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass
from typing import Any, Iterator


class LinkError(Exception):
    """Base class for transport failures."""


class PortBusyError(LinkError):
    """The serial port exists but is held by another process.

    On Windows this is the signature of QGroundControl (or a second copy of
    this backend) still owning the port. It is reported distinctly because the
    fix -- close the other program -- is completely different from the fix for
    a missing or misconfigured port.
    """


class PortNotFoundError(LinkError):
    """The configured serial port does not exist on this machine."""


class LinkClosedError(LinkError):
    """An operation was attempted on a link that is not open."""


@dataclass(frozen=True)
class ReceivedMessage:
    """A decoded MAVLink message plus the addressing the transport observed."""

    message: Any
    system_id: int | None
    component_id: int | None

    def get_type(self) -> str:
        return self.message.get_type()


class MavlinkLink(abc.ABC):
    """A bidirectional MAVLink transport restricted to safe operations.

    There is intentionally no ``send_raw`` / ``send_packet`` method. This
    interface can produce only the reviewed outbound frames below:

    1. a GCS heartbeat;
    2. a ``COMMAND_LONG`` carrying a command id that
       :mod:`app.mavlink.command_service` has already validated against its
       allowlist;
    3. a ``SET_POSITION_TARGET_LOCAL_NED`` velocity setpoint produced solely by
       the separately retained GUIDED-mode velocity feature;
    4. an ``RC_CHANNELS_OVERRIDE`` for channels 1--8 produced by the manual
       pilot service; and
    5. a read-only ``PARAM_REQUEST_READ`` used to discover the vehicle's RC
       mapping, calibration, and override-failsafe configuration.

    A caller cannot use this interface to transmit an arbitrary MAVLink
    message even if it wanted to.

    (A ``SET_MODE`` sender is deliberately absent. Mode changes go through
    ``COMMAND_LONG``/``MAV_CMD_DO_SET_MODE`` instead, because that path returns
    a ``COMMAND_ACK`` the command service can check — bare ``SET_MODE`` is
    unacknowledged, so a failure would be invisible.)

    Still deliberately absent, and not to be added without a separate reviewed
    change: ``MANUAL_CONTROL``, ``PARAM_SET``, ``SET_ATTITUDE_TARGET``,
    ``MAV_CMD_DO_SET_SERVO`` and anything that commands motors directly.
    """

    @property
    @abc.abstractmethod
    def is_open(self) -> bool:
        """Whether the transport currently holds its resource."""

    @abc.abstractmethod
    def open(self) -> None:
        """Acquire the transport.

        Raises:
            PortBusyError: another process owns the port.
            PortNotFoundError: the port does not exist.
            LinkError: any other transport failure.
        """

    @abc.abstractmethod
    def close(self) -> None:
        """Release the transport. Must be idempotent and must not raise."""

    @abc.abstractmethod
    def receive(self, timeout: float) -> Iterator[ReceivedMessage]:
        """Yield messages that arrived within ``timeout`` seconds.

        Must return (possibly empty) rather than block indefinitely, so the
        worker thread can honour a shutdown request promptly.
        """

    @abc.abstractmethod
    def send_gcs_heartbeat(self) -> None:
        """Transmit one MAV_TYPE_GCS / MAV_AUTOPILOT_INVALID heartbeat."""

    @abc.abstractmethod
    def send_command_long(
        self,
        *,
        target_system: int,
        target_component: int,
        command: int,
        params: tuple[float, float, float, float, float, float, float],
    ) -> None:
        """Transmit COMMAND_LONG for an allowlisted command id."""

    @abc.abstractmethod
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
        """Transmit one ``SET_POSITION_TARGET_LOCAL_NED`` velocity setpoint.

        Body frame (``MAV_FRAME_BODY_NED``), velocity + yaw-rate only. Units
        and signs are MAVLink's, already converted and clamped by
        :func:`app.mavlink.pilot_limits.normalized_to_velocity`:

        * ``vx`` m/s, positive forward
        * ``vy`` m/s, positive right
        * ``vz`` m/s, positive **down** (so a climb is negative)
        * ``yaw_rate`` rad/s, positive nose-right

        Implementations must not re-scale or re-interpret these values; the
        limit boundary is :mod:`app.mavlink.pilot_limits`, and duplicating it
        here would create a second place for the aircraft's top speed to live.
        """

    @abc.abstractmethod
    def send_rc_channels_override(
        self,
        *,
        target_system: int,
        target_component: int,
        channels: tuple[int, int, int, int, int, int, int, int],
    ) -> None:
        """Transmit one ``RC_CHANNELS_OVERRIDE`` for channels 1--8.

        Values use MAVLink's first-eight-channel semantics: ``0`` releases a
        channel to the normal receiver, ``65535`` leaves its existing input
        unchanged, and any other unsigned 16-bit value is the requested PWM.
        Channels 9--18 are deliberately outside this contract and therefore
        remain ignored.
        """

    @abc.abstractmethod
    def send_parameter_request(
        self,
        *,
        target_system: int,
        target_component: int,
        name: str,
    ) -> None:
        """Request one parameter by name with ``PARAM_REQUEST_READ``.

        This is intentionally a read-only operation. No parameter-write method
        exists on the transport contract.
        """

    @abc.abstractmethod
    def describe(self) -> dict[str, Any]:
        """Transport details for the status endpoint (port, baud, mode, ...)."""
