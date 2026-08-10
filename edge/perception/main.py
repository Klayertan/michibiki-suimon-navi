"""Commands for RealSense verification, preview, and field data recording."""
from __future__ import annotations
import argparse,json,logging,signal,time
from pathlib import Path
import cv2
from .camera.realsense import RealSenseCamera,enumerate_devices
from .config import PerceptionConfig
from .dataset import RecorderSchedule,next_sample_number,save_sample,build_metadata,create_manifest,validate_dataset,export_training
from .runtime import SyncStatistics,RuntimeStatistics,FrameDropCounter,PeriodicInfo,mock_hud
from .models import Detection
from .detection.base import MockDetector
from .geometry.depth_projection import robust_depth_measurement
def camera_info(_):
 camera=RealSenseCamera();logging.getLogger(__name__).info("RealSense hardware:\n%s",json.dumps({"devices":enumerate_devices(),"supported_profiles":camera.supported_profiles()},indent=2))
def preview(args,record=False):
 config=PerceptionConfig();output=Path(args.output) if record else None;sample=next_sample_number(output)-1 if record else 0;schedule=RecorderSchedule(getattr(args,"interval",None) if record else None,time.monotonic());sync=SyncStatistics();stats=RuntimeStatistics()
 try:
  with RealSenseCamera(config.camera) as camera:
   if record:create_manifest(output,getattr(args,"purpose","general_capture"),getattr(args,"notes",""),{"model":camera.device_info.get("product_name"),"serial":camera.device_info.get("serial_number")},{"rgb":f"{config.camera.rgb_width}x{config.camera.rgb_height}@{config.camera.rgb_fps}","depth":f"{config.camera.depth_width}x{config.camera.depth_height}@{config.camera.depth_fps}"})
   while True:
    frame=camera.get_frames();sync.add(frame.rgb_depth_delta_ms);stats.capture();depth_display=cv2.applyColorMap(cv2.convertScaleAbs(frame.depth,alpha=.03),cv2.COLORMAP_TURBO);cv2.imshow("RealSense RGB",frame.rgb);cv2.imshow("Aligned depth",depth_display);key=cv2.waitKey(1)&255
    if len(stats.capture_times)%300==0:
     summary=sync.summary();logging.info("RGB/depth sync: current=%s mean=%s max=%s samples=%d",summary["current_ms"],summary["mean_ms"],summary["max_ms"],summary["samples"])
    if record and schedule.should_capture(key,time.monotonic()):
     sample+=1;directory=save_sample(output,sample,frame.rgb,frame.depth,build_metadata(frame,camera.device_info or {},config.camera.rgb_fps));logging.info("Saved %s",directory)
    if key in (27,ord("q")):break
 except KeyboardInterrupt: logging.info("Stopping perception...")
 finally: cv2.destroyAllWindows();logging.info("RealSense stopped.")
def run_mock(args):
 """Visible end-to-end smoke test; it does not claim trained AI or publish."""
 config=PerceptionConfig();logging.warning("MOCK DETECTOR active: deterministic test detection; no observations will be published")
 sync=SyncStatistics();stats=RuntimeStatistics();drops=FrameDropCounter();periodic=PeriodicInfo();frames=0;session_started=time.monotonic()
 try:
  with RealSenseCamera(config.camera) as camera:
   while True:
    started=time.monotonic();frame=camera.get_frames();stats.capture();sync.add(frame.rgb_depth_delta_ms);drops.add(frame.rgb_frame_number,frame.depth_frame_number);h,w=frame.rgb.shape[:2];detector=MockDetector([Detection("mock_weed",.99,(w*.35,h*.35,w*.65,h*.65))]);image=frame.rgb.copy();inference_started=time.monotonic();detections=detector.detect(image);detection=detections[0];depth=robust_depth_measurement(detection,frame.depth,frame.depth_scale,config.depth)
    x1,y1,x2,y2=map(int,detection.bbox_xyxy);cv2.rectangle(image,(x1,y1),(x2,y2),(0,255,255),2)
    inference_s=time.monotonic()-inference_started;stats.inference(inference_s);stats.detection();frames+=1;latency=(time.monotonic()-started)*1000;stats.latency(latency/1000);hud=mock_hud(camera.device_info or {},stats.capture_fps(),stats.detection_fps(),inference_s*1000,latency,frame.rgb_depth_delta_ms,drops,detection,depth)
    for index,line in enumerate(hud):cv2.putText(image,line,(10,25+20*index),cv2.FONT_HERSHEY_SIMPLEX,.5,(255,255,255),1)
    cv2.imshow("MOCK DETECTOR - no publishing",image);logging.debug("MOCK DETECTOR: class=%s confidence=%.2f depth=%s quality=%s",detection.class_name,detection.confidence,depth.distance_m,depth.quality)
    if periodic.due(time.monotonic()):logging.info("Perception: capture=%.1f FPS detection=%.1f FPS inference=%.1f ms latency=%.1f ms sync=%s depth=%s quality=%s",stats.capture_fps(),stats.detection_fps(),inference_s*1000,latency,"--" if frame.rgb_depth_delta_ms is None else f"{frame.rgb_depth_delta_ms:.1f} ms","--" if depth.distance_m is None else f"{depth.distance_m:.3f} m",depth.quality)
    if cv2.waitKey(1)&255 in (27,ord("q")):break
 except KeyboardInterrupt: logging.info("Stopping perception...")
 finally:
  cv2.destroyAllWindows();summary=sync.session_summary();session=stats.session_summary();logging.info("Session summary\nCapture frames: %d\nMean capture FPS: %.1f\nDetection frames: %d\nMean effective detection FPS: %.1f\nMean inference time: %s\nMean pipeline latency: %s\nRGB frame gaps: %d\nDepth frame gaps: %d\nMean |RGB-depth delta|: %s\nMax |RGB-depth delta|: %s\nRuntime: %.1f s",stats.capture_frames,session["capture_fps"],stats.detection_frames,session["detection_fps"],"--" if session["mean_inference_ms"] is None else f"{session['mean_inference_ms']:.1f} ms","--" if session["mean_latency_ms"] is None else f"{session['mean_latency_ms']:.1f} ms",drops.rgb_dropped,drops.depth_dropped,"--" if summary["mean_ms"] is None else f"{summary['mean_ms']:.1f} ms","--" if summary["max_ms"] is None else f"{summary['max_ms']:.1f} ms",session["runtime_s"]);logging.info("RealSense stopped.")
def validate_command(args):
 report=validate_dataset(Path(args.input));mean=lambda values:sum(values)/len(values) if values else None
 manifest=report["manifest"] or {};logging.info("Dataset: %s\nSamples: %d\nValid samples: %d\nRGB dimensions: %s\nDepth dimensions: %s\nDepth dtype: uint16 (validated)\nCamera manifest: %s\nSample serials: %s\nFirmware/USB: recorded per sample metadata\nDepth scale: recorded/validated per sample\nSchema versions: %s\nTimestamp domains/deltas: delta available for %d samples\nMean valid depth: %s\nMinimum valid depth: %s\nMaximum valid depth: %s\nMean RGB/depth delta: %s ms\nMaximum sync delta: %s ms\nManifest purpose: %s\nManifest capture profile: %s\nErrors: %d\nWarnings: %d",args.input,report["samples"],report["valid"],report["rgb"],report["depth"],manifest.get("camera"),report["serials"],report["schemas"],len(report["deltas"]),mean(report["valid_ratios"]),min(report["valid_ratios"],default=None),max(report["valid_ratios"],default=None),mean(report["deltas"]),max(report["deltas"],default=None),manifest.get("purpose"),manifest.get("capture_profile"),len(report["errors"]),len(report["warnings"]))
 for message in report["errors"]+report["warnings"]:logging.warning(message)
def export_command(args):
 count,skipped=export_training(Path(args.input),Path(args.output));logging.info("Exported = %d; skipped = %d",count,len(skipped))
 for reason in skipped:logging.warning(reason)
def main():
 logging.basicConfig(level=logging.INFO,format="%(asctime)s %(levelname)s %(name)s: %(message)s");parser=argparse.ArgumentParser();commands=parser.add_subparsers(required=True)
 commands.add_parser("camera-info").set_defaults(func=camera_info)
 commands.add_parser("preview").set_defaults(func=lambda a:preview(a))
 record=commands.add_parser("record");record.add_argument("--output",required=True);record.add_argument("--interval",type=float);record.add_argument("--purpose",default="general_capture");record.add_argument("--notes",default="");record.set_defaults(func=lambda a:preview(a,True))
 run=commands.add_parser("run");run.add_argument("--detector",default="mock",choices=["mock"]);run.set_defaults(func=run_mock)
 validate=commands.add_parser("validate-dataset");validate.add_argument("--input",required=True);validate.set_defaults(func=validate_command)
 export=commands.add_parser("export-training");export.add_argument("--input",required=True);export.add_argument("--output",required=True);export.set_defaults(func=export_command)
 args=parser.parse_args();args.func(args)
if __name__=="__main__":main()
