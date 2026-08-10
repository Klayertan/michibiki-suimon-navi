import { useEffect } from 'react'
import { recordingService } from '../recording/recordingService'
import { recordedSurveyRepository } from '../recording/recordedSurveyRepository'
import { useLiveGnssStore } from '../../store/useLiveGnssStore'
import { useSystemStatusStore } from '../../store/useSystemStatusStore'
import { serialGnssService, type GnssSerialSnapshot } from './serialGnssService'

/** Exported for direct unit testing of the Stage 5B state -> badge mapping (see useGnssRuntime.test.tsx). */
export function publishSerialStatus(snapshot: GnssSerialSnapshot): void {
  const setStatus = useSystemStatusStore.getState().setStatus
  const state = snapshot.connectionState
  // Stage 5B (task section 12): GNSS CONNECTED / LOST / RECONNECTING /
  // RECONNECT REQUIRED must be distinguishable, not collapsed into one
  // generic "disconnected". 'stalled' (Class D -- port open, no data) stays
  // its own case too: the transport itself is fine, unlike A/B.
  if (state === 'connected') setStatus('serial', 'connected', snapshot.transportLabel ?? undefined)
  else if (state === 'reconnecting') setStatus('serial', 'warning', `Reconnecting (${snapshot.reconnectAttempt}/${snapshot.reconnectMaxAttempts})`)
  else if (state === 'reconnect_required') setStatus('serial', 'warning', 'Reconnect required')
  else if (state === 'stalled' || state === 'error' || state === 'unsupported') setStatus('serial', 'warning', snapshot.message ?? state)
  else if (state === 'requesting' || state === 'opening' || state === 'disconnecting') setStatus('serial', 'unknown', state)
  else setStatus('serial', 'disconnected')

  if (state === 'reconnecting') setStatus('gnss', 'warning', `Reconnecting (${snapshot.reconnectAttempt}/${snapshot.reconnectMaxAttempts})`)
  else if (state === 'reconnect_required') setStatus('gnss', 'warning', 'Reconnect required')
  else if (state === 'stalled') setStatus('gnss', 'warning', 'No data received recently')
  else if (state !== 'connected') setStatus('gnss', 'disconnected')
  else if (!snapshot.currentFix) setStatus('gnss', 'unknown', 'Waiting for a valid fix')
  else if (Date.now() - snapshot.currentFix.receivedAtMs > 30_000) setStatus('gnss', 'warning', 'Latest fix is stale')
  else setStatus('gnss', 'connected', `fix ${snapshot.currentFix.fixQuality ?? 'unknown'}`)
}

function publishRecordingStatus(): void {
  const snapshot = recordingService.getSnapshot()
  const setStatus = useSystemStatusStore.getState().setStatus
  if (snapshot.state === 'recording') setStatus('recording', snapshot.error ? 'warning' : 'connected', snapshot.error ?? undefined)
  else if (snapshot.state === 'stopping') setStatus('recording', 'unknown', 'Saving')
  else if (snapshot.state === 'error') setStatus('recording', 'warning', snapshot.error ?? undefined)
  // Reuses the existing 'recording' status slot with a warning tone rather
  // than inventing a new status-bar category -- an unresolved recovery is a
  // recording-related condition needing attention, not a distinct subsystem.
  else if (snapshot.state === 'recovery_available') setStatus('recording', 'warning', 'RECOVERY REQUIRED')
  else setStatus('recording', 'disconnected')
}

/** Mounted once at App root; owns the only serial-to-recording subscription. */
export function useGnssRuntime(): void {
  useEffect(() => {
    const applySerial = () => {
      const snapshot = serialGnssService.getSnapshot()
      useLiveGnssStore.getState().applySnapshot(snapshot)
      recordingService.setConnectionMeta(snapshot)
      publishSerialStatus(snapshot)
    }
    const applyRecording = () => {
      publishRecordingStatus()
      if (recordingService.getSnapshot().state === 'stopped') void recordedSurveyRepository.refresh()
    }
    applySerial()
    applyRecording()
    // Detect an unfinished recording exactly once per app load, regardless of
    // which workspace is active first -- mirrors legacy's mount()-time
    // refreshRecoveryList() call. Never mutates anything it finds.
    void recordingService.checkForRecovery()
    const unsubscribeSerial = serialGnssService.subscribe(applySerial)
    const unsubscribeLines = serialGnssService.subscribeLines((event) => recordingService.ingest(event))
    const unsubscribeRecording = recordingService.subscribe(applyRecording)
    const staleTimer = window.setInterval(() => publishSerialStatus(serialGnssService.getSnapshot()), 1000)
    return () => {
      unsubscribeSerial()
      unsubscribeLines()
      unsubscribeRecording()
      window.clearInterval(staleTimer)
    }
  }, [])
}
