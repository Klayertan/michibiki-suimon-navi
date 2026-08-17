# Stage-1 Accounts + Cloud Field Persistence

A farmer can create an account, log in, see only their own registered 田圃,
select one, keep using 基本モード unchanged, log out, and log back in on
another device to recover the same fields.

**The offline app is untouched.** No account is required for anything. With the
configuration this repository ships (`config/cloud-config.js`, empty), there is
no login screen, no account control, and the local storage keys are byte-for-byte
what they were before this change.

Setup: [SUPABASE_SETUP.md](SUPABASE_SETUP.md).
Prior work: [STAGE1_FIELD_WORKFLOW_SIMPLIFICATION.md](STAGE1_FIELD_WORKFLOW_SIMPLIFICATION.md).

---

## 1. Architecture

```
                         ┌──────────────────────────┐
  farmer's actions ─────▶│  Basic Mode (index.html) │
                         └────────────┬─────────────┘
                                      │  (unchanged call sites)
                         ┌────────────▼─────────────┐
                         │ FieldAnnotationController│  domain + local persistence
                         └────────────┬─────────────┘
                                      │  options.storage
                         ┌────────────▼─────────────┐
                         │  ScopedStorage           │  guest → original keys
                         │  js/cloud/user-scope.js  │  signed in → ::u:<uid>
                         └────────────┬─────────────┘
                                      │
                                 localStorage
                                      ▲
                                      │  reads / writes merged records
                         ┌────────────┴─────────────┐
      ✓ ⟳ ! status ◀─────│  FieldSyncService        │  debounced, never blocking
                         └────────────┬─────────────┘
                                      │
                         ┌────────────▼─────────────┐
                         │ SupabaseCloudStore       │ (or MockCloudStore in tests)
                         └────────────┬─────────────┘
                                      │  PostgREST + JWT
                         ┌────────────▼─────────────┐
                         │ Postgres + RLS           │  owner_id = auth.uid()
                         └──────────────────────────┘
```

Two rules shape it:

**The local repository stays the domain boundary.** `FieldAnnotationController`
was not rewritten and `buildField()` was not touched. The account feature
attaches at exactly two seams that already existed: `options.storage` (which is
how per-user namespacing works) and `onFieldsChanged` (which is how the sync
queue learns about a change).

**Cloud sync sits beside the repository, never in front of it.** Nothing in
the field workflow awaits a network call. A registration is written to
localStorage and rendered before the sync service is even told about it.

### Files

**New**

| File | Purpose |
|---|---|
| `config/cloud-config.js` | Committed frontend configuration. Empty in the shipped state. |
| `js/cloud/cloud-config.js` | Config normalisation, redirect-URL derivation, `service_role` guard. Pure. |
| `js/cloud/user-scope.js` | `ScopedStorage` — per-user namespacing of the existing keys. |
| `js/cloud/field-sync-core.js` | Record↔row mapping, merge rules, import planning, status. Pure. |
| `js/cloud/field-sync-service.js` | Orchestration: queue, debounce, two-way sync, status events. |
| `js/cloud/supabase-client.js` | Lazy CDN load of the Supabase SDK. |
| `js/cloud/supabase-cloud-store.js` | Postgres adapter. |
| `js/cloud/mock-cloud-store.js` | RLS-simulating in-memory store, for tests. |
| `js/auth/auth-state.js` | State machine + login-screen visibility rules. Pure. |
| `js/auth/auth-errors.js` | Provider errors → Japanese. Pure. |
| `js/auth/auth-controller.js` | All DOM binding for the account surfaces. |
| `js/auth/supabase-auth-client.js` | Supabase Auth adapter. |
| `js/auth/mock-auth-client.js` | In-memory auth provider, for tests. |
| `css/auth.css` | Login screen, account menu, 圃場 tiles, sync chip. |
| `supabase/migrations/001_accounts_fields.sql` | Schema + RLS. |
| `supabase/tests/rls_verification.sql` | Database-level cross-user verification. |
| `tests/unit/cloud-config.test.js` | 12 tests |
| `tests/unit/auth-state.test.js` | 15 tests |
| `tests/unit/auth-errors.test.js` | 8 tests |
| `tests/unit/user-scope.test.js` | 12 tests |
| `tests/unit/field-sync-core.test.js` | 24 tests |
| `tests/browser/auth-cloud-fields.spec.js` | 35 tests |
| `docs/STAGE1_AUTH_CLOUD_FIELDS.md`, `docs/SUPABASE_SETUP.md` | This report and the setup guide |

**Modified**

| File | Change |
|---|---|
| `index.html` | Login screen markup; account control in the header after 使い方; あなたの圃場 card; local-import prompt; 設定 → アカウント panel; `config/cloud-config.js` script tag; `accountScopedStorage`; `storage:` passed to `FieldAnnotationController`; `authController.notifyLocalChange()` in `onFieldsChanged`; target water levels routed through the scoped storage; AuthController mounted in `init()` |
| `js/fields/field-annotation-controller.js` | `hydrateFromStorage()` now calls a new `resetInMemoryState()` first — see §9 |
| `css/stage1-basic.css` | untouched by this work |

---

## 2. Login UX

```
                        水
                   スイスイナビ
               圃場管理をもっと簡単に

    メールアドレス
    [__________________________]

    パスワード
    [__________________________]

    [        ログイン           ]
    ─────────────────────────────
              初めての方
    [     アカウントを作成      ]

           ログインせずに使う

  ログインしなくても、圃場の測量・面積計算・
  水管理はこの端末だけで使えます。
```

One column, Japanese-first, no marketing. `アカウントを作成` switches the same
form into sign-up mode and reveals an optional お名前 field. Inputs are 48px
tall with `font-size: 16px` (below 16px, iOS Safari zooms the viewport on focus
and pushes the submit button off-screen).

### When it appears — and when it must not

`shouldShowLoginScreen()` in `js/auth/auth-state.js`, unit-tested:

| Situation | Screen? |
|---|---|
| Session still being restored (`unknown`) | **No** — this is the flash the brief forbids |
| No cloud configured (`unavailable`) — the shipped state | **No** |
| Signed in, online or offline | **No** |
| Farmer previously chose ログインせずに使う | **No** |
| Farmer asked for it from the account menu | **Yes** |
| Cloud available, nobody has decided yet | **Yes** |
| Last attempt failed | **Yes**, with the error, so it can be retried |

The guest choice is stored in `suimonNaviAuthChoiceV1` and survives reloads.

### Header

```
スイスイナビ                        [? 使い方]  [✓ 同期済み]  [ Kai ▾ ]
```

`? 使い方` is unchanged and still present in every mode. The account control is
added after it and is hidden entirely when no cloud is configured. The menu
holds the email, the status line, 今すぐ同期, and ログアウト — nothing else.

---

## 3. Guest mode

`ログインせずに使う` is a first-class path, not a downgrade. A guest can load
NMEA, pick START/END, build the polygon, read the area, register the field,
manage water points, set a target water level and see 今日の水門判断 — the
entire Stage-1 workflow, on the device, with no network.

Guest data is written to the **original, unprefixed** storage keys. Pinned by a
browser test that registers a field with no cloud configured and asserts the
only field key in localStorage is `suimonNaviFieldAnnotationsV2`.

---

## 4. Database schema

Five tables. Full DDL in `supabase/migrations/001_accounts_fields.sql`.

| Table | Key columns |
|---|---|
| `profiles` | `user_id` (PK, `auth.uid()`), `display_name` |
| `fields` | `id` uuid PK, `owner_id`, `legacy_field_id`, `name`, `area_m2`, `source_nmea_filename`, `boundary` jsonb, `record` jsonb, `local_updated_at`; unique `(owner_id, legacy_field_id)` |
| `water_control_points` | `id` uuid PK, `owner_id`, `field_id`, `legacy_point_id`, `legacy_field_id`, `point_type`, `lat`, `lon`, `record`; unique `(owner_id, legacy_point_id)` |
| `field_observations` | same shape, plus `observation_type`, `severity`; unique `(owner_id, legacy_observation_id)` |
| `field_water_targets` | PK `(owner_id, legacy_field_id)`, `target_water_level_cm` |

### Why `record jsonb`

The brief says preserving the current field structure may matter more than
database elegance, and here it does. `buildField()` produces a record the map
layer, the area calculation, 圃場レポート, the JSON export and roughly a
hundred existing tests all depend on, and the Stage-1 report explicitly pins
"Field record shape — `buildField()` not touched".

So the cloud row carries the local record verbatim and reconstructs from it
alone. The denormalized columns exist so the table is queryable and so a
support question is answerable in the Supabase table editor — they are never
read back. A column drifting out of step with the blob cannot corrupt a paddy
boundary.

### IDs

`id` is a `uuid` from `gen_random_uuid()`. A human-readable name is never a
primary key. The device's own id (`paddy-001`) is kept in `legacy_field_id`,
unique **per owner** — so two farmers can both have a `paddy-001`, and existing
code that expects `paddy-001` keeps working untouched.

### Legacy semantics preserved

- `relatedFieldId` (water points) and `fieldId` (observations) are **not**
  merged into one concept; each maps to its own `legacy_field_id` column and
  the distinction is asserted by a unit test.
- `[lat, lon]` tuples stay in that order. `boundary` is the ring exactly as
  Leaflet holds it.
- The exported type strings (`water_gate`, `water_inlet`, …) are stored as-is
  rather than re-derived; `point_type` is deliberately `text`, not an enum, so
  a new type on the device can never fail an upload.

---

## 5. Security

### The model

1. `owner_id uuid not null default auth.uid()` on every user-owned table.
   **The browser never sends `owner_id`** — `js/cloud/supabase-cloud-store.js`
   omits it from every payload.
2. RLS `enable` **and** `force` on all five tables. `force` matters: without
   it the table owner bypasses the policies.
3. Four policies per table, `to authenticated`, with **both**
   `using (owner_id = auth.uid())` and `with check (owner_id = auth.uid())`.
   `using` decides what can be seen; `with check` decides what can be written.
   A payload naming another farmer is rejected, not silently rewritten.
4. **No policy exists for `anon`.** An unauthenticated request reads nothing.
5. The client deliberately does **not** add `.eq("owner_id", …)` to its
   SELECTs. Adding it would imply the filter is the protection. It is not. If a
   query could return another farmer's row that is a database bug to fix in the
   migration, not to hide in JavaScript.

### Verification

`supabase/tests/rls_verification.sql` impersonates two users the way PostgREST
does and asserts, inside the database:

- A's two paddies and B's one paddy stay separate even when both use the local
  id `paddy-001`
- B reading A's row **by primary key** returns nothing — the "change the field
  ID" attack named in the brief
- B's `UPDATE`/`DELETE` against A's rows affect zero rows
- B's `INSERT` claiming `owner_id = A` raises `insufficient_privilege`
- anonymous reads return nothing from all five tables

It ends in `ROLLBACK`. The browser suite checks the same five properties
against `MockCloudStore`, which implements the same rules — including
`RlsDeniedError` on a spoofed owner and `NotAuthenticatedError` with no token.

### Security audit (brief §35)

| Check | Result |
|---|---|
| Passwords never logged | ✅ No `console.*` anywhere in `js/auth/` or `js/cloud/` receives a password. The only log is `console.warn("Cloud auth unavailable:", error.message)` on SDK load failure. |
| Passwords never persisted by us | ✅ Only Supabase Auth handles them. `MockAuthClient` compares two in-memory strings and persists no password. The password input is cleared immediately after the provider call. |
| Tokens never printed into the UI | ✅ No template or render path reads `accessToken`. The account menu shows email and status only. |
| `service_role` key absent | ✅ Not in the repo; and `normalizeCloudConfig()` refuses to enable the cloud if one is pasted into the config, discarding the value. |
| RLS enabled | ✅ `enable` + `force` on all five tables, verified in §8 of the setup guide. |
| Cross-user reads denied | ✅ SQL verification + 3 browser tests. |
| Cross-user writes denied | ✅ SQL verification (`insufficient_privilege`) + browser test (`RlsDeniedError`). |
| `owner_id` cannot be spoofed | ✅ Never sent by the client (unit-tested for all three row builders); rejected by `with check` if it were. |
| Logout clears cloud state | ✅ Session ended, scope re-pointed to guest, account card and sync chip hidden, store rejects every call with `NotAuthenticatedError`. |
| User-switch state cannot leak | ✅ §6 below; pinned by a browser test that switches A→B→A. |
| Secrets in the diff | ✅ Searched for `service_role`, `password`, `Bearer`, `secret`, `token`, `private key`, `BEGIN .* KEY`, `sb_secret_`, `eyJ`. Only the guard code, its tests, and documentation prose. |

---

## 6. User switching and shared-device privacy

Option **A** from the brief: namespace the local caches by user id.

```
guest            suimonNaviFieldAnnotationsV2
farmer abc-123   suimonNaviFieldAnnotationsV2::u:abc-123
farmer def-456   suimonNaviFieldAnnotationsV2::u:def-456
```

Three keys are namespaced: the field domain, the target water levels, and the
sync bookkeeping. Anything else (e.g. `suimonNaviFieldMode`, a UI preference)
stays global. That list is asserted by a unit test, because a key added later
and forgotten here would be a cross-user leak.

The namespace uses the provider's opaque user id, never an email or display
name — an email is personal data with no business being in a storage key, and a
display name is not unique.

`ScopedStorage` is a `Storage`-shaped object, so it drops into
`FieldAnnotationController`'s existing `options.storage`. On a scope change the
controller is asked to re-hydrate and re-render. In the guest scope it resolves
every key to its original name, so nothing changes for an install that never
signs in.

### The bug this surfaced

`hydrateFromStorage()` used to `return` early when the key was absent. That was
harmless when it only ran once at mount against empty arrays. Called on a user
switch it was a privacy hole: signing in as B, whose namespace is empty, would
have left A's paddies in memory. It now calls `resetInMemoryState()` first,
which also clears `this.selected` — a selected-feature editor still pointing at
the previous scope's record could otherwise read *and save* it after a switch.

---

## 7. Sync strategy

### Trigger points

Sign-in; an explicit 今すぐ同期; the browser's `online` event; and a **1.5s
debounced** call after a local change. Never per click.

### Matching and conflicts

Records are matched by the **local** id, carried on the row as `legacy_*_id`
and unique per owner. Matching on the cloud UUID would give a farmer who
registers offline on a phone and again on a tablet two rows for one paddy.

Conflicts resolve **last-write-wins**, compared on the record's own
`properties.updatedAt` against the row's `local_updated_at` — a local clock on
both sides, so client/server clock skew never decides which boundary survives.
Ties mean "already in sync" and cost nothing. A v1 three-way merge of a polygon
is not attempted, and this rule is stated here rather than left to be
discovered.

A cloud row whose `record` is missing or malformed is never applied; the
device's copy wins and is pushed back up.

### The queue

The queue *is* the persisted sidecar (`suimonNaviCloudSyncV1`, per user), which
holds `{ cloudId, syncedLocalUpdatedAt, syncedAt, state }` per record. A record
is pending if it has no entry or its `updatedAt` differs from the stamp
captured at upload. So an edit made in a paddy with no signal is still detected
after a reload and a battery death.

Sidecar, not record: adding a sync field to a paddy record would change the
shape §4 exists to protect.

### Target water level — an honest exception

Union merge, device wins on conflict. The existing local format is a bare
`{ fieldId: number }` map with **no timestamp anywhere**, so there is no honest
way to say which side is newer. Inventing a timestamp and pretending would be
worse than documenting the rule.

### Sync status

Three states, one small chip in the header, detail in Settings.

| | Meaning |
|---|---|
| `✓ 同期済み` | Everything local is in the cloud |
| `⟳ 同期待ち N件` | Queued — offline, or the debounce has not fired |
| `! 同期エラー` | Something went wrong that waiting will not fix |

An unreachable server is `⟳`, not `!`. `!` should mean a farmer needs to do
something. The chip is hidden entirely for a guest.

The count is computed against **live local data**, not against the sidecar
alone: a paddy registered thirty seconds ago has no sidecar entry, and counting
only known entries would show ✓ 同期済み over a paddy that has never left the
phone.

---

## 8. Local data → account (§17)

On the first sign-in on a device that already has guest-registered paddies:

```
端末内の圃場
ログインせずに登録した圃場が2件あります。
アカウントに追加すると、他の端末でも同じ圃場を開けます。
端末内のデータは削除されません。

[ アカウントに追加する ]   [ 今はしない ]
```

- Offered on an **actual sign-in**, never on a plain reload, and **at most once
  per user per device** (`suimonNaviLocalImportChoiceV1`). Neither nagging nor
  silently uploading.
- Importing **copies**. The guest namespace is left intact, so the farmer can
  keep working without an account and nothing is destroyed if they decide the
  account was a mistake.
- Records already in the account (same local id) are skipped — the duplicate
  guard.
- Children follow their parent: water points, observations, survey sessions and
  boundary tracks come across only for paddies actually being adopted. A water
  point belonging to a paddy the account already had would be a duplicate.
- Adopted records are marked pending and sync on the next pass.

**Conflict behaviour:** a guest paddy whose local id already exists in the
account is *not* imported and *not* merged. Two different paddies that happen
to share the id `paddy-001` is the realistic case, and silently overwriting one
with the other would destroy a measurement. The account's copy wins and the
guest copy stays where it is.

---

## 9. Offline behaviour

| Situation | Behaviour |
|---|---|
| No signal at launch, session cached | `offline_authenticated`. Fields, map, area, water all work from cache. The SDK restores the session with no network call. |
| Signal lost while working | `online`/`offline` events flip the state; the chip goes ⟳. Nothing is interrupted. |
| Register a paddy offline | Written to localStorage and rendered immediately; queued. Pinned by a test that registers with the provider forced offline and asserts the record is on disk. |
| Signal returns | The `online` event triggers a sync; the queue drains; the chip returns to ✓. |
| Login attempted offline | 「インターネットに接続できません。オフラインのままでも「ログインせずに使う」で作業を続けられます。」 Never "wrong password". |
| Supabase SDK cannot be fetched | Caught at mount, logged as a warning, state becomes `unavailable`. The app is the offline app. |

No console errors are produced in any of these paths; the offline browser test
asserts `pageerror` stays empty.

---

## 10. What syncs, and what does not

**Syncs:** registered fields (polygon, area, source filename, point count, fix
quality summary — the whole record), water-management points, field
observations, per-field target water level, display name.

**Stays local, deliberately:**

| | Why |
|---|---|
| Raw NMEA text and survey sessions | A single walk can be megabytes. Uploading it would make accounts slow and expensive for no farmer-visible gain. The cloud field row still carries the measurement quality that matters. |
| Recording sessions (IndexedDB) and their marked observations | These are the session-child water-level readings the brief asks about. Audited before designing the schema: they live in the recording store keyed by a recording session id, alongside raw NMEA lines and image blobs, and creating one requires an active WebSerial connection. They belong to the recording session, not the paddy, so they follow the recording data. A `water_measurements` table invented now would be a guess at a Stage-2 shape. |
| Boundary tracks | A Settings-only legacy concept the Stage-1 Basic flow can no longer create. |

Both the Settings account panel and the migration file state this in place, so
nobody is left believing everything syncs.

---

## 11. Tests

```bash
npm test
```
**314 passed, 0 failed.** 71 of those are new here, across five files; the
remaining 243 are the pre-existing suite plus 11 from the concurrent
iPhone-UX session (see §16).

```bash
npx playwright test --workers=1
```
**274 passed, 0 failed** (8.3 min), including all 35 new tests and every
pre-existing spec — NMEA, START/END, field registration, water, navigation,
basemap, iPhone upload, decision, recording, drone, pilot, vegetation,
assurance.

Every new browser test runs against the mock provider, injected before page
load. No external Supabase project is contacted, and the default (uninjected)
configuration is the one every other spec runs in.

Coverage by requirement:

| # | Requirement | Test |
|---|---|---|
| 1 | First load shows login appropriately | login screen with cloud; **no** login screen without |
| 2 | Guest enters Basic | + choice survives reload; + full Stage-1 workflow with no account and nothing uploaded |
| 3 | Signup form | display-name field appears; duplicate email; short password; malformed email |
| 4 | Login success | + session survives reload without a flash |
| 5 | Login error | Japanese wording, no raw provider text, email retained |
| 6 | Signed-in header | 使い方 *and* the account control; menu shows email + status + logout |
| 7 | Fields render | あなたの圃場 with names and m² |
| 8 | Selection drives the existing active field | exactly one selector; tile click sets `#basicActiveFieldSelect` |
| 9 | Register → sync | local first, then cloud; record verbatim; UUID PK ≠ name ≠ local id |
| 10 | Sync failure keeps local data | registered with the provider offline |
| 11 | Logout | session ends, cache retained on disk |
| 12 | Second user sees nothing of the first | A→B→A, plus selector and registered-list checks |
| 13 | Import prompt | offered, imported, guest copy retained |
| 14 | Skip import | nothing uploaded, not asked again |
| 15 | Sync indicator | hidden for guests, ✓ after sync, ⟳ 同期待ち offline, small |
| §24 | RLS | direct read by id → null; spoofed owner → `RlsDeniedError`; signed out → `NotAuthenticatedError`; plus `supabase/tests/rls_verification.sql` |
| §25 | Offline | fields/map/water usable, new registration works, queue drains on reconnect, no page errors |
| §33 | Mobile | 390×844 and 393×852 |

### Bugs found while testing

1. **✓ 同期済み over an unsynced paddy.** The status counted only sidecar
   entries, and a newly registered paddy has none — so the chip claimed
   everything was safe in the cloud the instant after a registration. Now
   computed against live local data.
2. **`hydrateFromStorage()` returned early on an empty scope**, leaving the
   previous farmer's paddies in memory after a user switch. See §6.
3. **An offline sync was reported as `! 同期エラー`.** A dropped connection is
   not an error a farmer can act on; it is now `⟳ 同期待ち`.
4. **Double sign-in handling.** The provider fires its own auth-state event
   during `signIn()`, so `completeSignIn()` ran twice — re-running the import
   check and re-rendering. It is now idempotent per user id.

---

## 12. Mobile verification

390×844 and 393×852, both asserted:

- No horizontal scroll on the login screen or in signed-in Basic
- `#authEmailInput`, `#authPasswordInput`, `#authSubmitButton`,
  `#authSwitchButton`, `#authGuestButton` all ≥ 44px tall and within the
  viewport width
- The account button is ≥ 44px and shares the header row with 使い方; below
  480px the cluster gap tightens, the account label ellipsises, and the sync
  chip drops its wording but keeps its ✓ / ⟳ / ! glyph
- Field tiles are ≥ 44px
- The map stays > 200px tall and 水位を記録 stays enabled
- Inputs are 16px so iOS Safari does not zoom on focus
- `body.auth-screen-open` locks background scroll while the login screen is up

---

## 13. External setup still required

**Cloud sign-in does not work yet, and this report does not claim it does.**

No Supabase project was created, no credentials exist in this repository, and
no live sign-in, live sync, or live RLS behaviour was observed. Everything
verified above ran against the mock provider and against pure functions.

To turn it on, follow [SUPABASE_SETUP.md](SUPABASE_SETUP.md): create a project,
run `001_accounts_fields.sql`, set the Site/Redirect URLs, paste the project
URL and anon key into `config/cloud-config.js`, then run
`supabase/tests/rls_verification.sql`.

Until that is done the deployed site is the offline app it is today.

---

## 14. Known limitations

1. **Live cloud unverified.** See §13.
2. **Last-write-wins.** A paddy edited on two devices while both were offline
   keeps the later `updatedAt` and loses the other. Documented, not hidden.
3. **No password reset UI.** Supabase can send a recovery email and the
   redirect URL is configured for it, but there is no 「パスワードをお忘れですか」
   flow in the app yet. A farmer who forgets their password needs help.
4. **No account deletion or "remove this account's data from this device".**
   `clearScope()` exists and is tested but is not wired to a button.
5. **Deletions do not propagate.** `rowsToDelete()` is implemented and tested
   but is not called by the sync pass: getting deletion wrong loses a paddy,
   and it needs a tombstone the local repository does not keep. Deleting a
   field in 設定 removes it locally; the cloud row stays and would be
   re-downloaded on the next device.
6. **Raw NMEA and recording sessions do not follow the account** (§10), so a
   farmer who signs in on a new device gets their fields and their measurement
   *summary*, not the original logs.
7. **The guest namespace is shared between farmers on one device.** That is
   what "guest" means, and the import offer is per-account, but two farmers
   sharing a phone who both work as guests share one local data set.
8. **The Supabase SDK loads from jsDelivr** and a dynamic `import()` cannot
   carry an integrity attribute. `sdkUrl` allows self-hosting; see the setup
   guide.
9. **The mock provider is reachable from a page that sets
   `provider: "mock"`.** That requires deliberately editing the config or
   injecting a global before load. It is the test seam, and the shipped config
   does not enable it.
10. **`display_name` is user-editable metadata.** It is a label; ownership is
    decided only by `auth.uid()` inside the database.

---

## 15. Screenshots / viewports

Verified in-browser:

- **Default (no cloud), desktop:** header is exactly as before — brand, `? 使い方`,
  mode tabs. No account control, no login screen, no あなたの圃場 card.
- **Login screen, 390×844:** centred card on the parchment background; 水 mark,
  スイスイナビ, 圃場管理をもっと簡単に; two full-width inputs; a green
  ログイン button; a rule; 初めての方 / アカウントを作成; ログインせずに使う
  underlined below; the reassurance note at the bottom. No horizontal scroll.
- **Signed in, desktop:** header reads `スイスイナビ … [? 使い方] [✓ 同期済み] [ 北田さん ▾ ]`.
  The panel opens with あなたの圃場 — one tile per paddy with its name and
  `4,286 m²`, the active one carrying a green left bar — then
  `＋ 新しい圃場を測る`, then the unchanged 現在の田圃 card.
- **Account menu:** email, ログイン中, `✓ 同期済み`, 今すぐ同期, ログアウト.
- **Import offer:** a 端末内の圃場 card above あなたの圃場 with the count and
  the two buttons, stacking to full width below 720px.
- **設定 → 圃場データ → アカウント:** アカウント / 状態 / クラウド同期 rows with
  the last-sync timestamp, the three buttons, and the note about what stays on
  the device. No field selector.

---

## 16. Git information

- **Branch:** `main`
- **Starting commit:** `7e4281e` (`docs(stage1): record commit, push and GitHub Pages status`)
- **Commit:** `a79b0ec` — `feat(auth): add user accounts and cloud field sync`
  (33 files, +8326 / −157)
- **Push:** fast-forward `7e4281e..a79b0ec` to `origin/main`, non-force.
  `git fetch` beforehand showed 0 behind / 1 ahead, so no remote work was
  overwritten.
- **Secret scan before staging:** searches for `service_role`, `sb_secret_`,
  JWT-shaped strings, `Bearer`, `secret`, `password`, private keys and tokens
  returned only documentation prose, the guard code in
  `js/cloud/cloud-config.js`, and test fixtures using `@example.test`
  addresses. No `.env` or credential file exists in the tree.
- **GitHub Pages:** legacy build from `main` / root, published at
  <https://klayertan.github.io/michibiki-suimon-navi/>. **Frontend deployed;
  cloud authentication pending Supabase configuration** — the site serves the
  new assets, and because `config/cloud-config.js` ships with `provider: null`
  it correctly shows no login screen and no account control. Sign-in does not
  work publicly and no claim is made that it does; see §14.

### Concurrency note

This work shared a checkout with a second, concurrent session (the same
situation the Stage-1 report records). That session's changes to `index.html`,
`css/stage1-basic.css`, `js/assurance/satellite-assurance-controller.js`,
`js/gnss/nmea-file-intake.js` and its new specs were **preserved in full** and
this work was adapted around them:

- every `index.html` edit here was made against a freshly read anchor rather
  than by rewriting a region
- the account cards were inserted alongside that session's Basic-mode layout,
  not in place of it
- `ensureActiveFieldSelected()`, added by that session, is called from the
  scope-change handler so a user switch restores the correct active field

Because both sessions edited `index.html`, that file's diff contains both sets
of changes.
