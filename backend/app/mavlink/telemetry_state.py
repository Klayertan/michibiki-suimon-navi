"""Thread-safe normalized telemetry state.

One :class:`TelemetryState` instance is owned by the link manager. The link
worker thread writes to it; the FastAPI event loop reads snapshots from it.
Every public method takes the internal lock, and :meth:`snapshot` returns a
freshly built plain-``dict`` tree so a reader can never observe a half-updated
structure or hold a reference into mutable state.

Freshness is computed from monotonic clocks, never wall clock, so an NTP step
or a daylight-saving change cannot make the link look stale or fresh.
Wall-clock timestamps are also recorded, but only for display.
"""

from __future__ import annotations

import threading
import time
from collections import Counter, deque
from collections.abc import Iterable
from enum import Enum
from typing import Any

from .normalizers import NORMALIZERS


# ArduPilot SERVOn_FUNCTION values for Copter motor outputs. Motor 9-12 use
# the non-contiguous IDs documented by ArduPilot; never infer motor identity
# from the physical output number itself.
_COPTER_MOTOR_FUNCTIONS = {
    **{function_id: function_id - 32 for function_id in range(33, 41)},
    **{function_id: function_id - 73 for function_id in range(82, 86)},
}


class ConnectionState(str, Enum):
    """Link lifecycle states surfaced to the operator.

    These are deliberately distinct: "connected but the radio went quiet" is a
    very different situation from "we never opened the port", and an operator
    standing next to an aircraft must be able to tell them apart at a glance.
    """

    DISCONNECTED = "disconnected"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    TELEMETRY_STALE = "telemetry_stale"
    LINK_LOST = "link_lost"
    RECONNECTING = "reconnecting"
    ERROR = "error"


#: States in which the vehicle is considered reachable enough to accept a
#: command. Note that ``TELEMETRY_STALE`` is *not* here: commanding a vehicle
#: whose telemetry has gone quiet means commanding blind.
COMMANDABLE_STATES = frozenset({ConnectionState.CONNECTED})


class TelemetryState:
    """Aggregated, normalized vehicle telemetry plus link bookkeeping."""

    def __init__(self, *, stale_timeout: float, link_lost_timeout: float, max_statustext: int) -> None:
        self._lock = threading.RLock()
        self._stale_timeout = stale_timeout
        self._link_lost_timeout = link_lost_timeout

        self._connection_state = ConnectionState.DISCONNECTED
        self._last_error: dict[str, Any] | None = None

        self._vehicle: dict[str, Any] = {}
        self._battery: dict[str, Any] = {}
        self._rc_channels: dict[str, Any] = {}
        #: Monotonic receipt time for RC_CHANNELS specifically, so its own
        #: freshness can be reported (see snapshot()'s "rc" section) the same
        #: NTP-safe way as the link's own message/heartbeat ages.
        self._rc_channels_mono: float | None = None
        self._servo_outputs: dict[str, Any] = {}
        self._servo_outputs_mono: float | None = None
        self._gps: dict[str, Any] = {}
        self._attitude: dict[str, Any] = {}
        self._hud: dict[str, Any] = {}
        self._position: dict[str, Any] = {}
        self._version: dict[str, Any] | None = None
        # Session-scoped, read-only cache populated from PARAM_VALUE replies.
        # Clearing it on disconnect prevents one airframe's calibration from
        # being reused accidentally after a different vehicle connects.
        self._parameters: dict[str, float] = {}

        self._statustexts: deque[dict[str, Any]] = deque(maxlen=max_statustext)
        self._message_counts: Counter[str] = Counter()

        self._last_message_mono: float | None = None
        self._last_message_wall: float | None = None
        self._last_heartbeat_mono: float | None = None
        self._last_heartbeat_wall: float | None = None
        self._connected_since_wall: float | None = None
        self._gcs_heartbeats_sent = 0
        self._last_gcs_heartbeat_wall: float | None = None
        #: Component ID the vehicle's own HEARTBEAT arrived on, used in
        #: preference to the configured target component when addressing it.
        self._observed_component: int | None = None
        self._observed_system: int | None = None

    # ------------------------------------------------------------------
    # Ingest
    # ------------------------------------------------------------------

    def apply_message(self, message: Any, *, system_id: int | None = None, component_id: int | None = None) -> str | None:
        """Fold one decoded MAVLink message into the state.

        Args:
            message: A decoded message exposing ``get_type()`` and fields.
            system_id: Sender system, when the transport knows it.
            component_id: Sender component, when the transport knows it.

        Returns:
            The message type that was applied, or ``None`` if the message could
            not be identified. Unknown *types* are still counted -- they are
            evidence the link is alive -- but nothing is derived from them.
        """
        try:
            msg_type = message.get_type()
        except Exception:  # noqa: BLE001 - a malformed frame must not kill the reader
            return None
        if msg_type in ("BAD_DATA", "UNKNOWN"):
            return None

        now_mono = time.monotonic()
        now_wall = time.time()

        with self._lock:
            self._message_counts[msg_type] += 1
            self._last_message_mono = now_mono
            self._last_message_wall = now_wall

            normalizer = NORMALIZERS.get(msg_type)
            if normalizer is None:
                return msg_type
            values = normalizer(message)

            if msg_type == "HEARTBEAT":
                self._apply_heartbeat(values, now_mono, now_wall, system_id, component_id)
            elif msg_type == "SYS_STATUS":
                self._battery.update(values)
            elif msg_type == "GPS_RAW_INT":
                self._gps.update(values)
            elif msg_type == "ATTITUDE":
                self._attitude.update(values)
            elif msg_type == "VFR_HUD":
                self._hud.update(values)
            elif msg_type == "GLOBAL_POSITION_INT":
                self._position.update(values)
            elif msg_type == "RC_CHANNELS":
                # Replace, not merge: a channel absent from this frame is
                # genuinely absent right now, not "still whatever it was
                # several messages ago".
                self._rc_channels = {**values, "receivedAt": now_wall}
                self._rc_channels_mono = now_mono
            elif msg_type == "SERVO_OUTPUT_RAW":
                # This is vehicle-reported, read-only PWM evidence. Replace
                # the whole frame so absent extension fields cannot retain
                # values from an older packet.
                self._servo_outputs = {**values, "receivedAt": now_wall}
                self._servo_outputs_mono = now_mono
            elif msg_type == "STATUSTEXT":
                self._statustexts.append({**values, "receivedAt": now_wall})
            elif msg_type == "AUTOPILOT_VERSION":
                self._version = {**values, "receivedAt": now_wall}
            elif msg_type == "PARAM_VALUE":
                param_id = values.get("paramId")
                value = values.get("value")
                if param_id is not None and value is not None:
                    self._parameters[str(param_id)] = float(value)
            # COMMAND_ACK is consumed by the command service via the link's ack
            # queue; nothing to fold into displayed state here.
            return msg_type

    def _apply_heartbeat(
        self,
        values: dict[str, Any],
        now_mono: float,
        now_wall: float,
        system_id: int | None,
        component_id: int | None,
    ) -> None:
        self._vehicle.update(values)
        if system_id is not None:
            self._vehicle["systemId"] = system_id
            self._observed_system = system_id
        if component_id is not None:
            self._vehicle["componentId"] = component_id
            # A GCS or companion computer on the same system also emits
            # heartbeats; only an autopilot heartbeat identifies the flight
            # controller component.
            if values.get("autopilot") not in (None, 8):
                self._observed_component = component_id
        self._last_heartbeat_mono = now_mono
        self._last_heartbeat_wall = now_wall
        if self._connected_since_wall is None:
            self._connected_since_wall = now_wall

    def note_gcs_heartbeat_sent(self) -> None:
        with self._lock:
            self._gcs_heartbeats_sent += 1
            self._last_gcs_heartbeat_wall = time.time()

    # ------------------------------------------------------------------
    # Connection state
    # ------------------------------------------------------------------

    def set_connection_state(self, state: ConnectionState) -> None:
        with self._lock:
            self._connection_state = state
            if state is ConnectionState.DISCONNECTED:
                self._connected_since_wall = None

    def get_connection_state(self) -> ConnectionState:
        with self._lock:
            return self._connection_state

    def set_error(self, message: str, *, kind: str = "link") -> None:
        """Record the most recent error. Errors are never silently discarded."""
        with self._lock:
            self._last_error = {"kind": kind, "message": message, "at": time.time()}

    def clear_error(self) -> None:
        with self._lock:
            self._last_error = None

    def reset_vehicle_data(self) -> None:
        """Forget vehicle telemetry, keeping the error and connection state.

        Called on disconnect so a stale battery voltage from the last session
        can never be mistaken for a live reading.
        """
        with self._lock:
            self._vehicle.clear()
            self._battery.clear()
            self._rc_channels.clear()
            self._rc_channels_mono = None
            self._servo_outputs.clear()
            self._servo_outputs_mono = None
            self._gps.clear()
            self._attitude.clear()
            self._hud.clear()
            self._position.clear()
            self._version = None
            self._parameters.clear()
            self._statustexts.clear()
            self._message_counts.clear()
            self._last_message_mono = None
            self._last_message_wall = None
            self._last_heartbeat_mono = None
            self._last_heartbeat_wall = None
            self._connected_since_wall = None
            self._observed_component = None
            self._observed_system = None

    # ------------------------------------------------------------------
    # Derived freshness
    # ------------------------------------------------------------------

    def _age(self, mono: float | None, now_mono: float) -> float | None:
        return None if mono is None else max(0.0, now_mono - mono)

    def evaluate_freshness(self, now_mono: float | None = None) -> ConnectionState:
        """Recompute and store the freshness-derived connection state.

        Only transitions *between* the healthy states are made here
        (``connected`` <-> ``telemetry_stale`` -> ``link_lost``). Deliberate
        states set by the link manager -- connecting, reconnecting, error,
        disconnected -- are left untouched, because losing telemetry while
        already reconnecting should not overwrite "reconnecting".
        """
        now = time.monotonic() if now_mono is None else now_mono
        with self._lock:
            current = self._connection_state
            if current not in (
                ConnectionState.CONNECTED,
                ConnectionState.TELEMETRY_STALE,
                ConnectionState.LINK_LOST,
            ):
                return current

            heartbeat_age = self._age(self._last_heartbeat_mono, now)
            message_age = self._age(self._last_message_mono, now)

            if heartbeat_age is not None and heartbeat_age >= self._link_lost_timeout:
                self._connection_state = ConnectionState.LINK_LOST
            elif (
                heartbeat_age is None
                or message_age is None
                or heartbeat_age >= self._stale_timeout
                or message_age >= self._stale_timeout
            ):
                self._connection_state = ConnectionState.TELEMETRY_STALE
            else:
                self._connection_state = ConnectionState.CONNECTED
            return self._connection_state

    def is_stale(self, now_mono: float | None = None) -> bool:
        now = time.monotonic() if now_mono is None else now_mono
        with self._lock:
            message_age = self._age(self._last_message_mono, now)
            heartbeat_age = self._age(self._last_heartbeat_mono, now)
            return (
                message_age is None
                or heartbeat_age is None
                or message_age >= self._stale_timeout
                or heartbeat_age >= self._stale_timeout
            )

    def is_armed(self) -> bool | None:
        """``True``/``False`` when known, ``None`` when no heartbeat was seen.

        Callers must treat ``None`` as "unknown", never as "disarmed".
        """
        with self._lock:
            return self._vehicle.get("armed")

    def current_mode(self) -> str | None:
        with self._lock:
            return self._vehicle.get("flightMode")

    def get_parameters(self, names: Iterable[str] | None = None) -> dict[str, float]:
        """Return a copy of parameters received during the current session.

        Supplying ``names`` filters the result without inventing defaults.
        Identifiers use the same uppercase normalization as incoming
        ``PARAM_VALUE.param_id`` fields.
        """
        with self._lock:
            if names is None:
                return dict(self._parameters)
            wanted = {str(name).strip().upper() for name in names}
            return {name: value for name, value in self._parameters.items() if name in wanted}

    def target_component(self, fallback: int) -> int:
        with self._lock:
            return self._observed_component if self._observed_component is not None else fallback

    def observed_component(self) -> int | None:
        """Return the autopilot component discovered from its HEARTBEAT.

        ``None`` means component discovery has not completed yet.  Keeping
        that distinct from the configured fallback lets the link manager
        admit the first target-system autopilot heartbeat without admitting
        later traffic from another component.
        """
        with self._lock:
            return self._observed_component

    #: GPS_RAW_INT.fix_type below this is NO_GPS (0) or NO_FIX (1) -- neither
    #: tells you where the vehicle is. 2 is 2D_FIX, the minimum fix quality
    #: that yields a usable horizontal position.
    _MIN_USABLE_FIX_TYPE = 2

    def _is_position_available(self) -> bool:
        """Whether the position the panel would display is trustworthy.

        Gated on GPS fix quality, not on the coordinate values: ArduPilot
        reports ``GLOBAL_POSITION_INT`` (and often ``GPS_RAW_INT``) lat/lon as
        literal ``0`` -- a real, non-sentinel integer -- while it has no fix
        at all, so "the field is not null" is not evidence of a usable
        position. Below ``_MIN_USABLE_FIX_TYPE``, or when no fix type has
        been received yet, the position is reported unavailable regardless of
        what the coordinate fields contain.

        Deliberately does **not** special-case ``(0, 0)`` once the fix is
        good enough: with a genuine 2D/3D fix, a vehicle that reports exactly
        zero for one or both coordinates is reporting a real place (0,0 lies
        in the Gulf of Guinea) and that is not this backend's call to
        second-guess -- rejecting it would be inventing a rule the MAVLink
        message itself does not support, the mirror image of the bug this
        method exists to fix. See
        ``test_position_available_at_true_zero_zero_with_a_valid_fix``.

        Checks the fused ``GLOBAL_POSITION_INT`` coordinate first, falling
        back to the raw ``GPS_RAW_INT`` one only when the fused message has
        not arrived yet -- the same preference the frontend applies when
        choosing which value to display -- so "available" always describes
        whichever value would actually be shown.
        """
        fix_type = self._gps.get("fixType")
        if fix_type is None or fix_type < self._MIN_USABLE_FIX_TYPE:
            return False

        lat = self._position.get("lat")
        if lat is None:
            lat = self._gps.get("lat")
        lon = self._position.get("lon")
        if lon is None:
            lon = self._gps.get("lon")
        return lat is not None and lon is not None

    # ------------------------------------------------------------------
    # Snapshot
    # ------------------------------------------------------------------

    def snapshot(self) -> dict[str, Any]:
        """Build a complete JSON-ready state tree.

        Returns a new dict every call; the caller owns it. Values that have not
        been received are ``None`` rather than invented.
        """
        now_mono = time.monotonic()
        state = self.evaluate_freshness(now_mono)
        with self._lock:
            message_age = self._age(self._last_message_mono, now_mono)
            heartbeat_age = self._age(self._last_heartbeat_mono, now_mono)
            stale = message_age is None or message_age > self._stale_timeout
            position_available = self._is_position_available()
            rc_channels_age = self._age(self._rc_channels_mono, now_mono)
            servo_outputs_age = self._age(self._servo_outputs_mono, now_mono)
            servo_channels = self._servo_outputs.get("channels")
            motor_outputs: list[dict[str, Any]] = []
            loaded_function_count = 0
            for output_channel in range(1, 17):
                parameter = f"SERVO{output_channel}_FUNCTION"
                raw_function = self._parameters.get(parameter)
                if raw_function is None or not float(raw_function).is_integer():
                    continue
                loaded_function_count += 1
                function_id = int(raw_function)
                motor_number = _COPTER_MOTOR_FUNCTIONS.get(function_id)
                if motor_number is None:
                    continue
                pwm = (
                    servo_channels[output_channel - 1]
                    if isinstance(servo_channels, list)
                    and output_channel <= len(servo_channels)
                    else None
                )
                motor_outputs.append(
                    {
                        "motorNumber": motor_number,
                        "outputChannel": output_channel,
                        "function": function_id,
                        "functionName": f"Motor {motor_number}",
                        "pwm": pwm,
                    }
                )

            return {
                "connectionState": state.value,
                "connected": state
                in (
                    ConnectionState.CONNECTED,
                    ConnectionState.TELEMETRY_STALE,
                    ConnectionState.LINK_LOST,
                ),
                "commandable": state in COMMANDABLE_STATES,
                "error": dict(self._last_error) if self._last_error else None,
                "link": {
                    "stale": stale,
                    "staleTimeout": self._stale_timeout,
                    "linkLostTimeout": self._link_lost_timeout,
                    "lastMessageAge": message_age,
                    "lastMessageAt": self._last_message_wall,
                    "lastHeartbeatAge": heartbeat_age,
                    "lastHeartbeatAt": self._last_heartbeat_wall,
                    "connectedSince": self._connected_since_wall,
                    "gcsHeartbeatsSent": self._gcs_heartbeats_sent,
                    "lastGcsHeartbeatAt": self._last_gcs_heartbeat_wall,
                    "messageCounts": dict(self._message_counts),
                    "totalMessages": sum(self._message_counts.values()),
                    "dropRateComm": self._battery.get("dropRateComm"),
                    "errorsComm": self._battery.get("errorsComm"),
                },
                "vehicle": {
                    "armed": self._vehicle.get("armed"),
                    "flightMode": self._vehicle.get("flightMode"),
                    "customMode": self._vehicle.get("customMode"),
                    "baseMode": self._vehicle.get("baseMode"),
                    "vehicleType": self._vehicle.get("vehicleType"),
                    "vehicleTypeName": self._vehicle.get("vehicleTypeName"),
                    "autopilot": self._vehicle.get("autopilot"),
                    "autopilotName": self._vehicle.get("autopilotName"),
                    "systemId": self._vehicle.get("systemId"),
                    "componentId": self._vehicle.get("componentId"),
                    "systemStatus": self._vehicle.get("systemStatus"),
                },
                "battery": {
                    "voltage": self._battery.get("voltage"),
                    "current": self._battery.get("current"),
                    "remaining": self._battery.get("remaining"),
                    "sensorsOk": self._battery.get("sensorsOk"),
                },
                # PASS/FAIL/UNKNOWN only, matching the same overall verdict
                # ArduPilot uses to decide whether it will accept ARM -- never
                # which of the individual underlying checks failed.
                "prearmCheck": self._battery.get("prearmCheck"),
                "rc": {
                    # The vehicle's own reported RC input (RC_CHANNELS),
                    # independent of source. This is what "RC INPUT SEEN BY
                    # PIXHAWK" in Manual Control shows -- never merely what the
                    # browser most recently intended to send.
                    "channels": self._rc_channels.get("channels"),
                    "channelCount": self._rc_channels.get("channelCount"),
                    "rssi": self._rc_channels.get("rssi"),
                    "receiverHealthy": self._battery.get("rcReceiverHealthy"),
                    "ageSeconds": rc_channels_age,
                    "receivedAt": self._rc_channels.get("receivedAt"),
                },
                "servoOutputs": {
                    "channels": servo_channels,
                    "port": self._servo_outputs.get("port"),
                    "timeUsec": self._servo_outputs.get("timeUsec"),
                    "ageSeconds": servo_outputs_age,
                    "receivedAt": self._servo_outputs.get("receivedAt"),
                },
                "motorOutputs": {
                    "outputs": motor_outputs,
                    "functionParametersLoaded": loaded_function_count,
                    "mappingComplete": loaded_function_count == 16,
                    "ageSeconds": servo_outputs_age,
                    "receivedAt": self._servo_outputs.get("receivedAt"),
                },
                "gps": {
                    "fixType": self._gps.get("fixType"),
                    "fixTypeName": self._gps.get("fixTypeName"),
                    "satellites": self._gps.get("satellites"),
                    "lat": self._gps.get("lat"),
                    "lon": self._gps.get("lon"),
                    "altMsl": self._gps.get("altMsl"),
                    "eph": self._gps.get("eph"),
                    "epv": self._gps.get("epv"),
                },
                "attitude": {
                    "roll": self._attitude.get("roll"),
                    "pitch": self._attitude.get("pitch"),
                    "yaw": self._attitude.get("yaw"),
                    "yawNormalized": self._attitude.get("yawNormalized"),
                },
                "motion": {
                    "heading": self._hud.get("heading") if self._hud.get("heading") is not None else self._position.get("heading"),
                    "groundSpeed": self._hud.get("groundSpeed"),
                    "airSpeed": self._hud.get("airSpeed"),
                    "altitude": self._hud.get("altitude"),
                    "climbRate": self._hud.get("climbRate"),
                },
                "position": {
                    # Raw GLOBAL_POSITION_INT passthrough -- never backfilled
                    # from GPS_RAW_INT here, and never nulled out to "hide" a
                    # bad fix. `available` below is the single place fix
                    # quality is judged; these fields stay exactly what the
                    # vehicle reported.
                    "lat": self._position.get("lat"),
                    "lon": self._position.get("lon"),
                    "altAmsl": self._position.get("altAmsl"),
                    "altRelative": self._position.get("altRelative"),
                    "vx": self._position.get("vx"),
                    "vy": self._position.get("vy"),
                    "vz": self._position.get("vz"),
                    "available": position_available,
                },
                "version": dict(self._version) if self._version else None,
                "parameters": dict(self._parameters),
                "statusTexts": [dict(entry) for entry in self._statustexts],
            }
