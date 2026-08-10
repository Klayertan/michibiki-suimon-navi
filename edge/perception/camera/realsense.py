"""RealSense boundary; pyrealsense2 is imported only for hardware use."""
from __future__ import annotations
import logging
from typing import Any
import numpy as np
from ..config import CameraProfile
from ..models import CameraFrames
logger=logging.getLogger(__name__)
class RealSenseUnavailable(RuntimeError): pass
class UnsupportedProfileError(ValueError): pass
_ACQUISITION_HELP = ("Unable to acquire RealSense camera.\n\nPossible causes:\n"
                     "- realsense-viewer is still open\n- another perception process owns the camera\n"
                     "- camera is reconnecting\n- USB device needs unplug/replug\n\n"
                     "Close other RealSense applications, verify rs-enumerate-devices, and retry.")
def _unavailable(exc):
    return RealSenseUnavailable(f"{_ACQUISITION_HELP}\n\nOriginal SDK error: {exc}")
def _format_name(value):
    return str(value).upper().split(".")[-1]
def _rs():
    try:
        import pyrealsense2 as rs
        return rs
    except ImportError as exc:
        raise RealSenseUnavailable("pyrealsense2 is unavailable. Install Intel/librealsense packages compatible with JetPack; do not assume a PyPI wheel supports this Jetson.") from exc
def enumerate_devices(rs=None):
    try:
        rs=rs or _rs(); result=[]
        for d in rs.context().query_devices():
            get=lambda key: d.get_info(key) if d.supports(key) else None
            result.append({"product_name":get(rs.camera_info.name),"serial_number":get(rs.camera_info.serial_number),"firmware_version":get(rs.camera_info.firmware_version),"usb_descriptor":get(rs.camera_info.usb_type_descriptor)})
        return result
    except RealSenseUnavailable: raise
    except RuntimeError as exc: raise _unavailable(exc) from exc
class RealSenseCamera:
    """RGB/depth capture aligned with the RealSense SDK, never manual resizing."""
    def __init__(self,profile=CameraProfile(),serial=None,rs_module=None): self.profile,self.serial,self._rs=profile,serial,rs_module;self._pipeline=None;self._align=None;self._depth_scale=None;self.device_info=None
    def _selected_device(self, rs):
        try:
            devices=list(rs.context().query_devices())
            if self.serial:
                for device in devices:
                    if device.get_info(rs.camera_info.serial_number) == self.serial: return device
                raise RealSenseUnavailable(f"RealSense serial {self.serial!r} was not found. Run camera-info to list connected devices.")
            if not devices: raise RealSenseUnavailable("No RealSense device found. Check USB 3 cable/power and run rs-enumerate-devices.")
            return devices[0]
        except RealSenseUnavailable: raise
        except RuntimeError as exc: raise _unavailable(exc) from exc
    def _device_info(self, device, rs):
        get=lambda key: device.get_info(key) if device.supports(key) else None
        return {"product_name":get(rs.camera_info.name),"serial_number":get(rs.camera_info.serial_number),"firmware_version":get(rs.camera_info.firmware_version),"usb_descriptor":get(rs.camera_info.usb_type_descriptor)}
    def supported_profiles(self):
        try:
            rs=self._rs or _rs(); out=[]
            for d in [self._selected_device(rs)]:
                for sensor in d.query_sensors():
                    for profile in sensor.get_stream_profiles():
                        try:
                            p=profile.as_video_stream_profile();out.append({"stream":str(p.stream_type()),"width":p.width(),"height":p.height(),"fps":p.fps(),"format":_format_name(p.format())})
                        except RuntimeError: pass # Non-video profiles are expected.
            return out
        except RealSenseUnavailable: raise
        except RuntimeError as exc: raise _unavailable(exc) from exc
    def _validate_requested_profile(self):
        profiles=self.supported_profiles();p=self.profile
        def supported(name,w,h,fps,formats): return any(name in x["stream"].lower() and (w,h,fps)==(x["width"],x["height"],x["fps"]) and x["format"] in formats for x in profiles)
        if not supported("color",p.rgb_width,p.rgb_height,p.rgb_fps,{"BGR8"}) or not supported("depth",p.depth_width,p.depth_height,p.depth_fps,{"Z16"}):
            relevant=[x for x in profiles if "color" in x["stream"].lower() or "depth" in x["stream"].lower()]
            raise UnsupportedProfileError(f"Requested RGB BGR8 {p.rgb_width}x{p.rgb_height}@{p.rgb_fps} and depth Z16 {p.depth_width}x{p.depth_height}@{p.depth_fps} are unsupported. Supported profiles: {relevant}")
    def start(self):
        try:
            rs=self._rs or _rs();self._rs=rs;selected=self._selected_device(rs)
            self._validate_requested_profile();cfg=rs.config()
            if self.serial: cfg.enable_device(self.serial)
            p=self.profile;cfg.enable_stream(rs.stream.color,p.rgb_width,p.rgb_height,rs.format.bgr8,p.rgb_fps);cfg.enable_stream(rs.stream.depth,p.depth_width,p.depth_height,rs.format.z16,p.depth_fps)
            self._pipeline=rs.pipeline()
            active=self._pipeline.start(cfg);self._depth_scale=float(active.get_device().first_depth_sensor().get_depth_scale());self._align=rs.align(rs.stream.color);self.device_info=self._device_info(selected,rs);logger.info("RealSense connected: %s",self.device_info)
        except (UnsupportedProfileError, RealSenseUnavailable): raise
        except Exception as exc:
            self.stop()
            raise _unavailable(exc) from exc
    def get_frames(self,timeout_ms=5000):
        if not self._pipeline: raise RuntimeError("camera.start() must be called first")
        try:
            native_frames=self._pipeline.wait_for_frames(timeout_ms); native_color=native_frames.get_color_frame(); native_depth=native_frames.get_depth_frame(); frames=self._align.process(native_frames)
        except Exception as exc: raise RuntimeError("RealSense frame acquisition failed; camera may have disconnected.") from exc
        color,depth=frames.get_color_frame(),frames.get_depth_frame()
        if not color or not depth or not native_color or not native_depth: raise RuntimeError("RealSense delivered incomplete RGB/depth frames")
        color_profile=native_color.profile.as_video_stream_profile(); native_depth_profile=native_depth.profile.as_video_stream_profile(); aligned_depth_profile=depth.profile.as_video_stream_profile()
        return CameraFrames(np.asanyarray(color.get_data()),np.asanyarray(depth.get_data()),self._depth_scale,color_profile.intrinsics,native_depth_profile.intrinsics,aligned_depth_profile.intrinsics,native_depth.profile.get_extrinsics_to(native_color.profile),float(native_color.get_timestamp()),float(native_depth.get_timestamp()),str(native_color.get_frame_timestamp_domain()),str(native_depth.get_frame_timestamp_domain()),getattr(native_color,"get_frame_number",lambda:None)(),getattr(native_depth,"get_frame_number",lambda:None)())
    def stop(self):
        if self._pipeline:
            try: self._pipeline.stop()
            except Exception: logger.debug("RealSense pipeline already stopped",exc_info=True)
            finally: self._pipeline=self._align=None
    def __enter__(self): self.start();return self
    def __exit__(self,*_): self.stop()
