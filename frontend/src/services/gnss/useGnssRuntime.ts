import { useEffect } from 'react'
import { recordingService } from '../recording/recordingService'
import { recordedSurveyRepository } from '../recording/recordedSurveyRepository'
import { useLiveGnssStore } from '../../store/useLiveGnssStore'
import { useSystemStatusStore } from '../../store/useSystemStatusStore'
import { serialGnssService, type GnssSerialSnapshot } from './serialGnssService'

function publishSerialStatus(snapshot: GnssSerialSnapshot): void {
  const setStatus = useSystemStatusStore.getState().setStatus
  const state = snapshot.connectionState
  if (state === 'connected') setStatus('serial', 'connected', snapshot.transportLabel ?? undefined)
  else if (state === 'stalled' || state === 'error' || state === 'unsupported') setStatus('serial', 'warning', snapshot.message ?? state)
  else if (state === 'requesting' || state === 'opening' || state === 'disconnecting') setStatus('serial', 'unknown', state)
  else setStatus('serial', 'disconnected')

  if (state !== 'connected') setStatus('gnss', 'disconnected')
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
