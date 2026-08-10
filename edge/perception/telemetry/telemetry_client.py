"""Read-only consumer of the existing backend normalized telemetry."""
from __future__ import annotations
import json
import time
import urllib.request
from ..models import TelemetrySample

USABLE_CONNECTION_STATES = frozenset({"connected"})

class TelemetryClient:
    """HTTP receipt freshness never substitutes for vehicle telemetry freshness."""
    def __init__(self, status_url: str = "http://127.0.0.1:8787/api/drone/status", freshness_ms: int = 500):
        self.status_url, self.freshness_ms, self.latest = status_url, freshness_ms, None
        self.last_http_received_monotonic: float | None = None

    def parse_status(self, state: dict, received_monotonic: float | None = None) -> TelemetrySample | None:
        received = time.monotonic() if received_monotonic is None else received_monotonic
        link, position, attitude, gps = (state.get("link", {}), state.get("position", {}), state.get("attitude", {}), state.get("gps", {}))
        vehicle_age = link.get("lastMessageAge")
        usable = (state.get("connectionState") in USABLE_CONNECTION_STATES and state.get("connected") is not False
                  and link.get("stale") is not True and position.get("available") is True
                  and gps.get("fixType") not in (None, 0, 1))
        if not usable: return None
        values = (position.get("lat"), position.get("lon"), position.get("altRelative"), attitude.get("roll"), attitude.get("pitch"), attitude.get("yaw"))
        if any(value is None for value in values): return None
        return TelemetrySample(None, received, *values, vehicle_age_ms=float(vehicle_age) * 1000 if vehicle_age is not None else None, http_received_monotonic=received)

    def poll(self) -> TelemetrySample | None:
        try:
            with urllib.request.urlopen(self.status_url, timeout=1) as response: state = json.load(response)
            self.last_http_received_monotonic = time.monotonic()
            self.latest = self.parse_status(state, self.last_http_received_monotonic)
            return self.latest
        except Exception:
            return None

    def closest_fresh(self, image_monotonic: float) -> tuple[TelemetrySample | None, float | None]:
        """Return only a locally recent *and backend-healthy* sample.

        The returned age is end-to-end vehicle age at image time: backend
        `lastMessageAge` plus time elapsed since HTTP receipt.
        """
        if not self.latest: return None, None
        http_age = (image_monotonic - self.latest.received_monotonic) * 1000
        vehicle_age = (getattr(self.latest, "vehicle_age_ms", None) or 0.0) + http_age
        if http_age < 0 or http_age > self.freshness_ms or vehicle_age > self.freshness_ms: return None, vehicle_age
        return self.latest, vehicle_age
