from abc import ABC,abstractmethod
import numpy as np
from ..models import Detection
class Detector(ABC):
 @abstractmethod
 def detect(self,image:np.ndarray)->list[Detection]: ...
class MockDetector(Detector):
 def __init__(self,detections=None): self.detections=detections or []
 def detect(self,image): return list(self.detections)
