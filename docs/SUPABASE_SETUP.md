# Supabase setup — スイスイナビ accounts

Everything in this document is **external configuration**. No Supabase project
was created for you, nothing was provisioned, and no credentials exist in this
repository. Until you complete these steps the app runs exactly as it always
has: fully offline, all data on the device, no login screen.

Related: [STAGE1_AUTH_CLOUD_FIELDS.md](STAGE1_AUTH_CLOUD_FIELDS.md) explains the
architecture and what does and does not sync.

---

## 0. What you will end up with

- A Supabase project (free tier is enough for a field trial)
- Five tables, all protected by Row Level Security
- Email + password sign-in
- Two values pasted into `config/cloud-config.js`, both safe to commit

Time: about 15 minutes.

---

## 1. Create the project

1. Sign in at <https://supabase.com/dashboard>.
2. **New project**. Choose a region close to the farm — Tokyo
   (`ap-northeast-1`) for Japan.
3. Set a database password. **Store it in your password manager. It never goes
   into this repository.**
4. Wait for provisioning to finish.

---

## 2. Apply the schema

Open **SQL Editor → New query**, paste the entire contents of

```
supabase/migrations/001_accounts_fields.sql
```

and run it.

It creates `profiles`, `fields`, `water_control_points`, `field_observations`
and `field_water_targets`; enables and **forces** RLS on all five; installs the
per-table owner policies; and adds a trigger that creates a profile row on
sign-up. It is idempotent, so re-running it later is safe.

If you use the Supabase CLI instead:

```bash
supabase db push
```

### Confirm RLS is on

**Database → Tables**. Every one of the five tables must show
**RLS enabled**. If any table does not, stop and re-run the migration — an
unprotected table is readable by anyone holding the public anon key.

---

## 3. Auth settings

**Authentication → Providers**

- **Email**: enabled.
- **Confirm email**: your choice. Leave it **on** for a real deployment. With
  it on, sign-up returns no session and the app says
  「確認メールを送信しました。メール内のリンクを開いてから、もう一度ログインしてください。」
  For a field trial where farmers are enrolled in person, turning it **off**
  removes a step that needs a working mailbox in a paddy.
- Leave every OAuth provider **off**. The app only implements email + password.

**Authentication → Providers → Email → Minimum password length**: set it to
**8** so the server agrees with the client-side rule in
`js/auth/auth-errors.js`.

---

## 4. Site URL and redirect URLs

**Authentication → URL Configuration**

| Setting | Value |
|---|---|
| **Site URL** | `https://klayertan.github.io/michibiki-suimon-navi/` |
| **Redirect URLs** | `https://klayertan.github.io/michibiki-suimon-navi/**` |
| **Redirect URLs** (dev, optional) | `http://127.0.0.1:4173/**` |

The trailing slash on the Site URL matters: this is a project served from a
GitHub Pages **repository sub-path**, not from a domain root.

The app does not hard-code any of this. `resolveRedirectUrl()` in
`js/cloud/cloud-config.js` derives the return URL from wherever the page is
actually being served — the Pages sub-path, a local dev server, or the packaged
desktop shell — so one committed config works everywhere. Set `redirectTo` in
`config/cloud-config.js` only if you move to a custom domain.

`localhost` is never used as the production callback.

---

## 5. Configure the client

**Project Settings → API**. Copy:

- **Project URL** → `url`
- **anon / public** key (also shown as the *publishable* key) → `anonKey`

Edit `config/cloud-config.js`:

```js
window.SUISUI_CLOUD_CONFIG ??= {
  provider: "supabase",
  url: "https://YOUR-PROJECT-REF.supabase.co",
  anonKey: "eyJhbGciOi...",   // anon / publishable key
  redirectTo: null
};
```

Commit that file. **Yes, really** — see below.

### Why committing the anon key is correct, not a leak

The anon key identifies the *project*, not a *user*. It carries no
authorization of its own: every request made with it is executed as the
PostgREST `anon` or `authenticated` role and is then filtered by the RLS
policies in the migration, which compare `owner_id` against `auth.uid()` from
the caller's own JWT. An attacker holding the anon key and nothing else can
read nothing, because there is no policy granting `anon` any row.

This is Supabase's documented design for browser clients, and it is the only
option available to a static site: GitHub Pages has no build step and no
server, so there is nowhere to hide a value from the browser anyway. A
"secret" shipped in a page is not a secret.

### What must never be committed

- the **`service_role`** / **secret** key — it **bypasses RLS entirely**
- the database password
- a personal access token
- any user's password

The app defends against the worst of these: if `anonKey` looks like a
`service_role` key, `normalizeCloudConfig()` refuses to enable the cloud
feature at all and Settings explains why. That is a seatbelt, not a substitute
for care.

---

## 6. Verify it works

```bash
npm run serve
```

Open <http://127.0.0.1:4173/>. You should see the login screen with
スイスイナビ / 圃場管理をもっと簡単に, and 「ログインせずに使う」 underneath.

1. **アカウントを作成** with a real address you can receive mail at.
2. If email confirmation is on, open the link, then log in.
3. Register a paddy: NMEAをアップロード → 開始点/終了点 → この範囲で圃場を作る
   → 登録する.
4. The header chip should go **⟳ 同期待ち** and then **✓ 同期済み**.
5. In the Supabase dashboard, **Table Editor → fields**: one row, with your
   `owner_id`, `legacy_field_id = paddy-001`, and the full local record in
   `record`.

---

## 7. Deploy

GitHub Pages serves this repository from `main` at the root, so a normal push
publishes it. The only new runtime dependency is the Supabase JS SDK, loaded
lazily from jsDelivr the first time the account surface is needed — a farmer
who never signs in never downloads it.

If your network policy forbids a third-party CDN, vendor the ESM bundle into
this repository and point at it:

```js
window.SUISUI_CLOUD_CONFIG ??= {
  provider: "supabase",
  url: "...",
  anonKey: "...",
  sdkUrl: "./vendor/supabase-js.esm.js"
};
```

A dynamic `import()` cannot carry a Subresource Integrity attribute, so
self-hosting is the only way to pin the SDK byte-for-byte.

---

## 8. Test users and the RLS verification

**Authentication → Users → Add user** (tick *Auto Confirm User*):

| Email | Password |
|---|---|
| `farmer-a@example.test` | any 8+ characters |
| `farmer-b@example.test` | any 8+ characters |

Then run `supabase/tests/rls_verification.sql` in the SQL Editor.

It impersonates each user the way PostgREST does (`set local role
authenticated` plus a `request.jwt.claims` setting) and asserts, at the
database level:

- A's two paddies and B's one paddy are separate, even though both use the
  local id `paddy-001`
- B cannot read A's rows **by primary key** — the "change the field ID" attack
- B's `UPDATE` and `DELETE` against A's rows affect zero rows
- B cannot `INSERT` a row claiming `owner_id = A` (rejected, not rewritten)
- anonymous requests read nothing from any of the five tables

It ends in `ROLLBACK`, so it leaves no data behind. A green run prints
`PASS: all RLS assertions held.`

Run it again after any schema change. The browser suite
(`tests/browser/auth-cloud-fields.spec.js`) checks the same properties against
a mock store that mirrors these policies, but only this script checks the real
database.

---

## 9. Troubleshooting

| Symptom | Cause |
|---|---|
| No login screen appears | `provider` is not `"supabase"`, or `url`/`anonKey` is empty. 設定 → 圃場データ → アカウント names the reason. |
| 設定 says 「公開してはいけない種類のキー」 | You pasted the `service_role` key. Use the anon/publishable key. |
| Sign-up succeeds but nothing happens | Email confirmation is on. Open the emailed link, then log in. |
| The confirmation link lands on a 404 | Site URL / Redirect URLs are missing the `/michibiki-suimon-navi/` sub-path. |
| ✓ never appears, chip stays ⟳ | Offline, or the SDK could not load. Check the browser console; local data is safe either way. |
| Signed in but no fields load | RLS is enabled but no policy exists — re-run the migration. |
| Everything works locally, nothing on Pages | The Pages build has not picked up `config/cloud-config.js`. Check the Actions run. |
