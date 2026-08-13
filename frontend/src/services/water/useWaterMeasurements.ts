import { useEffect, useSyncExternalStore } from 'react'
import { recordedWaterMeasurementRepository } from './recordedWaterMeasurementRepository'
import type { WaterMeasurementSnapshot } from '../../domain/water/types'

/**
 * Live view of saved water-level readings. Unlike the localStorage-backed
 * water-point snapshot, this one genuinely loads asynchronously (IndexedDB),
 * so `loading` is real here and is not synthesized.
 */
export function useWaterMeasurementSnapshot(): WaterMeasurementSnapshot {
  const snapshot = useSyncExternalStore(
    recordedWaterMeasurementRepository.subscribe,
    recordedWaterMeasurementRepository.getSnapshot,
    recordedWaterMeasurementRepository.getSnapshot,
  )
  useEffect(() => { recordedWaterMeasurementRepository.ensureLoaded() }, [])
  return snapshot
}
