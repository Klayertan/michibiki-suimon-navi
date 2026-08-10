import numpy as np
from .base import Detector
from ..models import Detection
from ..config import TileConfig
def tile_origins(length,tile,overlap):
 if length<=tile:return [0]
 step=max(1,round(tile*(1-overlap)));out=list(range(0,length-tile+1,step));return out if out[-1]==length-tile else out+[length-tile]
def iou(a,b):
 x1,y1,x2,y2=map(float,a);X1,Y1,X2,Y2=map(float,b);inter=max(0,min(x2,X2)-max(x1,X1))*max(0,min(y2,Y2)-max(y1,Y1));union=(x2-x1)*(y2-y1)+(X2-X1)*(Y2-Y1)-inter;return inter/union if union else 0.
def nms(detections,threshold):
 """Class-aware NMS; the highest-confidence detection and its mask survive."""
 kept=[]
 for d in sorted(detections,key=lambda d:d.confidence,reverse=True):
  if not any(d.class_name==x.class_name and iou(d.bbox_xyxy,x.bbox_xyxy)>=threshold for x in kept):kept.append(d)
 return kept
def tiled_detect(image,detector:Detector,config:TileConfig):
 all_d=[];h,w=image.shape[:2]
 for y in tile_origins(h,config.height,config.overlap):
  for x in tile_origins(w,config.width,config.overlap):
   for d in detector.detect(image[y:y+config.height,x:x+config.width]):
    if d.confidence>=config.confidence_threshold:
     x1,y1,x2,y2=d.bbox_xyxy;mask=None
     if d.mask is not None:
      # Tile-local masks are expanded to the original frame, even for edge tiles.
      mask=np.zeros((h,w),dtype=d.mask.dtype);mh,mw=d.mask.shape[:2];mask[y:min(h,y+mh),x:min(w,x+mw)]=d.mask[:max(0,h-y),:max(0,w-x)]
     all_d.append(Detection(d.class_name,d.confidence,(x1+x,y1+y,x2+x,y2+y),mask))
 return nms(all_d,config.nms_iou_threshold)
