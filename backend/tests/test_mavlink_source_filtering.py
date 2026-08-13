"""Target-address filtering for safety-relevant MAVLink replies and state."""

from __future__ import annotations

from app.config import Settings
from app.mavlink.constants import MAV_CMD_COMPONENT_ARM_DISARM, MAV_MODE_FLAG_SAFETY_ARMED
from app.mavlink.interface import ReceivedMessage
from app.mavlink.link_manager import LinkManager
from app.mavlink.mock_connection import MockMavlinkLink, MockMessage


def received(message: MockMessage, *, system_id: int = 1, component_id: int = 1) -> ReceivedMessage:
    return ReceivedMessage(message=message, system_id=system_id, component_id=component_id)


def heartbeat(*, armed: bool) -> MockMessage:
    return MockMessage(
        "HEARTBEAT",
        type=2,
        autopilot=3,
        base_mode=MAV_MODE_FLAG_SAFETY_ARMED if armed else 0,
        custom_mode=0,
        system_status=4,
    )


def ack() -> MockMessage:
    return MockMessage("COMMAND_ACK", command=MAV_CMD_COMPONENT_ARM_DISARM, result=0)


def parameter(value: float) -> MockMessage:
    return MockMessage(
        "PARAM_VALUE",
        param_id="RCMAP_ROLL",
        param_value=value,
        param_type=9,
        param_count=1,
        param_index=0,
    )


def build_manager(settings: Settings) -> LinkManager:
    return LinkManager(settings, lambda: MockMavlinkLink())


def test_wrong_system_ack_cannot_satisfy_target_command_waiter(settings: Settings) -> None:
    manager = build_manager(settings)
    waiter = manager.register_ack_waiter(MAV_CMD_COMPONENT_ARM_DISARM)

    assert manager._apply(received(ack(), system_id=42)) is None
    assert waiter.wait(0) is None

    assert manager._apply(received(ack())) == "COMMAND_ACK"
    assert waiter.wait(0) == {
        "command": MAV_CMD_COMPONENT_ARM_DISARM,
        "result": 0,
        "resultName": "ACCEPTED",
        "accepted": True,
    }


def test_wrong_system_heartbeat_cannot_confirm_target_armed_state(settings: Settings) -> None:
    manager = build_manager(settings)
    assert manager._apply(received(heartbeat(armed=False))) == "HEARTBEAT"
    waiter = manager.register_arm_state_waiter(True)

    assert manager._apply(received(heartbeat(armed=True), system_id=42)) is None
    assert waiter.wait(0) is None
    assert manager.state.is_armed() is False

    assert manager._apply(received(heartbeat(armed=True))) == "HEARTBEAT"
    assert waiter.wait(0) is True
    assert manager.state.is_armed() is True


def test_wrong_system_parameter_cannot_poison_target_cache(settings: Settings) -> None:
    manager = build_manager(settings)

    assert manager._apply(received(parameter(42.0), system_id=42)) is None
    assert manager.state.get_parameters() == {}
    rejected_snapshot = manager.snapshot()
    assert rejected_snapshot["link"]["totalMessages"] == 0
    assert rejected_snapshot["link"]["lastMessageAt"] is None

    assert manager._apply(received(parameter(1.0))) == "PARAM_VALUE"
    assert manager.state.get_parameters() == {"RCMAP_ROLL": 1.0}


def test_first_target_heartbeat_discovers_component_then_filters_other_components(
    settings: Settings,
) -> None:
    manager = build_manager(settings)

    assert manager._apply(received(heartbeat(armed=False), component_id=0)) == "HEARTBEAT"
    assert manager.state.target_component(settings.target_component) == 0

    waiter = manager.register_ack_waiter(MAV_CMD_COMPONENT_ARM_DISARM)
    assert manager._apply(received(ack(), component_id=42)) is None
    assert waiter.wait(0) is None
    assert manager._apply(received(ack(), component_id=0)) == "COMMAND_ACK"
    assert waiter.wait(0) is not None
