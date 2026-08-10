"""Lossless dataset sample persistence, separated from camera/UI code."""
from __future__ import annotations
import json
from pathlib import Path
import cv2
import numpy as np
import time
import shutil
import re
SAMPLE_RE=re.compile(r"^sample_(\d{6})$")
def sample_number(path: Path):
    match=SAMPLE_RE.fullmatch(path.name)
    return int(match.group(1)) if path.is_dir() and match else None
def sample_directories(root: Path): return sorted((path for path in root.iterdir() if sample_number(path) is not None),key=lambda p:sample_number(p)) if root.exists() else []
def serialize_intrinsics(intrinsics) -> dict:
    """JSON-safe calibration needed to reproduce pixel-to-ray calculations."""
    return {"width":int(intrinsics.width),"height":int(intrinsics.height),"ppx":float(intrinsics.ppx),"ppy":float(intrinsics.ppy),"fx":float(intrinsics.fx),"fy":float(intrinsics.fy),"model":str(intrinsics.model),"coeffs":[float(v) for v in intrinsics.coeffs]}
def build_metadata(frame, camera_info: dict, fps: int, captured_at: str | None = None) -> dict:
    now=captured_at or time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime())
    ext=frame.depth_to_color_extrinsics
    return {"schema_version":2,"capture":{"captured_at_utc":now,"rgb_timestamp_ms":frame.rgb_timestamp_ms,"depth_timestamp_ms":frame.depth_timestamp_ms,"rgb_depth_delta_ms":frame.rgb_depth_delta_ms,"rgb_frame_number":frame.rgb_frame_number,"depth_frame_number":frame.depth_frame_number,"rgb_timestamp_domain":frame.rgb_timestamp_domain,"depth_timestamp_domain":frame.depth_timestamp_domain},"camera":{**camera_info,"rgb_width":frame.rgb.shape[1],"rgb_height":frame.rgb.shape[0],"depth_width":frame.depth.shape[1],"depth_height":frame.depth.shape[0],"fps":fps,"depth_scale":frame.depth_scale},"intrinsics":{"color":serialize_intrinsics(frame.color_intrinsics),"depth_native":serialize_intrinsics(frame.depth_native_intrinsics),"depth_aligned_to_color":serialize_intrinsics(frame.depth_aligned_intrinsics)},"extrinsics":{"depth_to_color":{"rotation":[float(v) for v in ext.rotation],"translation_m":[float(v) for v in ext.translation],"source_frame":"depth_native","destination_frame":"color","rotation_order":"RealSense SDK row-major 3x3"}},"drone":{"latitude":None,"longitude":None,"altitude_m":None,"roll_deg":None,"pitch_deg":None,"yaw_deg":None,"telemetry_age_ms":None}}
def create_manifest(output: Path, purpose="general_capture", notes="", camera=None, profile=None):
    output.mkdir(parents=True,exist_ok=True); path=output/"dataset.json"
    labels=["rice","weed"] if purpose=="paddy_weed_training" else []
    expected={"purpose":purpose,"camera":camera or {},"capture_profile":profile or {}}
    if path.exists():
        existing=read_metadata(path)
        for key in expected:
            if existing.get(key)!=expected[key]: raise ValueError(f"Existing dataset manifest is incompatible for {key}; refuse to mix capture sessions. Create a new output directory.")
        return path
    data={"schema_version":1,**expected,"labels":labels,"notes":notes,"created_at":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime())};path.write_text(json.dumps(data,indent=2),encoding="utf-8");return path
def read_metadata(path: Path):
    """Reads v1/v2 without silently remapping old fields."""
    return json.loads(path.read_text(encoding="utf-8"))
def validate_sample(sample: Path, manifest=None):
    rgb,depth,metadata=(sample/"rgb.jpg",sample/"depth.png",sample/"metadata.json");missing=[name for name,path in (("RGB",rgb),("depth",depth),("metadata",metadata)) if not path.exists()]
    if missing:return None,f"{sample.name}: missing {', '.join(missing)}"
    try: meta=read_metadata(metadata)
    except (json.JSONDecodeError,UnicodeDecodeError): return None,f"{sample.name}: invalid JSON"
    im=cv2.imread(str(rgb));raw=cv2.imread(str(depth),cv2.IMREAD_UNCHANGED)
    if im is None or raw is None or raw.dtype != np.uint16:return None,f"{sample.name}: invalid image or depth not uint16"
    camera=meta.get("camera",{});scale=camera.get("depth_scale")
    if not isinstance(scale,(int,float)) or scale<=0:return None,f"{sample.name}: invalid/missing depth scale"
    if (camera.get("rgb_width"),camera.get("rgb_height")) not in ((None,None),(im.shape[1],im.shape[0])):return None,f"{sample.name}: RGB metadata dimensions mismatch"
    if (camera.get("depth_width"),camera.get("depth_height")) not in ((None,None),(raw.shape[1],raw.shape[0])):return None,f"{sample.name}: depth metadata dimensions mismatch"
    if manifest:
        mcam=manifest.get("camera",{});serial=mcam.get("serial") or mcam.get("serial_number")
        if serial and camera.get("serial_number") and serial!=camera.get("serial_number"):return None,f"{sample.name}: serial differs from manifest"
    return {"meta":meta,"rgb":tuple(im.shape[:2][::-1]),"depth":tuple(raw.shape[:2][::-1]),"ratio":float(np.count_nonzero(raw))/raw.size},None
def validate_dataset(root: Path):
    manifest=None;report={"samples":0,"valid":0,"errors":[],"warnings":[],"serials":set(),"schemas":set(),"deltas":[],"valid_ratios":[],"rgb":set(),"depth":set(),"manifest":None}
    try:
        if (root/"dataset.json").exists():manifest=read_metadata(root/"dataset.json");report["manifest"]=manifest
    except json.JSONDecodeError:report["errors"].append("dataset.json: invalid JSON")
    for sample in sample_directories(root):
        report["samples"]+=1; rgb,depth,metadata=(sample/"rgb.jpg",sample/"depth.png",sample/"metadata.json")
        checked,error=validate_sample(sample,manifest)
        if error:report["errors"].append(error);continue
        meta=checked["meta"];report["valid"]+=1;report["rgb"].add(checked["rgb"]);report["depth"].add(checked["depth"]);report["valid_ratios"].append(checked["ratio"])
        report["schemas"].add(meta.get("schema_version",1));report["serials"].add(meta.get("camera",{}).get("serial_number"));capture=meta.get("capture",{});
        delta=capture.get("rgb_depth_delta_ms")
        if delta is not None:report["deltas"].append(abs(float(delta)))
        elif capture:report["warnings"].append(f"{sample.name}: RGB/depth timestamps use incompatible domains; sync delta unavailable")
    if len(report["serials"]-{None})>1: report["warnings"].append("camera serial inconsistency")
    if len(report["schemas"])>1:report["warnings"].append("mixed metadata schema versions (legacy schema and schema_version=2)")
    return report
def export_training(source: Path, output: Path):
    (output/"images").mkdir(parents=True,exist_ok=True);(output/"source_metadata").mkdir(parents=True,exist_ok=True);count=0
    report=validate_dataset(source);manifest=report["manifest"] or {};skipped=[]
    for sample in sample_directories(source):
        checked,error=validate_sample(sample,manifest)
        if error:skipped.append(error);continue
        name=sample.name;shutil.copy2(sample/"rgb.jpg",output/"images"/f"{name}.jpg");shutil.copy2(sample/"metadata.json",output/"source_metadata"/f"{name}.json");count+=1
    (output/"dataset.json").write_text(json.dumps({"schema_version":1,"annotation_status":"unlabeled","purpose":manifest.get("purpose"),"camera":manifest.get("camera",{}),"capture_profile":manifest.get("capture_profile",{}),"labels":manifest.get("labels",[]),"source_dataset":str(source),"images":count,"skipped":len(skipped)},indent=2),encoding="utf-8");return count,skipped
def sample_directory(output: Path, number: int) -> Path:
    if number < 1: raise ValueError("sample number starts at 1")
    return output / f"sample_{number:06d}"
def next_sample_number(output: Path) -> int:
    """Resume after valid sample directory names; never overwrite a capture."""
    if not output.exists(): return 1
    numbers = [sample_number(path) for path in sample_directories(output)]
    return max(numbers, default=0) + 1
class RecorderSchedule:
    """Testable capture decision logic, independent of OpenCV keyboard/UI."""
    def __init__(self, interval_s: float | None, now: float): self.interval_s=interval_s; self.next_due=(now + interval_s) if interval_s is not None else None
    def should_capture(self, key: int | None, now: float) -> bool:
        manual = key == ord("s")
        timed = self.next_due is not None and now >= self.next_due
        if not manual and not timed: return False
        if self.interval_s is not None: self.next_due = now + self.interval_s
        return True
def save_sample(output: Path, number: int, rgb: np.ndarray, depth: np.ndarray, metadata: dict) -> Path:
    if depth.dtype != np.uint16: raise ValueError("raw RealSense depth must be uint16 for lossless PNG")
    directory=sample_directory(output,number);directory.mkdir(parents=True,exist_ok=False)
    if not cv2.imwrite(str(directory/"rgb.jpg"),rgb) or not cv2.imwrite(str(directory/"depth.png"),depth): raise OSError("failed to write dataset image")
    (directory/"metadata.json").write_text(json.dumps(metadata,indent=2,allow_nan=False),encoding="utf-8")
    return directory
