// Orchestrates local <-> cloud synchronisation.
//
// LOCAL-FIRST, and that is not a slogan here. Every rule below exists because
// the farmer is standing in a paddy on one bar of signal:
//
//   1. The local repository is the source of truth for the running app. This
//      service reads from it and writes to it; nothing in the field workflow
//      ever awaits a network call before it takes effect.
//   2. A registration is persisted locally FIRST, then queued. If the queue
//      never drains, the paddy is still registered.
//   3. Nothing here throws into a UI path. A sync failure becomes a status
//      and a Japanese message; it never surfaces as a broken button.
//   4. Sync is triggered on sign-in, on an explicit 今すぐ同期, when the
//      browser reports the network came back, and (debounced) after a local
//      change. It is NOT triggered per click.
//
// The merge rules themselves live in field-sync-core.js and are pure.

import {
  KIND_FIELD,
  KIND_OBSERVATION,
  KIND_WATER_POINT,
  applyRemoteRecords,
  fieldToCloudRow,
  markSyncError,
  markSynced,
  mergeRecords,
  normalizeSyncMetadata,
  observationToCloudRow,
  recordsNeedingUpload,
  summarizeSyncStatus,
  waterControlPointToCloudRow
} from "./field-sync-core.js";
import { isOfflineError, syncErrorMessage } from "../auth/auth-errors.js";

const SYNC_METADATA_KEY = "suimonNaviCloudSyncV1";
// Long enough to coalesce the burst a single registration produces (the field
// controller re-renders several times), short enough that a farmer watching
// the ⟳ chip does not wonder whether it is stuck.
const DEBOUNCE_MS = 1500;

export class FieldSyncService extends EventTarget {
  /**
   * @param {object} options
   * @param {object} options.store           cloud store adapter (Supabase or mock)
   * @param {Function} options.getLocalData  () => { fields, waterControlPoints, fieldObservations, waterTargets }
   * @param {Function} options.applyRemote   (patch) => void — writes merged records back into the local repo
   * @param {object} options.storage         user-scoped storage (sync bookkeeping is per user)
   * @param {Function} options.isAuthenticated
   */
  constructor({ store, getLocalData, applyRemote, storage, isAuthenticated = () => false } = {}) {
    super();
    this.store = store || null;
    this.getLocalData = getLocalData || (() => ({ fields: [], waterControlPoints: [], fieldObservations: [], waterTargets: {} }));
    this.applyRemote = applyRemote || (() => {});
    this.storage = storage || null;
    this.isAuthenticated = isAuthenticated;
    this.metadata = this.readMetadata();
    // A dropped connection is NOT a sync error. `!同期エラー` should mean
    // "something went wrong that waiting will not fix"; an unreachable server
    // is `⟳ 同期待ち`, which is both true and not alarming. Tracked separately
    // from lastError so the two can never be confused.
    this.providerUnreachable = false;
    this.lastError = null;
    this.lastMessage = "";
    this.syncing = false;
    this.debounceTimer = null;
    this.queuedWhileSyncing = false;
  }

  // -- bookkeeping -----------------------------------------------------------

  readMetadata() {
    try {
      const raw = this.storage?.getItem(SYNC_METADATA_KEY);
      return normalizeSyncMetadata(raw ? JSON.parse(raw) : null);
    } catch {
      return normalizeSyncMetadata(null);
    }
  }

  writeMetadata(metadata) {
    this.metadata = normalizeSyncMetadata(metadata);
    try {
      this.storage?.setItem(SYNC_METADATA_KEY, JSON.stringify(this.metadata));
    } catch {
      // Quota/private browsing: the queue degrades to in-memory only, so a
      // reload re-uploads. Wasteful, never lossy.
    }
  }

  /** Re-reads bookkeeping after the storage scope was re-pointed at another user. */
  reloadForCurrentScope() {
    this.metadata = this.readMetadata();
    this.lastError = null;
    this.providerUnreachable = false;
    this.lastMessage = "";
    this.emitStatus();
  }

  setStore(store) {
    this.store = store || null;
  }

  // -- status ----------------------------------------------------------------

  online() {
    return typeof navigator === "undefined" || navigator.onLine !== false;
  }

  /**
   * How many records the cloud does not yet have the current version of.
   *
   * Computed against the LIVE local data rather than against the sidecar
   * alone, because a paddy registered thirty seconds ago has no sidecar entry
   * at all — counting only known entries would show ✓ 同期済み over a paddy
   * that has never left the phone, which is precisely the lie the brief's
   * "do not silently pretend everything is synced" rules out.
   */
  pendingCount() {
    const local = this.getLocalData();
    return recordsNeedingUpload(this.metadata, KIND_FIELD, local.fields || []).length
      + recordsNeedingUpload(this.metadata, KIND_WATER_POINT, local.waterControlPoints || []).length
      + recordsNeedingUpload(this.metadata, KIND_OBSERVATION, local.fieldObservations || []).length;
  }

  status() {
    return {
      ...summarizeSyncStatus({
        authenticated: this.isAuthenticated(),
        // Either signal counts as offline: the browser saying so, or the
        // provider proving it by failing to answer.
        online: this.online() && !this.providerUnreachable,
        pendingCount: this.pendingCount(),
        lastError: this.lastError
      }),
      syncing: this.syncing,
      lastSyncedAt: this.metadata.lastFullSyncAt,
      message: this.lastMessage
    };
  }

  emitStatus() {
    this.dispatchEvent(new CustomEvent("status", { detail: this.status() }));
  }

  // -- triggers ---------------------------------------------------------------

  /**
   * Called after any local mutation. Debounced: a farmer trimming a boundary
   * fires a burst of changes, and each one does not deserve its own upload.
   */
  scheduleSync() {
    if (!this.isAuthenticated() || !this.store) {
      return;
    }
    this.emitStatus();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.syncNow({ silent: true });
    }, DEBOUNCE_MS);
  }

  /**
   * Full two-way sync. Resolves to a result object rather than throwing —
   * every caller is a UI path.
   */
  async syncNow({ silent = false } = {}) {
    if (!this.isAuthenticated() || !this.store) {
      return { ok: false, reason: "not_authenticated" };
    }
    if (this.syncing) {
      // Coalesce rather than run two merges against the same local state.
      this.queuedWhileSyncing = true;
      return { ok: false, reason: "busy" };
    }
    if (!this.online()) {
      this.lastMessage = "オフラインのため同期を保留しました。";
      this.emitStatus();
      return { ok: false, reason: "offline" };
    }

    this.syncing = true;
    this.lastError = null;
    this.emitStatus();
    try {
      const result = await this.runSync();
      this.providerUnreachable = false;
      this.lastMessage = silent ? "" : "同期しました。";
      this.writeMetadata({ ...this.metadata, lastFullSyncAt: new Date().toISOString() });
      this.emitStatus();
      return { ok: true, ...result };
    } catch (error) {
      this.lastMessage = syncErrorMessage(error);
      if (isOfflineError(error)) {
        // The server could not be reached. Nothing is wrong with the data and
        // nothing is lost — it is simply still queued.
        this.providerUnreachable = true;
        this.emitStatus();
        return { ok: false, reason: "offline", error, message: this.lastMessage };
      }
      this.lastError = error;
      this.emitStatus();
      return { ok: false, reason: "error", error, message: this.lastMessage };
    } finally {
      this.syncing = false;
      if (this.queuedWhileSyncing) {
        this.queuedWhileSyncing = false;
        this.scheduleSync();
      }
    }
  }

  // -- the sync itself ---------------------------------------------------------

  async runSync() {
    const local = this.getLocalData();
    let metadata = this.metadata;
    const patch = {};
    let uploaded = 0;
    let downloaded = 0;

    // Fields first: water points and observations reference a field by its
    // LOCAL id, and the cloud field row is what carries the cloud UUID those
    // rows point at.
    const fieldMerge = mergeRecords({
      localRecords: local.fields || [],
      cloudRows: await this.store.listFields(),
      legacyIdKey: "legacy_field_id"
    });
    const cloudIdByLegacyFieldId = { ...fieldMerge.cloudIdByLocalId };

    if (fieldMerge.toUpload.length > 0) {
      const rows = fieldMerge.toUpload.map((field) => fieldToCloudRow(field, {
        cloudId: cloudIdByLegacyFieldId[String(field.id)] || null
      }));
      const written = await this.store.upsertFields(rows);
      written.forEach((row) => {
        cloudIdByLegacyFieldId[String(row.legacy_field_id)] = row.id;
      });
      fieldMerge.toUpload.forEach((field) => {
        metadata = markSynced(metadata, KIND_FIELD, field, { cloudId: cloudIdByLegacyFieldId[String(field.id)] });
      });
      uploaded += fieldMerge.toUpload.length;
    }
    fieldMerge.inSync.forEach((field) => {
      metadata = markSynced(metadata, KIND_FIELD, field, { cloudId: cloudIdByLegacyFieldId[String(field.id)] });
    });
    if (fieldMerge.toApply.length > 0) {
      patch.fields = applyRemoteRecords(local.fields || [], fieldMerge.toApply);
      fieldMerge.toApply.forEach((field) => {
        metadata = markSynced(metadata, KIND_FIELD, field, { cloudId: cloudIdByLegacyFieldId[String(field.id)] });
      });
      downloaded += fieldMerge.toApply.length;
    }

    // Water-management points.
    const pointMerge = mergeRecords({
      localRecords: local.waterControlPoints || [],
      cloudRows: await this.store.listWaterControlPoints(),
      legacyIdKey: "legacy_point_id"
    });
    if (pointMerge.toUpload.length > 0) {
      const rows = pointMerge.toUpload.map((point) => waterControlPointToCloudRow(point, {
        cloudId: pointMerge.cloudIdByLocalId[String(point.id)] || null,
        fieldCloudId: cloudIdByLegacyFieldId[String(point.relatedFieldId)] || null
      }));
      await this.store.upsertWaterControlPoints(rows);
      pointMerge.toUpload.forEach((point) => {
        metadata = markSynced(metadata, KIND_WATER_POINT, point, { cloudId: pointMerge.cloudIdByLocalId[String(point.id)] });
      });
      uploaded += pointMerge.toUpload.length;
    }
    pointMerge.inSync.forEach((point) => {
      metadata = markSynced(metadata, KIND_WATER_POINT, point, { cloudId: pointMerge.cloudIdByLocalId[String(point.id)] });
    });
    if (pointMerge.toApply.length > 0) {
      patch.waterControlPoints = applyRemoteRecords(local.waterControlPoints || [], pointMerge.toApply);
      pointMerge.toApply.forEach((point) => {
        metadata = markSynced(metadata, KIND_WATER_POINT, point, { cloudId: pointMerge.cloudIdByLocalId[String(point.id)] });
      });
      downloaded += pointMerge.toApply.length;
    }

    // Field observations.
    const observationMerge = mergeRecords({
      localRecords: local.fieldObservations || [],
      cloudRows: await this.store.listObservations(),
      legacyIdKey: "legacy_observation_id"
    });
    if (observationMerge.toUpload.length > 0) {
      const rows = observationMerge.toUpload.map((observation) => observationToCloudRow(observation, {
        cloudId: observationMerge.cloudIdByLocalId[String(observation.id)] || null,
        fieldCloudId: cloudIdByLegacyFieldId[String(observation.fieldId)] || null
      }));
      await this.store.upsertObservations(rows);
      observationMerge.toUpload.forEach((observation) => {
        metadata = markSynced(metadata, KIND_OBSERVATION, observation, { cloudId: observationMerge.cloudIdByLocalId[String(observation.id)] });
      });
      uploaded += observationMerge.toUpload.length;
    }
    observationMerge.inSync.forEach((observation) => {
      metadata = markSynced(metadata, KIND_OBSERVATION, observation, { cloudId: observationMerge.cloudIdByLocalId[String(observation.id)] });
    });
    if (observationMerge.toApply.length > 0) {
      patch.fieldObservations = applyRemoteRecords(local.fieldObservations || [], observationMerge.toApply);
      observationMerge.toApply.forEach((observation) => {
        metadata = markSynced(metadata, KIND_OBSERVATION, observation, { cloudId: observationMerge.cloudIdByLocalId[String(observation.id)] });
      });
      downloaded += observationMerge.toApply.length;
    }

    // Per-field target water level.
    //
    // Union merge, device wins on conflict. Unlike the record types above,
    // the existing local storage format for this value is a bare
    // `{ fieldId: number }` map with no timestamp anywhere, so there is no
    // honest way to decide which side is newer. Rather than invent a
    // timestamp and pretend, v1 documents the rule: a value typed on this
    // device wins, and cloud-only values are adopted. Documented in
    // docs/STAGE1_AUTH_CLOUD_FIELDS.md §7.
    const cloudTargets = await this.store.listWaterTargets();
    const localTargets = local.waterTargets || {};
    const mergedTargets = { ...localTargets };
    cloudTargets.forEach((row) => {
      const key = String(row.legacy_field_id);
      if (!(key in mergedTargets) && Number.isFinite(Number(row.target_water_level_cm))) {
        mergedTargets[key] = Number(row.target_water_level_cm);
      }
    });
    const targetRows = Object.entries(mergedTargets)
      .filter(([, value]) => Number.isFinite(Number(value)))
      .map(([legacyFieldId, value]) => ({
        legacy_field_id: legacyFieldId,
        field_id: cloudIdByLegacyFieldId[legacyFieldId] || null,
        target_water_level_cm: Number(value)
      }));
    if (targetRows.length > 0) {
      await this.store.upsertWaterTargets(targetRows);
    }
    metadata = { ...normalizeSyncMetadata(metadata), waterTargets: { syncedAt: new Date().toISOString(), state: "synced", values: mergedTargets } };
    if (JSON.stringify(mergedTargets) !== JSON.stringify(localTargets)) {
      patch.waterTargets = mergedTargets;
    }

    this.writeMetadata(metadata);
    if (Object.keys(patch).length > 0) {
      this.applyRemote(patch);
    }
    return { uploaded, downloaded };
  }

  /**
   * Marks a specific record as failed without losing the rest of the queue.
   * Used by the caller when it knows which record a partial failure belongs
   * to; the bulk path above marks the whole attempt via `lastError`.
   */
  noteRecordError(kind, localId, message) {
    this.writeMetadata(markSyncError(this.metadata, kind, localId, message));
    this.emitStatus();
  }

  dispose() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}
