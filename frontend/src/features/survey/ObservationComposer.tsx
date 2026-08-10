import { useState } from 'react'
import { isPointInsideBoundary, OBSERVATION_TYPE_LABELS, SEVERITY_LABELS } from '@legacy/fields/field-annotation-core.js'
import { validateObservationCreation } from '@legacy/recording/recording-core.js'
import type { ObservationSeverity, Stage3CObservationType } from '../../domain/observations/types'
import { useActiveField } from '../../services/fields/useActiveField'
import { observationRepository } from '../../services/observations/legacyObservationRepository'
import { useObservationSnapshot } from '../../services/observations/useObservations'
import { useLiveGnssStore } from '../../store/useLiveGnssStore'
import { useObservationPlacementStore } from '../../store/useObservationPlacementStore'
import { useSelectedEntityStore } from '../../store/useSelectedEntityStore'

const TYPES: Stage3CObservationType[] = ['note', 'weed', 'insect', 'disease']
const SEVERITIES: ObservationSeverity[] = ['low', 'medium', 'high', 'urgent']

export function ObservationComposer() {
  const activeField = useActiveField()
  const currentFix = useLiveGnssStore((state) => state.currentFix)
  // Also read connectionState (not just currentFix) so this re-renders the
  // instant the link enters 'stalled' -- that transition is exactly the case
  // where currentFix stays non-null (task section 11: "preserve the last
  // known fix... but mark it clearly as stale") yet must stop being treated
  // as current the moment DEFAULT_FIX_STALE_MS elapses.
  const connectionState = useLiveGnssStore((state) => state.connectionState)
  // Reuses the exact legacy gate ("現在地を記録" / js/recording/recording-core.js)
  // rather than re-deriving a staleness rule -- never fabricates a position,
  // refuses instead of using a stale/missing fix.
  const fixValidation = validateObservationCreation(currentFix, Date.now())
  const staleNotice = currentFix && !fixValidation.ok
    ? (connectionState === 'stalled' ? `GNSS connected but not producing new fixes. ${fixValidation.reason}` : fixValidation.reason)
    : null
  const { error: readError, warnings } = useObservationSnapshot()
  const candidate = useObservationPlacementStore((state) => state.candidate)
  const mapPlacementActive = useObservationPlacementStore((state) => state.mapPlacementActive)
  const setCandidate = useObservationPlacementStore((state) => state.setCandidate)
  const beginMapPlacement = useObservationPlacementStore((state) => state.beginMapPlacement)
  const cancelPlacement = useObservationPlacementStore((state) => state.cancel)
  const select = useSelectedEntityStore((state) => state.select)
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<Stage3CObservationType>('note')
  const [severity, setSeverity] = useState<ObservationSeverity>('medium')
  const [memo, setMemo] = useState('')
  const [error, setError] = useState<string | null>(null)

  const useCurrent = () => {
    if (!activeField || !currentFix || !fixValidation.ok) return
    const coordinates: [number, number] = [currentFix.lat, currentFix.lon]
    setCandidate({ coordinates, sourceType: 'qz1_current_position', outsideField: !isPointInsideBoundary(coordinates, activeField.coordinates) })
  }

  const save = async () => {
    if (!activeField || !candidate) return
    try {
      const observation = await observationRepository.create({
        fieldId: activeField.id, fieldName: activeField.name, type, severity, memo,
        coordinates: candidate.coordinates, sourceType: candidate.sourceType,
      })
      cancelPlacement(); setMemo(''); setOpen(false); setError(null)
      select({ type: 'observation', id: observation.id })
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The observation could not be saved.') }
  }

  if (!open) return <button type="button" className="ghost-button" onClick={() => setOpen(true)}>Add Observation</button>
  return (
    <section className="survey-bridge" aria-label="Add field observation">
      <strong>Add observation</strong>
      {!activeField ? <p className="survey-live__message survey-live__message--error" role="alert">Select an active field before adding an observation.</p> : null}
      <div className="survey-bridge__form-grid">
        <label>Type<select value={type} onChange={(event) => setType(event.target.value as Stage3CObservationType)}>{TYPES.map((value) => <option key={value} value={value}>{OBSERVATION_TYPE_LABELS[value]}</option>)}</select></label>
        <label>Severity<select value={severity} onChange={(event) => setSeverity(event.target.value as ObservationSeverity)}>{SEVERITIES.map((value) => <option key={value} value={value}>{SEVERITY_LABELS[value]}</option>)}</select></label>
      </div>
      <label>Notes<textarea value={memo} onChange={(event) => setMemo(event.target.value)} rows={2} /></label>
      <div className="survey-live__controls">
        <button type="button" className="ghost-button" disabled={!activeField || !fixValidation.ok} onClick={useCurrent}>Use Current GNSS</button>
        <button type="button" className="ghost-button" disabled={!activeField || mapPlacementActive} onClick={beginMapPlacement}>{mapPlacementActive ? 'Click the map…' : 'Place on Map'}</button>
      </div>
      {staleNotice ? <p className="survey-live__message" role="status">{staleNotice}</p> : null}
      {candidate ? <p className="survey-live__message">Preview: {candidate.coordinates[0].toFixed(7)}, {candidate.coordinates[1].toFixed(7)}</p> : null}
      {candidate?.outsideField ? <p className="survey-live__message survey-live__message--error" role="alert">This point is outside the active field. Save only after reviewing it.</p> : null}
      {readError ? <p className="survey-live__message survey-live__message--error" role="alert">{readError}</p> : null}
      {warnings.length ? <p className="survey-live__message" role="status">{warnings.join(' ')}</p> : null}
      {error ? <p className="survey-live__message survey-live__message--error" role="alert">{error}</p> : null}
      <div className="survey-live__controls">
        <button type="button" className="ghost-button" disabled={!candidate || Boolean(readError)} onClick={() => void save()}>{candidate?.outsideField ? 'Save Anyway' : 'Save Observation'}</button>
        <button type="button" className="ghost-button" onClick={() => { cancelPlacement(); setOpen(false); setError(null) }}>Cancel</button>
      </div>
      <p className="survey-live__message">Escape cancels map placement. No normal map click creates data.</p>
    </section>
  )
}
