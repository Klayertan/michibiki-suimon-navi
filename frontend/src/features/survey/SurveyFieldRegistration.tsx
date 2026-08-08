import { useEffect, useState } from 'react'
import { prepareSurveyBoundary, SurveyBoundaryError, type SurveyBoundaryPreview } from '../../domain/surveys/surveyBoundary'
import type { SurveyRecord } from '../../domain/surveys/types'
import { fieldRepository } from '../../services/fields/legacyFieldRepository'
import { recordedSurveyRepository } from '../../services/recording/recordedSurveyRepository'
import { surveyRepository } from '../../services/surveys/legacySurveyRepository'
import { useActiveFieldStore } from '../../store/useActiveFieldStore'
import { useSelectedEntityStore } from '../../store/useSelectedEntityStore'
import { useSurveyBoundaryPreviewStore } from '../../store/useSurveyBoundaryPreviewStore'

export function SurveyFieldRegistration({ survey }: { survey: SurveyRecord }) {
  const [preview, setPreview] = useState<SurveyBoundaryPreview | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [duplicateConfirmed, setDuplicateConfirmed] = useState(false)
  const setPreviewCoordinates = useSurveyBoundaryPreviewStore((state) => state.setCoordinates)
  const clearPreview = useSurveyBoundaryPreviewStore((state) => state.clear)
  const setActiveFieldId = useActiveFieldStore((state) => state.setActiveFieldId)
  const select = useSelectedEntityStore((state) => state.select)

  useEffect(() => () => clearPreview(), [clearPreview])
  useEffect(() => {
    setPreview(null); setError(null); setConfirmed(false); setDuplicateConfirmed(false); clearPreview()
  }, [survey.id, clearPreview])

  const begin = (explicitDuplicate = false) => {
    if (survey.fieldId && !explicitDuplicate) { setDuplicateConfirmed(false); setError(null); return }
    try {
      const next = prepareSurveyBoundary(survey)
      setPreview(next)
      setPreviewCoordinates(next.coordinates)
      setName(`${survey.name} Field`)
      setConfirmed(!next.requiresConfirmation)
      setDuplicateConfirmed(explicitDuplicate)
      setError(null)
    } catch (cause) {
      setError(cause instanceof SurveyBoundaryError ? cause.message : 'The survey boundary could not be prepared.')
    }
  }

  const openExisting = () => {
    if (!survey.fieldId) return
    setActiveFieldId(survey.fieldId)
    select({ type: 'field', id: survey.fieldId })
  }

  const save = async () => {
    if (!preview || !name.trim() || (preview.requiresConfirmation && !confirmed)) return
    setSaving(true); setError(null)
    try {
      const field = await fieldRepository.create({
        name: name.trim(), coordinates: preview.coordinates,
        closedManually: !preview.autoClose,
        sourceSessionId: survey.session?.id ?? survey.track?.sourceSessionId ?? null,
        sourceTrackId: survey.track?.id ?? null,
        linkSourceToField: !duplicateConfirmed,
        sourceType: 'QZ1_NMEA',
        sourceFileName: survey.session?.sourceFileName ?? null,
        sourcePointCount: preview.coordinates.length,
        fixQualitySummary: survey.track?.fixQualitySummary ?? null,
      })
      if (survey.id.startsWith('recording:') && !duplicateConfirmed) await recordedSurveyRepository.linkToField(survey.id, field)
      surveyRepository.refresh()
      setActiveFieldId(field.id)
      select({ type: 'field', id: field.id })
      setPreview(null); clearPreview()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The field could not be saved.')
    } finally { setSaving(false) }
  }

  if (!preview) return (
    <section className="survey-bridge" aria-label="Survey field registration">
      <button type="button" className="ghost-button" onClick={() => begin(false)}>Use as Field Boundary</button>
      {survey.fieldId ? (
        <div className="survey-bridge__linked" role="status">
          <p>This survey is already linked to field <code>{survey.fieldId}</code>.</p>
          <div className="survey-live__controls">
            <button type="button" className="ghost-button" onClick={openExisting}>Open Existing Field</button>
            <button type="button" className="ghost-button" onClick={() => begin(true)}>Create Another Field</button>
          </div>
        </div>
      ) : null}
      {error ? <p className="survey-live__message survey-live__message--error" role="alert">{error}</p> : null}
    </section>
  )

  return (
    <section className="survey-bridge" aria-label="Field boundary preview">
      <strong>Field boundary preview</strong>
      <p className="survey-live__message">{preview.coordinates.length} points · source: {preview.source} · persisted as [lat, lon]</p>
      <label>Field name<input value={name} onChange={(event) => setName(event.target.value)} /></label>
      {preview.warnings.length ? <p className="survey-live__message survey-live__message--error" role="alert">{preview.warnings.join(' ')}</p> : null}
      {preview.requiresConfirmation ? <label className="survey-bridge__confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />I reviewed the geometry warning and want to close this walked boundary.</label> : null}
      {duplicateConfirmed ? <p className="survey-live__message">The existing survey link will remain unchanged; this is an explicit additional field.</p> : null}
      <div className="survey-live__controls">
        <button type="button" className="ghost-button" disabled={saving || !name.trim() || !confirmed} onClick={() => void save()}>{saving ? 'Saving…' : 'Register Field'}</button>
        <button type="button" className="ghost-button" disabled={saving} onClick={() => { setPreview(null); clearPreview() }}>Cancel</button>
      </div>
      {error ? <p className="survey-live__message survey-live__message--error" role="alert">{error}</p> : null}
    </section>
  )
}
