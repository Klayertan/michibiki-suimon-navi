"""Future instance-segmentation adapter: rice and weed."""
from .base import Detector
class WeedSegmentationDetector(Detector):
    def __init__(self, model_path=None):
        if not model_path: raise RuntimeError("No weed model configured. Collect and annotate field data first.")
        raise RuntimeError("Weed model runtime is not implemented yet; no trained weights are bundled.")
    def detect(self, image): raise RuntimeError("No weed model configured. Collect and annotate field data first.")
