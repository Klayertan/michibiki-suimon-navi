# SuisuiNavi MAVLink backend

A local-only FastAPI service that owns the serial telemetry link to a Holybro
X500 V2 (Pixhawk 6C, ArduCopter 4.5.7) and exposes normalized telemetry to the
SuisuiNavi browser frontend.

**Normal ARM/DISARM and bounded manual RC override exist only behind explicit
safety gates. Force-arm, takeoff, land, RTL, mission upload, motor test,
parameter writes and safety-check bypasses are not implemented.** See
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
| `app/mavlink/interface.py` | Transport contract for telemetry commands, read-only parameter requests, RC override, and the separately retained Guided velocity sender |
| `app/mavlink/mock_connection.py` | Simulated ArduCopter; the default transport |
| `app/mavlink/real_connection.py` | pymavlink over serial; imports pymavlink lazily |
| `app/mavlink/normalizers.py` | The single place raw MAVLink units are converted |
| `app/mavlink/telemetry_state.py` | Thread-safe normalized state + freshness machine |
| `app/mavlink/link_manager.py` | Worker thread, heartbeat, reconnect, shutdown |
| `app/mavlink/command_service.py` | Acknowledged commands, including normal command-400 ARM/DISARM |
| `app/mavlink/pilot_service.py` | Manual-control gates, vehicle-calibrated RC mapping, cadence and override release |
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
| ARM requires safe commands, enabled Manual Control, explicit confirmation, a fresh link, and props acknowledgement in Bench Mode | `main.py`, `command_service.py` |
| ARM/DISARM use command 400 with `param2=0`; acknowledgement and HEARTBEAT state must confirm success | `command_service.py` |
| Manual input requires a continuously-held dead-man and STABILIZE/ALT_HOLD | `pilot_service.py` |
| RCMAP/RCx calibration, RC_OPTIONS, a finite RC_OVERRIDE_TIME with cadence margin, and legacy/new GCS source-ID range are read and validated; never written | `pilot_limits.py`, `pilot_service.py` |
| STABILIZE throttle zero is calibrated low-stick; ALT_HOLD zero is the calibrated range midpoint | `pilot_limits.normalized_to_rc_override` |
| Simulated provider input is refused in real backend mode | `models.py`, `pilot_service.py` |
| Every manual gate closure releases RC channels 1-8 with MAVLink release semantics | `pilot_service.py` |
| Takeoff / land / RTL / mission / motor-test / parameter-write operations refuse without transmitting | `command_service.refuse` |
| Binds loopback only | `config.py` — `HOST=127.0.0.1` |

`SUISUI_MAVLINK_ALLOW_ARM=1` and `SUISUI_MAVLINK_ALLOW_TAKEOFF=1` remain parsed
only for backwards compatibility. **They bypass nothing.** Normal ARM/DISARM
is governed by the gates above; takeoff remains unsupported. Force value
`21196` is never used.

## Tests

```bash
npm run test:backend
```

The suite forces mock mode. No test opens a serial port or requires a telemetry
radio; use the operator guide for the separate propellers-removed real bench
procedure.
