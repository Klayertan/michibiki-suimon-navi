# Auth Architecture (Sakura Cloud Backend)

How `cloud_backend/` authenticates a farmer, keeps them signed in, and keeps
one farmer's data invisible to every other farmer — with no database-level
Row Level Security, since that was specifically a Supabase/Postgres
mechanism (`auth.uid()`) tied to Supabase's hosted auth+PostgREST layer.

See also: [SAKURA_CLOUD_BACKEND.md](SAKURA_CLOUD_BACKEND.md) (overall
architecture, schema, verification tiers) and
[SAKURA_CLOUD_DEPLOYMENT.md](SAKURA_CLOUD_DEPLOYMENT.md) (VM setup, secrets).

---

## 1. Passwords

Argon2id via `argon2-cffi`'s `PasswordHasher()`, using the library's own
current recommended parameters (`app/security.py`) — deliberately not
hand-tuned. A single Sakura Cloud VM should not be guessing at KDF cost
parameters; the library's defaults already target "expensive enough for an
attacker, fast enough for one login request," and `needs_rehash()` transparently
upgrades a stored hash the next time its owner logs in if the library's
recommended parameters change in a future version.

Minimum length: 8 characters, enforced twice — once cheaply in the Pydantic
schema (`RegisterRequest`'s validator, before a password ever reaches
Argon2) and again against `Settings.min_password_length` in the service
layer (the authoritative check). No password is ever logged, stored
plaintext, or included in any error response.

No homemade cryptography anywhere in this file or `security.py` — hashing is
Argon2id, every random token (`secrets.token_urlsafe`) is a CSPRNG value,
and the only custom "crypto" is a SHA-256 lookup hash for sessions (§2),
which protects nothing on its own — see that section for why that is fine.

## 2. Sessions

**Opaque, server-side sessions — not JWTs.** `POST /api/auth/login` (or
`/register`) mints a random 32-byte token (`secrets.token_urlsafe(32)`),
sends it to the browser as an `HttpOnly` cookie, and stores only its
SHA-256 hash server-side, in the `sessions` table. A stolen database backup
therefore cannot be replayed as a live session — the hash is one-way, and
SHA-256 (not a slow KDF) is the right choice here specifically *because*
this is a lookup key for an already-high-entropy random token, not a
password; there is nothing for a slow hash to protect against, and a fast
hash keeps every authenticated request cheap.

**Why not a JWT:** a signed JWT stays valid until it expires no matter what
the server does — there is no way to revoke one early short of maintaining
a denylist, which is just a session table by another name. An opaque
server-side session makes "sign out" and "sign out everywhere" actually
work: `POST /api/auth/logout` sets `sessions.revoked_at`, and
`resolve_session()` checks that column on every authenticated request.

Every authenticated request calls `get_current_user()` (`app/dependencies.py`),
which reads the session cookie, looks up its hash, and rejects
(401) if the row is missing, `revoked_at` is set, or `expires_at` has
passed. `session_ttl_days` (default 30) controls how long a session lives
before it needs a fresh login.

**Do NOT store long-lived auth tokens in localStorage** — this is why the
session token lives only in an `HttpOnly` cookie the browser manages
automatically, invisible to and unreachable by JavaScript, rather than in
`localStorage` where an XSS bug could exfiltrate it directly.

## 3. CSRF — the double-submit cookie pattern

An `HttpOnly` session cookie alone is not enough: a malicious page can still
make the browser attach it automatically to a forged cross-site `fetch()`
or form POST (that's what cookies do). The defense is a **second**,
**readable** cookie (`suisui_csrf`, set alongside the session cookie at
login/register) that the frontend adapter reads via `document.cookie` and
echoes back as the `X-Suisui-Csrf` request header on every state-changing
call (`js/auth/sakura-auth-client.js`'s `getCsrfToken()`,
`js/cloud/sakura-cloud-store.js`'s `request()`).

`require_csrf()` (`app/dependencies.py`) checks that header against the
session's stored `csrf_token` using `secrets.compare_digest` (constant-time,
so response timing can't leak a partial match). A cross-site attacker's page
can make the session cookie ride along on a forged request, but it **cannot
read** the CSRF cookie's value first (blocked by the Same-Origin Policy) to
also send a matching header — so it cannot construct a request this check
accepts.

Applied to every state-changing route (`POST`/`PUT`/`DELETE`-equivalent);
plain `GET` reads are exempt, since there is nothing for a forged `GET` to
change.

## 4. Cookie domain and SameSite

`SUISUI_CLOUD_SESSION_COOKIE_DOMAIN` defaults to **empty** (`app/config.py`)
— a host-only cookie, valid for exactly the responding host and no other.
This is deliberate and was corrected mid-implementation after an end-to-end
test caught the alternative failing (see
[SAKURA_CLOUD_BACKEND.md](SAKURA_CLOUD_BACKEND.md) §10.3): an httpx-based
integration client with a non-matching host was — correctly — refused the
cookie by the HTTP client's own cookie-jar logic, exactly as a real browser
would refuse a `Set-Cookie: Domain=.suisuinavi.sakura.ne.jp` response from a
server whose own host isn't a subdomain of that domain. A non-empty default
here would have silently broken session cookies on every non-production
topology: local `uvicorn` dev, the Docker Compose integration environment
(Phase 15), and this project's own test suite.

**Production** sets it explicitly:
`SUISUI_CLOUD_SESSION_COOKIE_DOMAIN=.suisuinavi.sakura.ne.jp` (see
[SAKURA_CLOUD_DEPLOYMENT.md](SAKURA_CLOUD_DEPLOYMENT.md)'s environment
variable table), so the cookie is shared between the frontend host
(`suisuinavi.sakura.ne.jp`) and the API host
(`api.suisuinavi.sakura.ne.jp`) as same-site siblings.

**Open question, honestly flagged:** whether `sakura.ne.jp` is itself
registered on the [Public Suffix List](https://publicsuffix.org/) affects
whether `.suisuinavi.sakura.ne.jp` (four labels) is accepted as a cookie
domain by strict browsers — a PSL-registered suffix means
`suisuinavi.sakura.ne.jp` is the effective "site," and a cookie scoped one
level above a farmer's own registrable domain is exactly what the PSL
mechanism exists to reject (it's the same rule that stops a cookie being
set for all of `.com`). This was **not verified against the real PSL
entry** in this task, since that requires checking Mozilla's actual public
suffix data for `sakura.ne.jp` — not something to assert without looking it
up. If the cookie is silently rejected in production despite matching the
config here, this is the first thing to check; the fallback is
`SUISUI_CLOUD_SESSION_COOKIE_SAMESITE=none` with `apiBaseUrl` and the
frontend origin kept as *separate* same-site-incompatible hosts each
carrying their own cookie, which changes the architecture (no shared
cookie) and would need its own follow-up design pass — not attempted here
since it wasn't yet known to be necessary.

`SameSite=Lax` is the default (`session_cookie_samesite`) — sent on
same-site requests and top-level cross-site navigations, not on cross-site
`fetch()`/XHR subresource requests. This is why local development needs the
frontend and API addressed via the **same hostname** (both `127.0.0.1`, not
one on `localhost` and the other on `127.0.0.1`) — see
[SAKURA_CLOUD_BACKEND.md](SAKURA_CLOUD_BACKEND.md) §8's cookie note, verified
directly against a real browser this session.

## 5. Rate limiting

`app/security.py`'s `RateLimiter` is a fixed-window, **in-memory,
per-process** limiter — explicitly not distributed. That is the correct
tradeoff for "one Sakura Cloud VM, one Uvicorn worker" (see
[SAKURA_CLOUD_BACKEND.md](SAKURA_CLOUD_BACKEND.md)'s Dockerfile comment on
why exactly one worker is required) — scaling to more than one API instance
would need a shared store (Redis) instead, which this deployment does not
have and should not pretend to.

Login and registration each have **two independent buckets**: one keyed by
client IP, one keyed by the submitted email (lowercased). Both must pass for
the request to proceed — this stops a credential-stuffing run against one
address from hiding behind many IPs rotating through NAT, and separately
stops a single IP from brute-forcing many different addresses, without
either bucket alone being sufficient. Defaults: 10 login attempts / 5
minutes, 5 registration attempts / hour per bucket
(`Settings.login_rate_limit_*`, `register_rate_limit_*` — overridable via
env, see `.env.example`).

Exceeding either bucket returns `429 {"detail": "too many attempts"}` —
checked **before** password verification, so even a *correct* password is
rejected once the bucket is exhausted (verified in
`tests/test_rate_limiting.py`).

## 6. Error disclosure

**Login never discloses whether an account exists.** `authenticate()`
(`app/auth/service.py`) raises the identical `InvalidCredentials` exception
whether the email doesn't exist or the password is wrong, and
`auth/router.py`'s `login()` turns both into the exact same
`401 {"detail": "invalid email or password"}` — byte-identical response
bodies, asserted in `tests/test_auth.py`.

**Registration is the one deliberate exception.** A duplicate signup
returns `409 {"detail": "email already registered"}`, not a generic error —
because the existing frontend's `js/auth/auth-errors.js` already shows
「このメールアドレスは既に登録されています」 on signup and expects to be able to
tell a farmer to log in instead. Phase 5's "do not disclose account
existence" is about *login*, where it protects against account
enumeration; a signup flow that can't tell a farmer their own address is
already registered is a worse farmer experience for a negligible security
gain (a signup form is already an oracle for "is this email taken" in most
real-world UX, Supabase's own default included).

**Production never returns a stack trace.** `app/main.py`'s global
exception handler logs full detail server-side (with a timestamp an
operator can correlate against a support report) and returns a generic
`{"detail": "internal server error"}` to the client for anything
unexpected — verified in `tests/test_security.py` alongside the CORS,
CSRF, oversized-body, and malformed-JSON cases.

## 7. Email verification and password reset

`app/email/sender.py` exists as a delivery **abstraction** — 
`send_email`/`send_verification_email`/`send_password_reset_email` and an
`EmailNotConfigured` exception — but is **not wired into `auth/service.py`'s
register flow** in this task. `Settings.require_email_verification` defaults
to `false`: an account is usable immediately after registration, with
`email_verified=false` recorded but not enforced.

This is explicit, documented configuration, not a fake success: `sender.py`
raises `EmailNotConfigured` rather than silently pretending to have sent
mail when no SMTP host is set. Flipping
`SUISUI_CLOUD_REQUIRE_EMAIL_VERIFICATION=true` without first configuring
SMTP (`SUISUI_CLOUD_SMTP_*` — see `.env.example`) would create accounts
nobody could ever verify, locking them out permanently; the
`.env.example` comment says so directly.

**Not built in this task:** the actual verification-link/reset-link
generation, storage (hashed, one-time-use, expiring — the tokens table this
would need does not exist yet), the email templates, or any frontend UI for
either flow. This is Phase 6's explicitly scoped-down deliverable — "design
properly, don't block first deployment on mail delivery" — and is scoped
work for later, not a gap discovered by accident.

## 8. Multi-user isolation

No database-level RLS (see [SAKURA_CLOUD_BACKEND.md](SAKURA_CLOUD_BACKEND.md)
§4 for why). The boundary instead:

1. **`owner_id` is never accepted from a request body.** Every
   `*Upsert` Pydantic schema in `app/models/schemas.py` simply has no
   `owner_id` field — pydantic v2's default `extra="ignore"` behavior means
   a client that sends one anyway has it silently dropped before the route
   handler ever sees it (`tests/test_multi_user_isolation.py`'s
   `*_browser_supplied_owner_id_is_ignored` tests exercise exactly this: a
   payload naming another farmer's real user id, submitted by a different
   authenticated farmer, still lands owned by the actual submitter).
2. **Every read is filtered by `owner_id == current_user.id`**, derived
   solely from the resolved session (§2) — never from anything
   client-supplied. `GET /api/fields/{id}` for another owner's row returns
   `404`, not `403` — confirming "this id exists but isn't yours" is
   exactly the information leak a 403 would create; a row belonging to
   another owner must look identical to a row that does not exist at all
   (mirrors the reasoning `supabase/migrations/001_accounts_fields.sql`'s
   RLS policies already used).
3. **Every upsert re-checks ownership even when an `id` is supplied** — the
   `ON CONFLICT DO UPDATE` path alone would not stop a crafted `id`
   belonging to another owner from being silently adopted; `app/api/fields.py`
   (and the water-point/observation equivalents) explicitly re-queries
   `WHERE id = :id AND owner_id = :caller` first and 404s if that fails,
   before ever reaching the database's conflict-resolution logic.
4. **Per-owner uniqueness, not global uniqueness**, on every legacy id
   column (`UniqueConstraint("owner_id", "legacy_field_id", ...)` etc.) —
   two farmers can both register a field they call `paddy-001` locally
   without colliding, verified directly in
   `tests/test_multi_user_isolation.py`'s `*_legacy_id_uniqueness_is_scoped_per_owner`
   tests and, for the composite-PK `field_water_targets` table, its own
   dedicated test.
5. **A delete by the wrong owner is a silent no-op**, not an error — the
   `DELETE ... WHERE id IN (:ids) AND owner_id = :caller` query simply
   matches zero rows for a foreign id, returning `204` either way. This was
   a deliberate choice to avoid a delete-by-id endpoint becoming an oracle
   for "does this id exist" the same way a 403 would.

This mirrors what `supabase/tests/rls_verification.sql` verified at the
database level for the Supabase-era schema — the same five properties,
enforced one layer up and exercised by
`cloud_backend/tests/test_multi_user_isolation.py` instead of SQL.

## 9. CORS and transport security

`app/main.py`'s `CORSMiddleware` uses an explicit origin allow-list
(`Settings.allowed_origins`, comma-separated env var) — **never** a
wildcard, and FastAPI itself refuses `allow_origins=["*"]` together with
`allow_credentials=True` at the framework level, so this is enforced twice.
A security-headers middleware adds `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and (production
only) `Strict-Transport-Security`. A body-size-limit middleware rejects
anything over `Settings.max_request_body_bytes` (default 1 MB) with `413`
before it is ever parsed. Interactive API docs (`/docs`, `/openapi.json`)
are disabled outright in production.

## 10. Frontend integration contract

`js/auth/sakura-auth-client.js` and `js/cloud/sakura-cloud-store.js`
implement the exact same `AuthClient`/`CloudStore` contract the existing
`SupabaseAuthClient`/`SupabaseCloudStore` and `MockAuthClient`/`MockCloudStore`
already do (`init()`/`signUp()`/`signIn()`/`signOut()`/`getSession()`/
`getUser()`/`getAccessToken()`/`onAuthStateChange()`, and the per-resource
list/upsert/delete methods) — see `js/auth/auth-controller.js`'s
`initProvider()`, which now branches on `PROVIDER_MOCK` /
`PROVIDER_SAKURA` / (else, Supabase). `getAccessToken()` always returns
`null` for the Sakura provider (there is no bearer token — see §2); it
exists only to satisfy the shared contract.

**Offline identity cache.** Unlike the Supabase SDK, which caches a signed
session (with its own expiry) in `localStorage` and can answer "who is
signed in" with zero network calls, this adapter has nothing to read
locally except the (invisible, `HttpOnly`) session cookie itself —
`init()` normally has to ask the server via `GET /api/auth/me`. Taken
literally, that would make a previously-signed-in farmer look signed out
the instant they lose signal in a paddy — exactly backwards for this
app's core "works offline in a field" requirement (`js/auth/auth-state.js`'s
`AUTH_OFFLINE_AUTHENTICATED` state exists precisely to avoid this for the
Supabase case, where a cached-but-unreachable session is not treated as
signed out). So `sakura-auth-client.js` keeps one small, **non-secret**
cache in `localStorage` (`suimonNaviSakuraIdentityV1`): the last-known
`{id, email, displayName}` — never a token, never anything that grants
access on its own; it only exists to pick the right per-user local-data
namespace (`js/cloud/user-scope.js`) and label the account menu while
offline. It updates on every successful `init()`/`signIn()`/`signUp()`, and
is cleared on an explicit `signOut()` or a `401` from `/api/auth/me` (which
genuinely means "not signed in," as opposed to a network failure, which
falls back to the cache). A network failure during `init()` with no cache
present still propagates as an error, degrading the whole app to
`AUTH_UNAVAILABLE` — the same graceful-degradation path the Supabase
adapter already uses when its SDK can't be fetched at all.

**Known, accepted limitation:** unlike Supabase's SDK, this adapter has no
push channel for server-initiated session changes (a revocation from
another device, an expiring token). A Sakura-authenticated session change
is only detected on the next explicit action (login, logout) or the next
page load's `init()` call — there is no polling. This was a deliberate
scope decision (Phase 9 did not ask for realtime revocation detection) and
is not a regression from a capability the app relied on before.

## 11. Registration cap

For a presentation to judges: at most `Settings.max_registered_users`
total accounts, and registration can be closed with one config flag
afterward — see [SAKURA_CLOUD_DEPLOYMENT.md](SAKURA_CLOUD_DEPLOYMENT.md)
"Presentation workflow" for the exact before/after commands. No invitation
codes, no separate admin/service-account class — every row in `users`
counts toward the cap, including whichever account the presenter registers
for themself.

**Two independent settings** (`app/config.py`):
- `registration_open` (bool, default `true`) — an on/off switch, independent of the cap.
- `max_registered_users` (int or unset, default unset = no cap) — evaluated only when set.

Registration is rejected (before the duplicate-email check, before hashing
anything) if `registration_open` is `false`, **or** the current row count in
`users` is already `>= max_registered_users`. Both cases return the
identical response — `403 {"detail": "現在、新しいアカウントの登録を受け付けていません。"}`
— a visitor is never told which reason applies, and the remaining slot
count is never disclosed anywhere in the API response. **Existing users can
always still log in** — neither setting is consulted anywhere in the login
path (`authenticate()`/`POST /api/auth/login` is entirely separate code from
`register_user()`).

**Fail closed on missing production config.** `app/main.py`'s startup check
(the same pattern already used for `session_secret`) refuses to boot in
production if `max_registered_users` is unset — an operator must set it
explicitly; there is no code path where "forgot to configure this" silently
becomes "unlimited registration in production." `registration_open` does
not need the same treatment — its Pydantic type is a plain `bool`, so a
genuinely malformed value (anything that isn't parseable as true/false)
already fails to boot at all via normal Settings validation, and its
sensible default (`true`) is the same value used before this feature
existed (registration was always open).

### Atomic enforcement — the concurrency problem and its fix

The naive approach —

```python
count = await db.scalar(select(func.count()).select_from(User))
if count < settings.max_registered_users:
    ...create the user...
```

— races: two concurrent requests can both read `count = 9` before either
has committed its insert, and both proceed, producing 11 rows for a cap of
10. `app/auth/service.py`'s `register_user()` wraps the entire
check-then-insert sequence (`_serialize_registration()`) in a critical
section instead:

```
acquire registration lock
  → check registration_open
  → SELECT COUNT(*) FROM users
  → reject if count >= max_registered_users
  → check duplicate email
  → hash password (Argon2id)
  → INSERT user, INSERT profile
  → commit (releases the lock)
```

**PostgreSQL (production): `pg_advisory_xact_lock`.** A transaction-scoped
advisory lock, keyed by a fixed application-chosen constant
(`_REGISTRATION_LOCK_KEY`). A second concurrent registration blocks *inside
the database* at the lock-acquisition call until the first transaction
commits or rolls back, at which point PostgreSQL releases the lock
automatically — so the second request's own `SELECT COUNT(*)`, issued only
after it acquires the lock, is guaranteed (under PostgreSQL's default READ
COMMITTED isolation) to see the first request's already-committed row.
Chosen over the alternatives considered:
- a dedicated lock row + `SELECT ... FOR UPDATE` — works, but needs a new
  table for exactly one lock, which an advisory lock doesn't.
- a unique constraint — can express "at most one row with this value," not
  "at most N rows total."

**No schema change was needed.** The cap is enforced entirely in
`app/auth/service.py`; `users` gained no new column, and no new table was
added.

**SQLite (this test suite's default, local dev without Docker):**
`pg_advisory_xact_lock` does not exist, so `_serialize_registration()`
falls back to a plain in-process `asyncio.Lock` — the same single-process
tradeoff `app/security.py`'s `RateLimiter` already accepts, for the same
underlying reason (no distributed/shared-database coordination primitive
available without adding infrastructure this deployment doesn't have). It
is enough to make the SQLite-backed tests meaningful for the *application-level
orchestration* (the ordering above), but it is **not** what protects a real
multi-connection PostgreSQL deployment.

**Verification tiers — read before trusting this on faith:**
`tests/test_registration_limit_concurrency.py` has two tests. The SQLite
one runs always and was observed passing repeatedly against real concurrent
`asyncio.gather()`'d requests (exactly one of two requests at the 9→10
boundary succeeds; final count is always exactly 10, never 11). The
PostgreSQL one is gated on `SUISUI_CLOUD_TEST_DATABASE_URL` and is
**skipped** in this repository's local development environment (no
PostgreSQL available) — it has not been observed passing anywhere yet; it
runs for real only in CI's `integration` job. See
[SAKURA_CLOUD_BACKEND.md](SAKURA_CLOUD_BACKEND.md) §10 for this project's
verification-tier convention.

## 12. Production login gate

Separate from the registration cap: whether an **unauthenticated visitor**
can use the app at all. Controlled entirely on the frontend by
`config/cloud-config.js`'s `requireAuth` flag (parsed by
`normalizeCloudConfig()` in `js/cloud/cloud-config.js`, `raw.requireAuth
=== true` only — a stray truthy value like the string `"true"` does not
count, and any misconfigured/unconfigured cloud result forces it back to
`false` regardless of what was requested, so a broken config can never
accidentally lock a farmer out of an app that isn't even cloud-configured).

**This is a UX-layer gate, not the real security boundary.** The real
boundary is unchanged: every `cloud_backend/` API route independently
requires a valid session (`get_current_user`/`require_csrf` — see §2/§3),
regardless of what the frontend does or does not render. `requireAuth`
exists so a signed-out visitor never even sees the app's controls, not
because the API would otherwise be reachable without a session — it never
is.

**How the gate works** (`js/auth/auth-state.js`'s `shouldShowLoginScreen()`,
`js/auth/auth-controller.js`): when `requireAuth` is true, the full-screen
login overlay (`#authScreen` — `position: fixed`, viewport-covering,
`z-index: 3000`, already the one thing a signed-out-with-cloud-configured
visitor could interact with even before this feature) is shown
unconditionally for any non-authenticated state, checked **before** the
existing `guestChosen`/`requested` logic — so a `ログインせずに使う` choice
already stored in `localStorage` from **before** `requireAuth` was turned on
cannot bypass it. The guest button, its reassurance note, and the screen's
close button are all hidden (`renderAuthScreen()`), and
`continueAsGuest()` itself refuses to act (returns immediately) as a second
layer, in case anything still calls it (a stray event handler, a console
call). A new `#authLimitedAccessNote` (「現在、このサービスは限定公開中です。」)
shows only on the sign-up form when `requireAuth` is true — no invitation
code, no displayed slot count, just a one-line explanation.

**Verified against a real browser** (Playwright,
`tests/browser/production-login-gate.spec.js`, mock provider, no real
backend needed): an unauthenticated visitor sees only the auth screen with
no guest path; the element under the pointer at the center of the viewport
is confirmed to be the overlay itself, not the map or any Basic-mode
control, behind it; Escape does not fall through to guest access; neither a
hash-route navigation (`/#drone`) nor a full page reload bypasses the gate;
a stored guest choice from before `requireAuth` was enabled is ignored;
signing up shows the limited-access note and reaches the app; logging out
returns to the gate (not to a guest-usable state); and — the negative case
— with `requireAuth: false` (development mode) the guest path is confirmed
completely unaffected. 8/8 passing.

**Development vs. production is just this one flag**, not a separate code
path: `config/cloud-config.js` ships `requireAuth: false` (alongside
`provider: null`) so the currently-live site at
<https://suisuinavi.sakura.ne.jp/> is completely unaffected by this
feature's existence — turning the gate on requires deliberately editing
that file, and doing so only makes sense once `apiBaseUrl` also points at a
real, live Sakura Cloud API (a `requireAuth: true` with no working backend
behind it would lock out every visitor, including the presenter). See
[SAKURA_CLOUD_DEPLOYMENT.md](SAKURA_CLOUD_DEPLOYMENT.md) — "Presentation
workflow."

**Offline behavior is unchanged for an already-authenticated farmer** — see
§10's offline identity cache. `requireAuth` only affects a visitor who has
never signed in on this device at all; someone who signed in previously and
later loses signal still gets `AUTH_OFFLINE_AUTHENTICATED`, their cached
local field data, and no re-login prompt, exactly as before. The one
explicit security-relevant limitation, stated plainly: the cached identity
this falls back to is **not** equivalent to a fresh, server-verified
session — it is a non-secret, non-authenticating label (id/email/display
name only) that exists purely to pick the correct local storage namespace
and render "who is this" while offline; it grants no access to any cloud
API endpoint on its own, since every endpoint re-checks the real session
cookie independently (§2). A device that has never held a valid session
cookie cannot manufacture this cache from nothing (it is written only
inside `init()`/`signIn()`/`signUp()`'s success paths — see §10) — so an
attacker with only local `localStorage` access to a shared device, but
never a valid session, gains nothing from this cache.
