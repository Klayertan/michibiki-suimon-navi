"""Exact real/mock MAVLink framing for the reviewed manual-control boundary."""

from __future__ import annotations

import pytest

from app.mavlink import constants
from app.mavlink.mock_connection import MockMavlinkLink, MockScenario
from app.mavlink.real_connection import RealMavlinkLink


class SpyMav:
    def __init__(self) -> None:
        self.rc_calls: list[tuple[object, ...]] = []
        self.param_calls: list[tuple[object, ...]] = []

    def rc_channels_override_send(self, *args: object) -> None:
        self.rc_calls.append(args)

    def param_request_read_send(self, *args: object) -> None:
        self.param_calls.append(args)


class SpyConnection:
    def __init__(self) -> None:
        self.mav = SpyMav()


def real_link_with_spy() -> tuple[RealMavlinkLink, SpyConnection]:
    link = RealMavlinkLink(
        port="TEST-NOT-A-PORT",
        baud=57600,
        source_system=255,
        source_component=190,
        target_system=1,
        target_component=1,
    )
    connection = SpyConnection()
    # No serial open: install a protocol spy directly at the already-tested
    # pymavlink boundary.
    link._connection = connection  # type: ignore[attr-defined]
    return link, connection


def test_real_override_sender_passes_exactly_target_plus_first_eight_channels() -> None:
    link, connection = real_link_with_spy()
    channels = (0, 0, 0, 0, 0, 0, 0, 0)
    link.send_rc_channels_override(target_system=1, target_component=2, channels=channels)
    assert connection.mav.rc_calls == [(1, 2, *channels)]


@pytest.mark.parametrize(
    "channels",
    [
        (0, 0, 0, 0, 0, 0, 0),
        (0, 0, 0, 0, 0, 0, 0, 65536),
        (0, 0, 0, 0, 0, 0, 0, -1),
        (0, 0, 0, 0, 0, 0, 0, True),
    ],
)
def test_real_override_sender_rejects_malformed_channel_payload(channels: tuple[object, ...]) -> None:
    link, connection = real_link_with_spy()
    with pytest.raises(ValueError):
        link.send_rc_channels_override(  # type: ignore[arg-type]
            target_system=1,
            target_component=1,
            channels=channels,
        )
    assert connection.mav.rc_calls == []


def test_real_parameter_discovery_uses_request_read_by_name() -> None:
    link, connection = real_link_with_spy()
    link.send_parameter_request(
        target_system=1,
        target_component=1,
        name="RC_OVERRIDE_TIME",
    )
    assert connection.mav.param_calls == [(1, 1, b"RC_OVERRIDE_TIME", -1)]


def test_mock_parameter_request_returns_param_value_and_records_read() -> None:
    link = MockMavlinkLink(scenario=MockScenario(parameters={"RC_OVERRIDE_TIME": 2.5}))
    link.open()
    try:
        link.send_parameter_request(
            target_system=1,
            target_component=1,
            name="RC_OVERRIDE_TIME",
        )
        received = list(link.receive(0.05))
        param = next(item.message for item in received if item.message.get_type() == "PARAM_VALUE")
        assert param.param_id == b"RC_OVERRIDE_TIME"
        assert param.param_value == 2.5
        assert link.parameter_request_log[-1]["name"] == "RC_OVERRIDE_TIME"
    finally:
        link.close()


def test_mock_rejects_any_nonzero_arm_param2_without_state_change() -> None:
    link = MockMavlinkLink()
    link.open()
    try:
        link.send_command_long(
            target_system=1,
            target_component=1,
            command=constants.MAV_CMD_COMPONENT_ARM_DISARM,
            params=(1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0),
        )
        received = list(link.receive(0.05))
        ack = next(item.message for item in received if item.message.get_type() == "COMMAND_ACK")
        assert ack.result == 2
        assert link.describe()["simulatedArmed"] is False
    finally:
        link.close()
