# Stage-1 accounts and cloud field persistence

A farmer can create an account, log in, see only their own registered 田圃,
select one, keep using 基本モード exactly as before, log out, and log back in on
another device to recover the same field data.

The offline app was not touched. **スイスイナビ still works with no account and
no network**, and that is the state the repository ships in.

---

## 1. Executive summary

| | |
|---|---|
| **Provider** | Supabase (Auth + Postgres + Row Level Security) |
| **Passwords** | Never stored, hashed, compared or logged by this code |
| **Ships enabled?** | **No.** `config/cloud-config.js` has no credentials, so there is no login screen and no behavior change until an operator completes `docs/SUPABASE_SETUP.md`. |
| **Guest mode** | Unchanged and unconditional. NMEA → boundary → area → register → water management all work signed out. |
| **Local-first** | Every write lands on the device first. A sync failure is a status, never a lost paddy. |
| **Isolation** | Enforced in the database by RLS on `owner_id = auth.uid()`, not by frontend filtering. |
| **Local record shape** | Unchanged. `buildField()` and the five persisted arrays are byte-identical; sync bookkeeping lives in a separate sidecar. |
| **Tests** | 324 unit (81 new), 274 browser (33 new), plus a database-level RLS script |

---

## 2. Architecture

```
                     ┌──────────────────────────────────────────┐
  index.html  ─────► │ AuthController                           │
  (init sequence)    │  login screen · header menu ·            │
                     │  あなたの圃場 · import offer · Settings    │
                     └───────┬──────────────────────┬───────────┘
                             │                      │
                 ┌───────────▼──────────┐  ┌────────▼───────────┐
                 │ AuthClient           │  │ FieldSyncService   │
                 │  Supabase | Mock     │  │  debounce, queue,  │
                 │  session, sign-in    │  │  status            │
                 └──────────────────────┘  └────────┬───────────┘
                                                    │
                                    ┌───────────────┴───────────┐
                                    │                           │
                        ┌───────────▼──────────┐   ┌────────────▼─────────┐
                        │ field-sync-core.js   │   │ CloudFieldStore      │
                        │ PURE merge rules     │   │  Supabase | Mock     │
                        └──────────────────────┘   └──────────────────────┘

  ScopedStorage ───► FieldAnnotationController ───► localStorage
  (per-user key)     (unchanged domain boundary)
```

### Files

**New**

| File | Lines | Purpose |
|---|---:|---|
| `js/auth/auth-state.js` | 128 | Pure state machine; decides when the login screen may appear |
| `js/auth/auth-errors.js` | 133 | Provider errors → farmer-readable Japanese |
| `js/auth/auth-controller.js` | 950 | All DOM binding for the account surfaces |
| `js/auth/supabase-auth-client.js` | 163 | Supabase Auth adapter |
| `js/auth/mock-auth-client.js` | 183 | In-memory provider for tests |
| `js/cloud/cloud-config.js` | 167 | Config normalization, redirect resolution, service_role guard |
| `js/cloud/user-scope.js` | 160 | `ScopedStorage` — per-user namespacing of the local repositories |
| `js/cloud/field-sync-core.js` | 385 | **Pure** record↔row mapping, merge, queue, status |
| `js/cloud/field-sync-service.js` | 372 | Orchestration: triggers, debounce, error handling |
| `js/cloud/supabase-client.js` | 69 | Lazy SDK loader |
| `js/cloud/supabase-cloud-store.js` | 141 | Postgres adapter |
| `js/cloud/mock-cloud-store.js` | 247 | In-memory store that simulates RLS |
| `css/auth.css` | 460 | Login screen, account menu, field tiles, sync chip |
| `config/cloud-config.js` | 53 | The one file an operator edits |
| `supabase/migrations/001_accounts_fields.sql` | 368 | Schema + RLS |
| `supabase/tests/rls_verification.sql` | 161 | Database-level isolation proof |
| `tests/unit/auth-state.test.js` | 192 | 25 tests |
| `tests/unit/auth-errors.test.js` | 83 | 8 tests |
| `tests/unit/cloud-config.test.js` | 113 | 12 tests |
| `tests/unit/user-scope.test.js` | 153 | 12 tests |
| `tests/unit/field-sync-core.test.js` | 257 | 24 tests |
| `tests/browser/auth-cloud-fields.spec.js` | 771 | 33 tests (35 with the two mobile viewports) |
| `docs/SUPABASE_SETUP.md` | — | Operator setup |
| `docs/STAGE1_AUTH_CLOUD_FIELDS.md` | — | This report |

**Modified**

| File | Change |
|---|---|
| `index.html` | Login screen markup, header account control + sync chip, `あなたの圃場` card, import-offer card, `設定 → アカウント` panel, `<script src="config/cloud-config.js">`, `ScopedStorage` bootstrap, `storage:` injection into `FieldAnnotationController`, `AuthController` mount, target-water-level reads routed through the scoped storage |
| `js/fields/field-annotation-controller.js` | `hydrateFromStorage()` now **replaces** in-memory state instead of returning early on an empty scope (see §9), extracted as `resetInMemoryState()` |

Nothing else in the field, water, drone, recording, report or assurance code
changed.

---

## 3. Why a provider, and not our own password table

The brief forbids custom password storage; this implementation contains none.

Doing it properly would mean owning Argon2id/bcrypt parameters, per-user salts,
timing-safe comparison, credential-stuffing rate limits, breached-password
screening, email-verification token issue and expiry, recovery-token rotation,
and session revocation. Every one of those is a way to leak a farmer's
credentials, and none of them is this project's problem. Supabase Auth owns all
of it.

Concretely, in this codebase:

- No password is ever written to `localStorage`, IndexedDB, a log, or a URL.
- The password input is cleared the moment the provider has been called
  (`clearCredentialInputs()`), so an unlocked shared phone does not hand the
  next person a filled-in field.
- `MockAuthClient` — used only by tests — compares two in-memory strings and
  persists no password anywhere.

Supabase was chosen because the domain is relational (users → fields → water
points / observations), because Postgres RLS gives database-level authorization
rather than frontend filtering, and because it works from a static GitHub Pages
site with no server. No alternative was silently substituted.

---

## 4. Login UX

```
              水
        スイスイナビ
     圃場管理をもっと簡単に

  メールアドレス
  [__________________________]

  パスワード
  [__________________________]

  [        ログイン         ]
  ────────────────────────────
         初めての方
  [    アカウントを作成      ]

      ログインせずに使う

  ログインしなくても、圃場の測量・面積計算・
  水管理はこの端末だけで使えます。
```

One column, Japanese-first, no marketing. `アカウントを作成` swaps the same form
into sign-up mode and reveals an optional お名前 field.

**Signed-in header** — the account control sits after 使い方, which stays
exactly where it was:

```
スイスイナビ                      [? 使い方] [✓ 同期済み] [ Kai ▾ ]
```

The menu holds the email, the state, the sync line, `今すぐ同期`, and
`ログアウト`. Nothing else was added to the header.

**あなたの圃場** appears in 基本モード above 現在の田圃:

```
あなたの圃場
┌──────────────┐  ┌──────────────┐
│ 北田          │  │ 南田          │
│ 4,286 m²      │  │ 3,910 m²      │
└──────────────┘  └──────────────┘
[ ＋ 新しい圃場を測る ]
```

### When the login screen appears — and when it must not

`shouldShowLoginScreen()` in `js/auth/auth-state.js`, unit-tested:

| Situation | Login screen |
|---|---|
| Session still being restored (`unknown`) | **No** — this is the flash §21 forbids |
| No cloud configured (`unavailable`) — the shipped state | **No** |
| Signed in, online or offline | **No** |
| Farmer previously chose ログインせずに使う | **No** |
| Farmer asked for it from the account menu | **Yes** |
| Cloud available, nobody has decided yet | **Yes**, once |

### Error messages

Every provider error passes through `authErrorMessage()`. A farmer never sees
`Invalid login credentials`, a status code, or a stack trace.

| Cause | Shown |
|---|---|
| Wrong password | メールアドレスまたはパスワードが違います。 |
| Duplicate email | このメールアドレスは既に登録されています。ログインしてください。 |
| Weak password | パスワードが短すぎます。8文字以上にしてください。 |
| Invalid email | メールアドレスの形式が正しくありません。 |
| Unconfirmed email | メールの確認が完了していません。届いた確認メールのリンクを開いてください。 |
| Rate limited | 試行回数が多すぎます。しばらく待ってからもう一度お試しください。 |
| **Offline** | インターネットに接続できません。オフラインのままでも「ログインせずに使う」で作業を続けられます。 |
| Server 5xx | クラウド側で問題が発生しました。データは端末に保存されています。 |

A dropped connection is never reported as a wrong password — that would send a
farmer hunting for a typo that does not exist, and imply their data was gone.

---

## 5. Guest mode

`ログインせずに使う` is not a degraded mode. A guest can load NMEA, pick
START/END, build a polygon, see the area, register a 田圃, add water-management
points, record water levels and read 今日の水門判断 — all of it, with no
account and no network.

The choice is remembered (`suimonNaviAuthChoiceV1`), so the screen is not shown
again. Guest data is written to the **original, unprefixed** storage keys, so a
device that never signs in is byte-identical to the app before this change.
That is asserted by both a unit test and a browser test.

---

## 6. Ownership model and database schema

```
auth.users
  └── profiles (display_name — a label, never an authorization input)
  └── fields
        ├── water_control_points
        ├── field_observations
        └── field_water_targets
```

Ownership is `owner_id`, never a display name. `owner_id` defaults to
`auth.uid()` in the database and the browser never sends it.

### fields

| Column | Notes |
|---|---|
| `id uuid` | Cloud primary key, generated. Never a human-readable name. |
| `owner_id uuid` | `default auth.uid()` |
| `legacy_field_id text` | The device id (`paddy-001`). **Unique per owner**, and the sync matching key. |
| `name`, `area_m2`, `source_nmea_filename`, `boundary jsonb` | Denormalized for querying and support |
| `record jsonb` | **The verbatim local record.** Authority for round-trip. |
| `local_updated_at` | The record's own `properties.updatedAt` at upload time |

`water_control_points` and `field_observations` follow the same pattern with
`legacy_point_id` / `legacy_observation_id`, plus a resolved `field_id` FK.
`field_water_targets` is keyed `(owner_id, legacy_field_id)`.

### Why `record jsonb` rather than full normalization

The brief says preserving the exact current field structure may matter more
than database elegance, and here it does. `buildField()` produces a record the
map layer, the area calculation, the 圃場レポート, the export format and the
existing test suite all depend on, and the Stage-1 report explicitly pins
"`buildField()` not touched". Round-tripping a paddy through a normalized
schema risks changing it. So the blob is the authority and the columns are for
humans. A column drifting out of step can never corrupt a boundary.

### Semantics deliberately preserved

- `relatedFieldId` (water points) and `fieldId` (observations) are **not**
  merged into one "field" concept — they mean different things in this codebase
  and the exported JSON would change.
- `[lat, lon]` tuples stay in Leaflet order. Not flipped to GeoJSON `[lng, lat]`.
- The exported long-form water types (`water_gate`, `water_inlet`, …) are
  carried through, not re-derived.
- `point_type` / `observation_type` are `text`, not enums, so a new type on the
  device cannot fail an upload.

---

## 7. What syncs, and what does not

**Synced**

- fields (polygon, area, source NMEA filename, fix-quality summary, memo)
- water-management points
- field observations
- per-field target water level

**Local only, on purpose**

| Not synced | Why |
|---|---|
| Raw `.nmea` text and survey sessions | A single walk can be megabytes. §8 of the brief rules this out for v1, and the measurement quality that matters (`sourceFileName`, `sourcePointCount`, `fixQualitySummary`) already travels inside the field record. |
| The IndexedDB recording store | Raw NMEA lines and image blobs, same reason. |
| **Session-child water-level readings** | Audited before designing the schema: these are `waterLevel` on a *marked observation* inside the recording store, keyed by a recording session, and creating one requires an active WebSerial connection to the QZ1. They belong to the recording session, not the paddy. A `water_measurements` table was therefore **not** invented — an empty table would imply a sync that does not exist. |
| Boundary tracks | A Settings-only legacy concept the Stage-1 Basic flow can no longer create. |

Settings → 圃場データ → アカウント states this in the UI, in Japanese, so nobody
is left believing everything syncs.

**Target water level** merges by union with the device's value winning. Unlike
the record types, its existing storage format is a bare `{ fieldId: number }`
map with no timestamp anywhere, so there is no honest way to decide which side
is newer. Rather than invent a timestamp and pretend, the rule is documented.

---

## 8. Local-first behavior and sync strategy

```
farmer action
   ↓
FieldAnnotationController.persist()      ← already done, unchanged
   ↓
onFieldsChanged → authController.notifyLocalChange()
   ↓
FieldSyncService.scheduleSync()          ← debounced 2.5s, non-blocking
   ↓
runSync(): merge → upload → download → apply
```

No button click waits on the network. Sync runs on sign-in, on an explicit
`今すぐ同期`, when the browser reports the network returned, and debounced after
a local change.

**Conflict rule — last write wins**, compared on the records' own
`properties.updatedAt` on both sides (the cloud row's `local_updated_at` holds
what that value was at upload). A client clock is therefore only ever compared
with another client clock, so server/client skew never decides which polygon
survives. A genuine three-way merge of a boundary is not attempted in v1.

**Matching is by the device id, not the cloud UUID.** A farmer who registers a
paddy offline on a phone and again on a tablet would otherwise get two rows for
one field. `unique (owner_id, legacy_field_id)` makes the upsert idempotent.

**The queue is the persisted sidecar**, `suimonNaviCloudSyncV1`, stored per
user and separate from the field records. It holds `{ cloudId,
syncedLocalUpdatedAt, syncedAt, state }` per record, so an edit made with no
signal is still detected as pending after a reload or a flat battery.

**Deletions** only propagate for rows this device previously synced. A row
created on another device and never downloaded here is not "deleted here".

A cloud row whose `record` is missing or malformed is skipped rather than
half-rebuilt, and the device's copy is pushed back up — a field reconstructed
from columns alone would render as an empty polygon and silently lose the walk.

---

## 9. User switching and shared-device privacy

Two farmers can share one phone. The implementation is **option A** from the
brief: namespace the local caches by user id.

```
guest        suimonNaviFieldAnnotationsV2
user abc123  suimonNaviFieldAnnotationsV2::u:abc123
```

`ScopedStorage` (`js/cloud/user-scope.js`) is a `Storage`-shaped object handed
to `FieldAnnotationController` through `options.storage` — an injection point
that already existed. The controller learns nothing about accounts; it remains
the domain and local-persistence boundary. Three keys are namespaced
(`…FieldAnnotationsV2`, `…TargetWaterLevelV1`, `…CloudSyncV1`); UI preferences
stay global.

### The bug this exposed, and the fix

`hydrateFromStorage()` returned early when the key was absent. Harmless while
it only ran once at mount with empty arrays — but on a user switch it would
have left **User A's paddies in memory for User B**. It now resets in-memory
state first, so an empty scope produces an empty controller. `this.selected` is
reset too, so a selected-feature editor cannot still point at the previous
scope's record. Covered by
`user B never sees user A's fields after a switch on the same browser`.

### Logout

Logout ends the cloud session and returns the scope to guest. It **does not
delete anything** — the signed-out farmer's cache stays under their own key, so
signing back in on this device is instant and works with no signal. Settings
says so explicitly:
「ログアウトしました。この端末に保存された圃場データは削除していません。」
`clearScope()` exists for an explicit "remove this account from this device"
and is not wired to logout.

---

## 10. Offline behavior

| | |
|---|---|
| Cached session, no network | `offline_authenticated` — still signed in. Signing a farmer out because their phone lost signal would hide the paddies they are standing in. |
| Cached fields | Visible, selectable, map and area intact |
| New registration offline | Succeeds locally, queued for the cloud |
| Sync indicator | `⟳ 同期待ち N件` |
| SDK unreachable (blocked CDN, no signal on first load) | Degrades to `unavailable` — the offline-first app, not a broken one |

A network failure during sync sets `providerUnreachable`, not `lastError`, so
the chip reads `⟳ 同期待ち` rather than `! 同期エラー`. `!` is reserved for
something that waiting will not fix.

---

## 11. Security review

| Check | Result |
|---|---|
| Passwords logged | **No.** No password reaches `console`, storage, or a URL anywhere in the codebase. |
| Passwords stored | **No.** Supabase Auth owns credentials; nothing here hashes or persists one. |
| Tokens printed into the UI | **No.** The account menu shows an email and a status; no token is rendered. |
| `service_role` key present | **No.** Repository-wide search is clean, and `normalizeCloudConfig()` refuses to start the cloud if one is configured. |
| RLS enabled | **Yes**, `ENABLE` + `FORCE` on all five tables, four policies each. |
| Cross-user reads denied | **Yes.** Browser test (`fetchById` returns null, `listFields` returns 0) and `supabase/tests/rls_verification.sql` (by primary key, at the database). |
| Cross-user writes denied | **Yes.** `UPDATE`/`DELETE` against another owner's row affect zero rows. |
| `owner_id` spoofable from the browser | **No.** The client never sends it; the column defaults to `auth.uid()` and `WITH CHECK` rejects a mismatch. Both the browser test and the SQL script attempt the spoof and observe a denial. |
| Anonymous access | **No policy grants `anon` anything.** Verified in both suites. |
| Logout clears cloud state | **Yes.** Session ended, scope returned to guest, cloud view cleared, `pendingImport` dropped. |
| User-switch UI leak | **No.** Field list, active-field selector and registered-fields panel are all empty for the second farmer. |
| Frontend-only filtering | **Deliberately absent.** `supabase-cloud-store.js` does not add `.eq("owner_id", …)`; a query that could return another owner's row is a database bug to fix, not to hide. |

**Committed secrets: none.** Searches for `service_role`, `Bearer`, `secret`,
`password`, `private key` and `token` across the working tree return only
documentation prose, the guard code, and test fixtures using
`@example.test` addresses.

One residual risk, stated plainly: the Supabase SDK is loaded by dynamic
`import()` from jsDelivr, and a dynamic import cannot carry a Subresource
Integrity attribute. `sdkUrl` in the config exists so an operator can vendor
the bundle and remove the third-party CDN from the auth path.

---

## 12. Tests

```bash
npm test           # 324 passed, 0 failed
npx playwright test --workers=1   # 274 passed, 0 failed (7.7m)
```

Both suites were green before and after. No pre-existing test was modified.

**Unit — 81 new**

- `auth-state.test.js` (25) — state derivation, every login-screen visibility
  rule, labels, credential validation, provider-error translation
- `auth-errors.test.js` (8) — the same error surface from the message side,
  including "no sync failure message omits 端末に保存されています"
- `cloud-config.test.js` (12) — unconfigured degradation, the service_role
  guard in both key formats, GitHub Pages sub-path redirect resolution
- `user-scope.test.js` (12) — guest byte-identity, namespacing, the shared-phone
  switch, logout preserving both caches
- `field-sync-core.test.js` (24) — lossless round-trip, no `owner_id` from the
  browser, last-write-wins in both directions, matching by device id, a broken
  cloud row never overwriting a good local one, import planning, status states

**Browser — 33 (35 including both mobile viewports)**, all against the mock
provider, all listed in the order of the brief's §32:

first-load login screen · guest entry and persistence · full Stage-1 workflow as
a guest · sign-up with display name · duplicate address · weak password ·
malformed email · wrong password · signed-in header beside 使い方 · reload
without a flash · あなたの圃場 listing · selecting a paddy driving the ONE active
field · local-first registration then cloud · verbatim record round-trip ·
restore after sign-out/in · sync failure not losing the paddy · offline
workflow · queue draining on reconnect · logout keeping local data · **user B
seeing none of user A's fields** · **direct read of another owner's row by id
denied** · **write claiming another owner denied** · **signed-out store access
denied** · import offer and import · 今はしない · no offer for the second farmer
· sync indicator states · Settings account section · 今すぐ同期 · mobile 390×844
and 393×852 · and three tests pinning that with no cloud configured there is no
login screen, no account control, and the original storage key is still used.

**Database** — `supabase/tests/rls_verification.sql` proves the same isolation
properties in Postgres, with no browser involved. It is the only check that
exercises the real policies; it has **not** been run, because no Supabase
project exists (see §14).

**Mobile** — verified at 390×844 and 393×852: no horizontal scroll on the login
screen or in signed-in Basic; ≥44px on the submit, switch, guest, email,
password, account button and field tiles; 16px inputs so iOS Safari does not
zoom the viewport on focus and push the submit button off-screen; the map still
≥200px tall with the account cards added; the verdict card still reachable.

---

## 13. External setup still required

**The account feature is not live.** No Supabase project was created, no
external service was provisioned, and nothing was paid for — per §30 of the
brief, that boundary was not crossed.

To enable it, follow `docs/SUPABASE_SETUP.md`: create a project, run
`supabase/migrations/001_accounts_fields.sql`, set the Site URL and redirect
URLs, paste the project URL and anon key into `config/cloud-config.js`, create
the two test users, and run `supabase/tests/rls_verification.sql`.

**No claim is made that live sign-in works**, because it has not been observed.
What has been verified is the frontend, the merge logic, the storage scoping and
the authorization *model*, against a mock store that mirrors the migration's
policies.

---

## 14. Known limitations

1. **Live cloud sync is unverified.** Everything above was tested against the
   mock provider. The RLS SQL script is written but unrun.
2. **Last-write-wins can lose an edit.** Two devices editing the same paddy
   offline: the later `updatedAt` wins outright. Documented, not silent.
3. **Target water level has no timestamp**, so its merge is union-with-device-
   wins rather than last-write-wins (§7).
4. **Raw NMEA, recording sessions and their water-level readings stay local.**
   A farmer who loses their phone loses those, though the paddy, its area and
   its measurement summary are recoverable.
5. **Boundary tracks do not sync.**
6. **No password reset flow in the UI.** Supabase can send a recovery email and
   the redirect URL is configured for it, but the app has no
   「パスワードを忘れた」 screen yet.
7. **No account deletion in the UI.** `clearScope()` removes a user's local
   cache but nothing calls it; cloud rows must be deleted in the dashboard.
8. **The SDK has no SRI pin** (§11).
9. **Deletion propagation is device-scoped** — deleting a paddy on a device that
   never synced it does nothing to the cloud row (§8).
10. **One active field, one account.** Sharing a paddy between two farmers is
    not modelled; there is no team or farm-level ownership.

---

## 15. Screenshots / viewports

Verified in-browser:

- **390×844, login screen** — one column, centred card, 水 mark over
  スイスイナビ / 圃場管理をもっと簡単に, two inputs, a full-width green ログイン,
  a divider, 初めての方 / アカウントを作成, an underlined ログインせずに使う, and
  the note that the app works without an account. No horizontal scroll; submit
  50px, guest 44px, inputs 16px.
- **390×844, shipped configuration** — identical to before this change: header
  with 使い方 only, no account control, the three mode tabs, the map dominant,
  水管理ポイント toolbar, 現在の田圃 with 圃場を測る. Console clean apart from the
  pre-existing MAVLink backend connection errors (the backend is not running).
- **1280×900, signed in** — `✓ 同期済み` chip and `Kai ▾` after 使い方;
  あなたの圃場 tiles above 現在の田圃; 設定 → 圃場データ → アカウント showing the
  email, ログイン中, the sync line with a last-sync timestamp, and 今すぐ同期 /
  ログアウト.

---

## 16. Git

- **Branch:** `main`
- **Starting commit:** `7e4281e` — *docs(stage1): record commit, push and
  GitHub Pages status*

### Concurrency note

This work shared a checkout with a second, concurrent session (the Stage-1
iPhone Basic-UX task: `docs/STAGE1_IPHONE_BASIC_UX.md`,
`js/gnss/nmea-file-intake.js`, `tests/browser/basic-ux-consolidation.spec.js`,
`tests/browser/nmea-ios-upload.spec.js`, `tests/unit/nmea-file-intake.test.js`,
and further edits to `index.html`, `css/stage1-basic.css` and
`js/assurance/satellite-assurance-controller.js`). That session's changes were
**preserved in full** and this work was adapted to them — for example the
account bootstrap sits alongside their `ensureActiveFieldSelected()` in
`onFieldsChanged`. Because both sessions edited `index.html`, that file's diff
contains both sets of changes, and the commit for this task stages only the
files listed in §2.
