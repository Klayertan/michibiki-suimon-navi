import math
from dataclasses import dataclass
from ..config import DeduplicationConfig
from ..geometry.georeference import EARTH_RADIUS_M
@dataclass
class Track: type:str;latitude:float;longitude:float;first_seen:float;last_seen:float;max_confidence:float;observations:int=1
def distance_m(a,b,c,d):return math.hypot(math.radians(c-a)*EARTH_RADIUS_M,math.radians(d-b)*EARTH_RADIUS_M*math.cos(math.radians((a+c)/2)))
class ObservationDeduplicator:
 def __init__(self,config=DeduplicationConfig()):self.config=config;self.tracks=[]
 def add(self,type,lat,lon,timestamp,confidence):
  radius=self.config.insect_radius_m if type=="insect" else self.config.weed_radius_m
  for t in self.tracks:
   if t.type==type and timestamp-t.last_seen<=self.config.time_window_s and distance_m(lat,lon,t.latitude,t.longitude)<=radius:t.last_seen=timestamp;t.max_confidence=max(t.max_confidence,confidence);t.observations+=1;return t,False
  t=Track(type,lat,lon,timestamp,timestamp,confidence);self.tracks.append(t);return t,True
