// Per-user namespacing for the existing localStorage repositories.
//
// THE PROBLEM (brief §23): two farmers can share one phone or one shared
// office browser. If User B logs in after User A logs out, User B must not
// find User A's paddies sitting in localStorage.
//
// THE SOLUTION (option A in the brief): the local repository stays exactly
// where it is for guests, and every signed-in user gets their own namespace
// derived from their user id. `ScopedStorage` is a drop-in `Storage`-shaped
// object, which is all `FieldAnnotationController` ever needed —
// `options.storage` was already an injection point.
//
//   guest        suimonNaviFieldAnnotationsV2
//   user abc123  suimonNaviFieldAnnotationsV2::u:abc123
//
// Consequences that are deliberate:
//   - Guest data is byte-identical to today. A farmer who never signs in sees
//     no behavioral change at all, and their data is not moved, copied, or
//     renamed by the mere presence of this module.
//   - Logging out does not delete anything (brief §22). It re-points reads at
//     the guest namespace; the signed-out user's cache stays on disk under
//     their own key so the next login on this device is instant and offline-
//     capable. `clearScope()` exists for an explicit "この端末から消す".
//   - A user id is never a display name or an email — see `scopeKeyFor()`.
//
// Pure except for the injected storage object, so it unit-tests against a
// plain Map-backed fake.

export const SCOPE_SEPARATOR = "::u:";

/** Every key this app namespaces. Anything not listed stays global by design. */
export const SCOPED_STORAGE_KEYS = [
  // The whole field domain: fields, boundary tracks, water-control points,
  // survey sessions, field observations, workflow state.
  "suimonNaviFieldAnnotationsV2",
  // Per-field target water level (基本モード water card).
  "suimonNaviTargetWaterLevelV1",
  // Per-field growth stage (生育ステージ) driving the water recommendation.
  // New key, so namespacing it costs nothing: there is no pre-existing
  // unprefixed value for a signed-in farmer to lose. (The older
  // suimonNaviCurrentWaterLevelV1 readings store is deliberately NOT added
  // here — it already has unprefixed values on real installs, and listing it
  // now would make those readings unreachable for a signed-in user without a
  // migration step. See docs/PADDY_WATER_MANAGEMENT.md.)
  "suimonNaviFieldGrowthStageV1",
  // QZ1 floating-sensor registry: device ids and which paddy each one is
  // assigned to. New key, so namespacing it costs nothing -- there is no
  // pre-existing unprefixed value for a signed-in farmer to lose. It holds
  // field IDs, never field geometry; the boundaries stay in
  // suimonNaviFieldAnnotationsV2, which remains the only field store.
  "suimonNaviFloatingSensorsV1",
  // Cloud sync bookkeeping (cloud ids, last-synced stamps, pending queue).
  "suimonNaviCloudSyncV1"
];

/**
 * The namespace suffix for a user id.
 *
 * Uses the provider's opaque user id (a UUID for Supabase), never an email or
 * a display name: an email can be changed and is personal data we have no
 * reason to write into a storage key, and a display name is not unique.
 */
export function scopeKeyFor(baseKey, userId) {
  const id = String(userId ?? "").trim();
  if (!id) {
    return baseKey;
  }
  return `${baseKey}${SCOPE_SEPARATOR}${id}`;
}

/** True for a key that belongs to some user's namespace (any user). */
export function isScopedKey(key) {
  return typeof key === "string" && key.includes(SCOPE_SEPARATOR);
}

/**
 * A `Storage`-shaped view whose scope can be re-pointed at runtime.
 *
 * `setUserId(null)` returns to the guest namespace. Callers must re-hydrate
 * whatever repository is reading through it after a scope change — this
 * object cannot know about the caller's in-memory copy.
 */
export class ScopedStorage {
  constructor(backing, { userId = null, keys = SCOPED_STORAGE_KEYS } = {}) {
    this.backing = backing || null;
    this.userId = userId ? String(userId) : null;
    this.keys = new Set(keys);
  }

  /** Returns true when the scope actually changed, so callers can skip a needless rehydrate. */
  setUserId(userId) {
    const next = userId ? String(userId) : null;
    if (next === this.userId) {
      return false;
    }
    this.userId = next;
    return true;
  }

  /** The physical key a logical key maps to under the current scope. */
  resolve(key) {
    return this.keys.has(key) ? scopeKeyFor(key, this.userId) : key;
  }

  getItem(key) {
    return this.backing ? this.backing.getItem(this.resolve(key)) : null;
  }

  setItem(key, value) {
    if (this.backing) {
      this.backing.setItem(this.resolve(key), value);
    }
  }

  removeItem(key) {
    if (this.backing) {
      this.backing.removeItem(this.resolve(key));
    }
  }
}

/** Reads one logical key out of a specific scope, whatever the current scope is. */
export function readScoped(backing, key, userId) {
  if (!backing) {
    return null;
  }
  return backing.getItem(scopeKeyFor(key, userId));
}

/** Writes one logical key into a specific scope, whatever the current scope is. */
export function writeScoped(backing, key, userId, value) {
  if (!backing) {
    return;
  }
  backing.setItem(scopeKeyFor(key, userId), value);
}

/**
 * Deletes every namespaced key for one user.
 *
 * NOT called on logout — see the module comment. This is the explicit
 * "remove this account's data from this device" action.
 */
export function clearScope(backing, userId, keys = SCOPED_STORAGE_KEYS) {
  if (!backing || !userId) {
    return 0;
  }
  let removed = 0;
  keys.forEach((key) => {
    const scoped = scopeKeyFor(key, userId);
    if (backing.getItem(scoped) !== null) {
      backing.removeItem(scoped);
      removed += 1;
    }
  });
  return removed;
}

/**
 * True when a scope holds no field data yet — the signal that a first sign-in
 * on this device should offer to import the guest-mode paddies (brief §17).
 */
export function scopeHasFields(backing, userId, key = "suimonNaviFieldAnnotationsV2") {
  const raw = readScoped(backing, key, userId);
  if (!raw) {
    return false;
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.fields) && parsed.fields.length > 0;
  } catch {
    return false;
  }
}
