import { useState } from 'react'
import { isPointInsideBoundary } from '@legacy/fields/field-annotation-core.js'
import { validateObservationCreation } from '@legacy/recording/recording-core.js'
import { waterControlTypeLabel } from '../../domain/water/selectors'
import type { WaterControlType } from '../../domain/water/types'
import { useActiveField } from '../../services/fields/useActiveField'
import { waterControlRepository } from '../../services/water/legacyWaterControlRepository'
import { useWaterControlSnapshot } from '../../services/water/useWaterControlPoints'
import { useLiveGnssStore } from '../../store/useLiveGnssStore'
import { useSelectedEntityStore } from '../../store/useSelectedEntityStore'
import { useWaterPlacementStore } from '../../store/useWaterPlacementStore'

const TYPES: WaterControlType[] = ['gate', 'inlet', 'outlet', 'sensor', 'photo']

/**
 * Adds one water control point, from either of the two positions legacy
 * supports: the current QZ1 fix, or one explicit map click. There is no phone-
 * GPS path because legacy has none for water points.
 *
 * Note the deliberate asymmetry with ObservationComposer: there is no
 * "Save Anyway" here. Legacy never blocks a water point for being outside the
 * field boundary, so an outside position is reported and saved normally.
 */
export function WaterControlComposer() {
  const activeField = useActiveField()
  const currentFix = useLiveGnssStore((state) => state.currentFix)
  // Re-render on connectionState changes too, so the button reacts the
  // instant a 'stalled' link's preserved-but-aging fix crosses the legacy
  // staleness threshold -- see ObservationComposer's identical comment.
  const connectionState = useLiveGnssStore((state) => state.connectionState)
  // Same authoritative legacy gate ObservationComposer uses (task section
  // 11: "Add Water Point at Current Position" must not treat a stale fix as
  // current either) -- one staleness rule, not two independently invented ones.
  const fixValidation = validateObservationCreation(currentFix, Date.now())
  const staleNotice = currentFix && !fixValidation.ok
    ? (connectionState === 'stalled' ? `GNSS connected but not producing new fixes. ${fixValidation.reason}` : fixValidation.reason)
    : null
  const { error: readError } = useWaterControlSnapshot()
  const pendingType = useWaterPlacementStore((state) => state.pendingType)
  const mapPlacementActive = useWaterPlacementStore((state) => state.mapPlacementActive)
  const candidate = useWaterPlacementStore((state) => state.candidate)
  const beginMapPlacement = useWaterPlacementStore((state) => state.beginMapPlacement)
  const armType = useWaterPlacementStore((state) => state.armType)
  const setCandidate = useWaterPlacementStore((state) => state.setCandidate)
  const cancelPlacement = useWaterPlacementStore((state) => state.cancel)
  const select = useSelectedEntityStore((state) => state.select)

  const [open, setOpen] = useState(false)
  const [type, setType] = useState<WaterControlType>('gate')
  const [memo, setMemo] = useState('')
  const [error, setError] = useState<string | null>(null)

  const chooseType = (next: WaterControlType) => {
    setType(next)
    if (pendingType) armType(next)
  }

  const useCurrent = () => {
    if (!activeField || !currentFix || !fixValidation.ok) return
    const coordinates: [number, number] = [currentFix.lat, currentFix.lon]
    armType(type)
    setCandidate({
      coordinates,
      sourceType: 'qz1_current_position',
      outsideField: !isPointInsideBoundary(coordinates, activeField.coordinates),
    })
  }

  const close = () => {
    cancelPlacement()
    setMemo('')
    setOpen(false)
    setError(null)
  }

  const save = async () => {
    if (!activeField || !candidate) return
    try {
      const point = await waterControlRepository.create({
        type,
        fieldId: activeField.id,
        fieldName: activeField.name,
        coordinates: candidate.coordinates,
        sourceType: candidate.sourceType,
        memo,
      })
      close()
      select({ type: 'waterControl', id: point.id })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The water point could not be saved.')
    }
  }

  if (!open) {
    return (
      <button type="button" className="ghost-button" onClick={() => setOpen(true)}>
        Add Water Point
      </button>
    )
  }

  return (
    <section className="water-composer" aria-label="Add water control point">
      <strong>Add water point</strong>
      {!activeField ? (
        <p className="water-message water-message--error" role="alert">
          Select an active field before adding a water point.
        </p>
      ) : null}
      <label>
        Type
        <select value={type} onChange={(event) => chooseType(event.target.value as WaterControlType)}>
          {TYPES.map((value) => (
            <option key={value} value={value}>{waterControlTypeLabel(value)}</option>
          ))}
        </select>
      </label>
      <label>
        Notes
        <textarea value={memo} onChange={(event) => setMemo(event.target.value)} rows={2} />
      </label>
      <div className="water-actions">
        <button type="button" className="ghost-button" disabled={!activeField || !fixValidation.ok} onClick={useCurrent}>
          Use Current GNSS
        </button>
        <button
          type="button"
          className="ghost-button"
          disabled={!activeField || mapPlacementActive}
          onClick={() => beginMapPlacement(type)}
        >
          {mapPlacementActive ? 'Click the map…' : 'Place on Map'}
        </button>
      </div>
      {staleNotice ? <p className="water-message" role="status">{staleNotice}</p> : null}
      {candidate ? (
        <p className="water-message">
          Preview: {candidate.coordinates[0].toFixed(7)}, {candidate.coordinates[1].toFixed(7)}
        </p>
      ) : null}
      {candidate?.outsideField ? (
        <p className="water-message" role="status">
          This position is outside the active field boundary. Legacy allows this for water points, so it will be saved
          as positioned.
        </p>
      ) : null}
      {readError ? <p className="water-message water-message--error" role="alert">{readError}</p> : null}
      {error ? <p className="water-message water-message--error" role="alert">{error}</p> : null}
      <div className="water-actions">
        <button type="button" className="ghost-button" disabled={!candidate || Boolean(readError)} onClick={() => void save()}>
          Save Water Point
        </button>
        <button type="button" className="ghost-button" onClick={close}>Cancel</button>
      </div>
      <p className="water-message">Escape cancels map placement. No normal map click creates data.</p>
    </section>
  )
}
