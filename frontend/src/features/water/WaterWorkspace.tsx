import {
  controlPointTypeLabel,
  controlPointsForField,
  measurementsForField,
  orphanedControlPoints,
  sortMeasurementsNewestFirst,
} from '../../domain/water/selectors'
import { useActiveField } from '../../services/fields/useActiveField'
import { useWaterControlSnapshot } from '../../services/water/useWaterControlPoints'
import { useWaterMeasurementSnapshot } from '../../services/water/useWaterMeasurements'
import { useSelectedEntityStore } from '../../store/useSelectedEntityStore'
import { GateDecisionPanel } from './GateDecisionPanel'
import { WaterControlComposer } from './WaterControlComposer'
import './WaterWorkspace.css'

/**
 * The /water route's inspector-panel content. The map itself stays owned by
 * AppShell, so this is a compact toolbar plus short lists, not a scrolling
 * settings page: selecting anything hands off to the contextual inspector.
 */
export function WaterWorkspace() {
  const activeField = useActiveField()
  const { points, warnings, error } = useWaterControlSnapshot()
  const { measurements, loading: measurementsLoading, error: measurementsError } = useWaterMeasurementSnapshot()
  const select = useSelectedEntityStore((state) => state.select)

  const fieldPoints = controlPointsForField(points, activeField?.id ?? null)
  const orphans = orphanedControlPoints(points)
  const fieldMeasurements = sortMeasurementsNewestFirst(measurementsForField(measurements, activeField?.id ?? null))

  return (
    <div className="water-workspace">
      <div className="water-toolbar">
        <span className="water-toolbar__field">
          {activeField ? (activeField.name || activeField.id) : 'No active field'}
        </span>
        <WaterControlComposer />
      </div>

      {error ? <p className="water-message water-message--error" role="alert">{error}</p> : null}
      {warnings.length ? <p className="water-message" role="status">{warnings.join(' ')}</p> : null}

      <GateDecisionPanel contextualMeasurementCount={activeField && !measurementsLoading ? fieldMeasurements.length : 0} />

      <section aria-label="Water control points">
        <h3 className="water-section-title">Water points {activeField ? `· ${fieldPoints.length}` : ''}</h3>
        {!activeField ? (
          <p className="feature-placeholder__summary">Select a field to see and add its water points.</p>
        ) : fieldPoints.length === 0 ? (
          <p className="feature-placeholder__summary">
            No water points on this field yet. Use “Add Water Point” to record a gate, inlet, outlet, sensor or photo
            position.
          </p>
        ) : (
          <ul className="water-list">
            {fieldPoints.map((point) => (
              <li key={point.id}>
                <button type="button" onClick={() => select({ type: 'waterControl', id: point.id })}>
                  <span className="water-list__label">{controlPointTypeLabel(point)}</span>
                  <span className="water-list__name">{point.name || point.id}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Water level readings">
        <h3 className="water-section-title">
          Water levels {activeField && !measurementsLoading ? `· ${fieldMeasurements.length}` : ''}
        </h3>
        {measurementsError ? (
          <p className="water-message water-message--error" role="alert">{measurementsError}</p>
        ) : measurementsLoading ? (
          <p className="feature-placeholder__summary">Loading saved readings…</p>
        ) : !activeField ? (
          <p className="feature-placeholder__summary">Select a field to see its recorded water levels.</p>
        ) : fieldMeasurements.length === 0 ? (
          <p className="feature-placeholder__summary">
            No water-level readings recorded for this field.
          </p>
        ) : (
          <ul className="water-list">
            {fieldMeasurements.map((measurement) => (
              <li key={measurement.id}>
                <button type="button" onClick={() => select({ type: 'waterMeasurement', id: measurement.id })}>
                  <span className="water-list__label">水位</span>
                  <span className="water-list__name">
                    {measurement.timestamp ? new Date(measurement.timestamp).toLocaleString() : measurement.id}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="feature-placeholder__note">
          Readings are read-only here: they belong to a recording session and are captured in the legacy recording
          panel from a validated live fix.
        </p>
      </section>

      {orphans.length ? (
        <section aria-label="Unlinked water points">
          <h3 className="water-section-title">Unlinked · {orphans.length}</h3>
          <ul className="water-list">
            {orphans.map((point) => (
              <li key={point.id}>
                <button type="button" onClick={() => select({ type: 'waterControl', id: point.id })}>
                  <span className="water-list__label">{controlPointTypeLabel(point)}</span>
                  <span className="water-list__name">{point.name || point.id}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="feature-placeholder__note">
            These points lost their field link when a field was deleted. They still appear on the map but are omitted
            from reports.
          </p>
        </section>
      ) : null}
    </div>
  )
}
