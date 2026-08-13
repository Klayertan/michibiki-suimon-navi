import { FeaturePlaceholder } from '../common/FeaturePlaceholder'

export function AiInspector() {
  return (
    <FeaturePlaceholder
      title="AI Inspection"
      summary="Camera status, RGB/depth preview, weed/pest/disease detections, confidence, location, image evidence, and human confirmation."
      migrationNote="No RealSense/ML pipeline exists yet anywhere in this codebase (confirmed in the Stage 0 audit) -- this workspace stays a placeholder/interface design until Stage 7."
    />
  )
}
