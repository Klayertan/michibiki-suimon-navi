# SuisuiNavi MAVLink backend

A local-only FastAPI service that owns the serial telemetry link to a Holybro
X500 V2 (Pixhawk 6C, ArduCopter 4.5.7) and exposes normalized telemetry to the
SuisuiNavi browser frontend.

**This backend does not arm, take off, land, return to launch, upload missions,
override RC, or test motors. Those operations are not implemented.** See
[Safety](#safety) below.

## Quick start

```bash
npm run backend:setup
```

```bash
npm run backend:mock
```

Then `http://127.0.0.1:8787/api/health` should return `{"status":"ok", ...}`.

Full instructions, troubleshooting and the real-hardware procedure live in
[`../docs/MAVLINK_OPERATOR_GUIDE.md`](../docs/MAVLINK_OPERATOR_GUIDE.md).

## Layout

| Path | Responsibility |
|---|---|
| `app/config.py` | Environment-driven settings; safe defaults; validation |
| `app/models.py` | Pydantic request/response models (strict, `extra="forbid"`) |
| `app/logging_config.py` | Single structured stderr handler |
| `app/main.py` | FastAPI app: REST routes, WebSocket, CORS, size limits |
| `app/mavlink/interface.py` | The transport contract — only two `send_*` methods exist |
| `app/mavlink/mock_connection.py` | Simulated ArduCopter; the default transport |
| `app/mavlink/real_connection.py` | pymavlink over serial; imports pymavlink lazily |
| `app/mavlink/normalizers.py` | The single place raw MAVLink units are converted |
| `app/mavlink/telemetry_state.py` | Thread-safe normalized state + freshness machine |
| `app/mavlink/link_manager.py` | Worker thread, heartbeat, reconnect, shutdown |
| `app/mavlink/command_service.py` | The only module that transmits a command |
| `app/mavlink/constants.py` | MAVLink enums and the flight-mode allowlist |

## Concurrency model

One worker thread owns the transport for its whole lifetime. It reads messages,
sends the 1 Hz GCS heartbeat, and runs queued transmit jobs. The FastAPI event
loop never touches the transport: it queues a job and awaits a future
(`asyncio.to_thread`). A heartbeat and a command therefore cannot interleave
mid-frame on the serial line.

Shutdown is deterministic: set the stop event, join the worker, close the port
in the worker's `finally` (and defensively from the caller if the join timed
out).

## Safety

| Gate | Where |
|---|---|
| Real mode is never the default | `config.py` — `SUISUI_MAVLINK_MODE=mock` |
| A real link starts read-only | `config.py` — `ALLOW_SAFE_COMMANDS=0` |
| Propellers-removed confirmation required per real connection | `main.py` |
| Real-mode mode change needs explicit `confirmed=true` | `main.py` |
| Only `STABILIZE` / `ALT_HOLD` can be commanded | `constants.COMMANDABLE_DISARMED_MODES` |
| Mode names validated as a Pydantic `Literal` before any handler runs | `models.py` |
| Refused while armed, or while the armed state is unknown | `command_service._require_disarmed` |
| Refused while telemetry is stale | `command_service._require_live_link` |
| Mode change confirmed by a vehicle HEARTBEAT, not just by the ack | `command_service.set_flight_mode` |
| Arm / takeoff / land / RTL / RC override / motor test refuse without transmitting | `command_service.refuse` |
| Only two `send_*` methods exist on the transport | `interface.MavlinkLink` |
| Binds loopback only | `config.py` — `HOST=127.0.0.1` |

`SUISUI_MAVLINK_ALLOW_ARM=1` and `SUISUI_MAVLINK_ALLOW_TAKEOFF=1` are parsed so
the running configuration can be reported and a warning logged. **They enable
nothing.** There is no code path from any endpoint to an arming or takeoff
frame, and `test_command_service.py` asserts that the command ids do not exist
in the codebase.

## Tests

```bash
npm run test:backend
```

154 tests, all in mock mode. No test opens a serial port, and the suite runs on
a machine with no telemetry radio attached.
