import { useState } from 'react'
import type { RecoverableSession } from '../../services/recording/recordingService'
import { useFields } from '../../services/fields/useFields'

interface RecoveryPanelProps {
  sessions: RecoverableSession[]
  inProgress: boolean
  warning: string | null
  onResume: (sessionId: string) => void
  onFinalize: (sessionId: string) => void
  onDiscard: (sessionId: string) => void
}

/**
 * The compact recovery surface for unfinished recordings (task section 8) --
 * a card per candidate, not a full-page workflow, so it fits inside the
 * already-compact Survey inspector without introducing document scrolling.
 *
 * Deliberately presentational: it reads no service or store directly (besides
 * `useFields()` to resolve a field name, which is a cheap synchronous
 * localStorage read) so its rendering/interaction logic is testable without a
 * real IndexedDB. `SurveyInspector` wires its callbacks to the real
 * `recordingService` singleton.
 */
export function RecoveryPanel({ sessions, inProgress, warning, onResume, onFinalize, onDiscard }: RecoveryPanelProps) {
  const fields = useFields()
  const [confirmingDiscard, setConfirmingDiscard] = useState<string | null>(null)

  if (sessions.length === 0) return null

  return (
    <section className="recovery-panel" aria-label="Unfinished recordings">
      <h3 className="feature-placeholder__title">
        {sessions.length === 1 ? 'Unfinished recording found' : `${sessions.length} unfinished recordings found`}
      </h3>
      <p className="feature-placeholder__note">
        Starting a new recording is blocked until every unfinished recording below is resumed, finished, or discarded.
      </p>
      {warning ? <p className="survey-live__message survey-live__message--error" role="alert">{warning}</p> : null}
      <ul className="recovery-panel__list">
        {sessions.map((session) => {
          const field = session.fieldId ? fields.find((candidate) => candidate.id === session.fieldId) : null
          return (
            <li key={session.sessionId} className="recovery-card">
              <dl className="survey-workspace__summary">
                <div>
                  <dt>Started</dt>
                  <dd>{session.startedAt ? new Date(session.startedAt).toLocaleString() : 'Unknown'}</dd>
                </div>
                <div>
                  <dt>Valid fixes</dt>
                  <dd>{session.validFixCount}</dd>
                </div>
                <div>
                  <dt>Raw lines saved</dt>
                  <dd>{session.rawLineCount}</dd>
                </div>
                <div>
                  <dt>Last point</dt>
                  <dd>
                    {session.lastValidFix
                      ? `${session.lastValidFix.lat.toFixed(6)}, ${session.lastValidFix.lon.toFixed(6)}${session.lastValidFix.timestamp ? ` (${session.lastValidFix.timestamp})` : ''}`
                      : 'None yet'}
                  </dd>
                </div>
                <div>
                  <dt>Field</dt>
                  <dd>
                    {!session.fieldId
                      ? 'Not linked'
                      : field
                        ? (field.name || field.id)
                        : `Linked field no longer exists (${session.fieldId})`}
                  </dd>
                </div>
              </dl>
              <div className="survey-live__controls">
                <button type="button" className="ghost-button" disabled={inProgress} onClick={() => onResume(session.sessionId)}>
                  Resume
                </button>
                <button type="button" className="ghost-button" disabled={inProgress} onClick={() => onFinalize(session.sessionId)}>
                  Finish &amp; Save
                </button>
                {confirmingDiscard === session.sessionId ? (
                  <span className="recovery-card__confirm">
                    Discard this recording permanently?
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={inProgress}
                      onClick={() => { onDiscard(session.sessionId); setConfirmingDiscard(null) }}
                    >
                      Confirm Discard
                    </button>
                    <button type="button" className="ghost-button" onClick={() => setConfirmingDiscard(null)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button type="button" className="ghost-button" disabled={inProgress} onClick={() => setConfirmingDiscard(session.sessionId)}>
                    Discard
                  </button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
