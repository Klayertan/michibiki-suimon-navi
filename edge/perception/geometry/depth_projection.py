import numpy as np
from ..models import Detection,DepthMeasurement
from ..config import DepthValidationConfig
def robust_depth_measurement(detection,depth_raw,depth_scale,config=DepthValidationConfig()):
 h,w=depth_raw.shape[:2]
 if detection.mask is not None and detection.mask.shape[:2]==(h,w): values=depth_raw[detection.mask.astype(bool)]
 else:
  x1,y1,x2,y2=map(int,detection.bbox_xyxy);dx=max(1,(x2-x1)//4);dy=max(1,(y2-y1)//4);values=depth_raw[max(0,y1+dy):min(h,y2-dy),max(0,x1+dx):min(w,x2-dx)].ravel()
 total=len(values);meters=values.astype(float)*depth_scale;valid=meters[(meters>=config.min_distance_m)&(meters<=config.max_distance_m)];ratio=len(valid)/total if total else 0.
 if not len(valid):return DepthMeasurement(None,ratio,"invalid")
 med=float(np.median(valid));mad=float(np.median(np.abs(valid-med)));filtered=valid if mad==0 else valid[np.abs(valid-med)<=3.5*mad]
 return DepthMeasurement(float(np.median(filtered)) if len(filtered) else None,ratio,"good" if ratio>=config.min_valid_pixel_ratio else "limited")
def pixel_depth_to_camera_xyz(pixel_xy,depth_m,intrinsics,rs_module=None):
 """Meters in RealSense optical frame: +X right, +Y down, +Z forward."""
 if rs_module:return tuple(float(x) for x in rs_module.rs2_deproject_pixel_to_point(intrinsics,list(pixel_xy),depth_m))
 return ((pixel_xy[0]-intrinsics.ppx)/intrinsics.fx*depth_m,(pixel_xy[1]-intrinsics.ppy)/intrinsics.fy*depth_m,depth_m)
