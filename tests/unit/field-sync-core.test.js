import test from "node:test";
import assert from "node:assert/strict";
import {
  KIND_FIELD,
  SYNC_STATE_SYNCED,
  SYNC_STATUS_ERROR,
  SYNC_STATUS_OFF,
  SYNC_STATUS_OFFLINE,
  SYNC_STATUS_PENDING,
  SYNC_STATUS_SYNCED,
  applyRemoteRecords,
  cloudRowToLocalRecord,
  emptySyncMetadata,
  fieldToCloudRow,
  localImportPromptText,
  markPending,
  markSyncError,
  markSynced,
  mergeRecords,
  normalizeSyncMetadata,
  observationToCloudRow,
  planLocalImport,
  recordsNeedingUpload,
  rowsToDelete,
  summarizeSyncStatus,
  waterControlPointToCloudRow
} from "../../js/cloud/field-sync-core.js";
import { buildField, buildFieldObservation, buildWaterControlPoint } from "../../js/fields/field-annotation-core.js";

const RING = [[34.6540, 135.8300], [34.6540, 135.8305], [34.6536, 135.8305], [34.6536, 135.8300]];

function field(id, { name = id, updatedAt = "2026-08-01T00:00:00.000Z" } = {}) {
  const record = buildField({ id, name, coordinates: RING, sourceFileName: "walk.nmea", nowIso: updatedAt });
  record.properties.updatedAt = updatedAt;
  return record;
}

function cloudRow(record, { cloudId = `uuid-${record.id}`, localUpdatedAt = record.properties.updatedAt } = {}) {
  return { ...fieldToCloudRow(record, { cloudId }), id: cloudId, local_updated_at: localUpdatedAt, owner_id: "owner" };
}

// ---------------------------------------------------------------------------
// Record <-> row mapping
// ---------------------------------------------------------------------------

test("a field row carries the local record verbatim, so a round trip is lossless", () => {
  // The Stage-1 report pins "buildField() not touched"; the cloud must not be
  // the thing that quietly reshapes a paddy.
  const original = field("paddy-001", { name: "北田" });
  const row = fieldToCloudRow(original);
  assert.deepEqual(cloudRowToLocalRecord(row), original);
});

test("the denormalized columns describe the row without being the authority", () => {
  const row = fieldToCloudRow(field("paddy-001", { name: "北田" }));
  assert.equal(row.legacy_field_id, "paddy-001");
  assert.equal(row.name, "北田");
  assert.ok(row.area_m2 > 0);
  assert.equal(row.source_nmea_filename, "walk.nmea");
  assert.deepEqual(row.boundary, RING);
  assert.equal(row.local_updated_at, "2026-08-01T00:00:00.000Z");
});

test("no row ever carries an owner_id from the browser", () => {
  // owner_id is filled by the database DEFAULT auth.uid(); a client-supplied
  // one is exactly the spoofing attempt the RLS WITH CHECK clause rejects.
  const rows = [
    fieldToCloudRow(field("paddy-001")),
    waterControlPointToCloudRow(buildWaterControlPoint({ id: "wcp-1", type: "gate", lat: 34.6, lon: 135.8, relatedFieldId: "paddy-001" })),
    observationToCloudRow(buildFieldObservation({ id: "obs-1", type: "weed", lat: 34.6, lon: 135.8, fieldId: "paddy-001" }))
  ];
  rows.forEach((row) => assert.equal("owner_id" in row, false, JSON.stringify(row).slice(0, 60)));
});

test("legacy relationships survive the trip: relatedFieldId vs fieldId are not merged", () => {
  // The two names mean different things in this codebase and the schema keeps
  // them apart rather than normalising them into one "field" concept.
  const point = buildWaterControlPoint({ id: "wcp-1", type: "gate", lat: 34.6, lon: 135.8, relatedFieldId: "paddy-001" });
  const observation = buildFieldObservation({ id: "obs-1", type: "weed", lat: 34.6, lon: 135.8, fieldId: "paddy-002" });
  assert.equal(waterControlPointToCloudRow(point).legacy_field_id, "paddy-001");
  assert.equal(observationToCloudRow(observation).legacy_field_id, "paddy-002");
  assert.deepEqual(cloudRowToLocalRecord(waterControlPointToCloudRow(point)).coordinates, [34.6, 135.8]);
});

test("the exported water-point type string is preserved, not re-derived", () => {
  const point = buildWaterControlPoint({ id: "wcp-1", type: "outlet", lat: 34.6, lon: 135.8 });
  assert.equal(waterControlPointToCloudRow(point).point_type, "water_outlet");
});

test("a row with no usable record is skipped rather than half-rebuilt", () => {
  // A field reconstructed from columns alone would render as an empty polygon
  // and silently lose the farmer's walk.
  assert.equal(cloudRowToLocalRecord({ record: null }), null);
  assert.equal(cloudRowToLocalRecord({ record: {} }), null);
  assert.equal(cloudRowToLocalRecord(undefined), null);
});

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

test("a paddy the cloud has never seen is queued for upload", () => {
  const merge = mergeRecords({ localRecords: [field("paddy-001")], cloudRows: [] });
  assert.deepEqual(merge.toUpload.map((f) => f.id), ["paddy-001"]);
  assert.equal(merge.toApply.length, 0);
});

test("a paddy only in the cloud is downloaded, with its cloud id remembered", () => {
  const remote = field("paddy-009", { name: "他端末の田" });
  const merge = mergeRecords({ localRecords: [], cloudRows: [cloudRow(remote)] });
  assert.deepEqual(merge.toApply.map((f) => f.id), ["paddy-009"]);
  assert.equal(merge.cloudIdByLocalId["paddy-009"], "uuid-paddy-009");
});

test("identical copies are neither uploaded nor downloaded", () => {
  // Re-uploading an unchanged record on every launch would burn mobile data.
  const record = field("paddy-001");
  const merge = mergeRecords({ localRecords: [record], cloudRows: [cloudRow(record)] });
  assert.equal(merge.toUpload.length, 0);
  assert.equal(merge.toApply.length, 0);
  assert.deepEqual(merge.inSync.map((f) => f.id), ["paddy-001"]);
});

test("last write wins, compared on the record's own updatedAt", () => {
  const older = field("paddy-001", { name: "旧", updatedAt: "2026-08-01T00:00:00.000Z" });
  const newer = field("paddy-001", { name: "新", updatedAt: "2026-08-02T00:00:00.000Z" });

  const localNewer = mergeRecords({ localRecords: [newer], cloudRows: [cloudRow(older)] });
  assert.deepEqual(localNewer.toUpload.map((f) => f.name), ["新"]);
  assert.equal(localNewer.toApply.length, 0);

  const cloudNewer = mergeRecords({ localRecords: [older], cloudRows: [cloudRow(newer)] });
  assert.deepEqual(cloudNewer.toApply.map((f) => f.name), ["新"]);
  assert.equal(cloudNewer.toUpload.length, 0);
});

test("matching is by the LOCAL id, so one paddy never becomes two rows", () => {
  // A farmer who registers offline on a phone and again on a tablet would
  // otherwise end up with duplicates of the same paddy.
  const local = field("paddy-001", { updatedAt: "2026-08-03T00:00:00.000Z" });
  const remote = { ...cloudRow(field("paddy-001")), id: "uuid-from-other-device" };
  const merge = mergeRecords({ localRecords: [local], cloudRows: [remote] });
  assert.equal(merge.toUpload.length, 1);
  assert.equal(merge.cloudIdByLocalId["paddy-001"], "uuid-from-other-device");
});

test("a broken cloud copy never overwrites a good local one", () => {
  const local = field("paddy-001", { updatedAt: "2026-08-01T00:00:00.000Z" });
  const broken = { ...cloudRow(local, { localUpdatedAt: "2026-09-01T00:00:00.000Z" }), record: null };
  const merge = mergeRecords({ localRecords: [local], cloudRows: [broken] });
  assert.equal(merge.toApply.length, 0);
  assert.deepEqual(merge.toUpload.map((f) => f.id), ["paddy-001"]);
});

test("applyRemoteRecords replaces by id and preserves the existing order", () => {
  // The registered-fields list must not reshuffle under the farmer.
  const a = field("paddy-001", { name: "A" });
  const b = field("paddy-002", { name: "B" });
  const updatedA = field("paddy-001", { name: "A2" });
  const c = field("paddy-003", { name: "C" });
  const merged = applyRemoteRecords([a, b], [updatedA, c]);
  assert.deepEqual(merged.map((f) => f.name), ["A2", "B", "C"]);
});

test("only records this device previously synced are treated as deletions", () => {
  // A row created on another device is "not downloaded yet", not "deleted here".
  const rows = [cloudRow(field("paddy-001")), cloudRow(field("paddy-777"))];
  const toDelete = rowsToDelete({ localRecords: [], cloudRows: rows, knownLocalIds: ["paddy-001"] });
  assert.deepEqual(toDelete.map((row) => row.legacy_field_id), ["paddy-001"]);
});

// ---------------------------------------------------------------------------
// Local -> account import (§17)
// ---------------------------------------------------------------------------

test("only guest paddies the account does not already have are offered", () => {
  const plan = planLocalImport({
    guestRecords: [field("paddy-001"), field("paddy-002")],
    accountRecords: [field("paddy-001")]
  });
  assert.equal(plan.count, 1);
  assert.deepEqual(plan.importable.map((f) => f.id), ["paddy-002"]);
  assert.equal(plan.alreadyOwned, 1);
});

test("nothing is offered when the account already has everything", () => {
  const plan = planLocalImport({ guestRecords: [field("paddy-001")], accountRecords: [field("paddy-001")] });
  assert.equal(plan.count, 0);
});

test("the import prompt counts in Japanese, singular and plural", () => {
  assert.match(localImportPromptText(1), /1件/);
  assert.match(localImportPromptText(3), /3件/);
});

// ---------------------------------------------------------------------------
// Sync bookkeeping + status
// ---------------------------------------------------------------------------

test("corrupt bookkeeping degrades to 'nothing has synced yet' rather than throwing", () => {
  for (const input of [null, undefined, "nonsense", 7, []]) {
    assert.doesNotThrow(() => normalizeSyncMetadata(input));
  }
  assert.deepEqual(normalizeSyncMetadata(null), emptySyncMetadata());
});

test("a record is pending until its exact synced stamp matches", () => {
  const record = field("paddy-001", { updatedAt: "2026-08-01T00:00:00.000Z" });
  let metadata = emptySyncMetadata();
  assert.equal(recordsNeedingUpload(metadata, KIND_FIELD, [record]).length, 1);

  metadata = markSynced(metadata, KIND_FIELD, record, { cloudId: "uuid-1" });
  assert.equal(recordsNeedingUpload(metadata, KIND_FIELD, [record]).length, 0);

  const edited = field("paddy-001", { updatedAt: "2026-08-02T00:00:00.000Z" });
  assert.equal(recordsNeedingUpload(metadata, KIND_FIELD, [edited]).length, 1,
    "an edit made offline must still be detected after a reload");
});

test("the queue survives a reload because it lives in the persisted sidecar", () => {
  let metadata = markPending(emptySyncMetadata(), KIND_FIELD, "paddy-001");
  const roundTripped = normalizeSyncMetadata(JSON.parse(JSON.stringify(metadata)));
  assert.equal(roundTripped.entries["field:paddy-001"].state, "pending");
  metadata = markSyncError(roundTripped, KIND_FIELD, "paddy-001", "boom");
  assert.equal(metadata.entries["field:paddy-001"].state, "error");
});

test("a record with no sidecar entry at all counts as pending", () => {
  // A paddy registered thirty seconds ago has no entry yet. Counting only
  // known entries would show ✓ 同期済み over a paddy that has never left the
  // phone -- the one thing the sync indicator must never claim.
  const brandNew = field("paddy-001");
  assert.equal(recordsNeedingUpload(emptySyncMetadata(), KIND_FIELD, [brandNew]).length, 1);
  const metadata = markSynced(emptySyncMetadata(), KIND_FIELD, brandNew, { cloudId: "u" });
  assert.equal(recordsNeedingUpload(metadata, KIND_FIELD, [brandNew]).length, 0);
  assert.equal(recordsNeedingUpload(metadata, KIND_FIELD, [brandNew, field("paddy-002")]).length, 1);
});

test("the status chip has exactly the states the brief asks for", () => {
  assert.equal(summarizeSyncStatus({ authenticated: false }).status, SYNC_STATUS_OFF);
  assert.equal(summarizeSyncStatus({ authenticated: true, pendingCount: 0 }).status, SYNC_STATUS_SYNCED);
  assert.equal(summarizeSyncStatus({ authenticated: true, pendingCount: 2 }).status, SYNC_STATUS_PENDING);
  assert.equal(summarizeSyncStatus({ authenticated: true, online: false }).status, SYNC_STATUS_OFFLINE);
  assert.equal(summarizeSyncStatus({ authenticated: true, lastError: new Error("x") }).status, SYNC_STATUS_ERROR);
});

test("a guest sees no sync indicator at all", () => {
  const status = summarizeSyncStatus({ authenticated: false, pendingCount: 5 });
  assert.equal(status.icon, "");
  assert.equal(status.text, "");
});

test("the three status glyphs match the brief's ✓ / ⟳ / !", () => {
  assert.equal(summarizeSyncStatus({ authenticated: true }).icon, "✓");
  assert.equal(summarizeSyncStatus({ authenticated: true, pendingCount: 1 }).icon, "⟳");
  assert.equal(summarizeSyncStatus({ authenticated: true, lastError: new Error("x") }).icon, "!");
});
