# First rice-versus-weed segmentation dataset

Collect a new real field dataset, not indoor D435 test images:

```bash
python3 -m edge.perception.main record --output datasets/paddy-weed-field-001 --purpose paddy_weed_training --notes "Field A, cloudy"
```

Initial visual task: separate weed vegetation from rice/crop/background. Keep the data reusable for semantic segmentation, instance segmentation, or object detection; do not choose the final annotation format until real paddy frames are reviewed. Instance segmentation remains useful for individual weeds, but dense/overlapping rice canopy can make individual rice-instance labels unnecessarily expensive. Collect at camera heights 0.6, 0.8, 1.0, 1.2, and 1.5 m. Include rice-only, rice plus weeds, small/large weeds, dense/sparse weeds, mud, standing water, reflections, sun, cloud, shadows, partial occlusion, growth stages, and small drone/camera tilts.

Export images without labels, annotate instances in an external tool, then retain the source metadata:

```bash
python3 -m edge.perception.main export-training --input datasets/paddy-weed-field-001 --output training/paddy-weed-v1
```

The export is explicitly `unlabeled`; it creates no fake annotation files. Review ambiguous water reflections and overlapping rice/weed instances before training.

Future deployment path: trained PyTorch segmentation model → supported ONNX export → TensorRT FP16 → Jetson Orin Nano Super. INT8 calibration is intentionally out of scope.
