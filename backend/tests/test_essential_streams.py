"""Automatic essential telemetry stream requests.

On real hardware, ArduPilot (and most autopilots) only ever emits HEARTBEAT
(and, from ArduPilot, TIMESYNC) to a freshly connected ground station until
that GCS explicitly asks for anything else via ``MAV_CMD_SET_MESSAGE_INTERVAL``.
This is what made a real COM10 connection previously show STABILIZE/DISARMED
correctly (from HEARTBEAT alone) while battery, GPS, attitude and VFR_HUD
stayed null forever -- nothing ever asked for them.

``LinkManager`` now sends that request burst automatically, right after the
first vehicle HEARTBEAT of every connection *and* every reconnect, with no
operator action and no ``SUISUI_MAVLINK_ALLOW_SAFE_COMMANDS`` requirement.

Every test here runs against ``MockMavlinkLink``, so it proves the
``LinkManager`` orchestration is correct without needing real hardware.
``mock_connection.py``'s generic ``COMMAND_LONG`` handling (falls through to
an ACCEPTED ack for any command it does not special-case) exercises the exact
same code path a real ArduCopter 4.5 would for ``MAV_CMD_SET_MESSAGE_INTERVAL``.
"""

from __future__ import annotations

import time

from app.config import Settings
from app.mavlink import constants
from app.mavlink.interface import LinkError
from app.mavlink.link_manager import LinkManager, StreamRequestTracker
from app.mavlink.mock_connection import MockMavlinkLink, MockScenario
from app.mavlink.telemetry_state import ConnectionState

from .conftest import wait_until

# The exact table required by the fix: name -> (message id, interval µs).
# RC_CHANNELS was added later so "RC INPUT SEEN BY PIXHAWK" in Manual Control
# reflects the vehicle's own reported RC input, not just what the browser
# intended to send -- see the RC-input diagnostics work in pilot_service.py.
REQUIRED_RATES: dict[str, tuple[int, int]] = {
    "SYS_STATUS": (1, 1_000_000),
    "GPS_RAW_INT": (24, 500_000),
    "ATTITUDE": (30, 100_000),
    "GLOBAL_POSITION_INT": (33, 200_000),
    "VFR_HUD": (74, 500_000),
    "BATTERY_STATUS": (147, 1_000_000),
    "RC_CHANNELS": (65, 200_000),
}


def stream_calls(mock_link: MockMavlinkLink) -> list[dict]:
    """Only the SET_MESSAGE_INTERVAL entries from the mock's command log."""
    return [
        call
        for call in mock_link.command_long_log
        if call["command"] == constants.MAV_CMD_SET_MESSAGE_INTERVAL
    ]


# ----------------------------------------------------------------------
# 1. The expected message IDs and intervals are requested
# ----------------------------------------------------------------------


def test_the_constant_table_matches_the_required_rates_exactly() -> None:
    actual = {name: (msg_id, interval_us) for name, msg_id, interval_us in constants.ESSENTIAL_TELEMETRY_STREAMS}
    assert actual == REQUIRED_RATES


def test_the_constant_table_names_are_exactly_the_seven_required_streams() -> None:
    names = [name for name, _, _ in constants.ESSENTIAL_TELEMETRY_STREAMS]
    assert names == [
        "SYS_STATUS",
        "GPS_RAW_INT",
        "ATTITUDE",
        "GLOBAL_POSITION_INT",
        "VFR_HUD",
        "BATTERY_STATUS",
        "RC_CHANNELS",
    ]


def test_a_real_connection_requests_exactly_the_required_message_ids_and_intervals(
    manager: LinkManager, mock_link: MockMavlinkLink
) -> None:
    manager.connect()
    assert wait_until(lambda: manager.state.get_connection_state() is ConnectionState.CONNECTED)
    assert wait_until(lambda: len(stream_calls(mock_link)) >= 6)

    sent = {(call["params"][0], call["params"][1]) for call in stream_calls(mock_link)}
    expected = {(float(msg_id), float(interval_us)) for _, msg_id, interval_us in constants.ESSENTIAL_TELEMETRY_STREAMS}
    assert sent == expected


def test_every_essential_stream_request_uses_command_511(manager: LinkManager, mock_link: MockMavlinkLink) -> None:
    manager.connect()
    assert wait_until(lambda: len(mock_link.command_long_log) >= 6)
    assert all(call["command"] == constants.MAV_CMD_SET_MESSAGE_INTERVAL for call in mock_link.command_long_log)


def test_stream_requests_carry_zero_in_every_unused_param(manager: LinkManager, mock_link: MockMavlinkLink) -> None:
    manager.connect()
    assert wait_until(lambda: len(stream_calls(mock_link)) >= 6)
    for call in stream_calls(mock_link):
        assert call["params"][2:] == (0.0, 0.0, 0.0, 0.0, 0.0)


def test_stream_requests_address_the_configured_target_system_and_the_detected_component(
    manager: LinkManager, mock_link: MockMavlinkLink, settings: Settings
) -> None:
    manager.connect()
    assert wait_until(lambda: len(stream_calls(mock_link)) >= 6)
    for call in stream_calls(mock_link):
        assert call["target_system"] == settings.target_system
        # The vehicle's own HEARTBEAT in mock mode reports component 1; this
        # proves the request used the *detected* component (via
        # TelemetryState.target_component), not just settings.target_component
        # blindly -- see the "component 0" test below for the fallback case.
        assert call["target_component"] == mock_link.describe()["targetComponent"]


def test_stream_requests_fall_back_to_the_configured_component_when_the_vehicle_reports_zero(
    settings: Settings,
) -> None:
    """Preserves the repo's existing component-0 handling.

    ArduPilot normally answers on component 1; some configurations report 0.
    TelemetryState.target_component() already prefers whatever the vehicle's
    own HEARTBEAT reports (even 0, since it is a valid int) and only falls
    back to the configured value when nothing has been observed yet. This
    proves the new stream-request code goes through that exact mechanism
    rather than reimplementing its own component selection.
    """
    link = MockMavlinkLink(target_system=1, target_component=0)
    manager = LinkManager(settings, lambda: link)
    try:
        manager.connect()
        assert wait_until(lambda: len(stream_calls(link)) >= 6)
        for call in stream_calls(link):
            assert call["target_component"] == 0
    finally:
        manager.shutdown()


# ----------------------------------------------------------------------
# 2. Requests happen after heartbeat
# ----------------------------------------------------------------------


def test_no_stream_requests_exist_before_a_connection_is_ever_started(mock_link: MockMavlinkLink) -> None:
    assert mock_link.command_long_log == []


def test_stream_requests_are_sent_only_once_the_link_is_connected(
    manager: LinkManager, mock_link: MockMavlinkLink
) -> None:
    """The transition to CONNECTED only ever happens on the first vehicle
    HEARTBEAT (see LinkManager._session), so requests appearing once that
    state is reached demonstrates the "after heartbeat" ordering without
    depending on sub-millisecond timing."""
    manager.connect()
    assert wait_until(lambda: manager.state.get_connection_state() is ConnectionState.CONNECTED)
    assert wait_until(lambda: len(stream_calls(mock_link)) == 7)


# ----------------------------------------------------------------------
# 3. Requests happen again after every successful reconnect
# ----------------------------------------------------------------------


def test_streams_are_requested_again_after_a_manual_disconnect_and_reconnect(
    manager: LinkManager, mock_link: MockMavlinkLink
) -> None:
    manager.connect()
    assert wait_until(lambda: len(stream_calls(mock_link)) >= 7)
    first_batch = len(mock_link.command_long_log)

    manager.disconnect()
    manager.connect()
    assert wait_until(lambda: len(stream_calls(mock_link)) >= first_batch + 7)

    second_batch = mock_link.command_long_log[first_batch:]
    assert len(second_batch) == 7
    assert all(call["command"] == constants.MAV_CMD_SET_MESSAGE_INTERVAL for call in second_batch)


def test_streams_are_requested_again_after_the_manager_auto_reconnects() -> None:
    """Force the internal retry loop itself, not a manual disconnect/connect.

    Mirrors the existing auto-reconnect test pattern
    (test_link_manager.py::test_auto_reconnect_retries_after_a_failed_open): a
    factory whose first link fails to open, and whose second attempt succeeds.
    """
    settings = Settings(
        mode="mock",
        heartbeat_interval=0.2,
        stale_timeout=1.0,
        link_lost_timeout=2.0,
        connect_timeout=2.0,
        reconnect_delay=0.2,
        auto_reconnect=True,
        allow_safe_commands=True,
        command_timeout=1.0,
    )
    links: list[MockMavlinkLink] = []

    def factory() -> MockMavlinkLink:
        if not links:
            link = MockMavlinkLink(scenario=MockScenario(fail_open_with=LinkError("radio not ready")))
        else:
            link = MockMavlinkLink()
        links.append(link)
        return link

    manager = LinkManager(settings, factory)
    try:
        manager.connect(settle_timeout=0.5)
        assert wait_until(lambda: manager.state.get_connection_state() is ConnectionState.CONNECTED, timeout=5.0)
        assert len(links) >= 2, "the manager must have retried onto a second link instance"
        assert wait_until(lambda: len(stream_calls(links[-1])) >= 6, timeout=3.0)
        # And the failed first attempt never got the chance to send anything.
        assert stream_calls(links[0]) == []
    finally:
        manager.shutdown()


# ----------------------------------------------------------------------
# 4. Mock mode does not require real MAVLink commands
# ----------------------------------------------------------------------


def test_mock_telemetry_flows_from_its_own_schedule_even_if_every_stream_request_is_denied(
    settings: Settings,
) -> None:
    """The mock link's built-in telemetry schedule (mock_connection.py's
    _StreamSchedule) is independent of MAV_CMD_SET_MESSAGE_INTERVAL -- unlike
    real hardware, it streams unconditionally. This proves the new mechanism
    does not become a hidden dependency for mock-mode development/tests."""
    link = MockMavlinkLink(scenario=MockScenario(reject_commands=6))
    manager = LinkManager(settings, lambda: link)
    try:
        manager.connect()
        assert wait_until(lambda: manager.state.get_connection_state() is ConnectionState.CONNECTED)
        assert wait_until(lambda: manager.state.snapshot()["battery"]["voltage"] is not None)
        snapshot = manager.state.snapshot()
        assert snapshot["gps"]["fixTypeName"] == "3D_FIX"
        assert snapshot["attitude"]["roll"] is not None
    finally:
        manager.shutdown()


# ----------------------------------------------------------------------
# 5. Read-only mode still requests telemetry
# ----------------------------------------------------------------------


def test_read_only_backend_still_sends_the_essential_stream_requests(mock_link: MockMavlinkLink) -> None:
    read_only = Settings(
        mode="mock",
        allow_safe_commands=False,  # the read-only default
        heartbeat_interval=0.2,
        stale_timeout=1.0,
        link_lost_timeout=2.0,
        command_timeout=1.0,
    )
    assert read_only.allow_safe_commands is False
    manager = LinkManager(read_only, lambda: mock_link)
    try:
        manager.connect()
        assert wait_until(lambda: len(stream_calls(mock_link)) >= 6)
    finally:
        manager.shutdown()


# ----------------------------------------------------------------------
# 6. Telemetry bootstrap still contains no command-service or actuator path
# ----------------------------------------------------------------------


def test_no_dangerous_command_names_appear_in_the_link_manager_source() -> None:
    import inspect

    from app.mavlink import link_manager as link_manager_module

    source = inspect.getsource(link_manager_module)
    forbidden = (
        "COMPONENT_ARM_DISARM",
        "ARM_DISARM",
        "NAV_TAKEOFF",
        "NAV_LAND",
        "NAV_RETURN_TO_LAUNCH",
        "DO_MOTOR_TEST",
        "rc_channels_override_send",
        "SET_POSITION_TARGET",
        "SET_ATTITUDE_TARGET",
    )
    for token in forbidden:
        assert token not in source, f"{token} must not appear in link_manager.py"


def test_the_transport_exposes_only_the_reviewed_senders() -> None:
    """Guards against a new send_* method being added to smuggle in a second,
    less-restricted transmit path.

    ``send_velocity_setpoint`` was added deliberately for pilot control (see
    ``app.mavlink.pilot_service``); it emits SET_POSITION_TARGET_LOCAL_NED,
    which ArduPilot's own controllers execute. Anything beyond these three
    needs its own review.
    """
    from app.mavlink.interface import MavlinkLink

    senders = {name for name in dir(MavlinkLink) if name.startswith("send")}
    assert senders == {
        "send_gcs_heartbeat",
        "send_command_long",
        "send_velocity_setpoint",
        "send_rc_channels_override",
        "send_parameter_request",
    }


def test_essential_streams_are_all_known_read_only_telemetry_message_types() -> None:
    allowed_names = {
        "SYS_STATUS",
        "GPS_RAW_INT",
        "ATTITUDE",
        "GLOBAL_POSITION_INT",
        "VFR_HUD",
        "BATTERY_STATUS",
        "RC_CHANNELS",
    }
    names = {name for name, _, _ in constants.ESSENTIAL_TELEMETRY_STREAMS}
    assert names == allowed_names, "only read-only telemetry message types may be requested automatically"


def test_essential_stream_bootstrap_is_not_gated_by_the_allow_safe_commands_flag() -> None:
    """The gate lives only in CommandService; LinkManager must never read it
    for this feature, or a future edit could silently reintroduce the gate
    this fix is required to bypass."""
    import inspect

    source = inspect.getsource(LinkManager._request_essential_streams)
    assert "allow_safe_commands" not in source


# ----------------------------------------------------------------------
# 7. Duplicate heartbeats do not continuously resend requests
# ----------------------------------------------------------------------


def test_duplicate_heartbeats_do_not_resend_stream_requests(manager: LinkManager, mock_link: MockMavlinkLink) -> None:
    manager.connect()
    assert wait_until(lambda: len(stream_calls(mock_link)) >= 6)
    count_after_first_batch = len(mock_link.command_long_log)

    # The mock keeps emitting a fresh HEARTBEAT every heartbeat_interval
    # (0.2s in the `settings` fixture); let several more go by.
    time.sleep(1.5)  # several more heartbeat_interval cycles (0.2s each in `settings`)

    assert len(mock_link.command_long_log) == count_after_first_batch


# ----------------------------------------------------------------------
# 8. The request sequence does not stop GCS heartbeat transmission
# ----------------------------------------------------------------------


def test_gcs_heartbeat_keeps_incrementing_while_and_after_streams_are_requested(manager: LinkManager) -> None:
    manager.connect()
    assert wait_until(lambda: manager.state.get_connection_state() is ConnectionState.CONNECTED)
    first_count = manager.snapshot()["link"]["gcsHeartbeatsSent"]
    assert first_count >= 1, "the GCS heartbeat must already be flowing by the time the link is connected"
    assert wait_until(lambda: manager.snapshot()["link"]["gcsHeartbeatsSent"] > first_count, timeout=3.0)


def test_essential_stream_request_burst_completes_well_within_one_heartbeat_interval(
    manager: LinkManager, mock_link: MockMavlinkLink, settings: Settings
) -> None:
    """A blocked burst would show up as a large gap between connect and the
    first heartbeat after CONNECTED; this bounds that gap generously."""
    started = time.monotonic()
    manager.connect()
    assert wait_until(lambda: len(stream_calls(mock_link)) >= 6, timeout=2.0)
    elapsed = time.monotonic() - started
    assert elapsed < settings.heartbeat_interval * 5


# ----------------------------------------------------------------------
# COMMAND_ACK handling: correlate, log, never fail the connection over one
# unsupported optional stream; error only when every one fails
# ----------------------------------------------------------------------


def test_accepted_stream_requests_never_set_a_backend_error(manager: LinkManager, mock_link: MockMavlinkLink) -> None:
    manager.connect()
    assert wait_until(lambda: len(stream_calls(mock_link)) >= 6)
    time.sleep(0.5)  # let the (accepted-by-default) acks arrive and be processed
    assert manager.state.snapshot()["error"] is None


def test_a_single_rejected_optional_stream_does_not_set_a_backend_error(settings: Settings) -> None:
    # reject_commands decrements per send_command_long call; with nothing else
    # transmitting during connect, this denies only the first of the six.
    link = MockMavlinkLink(scenario=MockScenario(reject_commands=1))
    manager = LinkManager(settings, lambda: link)
    try:
        manager.connect()
        assert wait_until(lambda: len(stream_calls(link)) >= 6)
        time.sleep(0.5)
        assert manager.state.snapshot()["error"] is None
    finally:
        manager.shutdown()


def test_every_essential_stream_rejected_sets_one_clear_backend_error(settings: Settings) -> None:
    link = MockMavlinkLink(scenario=MockScenario(reject_commands=7))
    manager = LinkManager(settings, lambda: link)
    try:
        manager.connect()
        assert wait_until(lambda: len(stream_calls(link)) >= 7)
        assert wait_until(lambda: manager.state.snapshot()["error"] is not None, timeout=3.0)
        error = manager.state.snapshot()["error"]
        assert error["kind"] == "stream_request"
        assert "telemetry" in error["message"].lower()
    finally:
        manager.shutdown()


def test_a_rejected_stream_does_not_abort_the_session_or_stop_the_heartbeat(settings: Settings) -> None:
    link = MockMavlinkLink(scenario=MockScenario(reject_commands=6))
    manager = LinkManager(settings, lambda: link)
    try:
        manager.connect()
        assert wait_until(lambda: manager.state.get_connection_state() is ConnectionState.CONNECTED)
        first_count = manager.snapshot()["link"]["gcsHeartbeatsSent"]
        assert wait_until(lambda: manager.snapshot()["link"]["gcsHeartbeatsSent"] > first_count, timeout=3.0)
        # Still connected, not kicked into ERROR/reconnect over an optional
        # (if all-failing) stream-request outcome.
        assert manager.state.get_connection_state() is ConnectionState.CONNECTED
    finally:
        manager.shutdown()


def test_a_stream_ack_that_never_arrives_still_resolves_via_the_deadline(settings: Settings) -> None:
    """drop_acks: the vehicle accepts (applies) the request but never sends a
    COMMAND_ACK for it -- must not hang the tracker forever."""
    short_timeout = Settings(
        mode="mock",
        heartbeat_interval=settings.heartbeat_interval,
        stale_timeout=settings.stale_timeout,
        link_lost_timeout=settings.link_lost_timeout,
        allow_safe_commands=True,
        command_timeout=0.5,
    )
    link = MockMavlinkLink(scenario=MockScenario(drop_acks=7))
    manager = LinkManager(short_timeout, lambda: link)
    try:
        manager.connect()
        assert wait_until(lambda: len(stream_calls(link)) >= 7)
        assert wait_until(lambda: manager.state.snapshot()["error"] is not None, timeout=3.0)
        assert manager.state.snapshot()["error"]["kind"] == "stream_request"
    finally:
        manager.shutdown()


# ----------------------------------------------------------------------
# StreamRequestTracker unit behaviour (isolated from the worker thread)
# ----------------------------------------------------------------------


def test_tracker_correlates_acks_in_send_order() -> None:
    tracker = StreamRequestTracker()
    tracker.reset()
    tracker.record_sent("SYS_STATUS")
    tracker.record_sent("GPS_RAW_INT")

    matched = tracker.offer({"resultName": "ACCEPTED"})
    assert matched == "SYS_STATUS"
    matched = tracker.offer({"resultName": "UNSUPPORTED"})
    assert matched == "GPS_RAW_INT"

    assert tracker.results == {"SYS_STATUS": "ACCEPTED", "GPS_RAW_INT": "UNSUPPORTED"}
    assert tracker.all_resolved is True


def test_tracker_offer_returns_none_when_nothing_is_pending() -> None:
    tracker = StreamRequestTracker()
    tracker.reset()
    assert tracker.offer({"resultName": "ACCEPTED"}) is None


def test_tracker_transmit_failure_is_recorded_without_expecting_an_ack() -> None:
    tracker = StreamRequestTracker()
    tracker.reset()
    tracker.record_transmit_failed("VFR_HUD")
    assert tracker.results == {"VFR_HUD": "TRANSMIT_FAILED"}
    assert tracker.all_resolved is True


def test_tracker_expire_pending_resolves_every_outstanding_entry() -> None:
    tracker = StreamRequestTracker()
    tracker.reset()
    tracker.record_sent("ATTITUDE")
    tracker.record_sent("VFR_HUD")
    tracker.expire_pending()
    assert tracker.results == {"ATTITUDE": "NO_ACK", "VFR_HUD": "NO_ACK"}
    assert tracker.all_resolved is True


def test_tracker_reset_discards_previous_results() -> None:
    tracker = StreamRequestTracker()
    tracker.reset()
    tracker.record_sent("SYS_STATUS")
    tracker.offer({"resultName": "ACCEPTED"})
    assert tracker.results

    tracker.reset()
    assert tracker.results == {}
    assert tracker.all_resolved is True
