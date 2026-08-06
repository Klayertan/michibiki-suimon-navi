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
    interface can produce exactly two kinds of outbound frame: a GCS heartbeat,
    and a ``COMMAND_LONG`` carrying a command id that
    :mod:`app.mavlink.command_service` has already validated against its
    allowlist. A caller cannot use this interface to transmit an arbitrary
    MAVLink message even if it wanted to.

    (A ``SET_MODE`` sender is deliberately absent. Mode changes go through
    ``COMMAND_LONG``/``MAV_CMD_DO_SET_MODE`` instead, because that path returns
    a ``COMMAND_ACK`` the command service can check — bare ``SET_MODE`` is
    unacknowledged, so a failure would be invisible.)
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
    def describe(self) -> dict[str, Any]:
        """Transport details for the status endpoint (port, baud, mode, ...)."""
