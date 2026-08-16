// Supabase Postgres adapter for the user's cloud-owned records.
//
// Same contract as MockCloudStore, so field-sync-service.js never knows which
// one it holds.
//
// SECURITY NOTE, and the reason this file is deliberately boring: it never
// sends `owner_id`. The column defaults to `auth.uid()` in the database and
// the RLS `WITH CHECK` clause rejects any row whose owner_id is not the
// caller. That means there is no browser-side payload that can claim another
// farmer's ownership — not by editing a request in devtools, not by calling
// these methods from the console. See supabase/migrations/001_accounts_fields.sql.
//
// It also never filters by owner_id in the SELECTs. That is not an oversight:
// adding `.eq("owner_id", …)` would imply the filter is what protects the
// data. RLS is. A read that returned another owner's row would be a database
// misconfiguration, and hiding it behind a client-side filter would hide the
// bug rather than the row.

const CONFLICT_FIELDS = "owner_id,legacy_field_id";
const CONFLICT_POINTS = "owner_id,legacy_point_id";
const CONFLICT_OBSERVATIONS = "owner_id,legacy_observation_id";

function unwrap({ data, error }) {
  if (error) {
    throw error;
  }
  return data || [];
}

export class SupabaseCloudStore {
  constructor({ getClient }) {
    this.getClient = getClient;
  }

  client() {
    const client = this.getClient();
    if (!client) {
      throw new Error("Supabase client is not ready");
    }
    return client;
  }

  // -- fields ----------------------------------------------------------------

  async listFields() {
    return unwrap(await this.client().from("fields").select("*").order("created_at", { ascending: true }));
  }

  async upsertFields(rows) {
    return unwrap(await this.client().from("fields").upsert(rows, { onConflict: CONFLICT_FIELDS }).select());
  }

  async deleteFields(cloudIds) {
    const { error } = await this.client().from("fields").delete().in("id", cloudIds);
    if (error) {
      throw error;
    }
  }

  /** Direct primary-key read. RLS returns nothing for another owner's id. */
  async fetchFieldById(cloudId) {
    const { data, error } = await this.client().from("fields").select("*").eq("id", cloudId).maybeSingle();
    if (error) {
      throw error;
    }
    return data || null;
  }

  // -- water-control points ---------------------------------------------------

  async listWaterControlPoints() {
    return unwrap(await this.client().from("water_control_points").select("*").order("created_at", { ascending: true }));
  }

  async upsertWaterControlPoints(rows) {
    return unwrap(await this.client().from("water_control_points").upsert(rows, { onConflict: CONFLICT_POINTS }).select());
  }

  async deleteWaterControlPoints(cloudIds) {
    const { error } = await this.client().from("water_control_points").delete().in("id", cloudIds);
    if (error) {
      throw error;
    }
  }

  // -- field observations -----------------------------------------------------

  async listObservations() {
    return unwrap(await this.client().from("field_observations").select("*").order("created_at", { ascending: true }));
  }

  async upsertObservations(rows) {
    return unwrap(await this.client().from("field_observations").upsert(rows, { onConflict: CONFLICT_OBSERVATIONS }).select());
  }

  async deleteObservations(cloudIds) {
    const { error } = await this.client().from("field_observations").delete().in("id", cloudIds);
    if (error) {
      throw error;
    }
  }

  // -- per-field target water level -------------------------------------------

  async listWaterTargets() {
    return unwrap(await this.client().from("field_water_targets").select("*"));
  }

  async upsertWaterTargets(rows) {
    const { error } = await this.client()
      .from("field_water_targets")
      .upsert(rows, { onConflict: "owner_id,legacy_field_id" });
    if (error) {
      throw error;
    }
  }

  // -- profile -----------------------------------------------------------------

  async upsertProfile({ displayName }) {
    // user_id also defaults to auth.uid() in the database; sending it would
    // add nothing but a spoofable field.
    const { data, error } = await this.client()
      .from("profiles")
      .upsert({ display_name: String(displayName ?? "") }, { onConflict: "user_id" })
      .select()
      .maybeSingle();
    if (error) {
      throw error;
    }
    return data || null;
  }

  async fetchProfile() {
    const { data, error } = await this.client().from("profiles").select("*").maybeSingle();
    if (error) {
      throw error;
    }
    return data || null;
  }
}
