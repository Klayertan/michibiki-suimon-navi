import { useSyncExternalStore } from 'react'
import { fieldRepository } from './legacyFieldRepository'
import type { Field } from '../../domain/fields/types'

/**
 * Live view of every persisted field, re-rendering only the components that
 * call this hook when the store actually changes (create/update here,
 * or a same-origin "storage" event from another tab -- see
 * legacyFieldRepository.ts). Reads are synchronous under the hood
 * (localStorage always is), which is what useSyncExternalStore needs; the
 * async FieldRepository.list()/get() are for callers that only need one
 * read, not a live subscription.
 */
export function useFields(): Field[] {
  return useSyncExternalStore(fieldRepository.subscribe, fieldRepository.getSnapshot, fieldRepository.getSnapshot)
}

/**
 * Operator-facing persistence status. Reads deliberately retain the legacy
 * behavior of degrading malformed data to an empty list, while this parallel
 * snapshot prevents that condition from looking like a normal empty store.
 */
export function useFieldReadError(): string | null {
  return useSyncExternalStore(
    fieldRepository.subscribe,
    fieldRepository.getReadErrorSnapshot,
    fieldRepository.getReadErrorSnapshot,
  )
}
