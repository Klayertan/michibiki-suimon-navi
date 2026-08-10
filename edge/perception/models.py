from __future__ import annotations
from dataclasses import dataclass
from typing import Any
import numpy as np
@dataclass
class Detection: class_name: str; confidence: float; bbox_xyxy: tuple[float,float,float,float]; mask: np.ndarray | None = None
@dataclass(frozen=True)
class DepthMeasurement: distance_m: float | None; valid_pixel_ratio: float; quality: str
@dataclass(frozen=True)
class TelemetrySample:
    captured_at: str | None; received_monotonic: float; latitude: float|None; longitude: float|None; altitude_m: float|None; roll_deg: float|None; pitch_deg: float|None; yaw_deg: float|None
    vehicle_age_ms: float | None = None; http_received_monotonic: float | None = None
@dataclass
class CameraFrames:
    rgb: np.ndarray; depth: np.ndarray; depth_scale: float
    color_intrinsics: Any; depth_native_intrinsics: Any; depth_aligned_intrinsics: Any
    depth_to_color_extrinsics: Any
    rgb_timestamp_ms: float; depth_timestamp_ms: float
    rgb_timestamp_domain: str | None; depth_timestamp_domain: str | None
    rgb_frame_number: int|None=None; depth_frame_number: int|None=None
    @property
    def rgb_depth_delta_ms(self):
        """Signed `RGB timestamp - native-depth timestamp`, in milliseconds."""
        if not self.rgb_timestamp_domain or not self.depth_timestamp_domain or self.rgb_timestamp_domain != self.depth_timestamp_domain:
            return None
        return self.rgb_timestamp_ms - self.depth_timestamp_ms
