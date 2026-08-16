// In-memory cloud store that simulates Postgres + Row Level Security.
//
// Only constructed when the config says `provider: "mock"`. Its job is to let
// the multi-user and offline requirements (brief §24, §25, §31) be tested in a
// browser with no external Supabase project — including the part that matters
// most: that authorization is enforced BELOW the UI.
//
// So this is not a permissive fake. It mirrors the policies in
// supabase/migrations/001_accounts_fields.sql:
//
//   - every row carries owner_id
//   - every read is filtered to owner_id = the caller's uid (RLS `USING`)
//   - every write has owner_id forced to the caller's uid, and an explicit
//     mismatched owner_id in the payload is REJECTED (RLS `WITH CHECK`)
//   - fetching a known row id belonging to another owner returns "not found",
//     exactly as RLS does — it does not leak the row's existence
//
// The backing store is a single localStorage key that is deliberately NOT
// user-scoped: it stands in for a shared server that both test users talk to.

const DB_KEY = "suimonNaviMockCloudDbV1";

export class RlsDeniedError extends Error {
  constructor(message = "row-level security policy violation") {
    super(message);
    this.name = "RlsDeniedError";
    this.status = 403;
    this.code = "42501";
  }
}

export class NotAuthenticatedError extends Error {
  constructor(message = "JWT missing or expired") {
    super(message);
    this.name = "NotAuthenticatedError";
    this.status = 401;
  }
}

function emptyDb() {
  return { profiles: [], fields: [], waterControlPoints: [], observations: [], waterTargets: [] };
}

function uuid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `mock-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`;
}

const TABLES = {
  fields: { legacyKey: "legacy_field_id" },
  waterControlPoints: { legacyKey: "legacy_point_id" },
  observations: { legacyKey: "legacy_observation_id" }
};

export class MockCloudStore {
  /**
   * `getAccessToken` is read on EVERY call rather than captured once, so a
   * logout mid-flight cannot leave a store still holding the old identity.
   * The mock token format is `mock-token:<userId>`, matching MockAuthClient.
   */
  constructor({ getAccessToken, storage = typeof localStorage !== "undefined" ? localStorage : null, online = true } = {}) {
    this.getAccessToken = getAccessToken || (() => null);
    this.storage = storage;
    this.online = online !== false;
  }

  setOnline(online) {
    this.online = Boolean(online);
  }

  // -- simulated transport ---------------------------------------------------

  requireOnline() {
    if (!this.online) {
      const error = new Error("Failed to fetch");
      error.name = "NetworkError";
      throw error;
    }
  }

  /** The caller's auth.uid(). Absent/!malformed token = no rows, ever. */
  uid() {
    const token = this.getAccessToken();
    const match = /^mock-token:(.+)$/.exec(String(token ?? ""));
    if (!match) {
      throw new NotAuthenticatedError();
    }
    return match[1];
  }

  read() {
    try {
      const raw = this.storage?.getItem(DB_KEY);
      return raw ? { ...emptyDb(), ...JSON.parse(raw) } : emptyDb();
    } catch {
      return emptyDb();
    }
  }

  write(db) {
    try {
      this.storage?.setItem(DB_KEY, JSON.stringify(db));
    } catch {
      // Quota: the simulated server simply forgets, which surfaces as a sync
      // mismatch rather than a crash.
    }
  }

  // -- generic table operations ---------------------------------------------

  async list(table) {
    this.requireOnline();
    const owner = this.uid();
    // RLS USING clause.
    return this.read()[table].filter((row) => row.owner_id === owner).map((row) => ({ ...row }));
  }

  async upsert(table, rows) {
    this.requireOnline();
    const owner = this.uid();
    const legacyKey = TABLES[table].legacyKey;
    const db = this.read();
    const now = new Date().toISOString();
    const written = [];

    rows.forEach((incoming) => {
      // RLS WITH CHECK: a browser payload naming a different owner is refused
      // outright rather than silently rewritten, so the test for
      // "owner_id cannot be spoofed" observes a real denial.
      if (incoming.owner_id && incoming.owner_id !== owner) {
        throw new RlsDeniedError();
      }
      const legacyId = String(incoming[legacyKey]);
      const existingIndex = db[table].findIndex((row) => row.owner_id === owner && String(row[legacyKey]) === legacyId);
      const row = {
        ...incoming,
        id: incoming.id || (existingIndex >= 0 ? db[table][existingIndex].id : uuid()),
        owner_id: owner,
        created_at: existingIndex >= 0 ? db[table][existingIndex].created_at : now,
        updated_at: now
      };
      if (existingIndex >= 0) {
        db[table][existingIndex] = row;
      } else {
        db[table].push(row);
      }
      written.push({ ...row });
    });

    this.write(db);
    return written;
  }

  async deleteByIds(table, cloudIds) {
    this.requireOnline();
    const owner = this.uid();
    const ids = new Set(cloudIds.map(String));
    const db = this.read();
    // A delete that matches no visible row is a no-op, not an error — the
    // same thing RLS produces when the id belongs to somebody else.
    db[table] = db[table].filter((row) => !(row.owner_id === owner && ids.has(String(row.id))));
    this.write(db);
  }

  /**
   * Direct fetch by primary key. Exists so the security suite can attempt the
   * exact attack the brief names in §4: "User A must not be able to retrieve
   * User B's fields by changing a URL, field ID, request parameter, or
   * JavaScript call." Returns null for another owner's row.
   */
  async fetchById(table, cloudId) {
    this.requireOnline();
    const owner = this.uid();
    const row = this.read()[table].find((candidate) => String(candidate.id) === String(cloudId));
    return row && row.owner_id === owner ? { ...row } : null;
  }

  // -- typed wrappers --------------------------------------------------------

  listFields() { return this.list("fields"); }
  upsertFields(rows) { return this.upsert("fields", rows); }
  deleteFields(ids) { return this.deleteByIds("fields", ids); }

  listWaterControlPoints() { return this.list("waterControlPoints"); }
  upsertWaterControlPoints(rows) { return this.upsert("waterControlPoints", rows); }
  deleteWaterControlPoints(ids) { return this.deleteByIds("waterControlPoints", ids); }

  listObservations() { return this.list("observations"); }
  upsertObservations(rows) { return this.upsert("observations", rows); }
  deleteObservations(ids) { return this.deleteByIds("observations", ids); }

  async listWaterTargets() {
    this.requireOnline();
    const owner = this.uid();
    return this.read().waterTargets.filter((row) => row.owner_id === owner).map((row) => ({ ...row }));
  }

  async upsertWaterTargets(rows) {
    this.requireOnline();
    const owner = this.uid();
    const db = this.read();
    const now = new Date().toISOString();
    rows.forEach((incoming) => {
      if (incoming.owner_id && incoming.owner_id !== owner) {
        throw new RlsDeniedError();
      }
      const index = db.waterTargets.findIndex(
        (row) => row.owner_id === owner && row.legacy_field_id === incoming.legacy_field_id
      );
      const row = { ...incoming, owner_id: owner, updated_at: now };
      if (index >= 0) {
        db.waterTargets[index] = row;
      } else {
        db.waterTargets.push(row);
      }
    });
    this.write(db);
  }

  async upsertProfile({ displayName }) {
    this.requireOnline();
    const owner = this.uid();
    const db = this.read();
    const index = db.profiles.findIndex((row) => row.user_id === owner);
    const row = {
      user_id: owner,
      display_name: String(displayName ?? ""),
      created_at: index >= 0 ? db.profiles[index].created_at : new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    if (index >= 0) {
      db.profiles[index] = row;
    } else {
      db.profiles.push(row);
    }
    this.write(db);
    return row;
  }

  async fetchProfile() {
    this.requireOnline();
    const owner = this.uid();
    return this.read().profiles.find((row) => row.user_id === owner) || null;
  }
}
