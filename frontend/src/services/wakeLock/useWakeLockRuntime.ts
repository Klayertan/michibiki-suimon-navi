import { useEffect } from 'react'
import { recordingService } from '../recording/recordingService'
import { useSystemStatusStore } from '../../store/useSystemStatusStore'
import { wakeLockService, type WakeLockSnapshot } from './wakeLockService'

/**
 * Publishes the compact "Screen" status badge (task section 12). Kept as a
 * pure function of (wake lock snapshot, is-recording, tab-hidden) so it can
 * be unit tested without mounting anything -- mirrors useGnssRuntime.ts's
 * exported publishSerialStatus().
 */
export function publishWakeLockStatus(snapshot: WakeLockSnapshot, isRecording: boolean, documentHidden: boolean): void {
  const setStatus = useSystemStatusStore.getState().setStatus
  if (snapshot.state === 'unsupported') {
    setStatus('wakeLock', 'warning', 'Keep-awake unsupported')
    return
  }
  if (!isRecording) {
    setStatus('wakeLock', 'disconnected')
    return
  }
  if (snapshot.state === 'active') { setStatus('wakeLock', 'connected', 'Awake'); return }
  if (snapshot.state === 'requesting') { setStatus('wakeLock', 'unknown', 'Requesting'); return }
  if (snapshot.state === 'released') { setStatus('wakeLock', 'warning', documentHidden ? 'Will reacquire on return' : 'Reacquiring'); return }
  if (snapshot.state === 'error') { setStatus('wakeLock', 'warning', snapshot.error ?? 'Keep-awake failed'); return }
  setStatus('wakeLock', 'disconnected')
}

/**
 * Owns the entire Wake Lock lifecycle (task section 17: one small hook, no
 * duplicated/conflicting listeners). Acquisition is driven exclusively by
 * RecordingService's own state -- never by GNSS connection, never merely
 * because Survey is open, an unfinished session exists, or Recovery Required
 * is showing (task sections 5, 15, 16): only a genuine `state === 'recording'`
 * transition (from Start *or* from a resumed recovery -- both land on the
 * same state) acquires, and leaving that state releases.
 *
 * No polling (task section 18): reacquisition after a tab-hidden release is
 * driven solely by the `visibilitychange` event, gated on whether recording
 * is still active at that moment.
 */
export function useWakeLockRuntime(): void {
  useEffect(() => {
    let wasRecording = false
    const applyRecording = () => {
      const isRecording = recordingService.getSnapshot().state === 'recording'
      if (isRecording && !wasRecording) void wakeLockService.request()
      else if (!isRecording && wasRecording) void wakeLockService.release()
      wasRecording = isRecording
      publishWakeLockStatus(wakeLockService.getSnapshot(), isRecording, document.hidden)
    }
    const applyWakeLock = () => {
      publishWakeLockStatus(wakeLockService.getSnapshot(), recordingService.getSnapshot().state === 'recording', document.hidden)
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && recordingService.getSnapshot().state === 'recording' && wakeLockService.isWanted()) {
        void wakeLockService.request()
      }
      applyWakeLock()
    }

    applyRecording()
    const unsubscribeRecording = recordingService.subscribe(applyRecording)
    const unsubscribeWakeLock = wakeLockService.subscribe(applyWakeLock)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      unsubscribeRecording()
      unsubscribeWakeLock()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])
}
