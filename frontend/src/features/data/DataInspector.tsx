import { FeaturePlaceholder } from '../common/FeaturePlaceholder'

export function DataInspector() {
  return (
    <FeaturePlaceholder
      title="Data"
      summary="Recorded sessions, observations, images, GNSS tracks, imported datasets, and JSON import/export."
      migrationNote="Existing export/import formats stay exactly as-is (see docs/UI_REDESIGN.md section 8) starting Stage 5."
    />
  )
}
