import { FeaturePlaceholder } from '../common/FeaturePlaceholder'

export function WaterInspector() {
  return (
    <FeaturePlaceholder
      title="Water"
      summary="Water-level observations, sluice/gate locations, irrigation decisions, target water level, history, and warnings."
      migrationNote="Backed by data/gate_rules.json and the decision logic in index.html starting Stage 4."
    />
  )
}
