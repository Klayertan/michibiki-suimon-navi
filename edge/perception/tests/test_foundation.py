import unittest
import json
from types import SimpleNamespace
import numpy as np
import cv2
from tempfile import TemporaryDirectory
from pathlib import Path
from edge.perception.config import CameraProfile,TileConfig,DepthValidationConfig,TelemetryConfig
from edge.perception.models import Detection,CameraFrames
from edge.perception.detection.base import MockDetector
from edge.perception.detection.tile_inference import tiled_detect,nms
from edge.perception.geometry.depth_projection import robust_depth_measurement,pixel_depth_to_camera_xyz
from edge.perception.geometry.transforms import rotation_matrix_rpy_deg,camera_to_body,body_to_local_ned
from edge.perception.geometry.georeference import local_ned_to_lat_lon
from edge.perception.telemetry.telemetry_client import TelemetryClient
from edge.perception.output.observation import build_drone_observation
from edge.perception.tracking.deduplicate import ObservationDeduplicator
from edge.perception.dataset import sample_directory,save_sample,next_sample_number,RecorderSchedule,serialize_intrinsics,build_metadata,create_manifest,validate_dataset,export_training
from edge.perception.runtime import SyncStatistics,RuntimeStatistics,FrameDropCounter,PeriodicInfo,mock_hud
from edge.perception.camera.realsense import RealSenseCamera,UnsupportedProfileError,RealSenseUnavailable,enumerate_devices

class FoundationTests(unittest.TestCase):
 def test_config_validation(self):
  with self.assertRaises(ValueError):CameraProfile(rgb_width=0)
  with self.assertRaises(ValueError):TileConfig(overlap=1)
  with self.assertRaises(ValueError):TelemetryConfig(freshness_ms=0)
 def test_tiled_coordinate_reconstruction(self):
  image=np.zeros((100,200,3),np.uint8);det=MockDetector([Detection("insect",.9,(1,2,5,6))]);out=tiled_detect(image,det,TileConfig(width=100,height=100,overlap=0,confidence_threshold=.1));self.assertIn((101,2,105,6),[d.bbox_xyxy for d in out])
 def test_tiled_duplicate_merge(self):
  self.assertEqual(len(nms([Detection("insect",.9,(0,0,10,10)),Detection("insect",.8,(1,1,11,11))],.5)),1)
 def test_tiled_mask_reconstruction(self):
  image=np.zeros((100,200,3),np.uint8);mask=np.ones((100,100),np.uint8);out=tiled_detect(image,MockDetector([Detection("weed",.9,(0,0,4,4),mask)]),TileConfig(width=100,height=100,overlap=0));self.assertEqual(out[1].mask.shape,(100,200));self.assertEqual(out[1].mask[20,120],1);self.assertEqual(out[1].mask[20,20],0)
 def test_robust_depth_and_invalid(self):
  d=Detection("weed",.9,(0,0,8,8));depth=np.full((8,8),1000,np.uint16);depth[4,4]=9000;m=robust_depth_measurement(d,depth,.001);self.assertAlmostEqual(m.distance_m,1);self.assertEqual(m.quality,"good");self.assertEqual(robust_depth_measurement(d,np.zeros((8,8),np.uint16),.001).quality,"invalid")
 def test_depth_mask_limited_and_bounds(self):
  mask=np.zeros((10,10),bool);mask[5,5]=True;d=Detection("weed",.9,(-3,-3,2,2),mask);self.assertEqual(robust_depth_measurement(d,np.where(mask,1000,0).astype(np.uint16),.001).quality,"good");raw=np.zeros((20,20),np.uint16);raw[8,8]=1000;self.assertEqual(robust_depth_measurement(Detection("weed",.9,(0,0,20,20)),raw,.001).quality,"limited");self.assertEqual(robust_depth_measurement(Detection("weed",.9,(-3,-3,1,1)),np.zeros((10,10),np.uint16),.001).distance_m,None)
 def test_pinhole_projection(self):
  i=SimpleNamespace(ppx=10,ppy=20,fx=10,fy=10);self.assertEqual(pixel_depth_to_camera_xyz((20,30),2,i),(2.,2.,2.))
 def test_transforms(self):
  self.assertTrue(np.allclose(camera_to_body((1,0,0),(0,0,0),(0,0,0)),[1,0,0]));self.assertTrue(np.allclose(rotation_matrix_rpy_deg(0,0,90)@np.array([1,0,0]),[0,1,0]));self.assertTrue(np.allclose(camera_to_body((0,0,1),(0,0,0),(0,90,0)),[1,0,0]));self.assertTrue(np.allclose(camera_to_body((1,0,0),(1,2,3),(0,0,0)),[2,2,3]));self.assertTrue(np.allclose(body_to_local_ned((1,0,0),0,0,90),[0,1,0]))
 def test_local_offsets(self):
  lat,lon=local_ned_to_lat_lon(0,0,0,0);self.assertEqual((lat,lon),(0,0));self.assertGreater(local_ned_to_lat_lon(35,139,1,0)[0],35);self.assertGreater(local_ned_to_lat_lon(35,139,0,1)[1],139)
 def test_stale_telemetry(self):
  c=TelemetryClient("http://invalid",100);c.latest=SimpleNamespace(received_monotonic=1);self.assertIsNone(c.closest_fresh(2)[0])
 def test_telemetry_status_validation(self):
  c=TelemetryClient();healthy={"connectionState":"connected","connected":True,"link":{"stale":False,"lastMessageAge":.02},"gps":{"fixType":3},"position":{"available":True,"lat":0,"lon":0,"altRelative":2},"attitude":{"roll":0,"pitch":0,"yaw":0}}
  sample=c.parse_status(healthy,1);self.assertIsNotNone(sample);self.assertEqual((sample.latitude,sample.longitude),(0,0));self.assertIsNone(c.parse_status({**healthy,"link":{"stale":True}},1));self.assertIsNone(c.parse_status({**healthy,"gps":{"fixType":1}},1));self.assertIsNone(c.parse_status({**healthy,"position":{"available":False,"lat":0,"lon":0,"altRelative":2}},1))
 def test_observation_and_dedup(self):
  o=build_drone_observation(observation_type="weed",latitude=35,longitude=139,confidence=.94,model="mock",captured_at="now");self.assertEqual(o["properties"]["sourceType"],"drone_ai");d=ObservationDeduplicator();self.assertTrue(d.add("weed",35,139,0,.5)[1]);track,new=d.add("weed",35,139,1,.9);self.assertFalse(new);self.assertEqual(track.observations,2)
 def test_dataset_naming_metadata_and_raw_depth(self):
  with TemporaryDirectory() as temp:
   root=Path(temp);self.assertEqual(sample_directory(root,1).name,"sample_000001");depth=np.array([[1000]],dtype=np.uint16);directory=save_sample(root,1,np.zeros((1,1,3),np.uint8),depth,{"drone":{"latitude":None}});self.assertEqual(cv2.imread(str(directory/"depth.png"),cv2.IMREAD_UNCHANGED).dtype,np.uint16);self.assertIsNone(__import__("json").loads((directory/"metadata.json").read_text())["drone"]["latitude"])
   (root/"sample_000003").mkdir();self.assertEqual(next_sample_number(root),4)
 def test_recorder_schedule_manual_and_timed(self):
  manual=RecorderSchedule(None,10);self.assertTrue(manual.should_capture(ord("s"),11));self.assertTrue(manual.should_capture(ord("s"),12));self.assertIsNone(manual.next_due);timed=RecorderSchedule(2,10);self.assertFalse(timed.should_capture(None,11));self.assertTrue(timed.should_capture(None,12));self.assertEqual(timed.next_due,14)
 def test_structured_intrinsics(self):
  i=SimpleNamespace(width=1280,height=720,ppx=1,ppy=2,fx=3,fy=4,model="brown",coeffs=[1,2,3,4,5]);self.assertEqual(serialize_intrinsics(i)["coeffs"],[1.,2.,3.,4.,5.])
 def test_unsupported_profile_includes_format(self):
  camera=RealSenseCamera();camera.supported_profiles=lambda:[{"stream":"color","width":1280,"height":720,"fps":30,"format":"RGB8"},{"stream":"depth","width":1280,"height":720,"fps":30,"format":"Z16"}]
  with self.assertRaisesRegex(UnsupportedProfileError,"BGR8"):camera._validate_requested_profile()
 def test_selected_serial_metadata(self):
  class Info: serial_number="serial";name="name";firmware_version="firmware";usb_type_descriptor="usb"
  class Device:
   def __init__(self,serial):self.serial=serial
   def get_info(self,key):return self.serial if key=="serial" else key
   def supports(self,key):return True
  class Context:
   def query_devices(self):return [Device("first"),Device("wanted")]
  class RS: camera_info=Info;context=lambda self:Context()
  camera=RealSenseCamera(serial="wanted",rs_module=RS());self.assertEqual(camera._device_info(camera._selected_device(camera._rs),camera._rs)["serial_number"],"wanted")
 def test_backend_unreachable(self):
  self.assertIsNone(TelemetryClient("http://127.0.0.1:1").poll())
 def test_camera_stop_is_idempotent(self):
  class Pipeline:
   def __init__(self):self.calls=0
   def stop(self):self.calls+=1
  camera=RealSenseCamera();pipeline=Pipeline();camera._pipeline=pipeline;camera.stop();camera.stop();self.assertEqual(pipeline.calls,1)
 def test_v2_metadata_separate_timing_calibration_and_extrinsics(self):
  i=SimpleNamespace(width=2,height=1,ppx=1,ppy=1,fx=1,fy=1,model="m",coeffs=[]);ext=SimpleNamespace(rotation=[1]*9,translation=[.1,.2,.3]);frame=CameraFrames(np.zeros((1,2,3),np.uint8),np.ones((1,2),np.uint16),.001,i,i,i,ext,101.,99.,"hardware_clock","hardware_clock",180,187);meta=build_metadata(frame,{"serial_number":"serial"},30,"now");self.assertEqual(meta["schema_version"],2);self.assertEqual(meta["capture"]["rgb_depth_delta_ms"],2);self.assertEqual(meta["capture"]["depth_frame_number"],187);self.assertIn("depth_native",meta["intrinsics"]);self.assertEqual(meta["extrinsics"]["depth_to_color"]["translation_m"],[.1,.2,.3])
 def test_dataset_validation_manifest_and_unlabeled_export(self):
  with TemporaryDirectory() as temp:
   root=Path(temp)/"source";create_manifest(root,notes="cloudy");save_sample(root,1,np.zeros((2,2,3),np.uint8),np.ones((2,2),np.uint16),{"schema_version":2,"camera":{"serial_number":"one","depth_scale":.001},"capture":{"rgb_depth_delta_ms":1}});(root/"sample_000002").mkdir();report=validate_dataset(root);self.assertEqual(report["samples"],2);self.assertEqual(report["valid"],1);self.assertTrue(report["errors"]);out=Path(temp)/"out";self.assertEqual(export_training(root,out)[0],1);export=json.loads((out/"dataset.json").read_text());self.assertEqual(export["annotation_status"],"unlabeled");self.assertFalse((out/"labels").exists())
 def test_sync_and_runtime_statistics(self):
  sync=SyncStatistics();sync.add(None);sync.add(-1);sync.add(3);self.assertEqual(sync.summary(),{"current_ms":3.,"mean_ms":2.,"max_ms":3.,"samples":2});stats=RuntimeStatistics();stats.capture(1);stats.capture(2);stats.detection(1);stats.detection(2);stats.inference(.1);self.assertEqual(stats.capture_fps(),1);self.assertEqual(stats.detection_fps(),1);self.assertEqual(stats.mean_inference_ms(),100)
 def test_timestamp_domains_and_drop_counters(self):
  i=SimpleNamespace(width=1,height=1,ppx=0,ppy=0,fx=1,fy=1,model="m",coeffs=[]);e=SimpleNamespace(rotation=[1]*9,translation=[0]*3);same=CameraFrames(np.zeros((1,1,3),np.uint8),np.zeros((1,1),np.uint16),.001,i,i,i,e,10,8,"hardware_clock","hardware_clock");different=CameraFrames(np.zeros((1,1,3),np.uint8),np.zeros((1,1),np.uint16),.001,i,i,i,e,10,8,"hardware_clock","system_time");missing=CameraFrames(np.zeros((1,1,3),np.uint8),np.zeros((1,1),np.uint16),.001,i,i,i,e,10,8,None,"hardware_clock");self.assertEqual(same.rgb_depth_delta_ms,2);self.assertIsNone(different.rgb_depth_delta_ms);self.assertIsNone(missing.rgb_depth_delta_ms);drops=FrameDropCounter();drops.add(100,50);drops.add(102,51);drops.add(1,1);self.assertEqual((drops.rgb_dropped,drops.depth_dropped),(1,0))
 def test_manifest_defaults_and_compatibility(self):
  with TemporaryDirectory() as temp:
   root=Path(temp);path=create_manifest(root,camera={"serial":"one"},profile={"rgb":"a","depth":"b"});self.assertEqual(json.loads(path.read_text())["labels"],[]);weed=Path(temp)/"weed";self.assertEqual(json.loads(create_manifest(weed,"paddy_weed_training").read_text())["labels"],["rice","weed"]);self.assertRaises(ValueError,create_manifest,root,"general_capture","",{"serial":"two"},{"rgb":"a","depth":"b"})
 def test_exact_sample_names_and_validation_cross_checks(self):
  with TemporaryDirectory() as temp:
   root=Path(temp);create_manifest(root,camera={"serial":"one"});[ (root/name).mkdir() for name in ("sample_notes","sample_backup","sample_12abc") ];self.assertEqual(next_sample_number(root),1);bad=root/"sample_000001";bad.mkdir();save_sample(root,2,np.zeros((2,2,3),np.uint8),np.ones((2,2),np.uint16),{"schema_version":2,"camera":{"serial_number":"two","depth_scale":.001,"rgb_width":3,"rgb_height":2}});report=validate_dataset(root);self.assertEqual(report["samples"],2);self.assertTrue(report["errors"])
 def test_gitignore_local_data(self):
  ignored=(Path(__file__).parents[3]/".gitignore").read_text();self.assertIn("datasets/",ignored);self.assertIn("training/",ignored)
 def test_runtime_hud_throttle_and_invalid_depth(self):
  self.assertTrue(PeriodicInfo(1).due(0));periodic=PeriodicInfo(1);self.assertTrue(periodic.due(0));self.assertFalse(periodic.due(.5));d=Detection("mock_weed",.99,(0,0,1,1));drops=FrameDropCounter();depth=SimpleNamespace(distance_m=None,quality="invalid");hud=mock_hud({"product_name":"D435","usb_descriptor":"3.2"},1,2,.5,3,None,drops,d,depth);self.assertIn("RGB↔Depth: --",hud);self.assertIn("Depth: --",hud);self.assertIn("Quality: INVALID",hud);self.assertIn("Inference: 0.5 ms",hud);self.assertIn("RGB frame gaps: 0",hud)
 def test_lifetime_metrics_are_not_rolling_metrics(self):
  stats=RuntimeStatistics(capacity=2,session_start_monotonic=0)
  for now,inference,latency in ((1,.001,.01),(2,.002,.02),(3,.100,.30)):
   stats.capture(now);stats.detection(now);stats.inference(inference);stats.latency(latency)
  self.assertEqual(len(stats.inference_times),2);self.assertAlmostEqual(stats.mean_inference_ms(),51);session=stats.session_summary(3);self.assertEqual(session["capture_fps"],1);self.assertEqual(session["detection_fps"],1);self.assertAlmostEqual(session["mean_inference_ms"],103/3);self.assertAlmostEqual(session["mean_latency_ms"],110)
  sync=SyncStatistics(capacity=2);sync.add(None);sync.add(1);sync.add(2);sync.add(100);self.assertEqual(sync.summary()["mean_ms"],51);self.assertEqual(sync.session_summary(),{"mean_ms":103/3,"max_ms":100.,"samples":3})
 def test_realsense_sdk_access_errors_are_actionable_and_chained(self):
  class Context:
   def query_devices(self):raise RuntimeError("failed to set power state")
  class RS: context=lambda self:Context()
  with self.assertRaises(RealSenseUnavailable) as caught:enumerate_devices(RS())
  self.assertIsInstance(caught.exception.__cause__,RuntimeError);self.assertIn("verify rs-enumerate-devices",str(caught.exception))
  with self.assertRaises(RealSenseUnavailable) as caught:RealSenseCamera(rs_module=RS())._selected_device(RS())
  self.assertIsInstance(caught.exception.__cause__,RuntimeError)
 def test_profile_and_pipeline_sdk_errors_are_chained(self):
  class Sensor:
   def get_stream_profiles(self):raise RuntimeError("profile access failed")
  class Device:
   def query_sensors(self):return [Sensor()]
  class Context:
   def query_devices(self):return [Device()]
  class RS: context=lambda self:Context()
  with self.assertRaises(RealSenseUnavailable) as caught:RealSenseCamera(rs_module=RS()).supported_profiles()
  self.assertIsInstance(caught.exception.__cause__,RuntimeError)
  class Pipeline:
   def start(self,cfg):raise RuntimeError("start failed")
   def stop(self):pass
  class Config:
   def enable_stream(self,*_):pass
  class Stream: color="color";depth="depth"
  class Format: bgr8="bgr8";z16="z16"
  class StartRS: config=lambda self:Config();pipeline=lambda self:Pipeline();stream=Stream();format=Format()
  camera=RealSenseCamera(rs_module=StartRS());camera._selected_device=lambda _:object();camera._validate_requested_profile=lambda:None
  with self.assertRaises(RealSenseUnavailable) as caught:camera.start()
  self.assertIsInstance(caught.exception.__cause__,RuntimeError)
 def test_unsupported_profile_not_translated_on_start(self):
  camera=RealSenseCamera(rs_module=object());camera._selected_device=lambda _:object();camera._validate_requested_profile=lambda:(_ for _ in ()).throw(UnsupportedProfileError("unsupported"))
  with self.assertRaises(UnsupportedProfileError):camera.start()
