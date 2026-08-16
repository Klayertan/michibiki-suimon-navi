// Lazy loader for the Supabase JS SDK.
//
// The SDK is a dynamic `import()` rather than a <script> tag in index.html
// for one reason that matters in a paddy: a farmer who never signs in, or
// whose phone has no signal, must not pay for downloading an auth SDK before
// the map appears. Nothing here runs until the app has actually decided that
// a Supabase project is configured AND the account surface is needed.
//
// Failure is normal and non-fatal. A CDN blocked by a corporate proxy, an
// offline phone, or a typo'd `sdkUrl` all resolve to "cloud unavailable",
// which the app already knows how to render — guest/local mode, unchanged.

import { DEFAULT_SUPABASE_SDK_URL } from "./cloud-config.js";

let sdkPromise = null;
let clientPromise = null;

/** Resets the memoized SDK/client. Only used by tests. */
export function resetSupabaseClient() {
  sdkPromise = null;
  clientPromise = null;
}

export async function loadSupabaseSdk(sdkUrl = DEFAULT_SUPABASE_SDK_URL) {
  if (!sdkPromise) {
    sdkPromise = import(/* @vite-ignore */ sdkUrl).catch((error) => {
      // Clear the memo so a later retry (e.g. once signal returns) can work.
      sdkPromise = null;
      throw error;
    });
  }
  return sdkPromise;
}

/**
 * Builds the single shared Supabase client.
 *
 * `persistSession` + `autoRefreshToken` are what make an offline-authenticated
 * state possible at all: the SDK restores the session from localStorage with
 * no network call, so a signed-in farmer who loses signal keeps their identity
 * — and therefore their user-scoped local cache — instead of being dropped
 * back to a login screen.
 *
 * `detectSessionInUrl` + `flowType: "pkce"` handle the redirect back from an
 * email-confirmation or password-recovery link. PKCE is the correct flow for
 * a public client with no secret, which is exactly what a GitHub Pages site is.
 */
export async function createSupabaseClient({ url, anonKey, sdkUrl = DEFAULT_SUPABASE_SDK_URL }) {
  if (!clientPromise) {
    clientPromise = loadSupabaseSdk(sdkUrl)
      .then(({ createClient }) => createClient(url, anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          flowType: "pkce",
          storageKey: "suimonNaviSupabaseAuthV1"
        },
        global: {
          headers: { "x-application-name": "suisui-navi" }
        }
      }))
      .catch((error) => {
        clientPromise = null;
        throw error;
      });
  }
  return clientPromise;
}
