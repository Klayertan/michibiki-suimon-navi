import { OBSERVATION_TYPE_LABELS, SEVERITY_LABELS, observationSourceLabel } from '@legacy/fields/field-annotation-core.js'
import { useFields } from '../../services/fields/useFields'
import { useObservationSnapshot } from '../../services/observations/useObservations'

interface Props { observationId: string; onBack: () => void }

export function ObservationInspector({ observationId, onBack }: Props) {
  const { observations, error } = useObservationSnapshot()
  const fields = useFields()
  const observation = observations.find((item) => item.id === observationId)
  if (error) return <div><h2 className="feature-placeholder__title">Observation</h2><p role="alert">{error}</p><button className="ghost-button" onClick={onBack}>Back</button></div>
  if (!observation) return <div><h2 className="feature-placeholder__title">Observation not found</h2><button className="ghost-button" onClick={onBack}>Back</button></div>
  const field = fields.find((item) => item.id === observation.fieldId)
  return (
    <div className="survey-detail">
      <h2 className="feature-placeholder__title">{OBSERVATION_TYPE_LABELS[observation.type]} Observation</h2>
      <dl className="survey-detail__list">
        <div><dt>Severity</dt><dd>{SEVERITY_LABELS[observation.properties.severity]}</dd></div>
        <div><dt>Coordinates</dt><dd>{observation.coordinates[0].toFixed(7)}, {observation.coordinates[1].toFixed(7)}</dd></div>
        {observation.properties.createdAt ? <div><dt>Recorded</dt><dd>{new Date(observation.properties.createdAt).toLocaleString()}</dd></div> : null}
        {observation.fieldId ? <div><dt>Field</dt><dd>{field?.name ?? observation.fieldId}</dd></div> : null}
        <div><dt>Source</dt><dd>{observationSourceLabel(observation.properties.sourceType)}</dd></div>
        {observation.properties.memo ? <div><dt>Notes</dt><dd>{observation.properties.memo}</dd></div> : null}
      </dl>
      <button type="button" className="ghost-button" onClick={onBack}>Back</button>
    </div>
  )
}
