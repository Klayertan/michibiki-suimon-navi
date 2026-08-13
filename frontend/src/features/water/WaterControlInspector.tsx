import { controlPointTypeLabel, findControlPointById, isOrphanedControlPoint } from '../../domain/water/selectors'
import { useFields } from '../../services/fields/useFields'
import { useWaterControlSnapshot } from '../../services/water/useWaterControlPoints'
import './WaterWorkspace.css'

interface WaterControlInspectorProps {
  pointId: string
  onBack: () => void
}

/**
 * Shows only what the annotation store actually persists for a water control
 * point. There is no water level here on purpose: a control point -- including
 * a 水位センサ pin -- records a *location*, never a reading.
 */
export function WaterControlInspector({ pointId, onBack }: WaterControlInspectorProps) {
  const { points } = useWaterControlSnapshot()
  const fields = useFields()
  const point = findControlPointById(points, pointId)

  if (!point) {
    return (
      <div className="feature-placeholder">
        <h2 className="feature-placeholder__title">Water point</h2>
        <p className="feature-placeholder__summary">This water point no longer exists.</p>
        <button type="button" className="ghost-button" onClick={onBack}>Back</button>
      </div>
    )
  }

  const field = fields.find((candidate) => candidate.id === point.relatedFieldId) ?? null

  return (
    <div className="water-inspector">
      <h2 className="feature-placeholder__title">{point.name || controlPointTypeLabel(point)}</h2>
      <dl className="water-detail">
        <div>
          <dt>Type</dt>
          <dd>{controlPointTypeLabel(point)} <code>{point.type}</code></dd>
        </div>
        <div>
          <dt>Position</dt>
          <dd><code>{point.coordinates[0].toFixed(7)}, {point.coordinates[1].toFixed(7)}</code></dd>
        </div>
        <div>
          <dt>Field</dt>
          <dd>
            {field ? `${field.name || field.id}` : 'Not linked'}
            {isOrphanedControlPoint(point) ? (
              <span className="water-detail__note">
                {' '}Unlinked points stay on the map but are left out of reports and counts.
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Recorded</dt>
          <dd>{point.properties.createdAt ? new Date(point.properties.createdAt).toLocaleString() : 'Unknown'}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd><code>{point.properties.sourceType}</code></dd>
        </div>
        {point.properties.memo ? (
          <div>
            <dt>Notes</dt>
            <dd>{point.properties.memo}</dd>
          </div>
        ) : null}
      </dl>
      <p className="feature-placeholder__note">
        Editing and deletion stay in the legacy interface until a cross-store reference policy exists — reports and the
        decision panel read this same array.
      </p>
      <button type="button" className="ghost-button" onClick={onBack}>Back</button>
    </div>
  )
}
