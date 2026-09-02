// Sakura Cloud adapter for the user's cloud-owned records — talks to the
// cloud_backend/ FastAPI service (see docs/SAKURA_CLOUD_BACKEND.md) instead
// of Supabase/PostgREST. Same contract as SupabaseCloudStore/MockCloudStore,
// so field-sync-service.js never knows which one it holds.
//
// The JSON keys returned by every cloud_backend endpoint (legacy_field_id,
// area_m2, local_updated_at, …) were deliberately chosen to match what
// SupabaseCloudStore already got back from PostgREST byte-for-byte (see
// cloud_backend/app/models/schemas.py's module docstring) — so this file
// needs no row-shape translation at all, only a different transport.
//
// SECURITY NOTE, mirroring supabase-cloud-store.js: this file never sends
// `owner_id`. The server derives ownership exclusively from the
// authenticated session (see cloud_backend/app/api/fields.py's module
// docstring) — there is no payload shape from this file that can claim
// another farmer's rows, the same guarantee RLS gave the Supabase adapter,
// just enforced in the API layer instead of the database layer (there is no
// per-request database role to enforce it at that layer here — see
// docs/AUTH_ARCHITECTURE.md's "Multi-user isolation").
//
// Every state-changing call needs the CSRF header; `getCsrfToken` is read on
// EVERY call rather than captured once, exactly like MockCloudStore already
// does for getAccessToken — the token rotates with the session, so a stale
// captured copy would eventually stop matching.

function unwrapError(status, data) {
  const detail = data?.detail;
  const message = typeof detail === "string" ? detail : `request failed with status ${status}`;
  const error = new Error(message);
  error.status = status;
  error.detail = detail;
  return error;
}

export class SakuraCloudStore {
  constructor({ apiBaseUrl, getCsrfToken, csrfHeaderName = "x-suisui-csrf" } = {}) {
    this.apiBaseUrl = String(apiBaseUrl || "").replace(/\/+$/, "");
    this.getCsrfToken = getCsrfToken || (() => null);
    this.csrfHeaderName = csrfHeaderName;
  }

  async request(method, path, body) {
    const headers = {};
    let payload;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    if (method !== "GET") {
      const csrf = this.getCsrfToken();
      if (csrf) {
        headers[this.csrfHeaderName] = csrf;
      }
    }
    let response;
    try {
      response = await fetch(`${this.apiBaseUrl}${path}`, {
        method,
        credentials: "include",
        headers,
        body: payload
      });
    } catch (cause) {
      const error = new Error("network request failed");
      error.name = "NetworkError";
      error.cause = cause;
      throw error;
    }
    if (response.status === 204) {
      return null;
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      throw unwrapError(response.status, data);
    }
    return data;
  }

  // -- fields ------------------------------------------------------------------

  async listFields() {
    return (await this.request("GET", "/api/fields")) || [];
  }

  async upsertFields(rows) {
    return (await this.request("POST", "/api/fields", rows)) || [];
  }

  async deleteFields(cloudIds) {
    await this.request("POST", "/api/fields/delete", { ids: cloudIds });
  }

  /** Direct id read. Not-found-or-not-yours resolves to null, matching the
   * RLS `.maybeSingle()` semantics SupabaseCloudStore relies on — the
   * server returns 404 rather than 403 specifically so this stays true. */
  async fetchFieldById(cloudId) {
    try {
      return await this.request("GET", `/api/fields/${encodeURIComponent(cloudId)}`);
    } catch (error) {
      if (error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  // -- water-control points -----------------------------------------------------

  async listWaterControlPoints() {
    return (await this.request("GET", "/api/water-control-points")) || [];
  }

  async upsertWaterControlPoints(rows) {
    return (await this.request("POST", "/api/water-control-points", rows)) || [];
  }

  async deleteWaterControlPoints(cloudIds) {
    await this.request("POST", "/api/water-control-points/delete", { ids: cloudIds });
  }

  // -- field observations ---------------------------------------------------------

  async listObservations() {
    return (await this.request("GET", "/api/field-observations")) || [];
  }

  async upsertObservations(rows) {
    return (await this.request("POST", "/api/field-observations", rows)) || [];
  }

  async deleteObservations(cloudIds) {
    await this.request("POST", "/api/field-observations/delete", { ids: cloudIds });
  }

  // -- per-field target water level -----------------------------------------------

  async listWaterTargets() {
    return (await this.request("GET", "/api/field-water-targets")) || [];
  }

  async upsertWaterTargets(rows) {
    await this.request("POST", "/api/field-water-targets", rows);
  }

  // -- profile ------------------------------------------------------------------

  async upsertProfile({ displayName }) {
    // user_id is never sent — the server keys the row off the authenticated
    // session (see cloud_backend/app/api/profile.py), the same reasoning
    // supabase-cloud-store.js documents for auth.uid().
    return await this.request("PUT", "/api/profile", { display_name: String(displayName ?? "") });
  }

  async fetchProfile() {
    try {
      return await this.request("GET", "/api/profile");
    } catch (error) {
      if (error.status === 404) {
        return null;
      }
      throw error;
    }
  }
}
