import { useSyncExternalStore } from 'react'
import { waterControlRepository } from './legacyWaterControlRepository'
import type { WaterControlSnapshot } from '../../domain/water/types'

/**
 * Live view of every persisted water control point. The read error travels
 * inside the snapshot (Stage 3C's convention) rather than through a second
 * subscription, so a corrupt store can never be mistaken for an empty one.
 */
export function useWaterControlSnapshot(): WaterControlSnapshot {
  return useSyncExternalStore(
    waterControlRepository.subscribe,
    waterControlRepository.getSnapshot,
    waterControlRepository.getSnapshot,
  )
}
