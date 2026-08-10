"""Validated, explicit configuration for the perception pipeline."""
from __future__ import annotations
from dataclasses import dataclass, field
from pathlib import Path
import json

@dataclass(frozen=True)
class CameraProfile:
    rgb_width: int = 1280; rgb_height: int = 720; rgb_fps: int = 30
    depth_width: int = 1280; depth_height: int = 720; depth_fps: int = 30
    def __post_init__(self):
        if min(self.rgb_width, self.rgb_height, self.depth_width, self.depth_height, self.rgb_fps, self.depth_fps) <= 0: raise ValueError("camera dimensions and FPS must be positive")
@dataclass(frozen=True)
class DepthValidationConfig:
    min_distance_m: float = .10; max_distance_m: float = 12.; min_valid_pixel_ratio: float = .20
    def __post_init__(self):
        if not 0 <= self.min_valid_pixel_ratio <= 1 or self.min_distance_m <= 0 or self.max_distance_m <= self.min_distance_m: raise ValueError("invalid depth validation limits")
@dataclass(frozen=True)
class CameraMountConfig: translation_m: tuple[float,float,float] = (0.,0.,0.); rotation_deg: tuple[float,float,float] = (0.,0.,0.)
@dataclass(frozen=True)
class TileConfig:
    width: int = 640; height: int = 640; overlap: float = .20; confidence_threshold: float = .25; nms_iou_threshold: float = .50
    def __post_init__(self):
        if self.width <= 0 or self.height <= 0 or not 0 <= self.overlap < 1: raise ValueError("tile dimensions must be positive and overlap must be in [0, 1)")
        if not 0 <= self.confidence_threshold <= 1 or not 0 <= self.nms_iou_threshold <= 1: raise ValueError("thresholds must be in [0, 1]")
@dataclass(frozen=True)
class TelemetryConfig:
    # Mirrors backend.app.config.Settings.http_port default without importing
    # the backend (edge deployment must remain independently installable).
    status_url: str = "http://127.0.0.1:8787/api/drone/status"; freshness_ms: int = 500
    def __post_init__(self):
        if self.freshness_ms <= 0: raise ValueError("telemetry freshness_ms must be positive")
@dataclass(frozen=True)
class DeduplicationConfig: weed_radius_m: float = .25; insect_radius_m: float = .10; time_window_s: float = 10.
@dataclass(frozen=True)
class PerceptionConfig:
    camera: CameraProfile = field(default_factory=CameraProfile); depth: DepthValidationConfig = field(default_factory=DepthValidationConfig); camera_mount: CameraMountConfig = field(default_factory=CameraMountConfig); tiles: TileConfig = field(default_factory=TileConfig); telemetry: TelemetryConfig = field(default_factory=TelemetryConfig); deduplication: DeduplicationConfig = field(default_factory=DeduplicationConfig)
    @classmethod
    def from_json(cls, path: Path):
        raw=json.loads(path.read_text(encoding="utf-8")); return cls(camera=CameraProfile(**raw.get("camera",{})),depth=DepthValidationConfig(**raw.get("depth",{})),camera_mount=CameraMountConfig(**raw.get("camera_mount",{})),tiles=TileConfig(**raw.get("tiles",{})),telemetry=TelemetryConfig(**raw.get("telemetry",{})),deduplication=DeduplicationConfig(**raw.get("deduplication",{})))
