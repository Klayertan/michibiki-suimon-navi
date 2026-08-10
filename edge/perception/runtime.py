from collections import deque
import time
class SyncStatistics:
    def __init__(self, capacity=300): self.values=deque(maxlen=capacity);self.total=0.;self.samples_total=0;self.max_total=None
    def add(self, delta_ms):
        if delta_ms is not None:
            value=abs(float(delta_ms));self.values.append(value);self.total+=value;self.samples_total+=1;self.max_total=value if self.max_total is None else max(self.max_total,value)
    def summary(self): return {"current_ms":self.values[-1] if self.values else None,"mean_ms":sum(self.values)/len(self.values) if self.values else None,"max_ms":max(self.values) if self.values else None,"samples":len(self.values)}
    def session_summary(self): return {"mean_ms":self.total/self.samples_total if self.samples_total else None,"max_ms":self.max_total,"samples":self.samples_total}
class RuntimeStatistics:
    def __init__(self, capacity=60, session_start_monotonic=None): self.capture_times=deque(maxlen=capacity);self.detection_times=deque(maxlen=capacity);self.inference_times=deque(maxlen=capacity);self.latencies=deque(maxlen=capacity);self.capture_frames=0;self.detection_frames=0;self.total_inference_time_s=0.;self.inference_samples_total=0;self.total_pipeline_latency_s=0.;self.latency_samples_total=0;self.session_start_monotonic=time.monotonic() if session_start_monotonic is None else session_start_monotonic
    def capture(self, now=None): self.capture_times.append(now if now is not None else time.monotonic());self.capture_frames+=1
    def detection(self, now=None): self.detection_times.append(now if now is not None else time.monotonic());self.detection_frames+=1
    def inference(self, elapsed_s): self.inference_times.append(elapsed_s);self.total_inference_time_s+=elapsed_s;self.inference_samples_total+=1
    def latency(self, elapsed_s): self.latencies.append(elapsed_s);self.total_pipeline_latency_s+=elapsed_s;self.latency_samples_total+=1
    def _fps(self, values):
        return (len(values)-1)/(values[-1]-values[0]) if len(values)>1 and values[-1]>values[0] else 0.
    def capture_fps(self): return self._fps(self.capture_times)
    def detection_fps(self): return self._fps(self.detection_times)
    def mean_inference_ms(self): return 1000*sum(self.inference_times)/len(self.inference_times) if self.inference_times else None
    def mean_latency_ms(self): return 1000*sum(self.latencies)/len(self.latencies) if self.latencies else None
    def session_summary(self, now=None):
        runtime=(time.monotonic() if now is None else now)-self.session_start_monotonic
        return {"runtime_s":max(0.,runtime),"capture_fps":self.capture_frames/runtime if runtime>0 else 0.,"detection_fps":self.detection_frames/runtime if runtime>0 else 0.,"mean_inference_ms":1000*self.total_inference_time_s/self.inference_samples_total if self.inference_samples_total else None,"mean_latency_ms":1000*self.total_pipeline_latency_s/self.latency_samples_total if self.latency_samples_total else None}
class FrameDropCounter:
    """Independent counters; only monotonically advancing sequence gaps count."""
    def __init__(self): self.previous_rgb=None;self.previous_depth=None;self.rgb_dropped=0;self.depth_dropped=0
    def _add(self, previous, current, attribute):
        if current is not None and previous is not None and current>previous:self.__dict__[attribute]+=max(0,current-previous-1)
        return current if current is not None else previous
    def add(self,rgb,depth): self.previous_rgb=self._add(self.previous_rgb,rgb,"rgb_dropped");self.previous_depth=self._add(self.previous_depth,depth,"depth_dropped")
def display_value(value, suffix=""):
    return "--" if value is None else f"{value}{suffix}"
def mock_hud(camera, capture_fps, detection_fps, inference_ms, latency_ms, delta_ms, drops, detection, depth):
    distance = None if depth is None else depth.distance_m
    quality = "INVALID" if depth is None else depth.quality.upper()
    return [f"{camera.get('product_name','RealSense')} / USB {camera.get('usb_descriptor','--')}",f"Capture: {capture_fps:.1f} FPS",f"Detection: {detection_fps:.1f} FPS",f"Inference: {inference_ms:.1f} ms",f"Latency: {latency_ms:.1f} ms",f"RGB↔Depth: {display_value(None if delta_ms is None else f'{delta_ms:.1f} ms')}",f"RGB frame gaps: {drops.rgb_dropped}",f"Depth frame gaps: {drops.depth_dropped}","",f"{detection.class_name} {detection.confidence:.2f}",f"Depth: {display_value(None if distance is None else f'{distance:.3f} m')}",f"Quality: {quality}"]
class PeriodicInfo:
    def __init__(self, interval_s=1.0): self.interval_s=interval_s;self.last=None
    def due(self, now):
        if self.last is None or now-self.last>=self.interval_s:self.last=now;return True
        return False
