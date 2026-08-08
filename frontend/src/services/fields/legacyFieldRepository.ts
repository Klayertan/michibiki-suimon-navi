// Adapter around the existing, already-persisted field store. Deliberately
// does NOT move js/fields/field-annotation-core.js or
// js/fields/field-registry.js into frontend/src/domain -- both stay exactly
// where they are and keep serving the legacy app unmodified (task section 4:
// "transitional architecture", docs/UI_REDESIGN.md Stage 2 section). This
// file is the one place that knows the on-disk shape; everything above it
// (React components, hooks) only sees domain/fields/types.ts's `Field`.
//
// Critical compatibility rule (task section 6): every write here reads the
// *current* full store, mutates only the `fields` array, and writes
// the full store straight back -- boundaryTracks/waterControlPoints/
// surveySessions/fieldObservations/workflowState must round-trip untouched.
// Writing only `{ fields }` would silently discard those other datasets the
// next time the legacy app (or a later migration stage) reads them.
import {
  LOCAL_STORAGE_KEY,
  SCHEMA_VERSION,
  buildField,
  emptyPersistedStore,
  normalizePersistedStore,
} from '@legacy/fields/field-annotation-core.js'
import { makeId } from '@legacy/gnss/gnss-store.js'
import { evaluateClosure } from '../../domain/fields/geometry'
import type { CreateFieldInput, Field, FieldPatch } from '../../domain/fields/types'
import { FieldNotFoundError, FieldSaveError, FieldValidationError } from './fieldRepositoryErrors'

/**
 * Loose on purpose: Stage 2 treats every sibling dataset as opaque and only
 * round-trips each whole array while mutating the fields array.
 */
interface PersistedFieldStore {
  schemaVersion: number
  fields: Field[]
  boundaryTracks: unknown[]
  waterControlPoints: unknown[]
  surveySessions: unknown[]
  fieldObservations: unknown[]
  workflowState: Record<string, unknown>
}

interface FieldReadResult {
  store: PersistedFieldStore
  error: string | null
}

export const FIELD_DELETION_DISABLED_REASON =
  'Deletion is deferred until recording, vegetation, and assurance field references have a cross-store policy.'

export interface FieldRepository {
  list(): Promise<Field[]>
  get(id: string): Promise<Field | null>
  create(input: CreateFieldInput): Promise<Field>
  update(id: string, patch: FieldPatch): Promise<Field>
}

export class LegacyFieldRepository implements FieldRepository {
  private readonly storage: Storage
  private readonly listeners = new Set<() => void>()
  private cache: Field[] | null = null
  private readError: string | null = null

  constructor(storage: Storage = window.localStorage) {
    this.storage = storage
    // Cross-tab/same-origin correctness: the legacy app and this app share
    // one localStorage once they share one origin (the desktop build -- see
    // docs/FRONTEND_ARCHITECTURE.md). In dev they run on different
    // ports/origins and this event never fires between them, which is a
    // browser storage-partitioning fact, not a bug here -- see the Stage 2
    // completion report's compatibility section.
    window.addEventListener('storage', (event) => {
      if (event.storageArea === this.storage && (event.key === LOCAL_STORAGE_KEY || event.key === null)) {
        this.invalidate()
      }
    })
  }

  // -- React binding (useSyncExternalStore, see ./useFields.ts) -------------
  // Not part of the FieldRepository interface: a future non-browser-storage
  // implementation (e.g. a FastAPI-backed one) would need its own binding
  // strategy, not necessarily a synchronous snapshot.

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): Field[] => {
    if (!this.cache) {
      const result = this.readStoreWithStatus()
      this.cache = result.store.fields
      this.readError = result.error
    }
    return this.cache
  }

  getReadErrorSnapshot = (): string | null => {
    // Ensure both snapshots describe the same storage read even if a caller
    // subscribes to the error without first subscribing to the field list.
    this.getSnapshot()
    return this.readError
  }

  /** Invalidate after a same-document compatibility fixture or legacy write. */
  refresh(): void {
    this.invalidate()
  }

  // -- FieldRepository --------------------------------------------------

  async list(): Promise<Field[]> {
    return this.readStore().fields
  }

  async get(id: string): Promise<Field | null> {
    return this.readStore().fields.find((field) => field.id === id) ?? null
  }

  async create(input: CreateFieldInput): Promise<Field> {
    const coordinates = input.coordinates
    const closure = evaluateClosure(coordinates)
    if (!closure.canClose) {
      // Only the hard structural floor (fewer than 3 points) is enforced
      // here. Gap/self-intersection remain soft warnings, exactly as in the
      // legacy upload-registration flow. The React creation UI is deferred
      // to Stage 2B, but the adapter contract stays behavior-compatible.
      throw new FieldValidationError('This boundary is not a valid polygon.', closure.warnings)
    }

    const store = this.readStoreForWrite()
    // TS infers buildField's plain-JS default-parameter types too narrowly
    // (e.g. `gapM = null` alone infers as exactly `null`, not the
    // `number | null` it actually accepts and uses) -- going through
    // `unknown` at this one call site sidesteps that; the real, checked
    // shape on both sides is CreateFieldInput in and Field out.
    const field = buildField({
      id: makeId('field'),
      name: input.name,
      coordinates,
      memo: input.memo ?? '',
      gapM: closure.gapM,
      closedManually: input.closedManually ?? !closure.autoClose,
      sourceSessionId: input.sourceSessionId ?? null,
      sourceType: input.sourceType ?? 'react_manual_draw',
      sourceFileName: input.sourceFileName ?? null,
      sourcePointCount: input.sourcePointCount ?? coordinates.length,
      fixQualitySummary: input.fixQualitySummary ?? null,
    } as unknown as Parameters<typeof buildField>[0]) as Field

    store.fields = [...store.fields, field]
    // Both legacy annotation survey sessions and boundary tracks already
    // carry fieldId. Linking only those explicitly named source records is
    // part of this one localStorage write, so no transient half-link exists.
    if (input.linkSourceToField !== false && input.sourceSessionId) {
      store.surveySessions = store.surveySessions.map((session) =>
        session && typeof session === 'object' && (session as { id?: unknown }).id === input.sourceSessionId
          ? { ...(session as Record<string, unknown>), fieldId: field.id }
          : session,
      )
      store.boundaryTracks = store.boundaryTracks.map((track) =>
        track && typeof track === 'object' && (track as { sourceSessionId?: unknown }).sourceSessionId === input.sourceSessionId
          ? { ...(track as Record<string, unknown>), fieldId: field.id }
          : track,
      )
    }
    if (input.linkSourceToField !== false && input.sourceTrackId) {
      store.boundaryTracks = store.boundaryTracks.map((track) =>
        track && typeof track === 'object' && (track as { id?: unknown }).id === input.sourceTrackId
          ? { ...(track as Record<string, unknown>), fieldId: field.id }
          : track,
      )
    }
    this.writeStore(store)
    return field
  }

  async update(id: string, patch: FieldPatch): Promise<Field> {
    const store = this.readStoreForWrite()
    const index = store.fields.findIndex((field) => field.id === id)
    if (index === -1) {
      throw new FieldNotFoundError(id)
    }
    const existing = store.fields[index]
    const updated: Field = {
      ...existing,
      name: patch.name ?? existing.name,
      properties: {
        ...existing.properties,
        memo: patch.memo ?? existing.properties.memo,
        updatedAt: new Date().toISOString(),
      },
    }
    store.fields = [...store.fields.slice(0, index), updated, ...store.fields.slice(index + 1)]
    this.writeStore(store)
    return updated
  }

  // -- Persistence --------------------------------------------------------

  private readStore(): PersistedFieldStore {
    return this.readStoreWithStatus().store
  }

  private readStoreWithStatus(): FieldReadResult {
    try {
      const raw = this.storage.getItem(LOCAL_STORAGE_KEY)
      if (!raw) {
        return { store: emptyPersistedStore() as PersistedFieldStore, error: null }
      }
      const parsed = JSON.parse(raw) as unknown
      const store = normalizePersistedStore(parsed) as PersistedFieldStore
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        !('schemaVersion' in parsed) ||
        (parsed as { schemaVersion?: unknown }).schemaVersion !== SCHEMA_VERSION
      ) {
        const found =
          parsed && typeof parsed === 'object' && 'schemaVersion' in parsed
            ? String((parsed as { schemaVersion?: unknown }).schemaVersion)
            : 'missing'
        return {
          store,
          error: `Saved field data uses schema version ${found}; this frontend supports version ${SCHEMA_VERSION}. It is read-only here.`,
        }
      }
      return { store, error: null }
    } catch {
      // Corrupted localStorage must never crash the app -- same contract as
      // the legacy controller's own hydrateFromStorage(). Unlike the legacy
      // surface, React also exposes this state to the operator instead of
      // presenting it as an ordinary empty store.
      return {
        store: emptyPersistedStore() as PersistedFieldStore,
        error: 'Saved field data could not be read. The stored value was left unchanged.',
      }
    }
  }

  /**
   * Mutations fail closed when existing bytes cannot be safely understood.
   * Read compatibility still mirrors the legacy controller (bad data renders
   * as empty), but React must never turn a corrupt or differently-versioned
   * value into a fresh v3 store merely because an operator creates/edits a
   * field. That would be an implicit migration and could destroy recoverable
   * data, contrary to the Stage 2 compatibility contract.
   */
  private readStoreForWrite(): PersistedFieldStore {
    let raw: string | null
    try {
      raw = this.storage.getItem(LOCAL_STORAGE_KEY)
    } catch (error) {
      throw new FieldSaveError('Existing field data could not be read, so no changes were saved.', error)
    }
    if (!raw) {
      return emptyPersistedStore() as PersistedFieldStore
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new FieldSaveError('Existing field data is malformed, so no changes were saved.', error)
    }

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('schemaVersion' in parsed) ||
      (parsed as { schemaVersion?: unknown }).schemaVersion !== SCHEMA_VERSION
    ) {
      throw new FieldSaveError(
        `Existing field data uses an unsupported schema. Expected version ${SCHEMA_VERSION}; no changes were saved.`,
      )
    }

    return normalizePersistedStore(parsed) as PersistedFieldStore
  }

  private writeStore(store: PersistedFieldStore): void {
    // Explicit key list (not a spread) so this can never drift from the
    // legacy controller's own persist() shape by picking up a stray key.
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      fields: store.fields,
      boundaryTracks: store.boundaryTracks,
      waterControlPoints: store.waterControlPoints,
      surveySessions: store.surveySessions,
      fieldObservations: store.fieldObservations,
      workflowState: store.workflowState,
    }
    try {
      this.storage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(payload))
    } catch (error) {
      // setItem either fully succeeds or throws without a partial write, so
      // this message is factually accurate, not just reassuring.
      throw new FieldSaveError('Could not save field. Existing field data was not modified.', error)
    }
    this.invalidate()
  }

  private invalidate(): void {
    this.cache = null
    this.readError = null
    this.listeners.forEach((listener) => listener())
  }
}

export function createLegacyFieldRepository(storage?: Storage): LegacyFieldRepository {
  return new LegacyFieldRepository(storage)
}

/**
 * Shared singleton: FieldLayer, FieldWorkspace, the field selector and the
 * inspector all need to observe the same live data. Tests construct their own
 * createLegacyFieldRepository(fakeStorage) instance instead of this one, for
 * isolation. This app has no SSR entry point (see frontend/src/main.tsx), so
 * `window`/`window.localStorage` are always present, in the browser and under
 * Vitest's jsdom environment alike -- matching how services/drone/droneService.ts
 * already assumes `window` unconditionally.
 */
export const fieldRepository = createLegacyFieldRepository()
