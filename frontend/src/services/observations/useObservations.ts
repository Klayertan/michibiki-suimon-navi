import { useSyncExternalStore } from 'react'
import { observationRepository } from './legacyObservationRepository'

export function useObservationSnapshot() {
  return useSyncExternalStore(observationRepository.subscribe, observationRepository.getSnapshot, observationRepository.getSnapshot)
}
