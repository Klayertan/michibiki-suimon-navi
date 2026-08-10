import { findMeasurementById, formatWaterLevel, isAmbiguousZeroReading } from '../../domain/water/selectors'
import { useFields } from '../../services/fields/useFields'
import { useWaterMeasurementSnapshot } from '../../services/water/useWaterMeasurements'
import './WaterWorkspace.css'

interface WaterMeasurementInspectorProps {
  measurementId: string
  onBack: () => void
}

/**
 * A saved water-level reading from the recording store. Everything shown is
 * persisted; nothing is converted. In particular the reading is displayed
 * without a unit, because the schema records none -- "cm" exists only in a
 * legacy input label and was never written to storage.
 */
export function WaterMeasurementInspector({ measurementId, onBack }: WaterMeasurementInspectorProps) {
  const { measurements, loading, error } = useWaterMeasurementSnapshot()
  const fields = useFields()
  const measurement = findMeasurementById(measurements, measurementId)

  if (loading) {
    return (
      <div className="feature-placeholder">
        <h2 className="feature-placeholder__title">Water level</h2>
        <p className="feature-placeholder__summary">Loading saved readings…</p>
      </div>
    )
  }

  if (error || !measurement) {
    return (
      <div className="feature-placeholder">
        <h2 className="feature-placeholder__title">Water level</h2>
        <p className="feature-placeholder__summary">{error ?? 'This water-level reading no longer exists.'}</p>
        <button type="button" className="ghost-button" onClick={onBack}>Back</button>
      </div>
    )
  }

  const field = fields.find((candidate) => candidate.id === measurement.fieldId) ?? null

  return (
    <div className="water-inspector">
      <h2 className="feature-placeholder__title">水位 / Water level</h2>
      <dl className="water-detail">
        <div>
          <dt>Reading</dt>
          <dd>
            {formatWaterLevel(measurement.waterLevel)}
            {isAmbiguousZeroReading(measurement) ? (
              <span className="water-detail__note">
                {' '}A stored 0 may mean the legacy field was left blank rather than a measured zero.
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Position</dt>
          <dd><code>{measurement.latitude.toFixed(7)}, {measurement.longitude.toFixed(7)}</code></dd>
        </div>
        <div>
          <dt>Recorded</dt>
          <dd>{measurement.timestamp ? new Date(measurement.timestamp).toLocaleString() : 'Unknown'}</dd>
        </div>
        <div>
          <dt>Field</dt>
          <dd>{field ? (field.name || field.id) : 'Not linked'}</dd>
        </div>
        <div>
          <dt>Fix quality</dt>
          <dd>
            {measurement.fixQuality ?? '—'} quality · {measurement.satelliteCount ?? '—'} sats · HDOP{' '}
            {measurement.hdop ?? '—'}{measurement.fixAugmented ? ' · augmented' : ''}
          </dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd><code>{measurement.positionSource || 'unknown'}</code> · session <code>{measurement.sessionId}</code></dd>
        </div>
        {measurement.note ? (
          <div>
            <dt>Notes</dt>
            <dd>{measurement.note}</dd>
          </div>
        ) : null}
      </dl>
      <p className="feature-placeholder__note">
        Read-only. Readings belong to a recording session and are created in the legacy recording panel from a
        validated live fix.
      </p>
      <button type="button" className="ghost-button" onClick={onBack}>Back</button>
    </div>
  )
}
