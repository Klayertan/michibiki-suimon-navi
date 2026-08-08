import { useEffect, useState, useSyncExternalStore } from 'react'
import { useSurveySnapshot } from '../../services/surveys/useSurveys'
import { useActiveSurveyStore } from '../../store/useActiveSurveyStore'
import { useLiveGnssStore } from '../../store/useLiveGnssStore'
import { serialGnssService, SERIAL_BAUD_RATES } from '../../services/gnss/serialGnssService'
import { recordingService } from '../../services/recording/recordingService'
import { useActiveField } from '../../services/fields/useActiveField'
import { SurveySelector } from './SurveySelector'
import { SurveyFieldRegistration } from './SurveyFieldRegistration'
import { ObservationComposer } from './ObservationComposer'
import './SurveyInspector.css'

export function SurveyInspector() {
  const { surveys, warnings, error, loading } = useSurveySnapshot()
  const activeSurveyId = useActiveSurveyStore((state) => state.activeSurveyId)
  const connectionState = useLiveGnssStore((state) => state.connectionState)
  const currentFix = useLiveGnssStore((state) => state.currentFix)
  const baudRate = useLiveGnssStore((state) => state.baudRate)
  const serialMessage = useLiveGnssStore((state) => state.message)
  const recording = useSyncExternalStore(recordingService.subscribe, recordingService.getSnapshot, recordingService.getSnapshot)
  const activeField = useActiveField()
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const activeSurvey = surveys.find((survey) => survey.id === activeSurveyId) ?? null

  useEffect(() => {
    if (recording.state !== 'recording' || !recording.startedAt) return
    const update = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - Date.parse(recording.startedAt!)) / 1000)))
    update()
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [recording.state, recording.startedAt])

  const busy = ['requesting', 'opening', 'disconnecting'].includes(connectionState)
  const connected = connectionState === 'connected'
  const canStart = recording.state === 'idle' || recording.state === 'stopped' || (recording.state === 'error' && !recording.activeSessionId)
  return (
    <div className="survey-workspace">
      <h2 className="feature-placeholder__title">Survey</h2>

      <section className="survey-live" aria-label="Live GNSS">
        <div className="survey-live__controls">
          <button
            type="button"
            className="ghost-button"
            disabled={connectionState === 'unsupported' || busy}
            onClick={() => connected ? void serialGnssService.disconnect() : void serialGnssService.connect()}
          >
            {connected ? 'Disconnect GNSS' : busy ? 'Connecting…' : 'Connect GNSS'}
          </button>
          <select
            aria-label="GNSS baud rate"
            value={baudRate}
            disabled={connectionState !== 'disconnected'}
            onChange={(event) => serialGnssService.setBaudRate(Number(event.target.value))}
          >
            {SERIAL_BAUD_RATES.map((rate) => <option key={rate} value={rate}>{rate} baud</option>)}
          </select>
        </div>
        <dl className="survey-live__metrics">
          <div><dt>Serial</dt><dd>{connectionState}</dd></div>
          <div><dt>Latitude</dt><dd>{currentFix ? currentFix.lat.toFixed(7) : '—'}</dd></div>
          <div><dt>Longitude</dt><dd>{currentFix ? currentFix.lon.toFixed(7) : '—'}</dd></div>
          <div><dt>HDOP</dt><dd>{currentFix?.hdop ?? '—'}</dd></div>
          <div><dt>Satellites</dt><dd>{currentFix?.satellites ?? '—'}</dd></div>
        </dl>
        {serialMessage ? <p className="survey-live__message" role={connectionState === 'error' ? 'alert' : 'status'}>{serialMessage}</p> : null}
      </section>

      <section className="survey-recording" aria-label="GNSS recording">
        <div className="survey-live__controls">
          <button type="button" className="ghost-button" disabled={!canStart} onClick={() => void recordingService.start(activeField)}>
            Start Recording
          </button>
          <button type="button" className="ghost-button" disabled={recording.state !== 'recording'} onClick={() => void recordingService.stop()}>
            {recording.state === 'stopping' ? 'Saving…' : 'Stop Recording'}
          </button>
        </div>
        <dl className="survey-live__metrics">
          <div><dt>Recording</dt><dd>{recording.state}</dd></div>
          <div><dt>Points</dt><dd>{recording.pointCount}</dd></div>
          <div><dt>Duration</dt><dd>{recording.state === 'recording' ? `${elapsedSeconds}s` : '—'}</dd></div>
          <div><dt>Pending</dt><dd>{recording.pendingCount}</dd></div>
        </dl>
        {recording.warning ? <p className="survey-live__message" role="status">{recording.warning}</p> : null}
        {recording.error ? <p className="survey-live__message survey-live__message--error" role="alert">{recording.error}</p> : null}
      </section>

      <SurveySelector />
      {loading ? <p className="feature-placeholder__summary">Loading saved recordings…</p> : null}
      {error ? <p className="feature-placeholder__note" role="alert">{error}</p> : null}
      {warnings.length > 0 ? <p className="feature-placeholder__note" role="status">{warnings.join(' ')}</p> : null}
      {!loading && !error && surveys.length === 0 ? (
        <p className="feature-placeholder__summary">No saved survey sessions or boundary tracks were found.</p>
      ) : null}
      {activeSurvey ? (
        <>
          <dl className="survey-workspace__summary">
            <div><dt>Selected</dt><dd>{activeSurvey.name}</dd></div>
            <div><dt>Track points</dt><dd>{activeSurvey.displayCoordinates.length}</dd></div>
          </dl>
          <SurveyFieldRegistration survey={activeSurvey} />
        </>
      ) : null}
      <ObservationComposer />
      <p className="survey-workspace__scope">Fields and observations use the existing annotation schema. Original survey points remain intact; only the supported fieldId link may be updated.</p>
    </div>
  )
}
