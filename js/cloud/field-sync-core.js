// Cloud <-> local field synchronisation: pure logic.
//
// No network, no storage, no DOM. Everything here is a function of the two
// record lists it is handed, so the merge rules are unit-testable and the
// service layer above stays a thin orchestrator.
//
// DESIGN CONSTRAINT that shapes everything below: the local field record is
// not allowed to change. `buildField()` in field-annotation-core.js produces
// a record that the map layer, the area calculation, the 圃場レポート, the
// export format and every existing test already depend on, and the Stage-1
// report explicitly pins "Field record shape — buildField() not touched".
// So the cloud row carries the whole local record verbatim in a `record`
// JSON column, and sync bookkeeping (cloud UUID, last-synced stamp, state)
// lives in a SEPARATE sidecar keyed by the local id. Nothing this module does
// adds a field to a paddy record.

export const SYNC_STATE_SYNCED = "synced";
export const SYNC_STATE_PENDING = "pending";
export const SYNC_STATE_ERROR = "error";

/** The three record kinds that participate in cloud sync in v1. */
export const KIND_FIELD = "field";
export const KIND_WATER_POINT = "waterControlPoint";
export const KIND_OBSERVATION = "observation";

export const SYNC_METADATA_VERSION = 1;

export function emptySyncMetadata() {
  return {
    version: SYNC_METADATA_VERSION,
    entries: {},        // `${kind}:${localId}` -> { cloudId, syncedLocalUpdatedAt, syncedAt, state, error }
    waterTargets: { syncedAt: null, state: SYNC_STATE_PENDING, values: {} },
    lastFullSyncAt: null
  };
}

/** Never throws: unreadable bookkeeping degrades to "nothing has synced yet". */
export function normalizeSyncMetadata(raw) {
  if (!raw || typeof raw !== "object") {
    return emptySyncMetadata();
  }
  const base = emptySyncMetadata();
  return {
    version: SYNC_METADATA_VERSION,
    entries: raw.entries && typeof raw.entries === "object" ? { ...raw.entries } : base.entries,
    waterTargets: {
      syncedAt: typeof raw.waterTargets?.syncedAt === "string" ? raw.waterTargets.syncedAt : null,
      state: raw.waterTargets?.state === SYNC_STATE_SYNCED ? SYNC_STATE_SYNCED : SYNC_STATE_PENDING,
      values: raw.waterTargets?.values && typeof raw.waterTargets.values === "object" ? { ...raw.waterTargets.values } : {}
    },
    lastFullSyncAt: typeof raw.lastFullSyncAt === "string" ? raw.lastFullSyncAt : null
  };
}

export function entryKey(kind, localId) {
  return `${kind}:${localId}`;
}

// ---------------------------------------------------------------------------
// Local record -> cloud row
//
// The denormalized columns (name / area_m2 / boundary / …) exist so the cloud
// row is queryable and inspectable — an "あなたの圃場" list must not require
// parsing a JSON blob, and a support question must be answerable in the
// Supabase table editor. `record` remains the authority on round-trip.
// ---------------------------------------------------------------------------

export function fieldToCloudRow(field, { cloudId = null } = {}) {
  return {
    id: cloudId || undefined,
    legacy_field_id: String(field.id),
    name: String(field.name ?? ""),
    area_m2: numberOrNull(field.properties?.areaM2),
    source_nmea_filename: field.properties?.sourceFileName ?? null,
    boundary: Array.isArray(field.coordinates) ? field.coordinates : [],
    record: field,
    local_updated_at: localTimestamp(field)
  };
}

export function waterControlPointToCloudRow(point, { cloudId = null, fieldCloudId = null } = {}) {
  return {
    id: cloudId || undefined,
    field_id: fieldCloudId || null,
    legacy_point_id: String(point.id),
    legacy_field_id: point.relatedFieldId ?? null,
    point_type: String(point.type ?? ""),
    lat: numberOrNull(point.coordinates?.[0]),
    lon: numberOrNull(point.coordinates?.[1]),
    record: point,
    local_updated_at: localTimestamp(point)
  };
}

export function observationToCloudRow(observation, { cloudId = null, fieldCloudId = null } = {}) {
  return {
    id: cloudId || undefined,
    field_id: fieldCloudId || null,
    legacy_observation_id: String(observation.id),
    legacy_field_id: observation.fieldId ?? null,
    observation_type: String(observation.type ?? ""),
    severity: observation.properties?.severity ?? null,
    lat: numberOrNull(observation.coordinates?.[0]),
    lon: numberOrNull(observation.coordinates?.[1]),
    record: observation,
    local_updated_at: localTimestamp(observation)
  };
}

/**
 * The reverse direction is deliberately trivial: whatever `record` holds IS
 * the local record. The denormalized columns are never used to reconstruct
 * one, so a column drifting out of step with the blob can never corrupt a
 * paddy boundary.
 *
 * A row whose `record` is missing or malformed is skipped rather than
 * half-rebuilt — a field with no coordinates would render as an empty polygon
 * and silently lose the farmer's walk.
 */
export function cloudRowToLocalRecord(row) {
  const record = row?.record;
  if (!record || typeof record !== "object" || !record.id) {
    return null;
  }
  return record;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Reconciles one kind of record between the device and the cloud.
 *
 * Matching is by the LOCAL id (`paddy-001`, `wcp-…`), carried on the cloud row
 * as `legacy_*_id` and constrained unique per owner in the database. The cloud
 * UUID is the primary key and is remembered in the sidecar, but it is not the
 * matching key: a farmer who registers 田圃1 on their phone while offline and
 * again on a tablet would otherwise get two rows for one paddy.
 *
 * Conflict rule — LAST WRITE WINS, compared on the records' own
 * `properties.updatedAt` (a local clock on both sides, so no server/client
 * skew enters the comparison), with the cloud row's `local_updated_at` column
 * holding what that value was when it was uploaded. Explicitly documented in
 * docs/STAGE1_AUTH_CLOUD_FIELDS.md; a genuine three-way merge of a polygon is
 * not something v1 attempts.
 *
 * Ties resolve to "already in sync" — re-uploading an identical record on
 * every launch would burn a farmer's mobile data for nothing.
 *
 * Returns:
 *   toUpload    local records the cloud does not have, or has an older copy of
 *   toApply     cloud records to write into the local repository
 *   inSync      records that match on both sides
 *   cloudIdByLocalId  what the sidecar should remember after this merge
 */
export function mergeRecords({ localRecords = [], cloudRows = [], legacyIdKey = "legacy_field_id" } = {}) {
  const cloudByLocalId = new Map();
  cloudRows.forEach((row) => {
    const legacyId = row?.[legacyIdKey];
    if (legacyId) {
      cloudByLocalId.set(String(legacyId), row);
    }
  });

  const toUpload = [];
  const toApply = [];
  const inSync = [];
  const cloudIdByLocalId = {};
  const seen = new Set();

  localRecords.forEach((record) => {
    const localId = String(record.id);
    seen.add(localId);
    const row = cloudByLocalId.get(localId);
    if (!row) {
      toUpload.push(record);
      return;
    }
    if (row.id) {
      cloudIdByLocalId[localId] = row.id;
    }
    const localStamp = localTimestamp(record);
    const cloudStamp = cloudTimestamp(row);
    if (isNewer(localStamp, cloudStamp)) {
      toUpload.push(record);
    } else if (isNewer(cloudStamp, localStamp)) {
      const remote = cloudRowToLocalRecord(row);
      if (remote) {
        toApply.push(remote);
      } else {
        // Cloud copy is unusable; keep the device's copy and push it back up
        // rather than leaving a broken row as the newest version.
        toUpload.push(record);
      }
    } else {
      inSync.push(record);
    }
  });

  cloudByLocalId.forEach((row, localId) => {
    if (seen.has(localId)) {
      return;
    }
    const remote = cloudRowToLocalRecord(row);
    if (remote) {
      toApply.push(remote);
      if (row.id) {
        cloudIdByLocalId[localId] = row.id;
      }
    }
  });

  return { toUpload, toApply, inSync, cloudIdByLocalId };
}

/**
 * Applies downloaded records to a local list, replacing by id and appending
 * what is new. Order of existing entries is preserved so the registered-fields
 * list does not reshuffle under the farmer after a sync.
 */
export function applyRemoteRecords(localRecords = [], remoteRecords = []) {
  const byId = new Map(localRecords.map((record) => [String(record.id), record]));
  const appended = [];
  remoteRecords.forEach((record) => {
    const id = String(record.id);
    if (byId.has(id)) {
      byId.set(id, record);
    } else {
      byId.set(id, record);
      appended.push(id);
    }
  });
  const order = [...localRecords.map((record) => String(record.id)), ...appended];
  return order.map((id) => byId.get(id));
}

// ---------------------------------------------------------------------------
// Local -> account import (brief §17)
// ---------------------------------------------------------------------------

/**
 * Which guest-mode records a first-time sign-in should offer to adopt.
 *
 * A record already present in the account's namespace (same local id) is NOT
 * offered again — that is the duplicate-upload guard. Nothing is deleted from
 * the guest namespace either way: the farmer keeps their offline copy.
 */
export function planLocalImport({ guestRecords = [], accountRecords = [] } = {}) {
  const owned = new Set(accountRecords.map((record) => String(record.id)));
  const importable = guestRecords.filter((record) => !owned.has(String(record.id)));
  return {
    importable,
    alreadyOwned: guestRecords.length - importable.length,
    count: importable.length
  };
}

/** Japanese prompt copy for the import offer. */
export function localImportPromptText(fieldCount) {
  return fieldCount === 1
    ? "ログインせずに登録した圃場が1件あります。"
    : `ログインせずに登録した圃場が${fieldCount}件あります。`;
}

// ---------------------------------------------------------------------------
// Sync status (brief §26 — subtle, three states, no dashboard)
// ---------------------------------------------------------------------------

export const SYNC_STATUS_OFF = "off";
export const SYNC_STATUS_SYNCED = "synced";
export const SYNC_STATUS_PENDING = "pending";
export const SYNC_STATUS_ERROR = "error";
export const SYNC_STATUS_OFFLINE = "offline";

export function summarizeSyncStatus({ authenticated = false, online = true, pendingCount = 0, lastError = null } = {}) {
  if (!authenticated) {
    return { status: SYNC_STATUS_OFF, icon: "", text: "" };
  }
  if (lastError) {
    return { status: SYNC_STATUS_ERROR, icon: "!", text: "同期エラー" };
  }
  if (!online) {
    return { status: SYNC_STATUS_OFFLINE, icon: "⟳", text: pendingCount > 0 ? `同期待ち ${pendingCount}件` : "オフライン" };
  }
  if (pendingCount > 0) {
    return { status: SYNC_STATUS_PENDING, icon: "⟳", text: `同期待ち ${pendingCount}件` };
  }
  return { status: SYNC_STATUS_SYNCED, icon: "✓", text: "同期済み" };
}

/**
 * Marks a local record as awaiting upload. Called on every local mutation so
 * that a registration made with no signal is not forgotten — the queue is the
 * sidecar itself, which is persisted, so it survives a reload and a battery
 * death in the middle of a paddy.
 */
export function markPending(metadata, kind, localId) {
  const next = normalizeSyncMetadata(metadata);
  const key = entryKey(kind, localId);
  next.entries[key] = { ...(next.entries[key] || {}), state: SYNC_STATE_PENDING };
  return next;
}

export function markSynced(metadata, kind, record, { cloudId = null, syncedAt = new Date().toISOString() } = {}) {
  const next = normalizeSyncMetadata(metadata);
  const key = entryKey(kind, record.id);
  next.entries[key] = {
    cloudId: cloudId || next.entries[key]?.cloudId || null,
    syncedLocalUpdatedAt: localTimestamp(record),
    syncedAt,
    state: SYNC_STATE_SYNCED,
    error: null
  };
  return next;
}

export function markSyncError(metadata, kind, localId, message) {
  const next = normalizeSyncMetadata(metadata);
  const key = entryKey(kind, localId);
  next.entries[key] = { ...(next.entries[key] || {}), state: SYNC_STATE_ERROR, error: String(message ?? "") };
  return next;
}

/**
 * Records whose local copy has changed since it was last uploaded, plus those
 * never uploaded at all. Compared against the stamp captured at upload time,
 * so an edit made while offline is still detected after a reload.
 */
export function recordsNeedingUpload(metadata, kind, records = []) {
  const entries = normalizeSyncMetadata(metadata).entries;
  return records.filter((record) => {
    const entry = entries[entryKey(kind, record.id)];
    if (!entry || entry.state !== SYNC_STATE_SYNCED) {
      return true;
    }
    return entry.syncedLocalUpdatedAt !== localTimestamp(record);
  });
}

/** Cloud rows for records the device no longer has, so a deletion propagates. */
export function rowsToDelete({ localRecords = [], cloudRows = [], legacyIdKey = "legacy_field_id", knownLocalIds = [] } = {}) {
  const present = new Set(localRecords.map((record) => String(record.id)));
  const known = new Set(knownLocalIds.map(String));
  return cloudRows.filter((row) => {
    const legacyId = String(row?.[legacyIdKey] ?? "");
    // Only delete what this device previously synced. A row created on
    // another device that this one has never seen is not "deleted here" — it
    // simply has not been downloaded yet.
    return legacyId && known.has(legacyId) && !present.has(legacyId);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function numberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/** The record's own last-modified stamp — the only clock used for conflicts. */
export function localTimestamp(record) {
  return record?.properties?.updatedAt || record?.properties?.createdAt || null;
}

function cloudTimestamp(row) {
  return row?.local_updated_at || row?.updated_at || null;
}

function isNewer(a, b) {
  if (!a) {
    return false;
  }
  if (!b) {
    return true;
  }
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return a > b;
  }
  return left > right;
}
