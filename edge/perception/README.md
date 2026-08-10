# Jetson perception foundation

## Verified hardware status

VERIFIED on Jetson Orin Nano Super: RealSense D435, serial `135522071535`, firmware `5.12.7.150`, USB 3.2, librealsense 2.58.3 RSUSB; 1280×720 BGR8/RGB8 colour at 30 FPS and 1280×720 Z16 depth at 30 FPS. Physical capture, alignment, preview, mock detection/depth fusion, and seven dataset samples were tested. RGB/depth frame numbers can differ and are not synchronization evidence.

NOT YET VERIFIED: weed AI, insect AI, mount calibration, target geolocation, QZ1 fusion, automatic observation publishing, and flight operation.

## Hardware and verification

Target hardware is a Jetson Orin Nano Super and a rigidly mounted Intel RealSense D435. Use a USB 3 connection. On Jetson, install the `pyrealsense2` binding supplied by a JetPack-compatible Intel/librealsense package; do not blindly install a PyPI wheel.

```bash
lsusb | grep -Ei "Intel|RealSense"
rs-enumerate-devices
rs-enumerate-devices -s
realsense-viewer
python -m edge.perception.main camera-info
python -m edge.perception.main preview
```

For the next validation step, send the complete output of the first three
commands, the `camera-info` output, and a screenshot/report from the Viewer
showing the selected RGB and depth profiles, firmware, USB type, and whether
the aligned preview remains stable for one minute.

`camera-info` lists actual profiles before capture; requested profiles are validated instead of assuming a D345 resolution. Preview shows SDK-aligned depth. Press `q`/Escape or Ctrl-C for deterministic cleanup.

## Dataset collection

```bash
python -m edge.perception.main record --output datasets/paddy-001
python -m edge.perception.main record --output datasets/paddy-001 --interval 2
```

Press `s` for manual capture. Each sample contains `rgb.jpg`, raw lossless 16-bit `depth.png`, and versioned `metadata.json`; a dataset session starts with `dataset.json`. Metadata preserves native-depth, aligned-depth, and colour intrinsics, plus RealSense native-depth→colour extrinsics. Extrinsic rotation is RealSense SDK row-major 3×3 and translation is metres. Convert raw depth pixels to metres with `depth_m = depth_pixel * camera.depth_scale`. Telemetry fields remain null until a safe backend client is integrated into the recorder.

## Frames and georeferencing

RealSense deprojection follows the SDK optical frame: +X image-right, +Y image-down, +Z camera-forward, in metres. Drone body uses Pixhawk/ArduPilot FRD: +X forward, +Y right, +Z down. Navigation uses NED: +X north, +Y east, +Z down. `camera_to_body` and `body_to_local_ned` use active, source-to-destination extrinsic rotations composed yaw-pitch-roll. Mount angles are explicit because a visually downward camera is not a calibration. Measure camera translation from drone body origin and roll/pitch/yaw before use; validate attitudes and altitude conventions before field georeferencing.

Flooded paddy water can produce invalid stereo depth. RGB detections remain valid when depth is invalid; only 3D position is omitted. Propeller motion, blur, occlusion, and tiny insects remain field limitations; tiled inference is ready but no trained weed or insect detector is included.

The telemetry client only reads the existing local backend `/api/drone/status`; it never opens a Pixhawk serial/MAVLink connection. TensorRT/PyTorch/ONNX adapters are future detector implementations, with FP16 TensorRT the intended deployment target.
