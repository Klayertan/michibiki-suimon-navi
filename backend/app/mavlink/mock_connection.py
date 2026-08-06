"""A simulated ArduCopter link.

This is the default transport. It lets the whole stack -- normalization, state
machine, heartbeat, commands, WebSocket, and the browser UI -- be developed and
tested with no aircraft powered, no propellers anywhere near a motor, and no
serial port opened.

The simulation is deliberately imperfect in useful ways: it can drop the link,
let telemetry go stale, refuse to open, and reject commands, because those are
the paths that must work correctly when they happen for real.

It never imports pymavlink and never touches hardware.
"""

from __future__ import annotations

import logging
import math
import random
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Iterator

from . import constants
from .interface import LinkError, MavlinkLink, ReceivedMessage

logger = logging.getLogger(__name__)

#: A plausible paddy-field location in the Nara area, used so the map shows a
#: sensible place during mock runs. Not a real survey point.
DEFAULT_MOCK_LAT = 34.5400
DEFAULT_MOCK_LON = 135.7350
DEFAULT_MOCK_ALT_MSL = 62.0


class MockMessage:
    """Minimal stand-in for a pymavlink message object."""

    def __init__(self, msg_type: str, **fields: Any) -> None:
        self._type = msg_type
        for key, value in fields.items():
            setattr(self, key, value)

    def get_type(self) -> str:
        return self._type

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"MockMessage({self._type})"


@dataclass
class MockScenario:
    """Knobs that let a test or a demo drive the simulated vehicle.

    Every field defaults to "healthy vehicle, nothing unusual", so a plain
    ``MockScenario()`` produces a well-behaved aircraft.
    """

    #: Raise this on the next :meth:`MockMavlinkLink.open` instead of opening.
    fail_open_with: Exception | None = None
    #: Seconds of silence to inject, starting at the next receive() call.
    link_loss_seconds: float = 0.0
    #: Report the vehicle as armed. Used to test the armed-state refusal path.
    armed: bool = False
    #: Reject the next N commands with MAV_RESULT_DENIED.
    reject_commands: int = 0
    #: Do not acknowledge the next N commands at all (tests the ACK timeout).
    drop_acks: int = 0
    #: Starting flight mode.
    mode: str = "STABILIZE"
    #: Starting pack voltage, volts. Drains slowly during a session.
    voltage: float = 16.2
    #: Satellites reported by the simulated receiver.
    satellites: int = 14
    #: GPS fix type; 3 == 3D_FIX. Set to 1 to simulate an indoor no-fix run.
    fix_type: int = 3
    lat: float = DEFAULT_MOCK_LAT
    lon: float = DEFAULT_MOCK_LON
    seed: int = 20260804


@dataclass
class _StreamSchedule:
    """When each simulated message type is next due."""

    intervals: dict[str, float] = field(
        default_factory=lambda: {
            "HEARTBEAT": 1.0,
            "SYS_STATUS": 1.0,
            "GPS_RAW_INT": 1.0,
            "ATTITUDE": 0.25,
            "VFR_HUD": 0.5,
            "GLOBAL_POSITION_INT": 0.5,
        }
    )
    next_due: dict[str, float] = field(default_factory=dict)

    def initialise(self, now: float) -> None:
        self.next_due = {name: now for name in self.intervals}

    def due(self, now: float) -> list[str]:
        ready = [name for name, due_at in self.next_due.items() if due_at <= now]
        for name in ready:
            self.next_due[name] = now + self.intervals[name]
        return ready

    def next_wakeup(self, now: float) -> float:
        if not self.next_due:
            return 0.05
        return max(0.0, min(self.next_due.values()) - now)


class MockMavlinkLink(MavlinkLink):
    """Simulated ArduCopter 4.5 on a Holybro X500 V2 airframe."""

    def __init__(
        self,
        *,
        target_system: int = 1,
        target_component: int = 1,
        scenario: MockScenario | None = None,
    ) -> None:
        self._target_system = target_system
        self._target_component = target_component
        self._scenario = scenario or MockScenario()
        self._random = random.Random(self._scenario.seed)
        self._open = False
        self._started_at = 0.0
        self._schedule = _StreamSchedule()
        self._pending: list[ReceivedMessage] = []
        self._silence_until = 0.0
        self._wake = threading.Event()
        self._boot_ms = 0
        self._mode = self._scenario.mode
        self._armed = self._scenario.armed
        self._gcs_heartbeats = 0
        self._announced_boot = False
        #: Every send_command_long() call, in order, regardless of outcome --
        #: lets tests assert exactly what was requested (message ids, rates,
        #: targets) without needing real hardware. Never cleared automatically,
        #: including across a disconnect/reconnect of the same instance, so a
        #: test can inspect the full history of a multi-session run.
        self.command_long_log: list[dict[str, Any]] = []

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    @property
    def is_open(self) -> bool:
        return self._open

    def open(self) -> None:
        if self._scenario.fail_open_with is not None:
            error = self._scenario.fail_open_with
            self._scenario.fail_open_with = None
            logger.warning("mock link refusing to open: %s", error)
            raise error
        now = time.monotonic()
        self._open = True
        self._started_at = now
        self._schedule.initialise(now)
        self._announced_boot = False
        if self._scenario.link_loss_seconds > 0:
            self._silence_until = now + self._scenario.link_loss_seconds
        logger.info("mock MAVLink link opened (simulated ArduCopter, system %d)", self._target_system)

    def close(self) -> None:
        self._open = False
        self._pending.clear()
        self._wake.set()
        logger.info("mock MAVLink link closed")

    # ------------------------------------------------------------------
    # Scenario control (used by tests and the demo endpoints)
    # ------------------------------------------------------------------

    def inject_link_loss(self, seconds: float) -> None:
        """Silence the simulated radio for ``seconds``."""
        self._silence_until = time.monotonic() + seconds
        logger.info("mock link: injecting %.1fs of silence", seconds)

    def set_armed(self, armed: bool) -> None:
        """Make the simulated vehicle report armed/disarmed.

        This only changes what the *simulation* reports. It does not and cannot
        arm anything -- there is no arming code path in this backend.
        """
        self._armed = armed

    def reject_next_commands(self, count: int = 1) -> None:
        self._scenario.reject_commands = count

    def drop_next_acks(self, count: int = 1) -> None:
        self._scenario.drop_acks = count

    # ------------------------------------------------------------------
    # Receive
    # ------------------------------------------------------------------

    def receive(self, timeout: float) -> Iterator[ReceivedMessage]:
        if not self._open:
            return iter(())

        now = time.monotonic()
        if self._pending:
            return iter(self._drain())

        if now < self._silence_until:
            # Simulated radio dropout: consume the timeout without producing
            # anything, which is exactly what a real dead link looks like.
            self._wake.wait(min(timeout, self._silence_until - now))
            self._wake.clear()
            self._schedule.initialise(time.monotonic())
            return iter(())

        wait_for = min(timeout, self._schedule.next_wakeup(now))
        if wait_for > 0:
            self._wake.wait(wait_for)
            self._wake.clear()
            if not self._open:
                return iter(())
            now = time.monotonic()

        for msg_type in self._schedule.due(now):
            self._pending.append(self._build(msg_type, now))

        if not self._announced_boot and self._pending:
            self._announced_boot = True
            self._pending.append(
                self._wrap(
                    MockMessage(
                        "STATUSTEXT",
                        severity=6,
                        text="ArduCopter V4.5.7 (simulated)",
                    )
                )
            )
        return iter(self._drain())

    def _drain(self) -> list[ReceivedMessage]:
        out = self._pending
        self._pending = []
        return out

    def _wrap(self, message: MockMessage) -> ReceivedMessage:
        return ReceivedMessage(
            message=message,
            system_id=self._target_system,
            component_id=self._target_component,
        )

    def _elapsed(self, now: float) -> float:
        return max(0.0, now - self._started_at)

    def _build(self, msg_type: str, now: float) -> ReceivedMessage:
        builder = {
            "HEARTBEAT": self._heartbeat,
            "SYS_STATUS": self._sys_status,
            "GPS_RAW_INT": self._gps_raw_int,
            "ATTITUDE": self._attitude,
            "VFR_HUD": self._vfr_hud,
            "GLOBAL_POSITION_INT": self._global_position_int,
        }[msg_type]
        return self._wrap(builder(self._elapsed(now)))

    def _heartbeat(self, elapsed: float) -> MockMessage:
        base_mode = constants.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED
        if self._armed:
            base_mode |= constants.MAV_MODE_FLAG_SAFETY_ARMED
        return MockMessage(
            "HEARTBEAT",
            type=2,  # MAV_TYPE_QUADROTOR
            autopilot=3,  # MAV_AUTOPILOT_ARDUPILOTMEGA
            base_mode=base_mode,
            custom_mode=constants.COMMANDABLE_DISARMED_MODES.get(
                self._mode, constants.COMMANDABLE_DISARMED_MODES["STABILIZE"]
            ),
            system_status=3,  # MAV_STATE_STANDBY
            mavlink_version=3,
        )

    def _sys_status(self, elapsed: float) -> MockMessage:
        # ~0.5 mV/s drain plus a little ripple, so the UI shows movement
        # without ever crossing the configured failsafe thresholds in a
        # short demo.
        voltage = self._scenario.voltage - elapsed * 0.0005 + self._random.uniform(-0.02, 0.02)
        current_a = 1.4 + self._random.uniform(-0.15, 0.15)
        remaining = max(0, min(100, int(round(96 - elapsed * 0.02))))
        healthy = 0x1FFFFFF
        return MockMessage(
            "SYS_STATUS",
            voltage_battery=int(voltage * 1000),
            current_battery=int(current_a * 100),
            battery_remaining=remaining,
            drop_rate_comm=int(self._random.uniform(0, 40)),
            errors_comm=0,
            onboard_control_sensors_present=healthy,
            onboard_control_sensors_enabled=healthy,
            onboard_control_sensors_health=healthy,
        )

    def _gps_raw_int(self, elapsed: float) -> MockMessage:
        satellites = self._scenario.satellites
        if self._scenario.fix_type < 2:
            satellites = max(0, satellites - 10)
        return MockMessage(
            "GPS_RAW_INT",
            fix_type=self._scenario.fix_type,
            satellites_visible=satellites + self._random.randint(-1, 1),
            lat=int(self._drift(self._scenario.lat, elapsed, 1.4e-6) * 1e7),
            lon=int(self._drift(self._scenario.lon, elapsed, 1.1e-6) * 1e7),
            alt=int(DEFAULT_MOCK_ALT_MSL * 1000),
            eph=int(self._random.uniform(70, 130)),
            epv=int(self._random.uniform(120, 200)),
        )

    def _attitude(self, elapsed: float) -> MockMessage:
        # A parked airframe is not perfectly level and is never perfectly
        # still -- a couple of degrees of wander looks right on the UI.
        return MockMessage(
            "ATTITUDE",
            roll=math.radians(1.2 * math.sin(elapsed * 0.7) + self._random.uniform(-0.2, 0.2)),
            pitch=math.radians(-0.8 * math.cos(elapsed * 0.5) + self._random.uniform(-0.2, 0.2)),
            yaw=math.radians((137.0 + 2.0 * math.sin(elapsed * 0.15)) % 360.0),
            rollspeed=0.0,
            pitchspeed=0.0,
            yawspeed=0.0,
            time_boot_ms=int(elapsed * 1000),
        )

    def _vfr_hud(self, elapsed: float) -> MockMessage:
        return MockMessage(
            "VFR_HUD",
            airspeed=0.0,
            groundspeed=round(abs(self._random.gauss(0.05, 0.03)), 3),
            heading=int((137.0 + 2.0 * math.sin(elapsed * 0.15)) % 360.0),
            throttle=0,
            alt=round(DEFAULT_MOCK_ALT_MSL + self._random.uniform(-0.15, 0.15), 2),
            climb=round(self._random.uniform(-0.05, 0.05), 3),
        )

    def _global_position_int(self, elapsed: float) -> MockMessage:
        return MockMessage(
            "GLOBAL_POSITION_INT",
            lat=int(self._drift(self._scenario.lat, elapsed, 1.4e-6) * 1e7),
            lon=int(self._drift(self._scenario.lon, elapsed, 1.1e-6) * 1e7),
            alt=int(DEFAULT_MOCK_ALT_MSL * 1000),
            relative_alt=int(self._random.uniform(-0.2, 0.2) * 1000),
            vx=0,
            vy=0,
            vz=0,
            hdg=int(((137.0 + 2.0 * math.sin(elapsed * 0.15)) % 360.0) * 100),
            time_boot_ms=int(elapsed * 1000),
        )

    def _drift(self, base: float, elapsed: float, amplitude: float) -> float:
        """Slow GNSS wander so the plotted point is not frozen."""
        return base + amplitude * math.sin(elapsed * 0.11)

    # ------------------------------------------------------------------
    # Transmit
    # ------------------------------------------------------------------

    def send_gcs_heartbeat(self) -> None:
        if not self._open:
            raise LinkError("mock link is not open")
        self._gcs_heartbeats += 1

    def send_command_long(
        self,
        *,
        target_system: int,
        target_component: int,
        command: int,
        params: tuple[float, float, float, float, float, float, float],
    ) -> None:
        if not self._open:
            raise LinkError("mock link is not open")

        self.command_long_log.append(
            {
                "target_system": target_system,
                "target_component": target_component,
                "command": command,
                "params": tuple(params),
            }
        )

        if self._scenario.reject_commands > 0:
            self._scenario.reject_commands -= 1
            self._queue_ack(command, result=2)  # MAV_RESULT_DENIED
            return
        drop = self._scenario.drop_acks > 0
        if drop:
            self._scenario.drop_acks -= 1

        if command == constants.MAV_CMD_DO_SET_MODE:
            if self._armed:
                # A real ArduCopter refuses some transitions while armed; the
                # backend refuses first, but the simulation refuses too so the
                # defence-in-depth path is exercised.
                if not drop:
                    self._queue_ack(command, result=2)
                return
            self._apply_mode(int(params[1]))
        elif command == constants.MAV_CMD_REQUEST_MESSAGE:
            if int(params[0]) == constants.MSG_ID_AUTOPILOT_VERSION:
                self._pending.append(self._wrap(self._autopilot_version()))

        if not drop:
            self._queue_ack(command, result=constants.MAV_RESULT_ACCEPTED)

    def _apply_mode(self, custom_mode: int) -> None:
        name = constants.mode_name(custom_mode)
        if name in constants.COMMANDABLE_DISARMED_MODES:
            self._mode = name
            self._pending.append(
                self._wrap(MockMessage("STATUSTEXT", severity=6, text=f"Flight mode: {name}"))
            )
            # Push a fresh heartbeat so mode verification does not have to wait
            # a full second, exactly like a real vehicle reporting promptly.
            self._pending.append(self._wrap(self._heartbeat(self._elapsed(time.monotonic()))))
            self._wake.set()

    def _queue_ack(self, command: int, *, result: int) -> None:
        self._pending.append(
            self._wrap(
                MockMessage(
                    "COMMAND_ACK",
                    command=command,
                    result=result,
                    target_system=255,
                    target_component=190,
                )
            )
        )
        self._wake.set()

    def _autopilot_version(self) -> MockMessage:
        return MockMessage(
            "AUTOPILOT_VERSION",
            capabilities=0b1111111,
            flight_sw_version=(4 << 24) | (5 << 16) | (7 << 8) | 255,
            middleware_sw_version=0,
            os_sw_version=0,
            board_version=0,
            vendor_id=0x3162,  # Holybro
            product_id=0x1011,
            uid=0,
        )

    def describe(self) -> dict[str, Any]:
        return {
            "transport": "mock",
            "port": None,
            "baud": None,
            "targetSystem": self._target_system,
            "targetComponent": self._target_component,
            "simulatedMode": self._mode,
            "simulatedArmed": self._armed,
            "gcsHeartbeatsSent": self._gcs_heartbeats,
        }
