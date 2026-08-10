import type { ReactNode } from 'react'
import { useSelectedEntityStore } from '../../store/useSelectedEntityStore'
import { FieldInspector } from '../../features/fields/FieldInspector'
import { SurveyDetail } from '../../features/survey/SurveyDetail'
import { ObservationInspector } from '../../features/observations/ObservationInspector'
import { WaterControlInspector } from '../../features/water/WaterControlInspector'
import { WaterMeasurementInspector } from '../../features/water/WaterMeasurementInspector'
import type { SelectedEntity } from '../../types/selection'
import './InspectorPanel.css'

const ENTITY_LABELS: Record<NonNullable<SelectedEntity>['type'], string> = {
  field: 'Field',
  survey: 'Survey',
  observation: 'Observation',
  waterControl: 'Water point',
  waterMeasurement: 'Water level',
  mission: 'Mission',
  waypoint: 'Waypoint',
}

interface InspectorPanelProps {
  /** The active workspace's default inspector content (the router's <Outlet/>). */
  children: ReactNode
}

/**
 * "The right inspector should depend on this [selection] model" -- task
 * section 10. A non-null selection always takes over the panel, regardless
 * of which workspace is active, exactly like the brief's "click a weed
 * observation -> inspector shows it, no navigation" example.
 *
 * `field` is the one entity type with real domain data as of Stage 2, so it
 * gets a real detail view (FieldInspector) instead of the generic
 * placeholder every other (not yet migrated) entity type still falls back to.
 */
export function InspectorPanel({ children }: InspectorPanelProps) {
  const selectedEntity = useSelectedEntityStore((state) => state.selectedEntity)
  const clear = useSelectedEntityStore((state) => state.clear)

  if (selectedEntity?.type === 'field') {
    return (
      <aside className="inspector-panel" aria-label="Inspector">
        <FieldInspector fieldId={selectedEntity.id} onBack={clear} />
      </aside>
    )
  }

  if (selectedEntity?.type === 'survey') {
    return (
      <aside className="inspector-panel" aria-label="Inspector">
        <SurveyDetail surveyId={selectedEntity.id} onBack={clear} />
      </aside>
    )
  }

  if (selectedEntity?.type === 'observation') {
    return (
      <aside className="inspector-panel" aria-label="Inspector">
        <ObservationInspector observationId={selectedEntity.id} onBack={clear} />
      </aside>
    )
  }

  if (selectedEntity?.type === 'waterControl') {
    return (
      <aside className="inspector-panel" aria-label="Inspector">
        <WaterControlInspector pointId={selectedEntity.id} onBack={clear} />
      </aside>
    )
  }

  if (selectedEntity?.type === 'waterMeasurement') {
    return (
      <aside className="inspector-panel" aria-label="Inspector">
        <WaterMeasurementInspector measurementId={selectedEntity.id} onBack={clear} />
      </aside>
    )
  }

  return (
    <aside className="inspector-panel" aria-label="Inspector">
      {selectedEntity ? (
        <div className="inspector-panel__selection">
          <h2 className="feature-placeholder__title">{ENTITY_LABELS[selectedEntity.type]}</h2>
          <p className="feature-placeholder__summary">
            Selected: <code>{selectedEntity.id}</code>
          </p>
          <p className="feature-placeholder__note">
            Placeholder selection -- domain data for this entity type has not been migrated yet.
          </p>
          <button type="button" className="ghost-button" onClick={clear}>
            Clear selection
          </button>
        </div>
      ) : (
        children
      )}
    </aside>
  )
}
