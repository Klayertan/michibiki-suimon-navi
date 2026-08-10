import type { GnssConnectionState } from '../../services/gnss/serialGnssService'

interface GnssReconnectBannerProps {
  connectionState: GnssConnectionState
  reconnectAttempt: number
  reconnectMaxAttempts: number
  isRecording: boolean
  onReconnect: () => void
  onStopRecording: () => void
}

/**
 * Compact reconnect surface (task section 13) -- a banner inside the
 * existing Survey inspector, not a full-page workflow or a blocking modal,
 * so Survey stays map-first even while a transient serial loss is being
 * retried. Deliberately presentational (props in, callbacks out), matching
 * RecoveryPanel's pattern, so it is testable without a real SerialPort.
 *
 * Only renders for the two states an operator can actually act on --
 * 'reconnecting' (an automatic bounded retry is in flight) and
 * 'reconnect_required' (retries exhausted, manual action needed). A
 * 'stalled' link is not shown here: the port itself is fine (task section
 * 3D), so there is nothing to "reconnect" -- see SurveyInspector's Serial
 * metric and ObservationComposer/WaterControlComposer's stale-fix notices
 * for how that case is surfaced instead.
 */
export function GnssReconnectBanner({
  connectionState, reconnectAttempt, reconnectMaxAttempts, isRecording, onReconnect, onStopRecording,
}: GnssReconnectBannerProps) {
  if (connectionState !== 'reconnecting' && connectionState !== 'reconnect_required') return null

  return (
    <section className="gnss-reconnect-banner" role="status" aria-label="GNSS reconnect status">
      <p>
        {connectionState === 'reconnecting'
          ? `GNSS connection lost. Attempting reconnect… ${reconnectAttempt}/${reconnectMaxAttempts}`
          : 'Automatic reconnect unsuccessful.'}
      </p>
      {isRecording ? <p>Recording remains open. No stale or synthetic points will be recorded until it reconnects.</p> : null}
      <div className="survey-live__controls">
        <button type="button" className="ghost-button" onClick={onReconnect}>Reconnect now</button>
        {isRecording ? <button type="button" className="ghost-button" onClick={onStopRecording}>Stop recording</button> : null}
      </div>
    </section>
  )
}
