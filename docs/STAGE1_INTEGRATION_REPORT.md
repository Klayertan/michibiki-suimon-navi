# Stage 1 Integration Report — floating field & water management dashboard

Final integration of three parallel workstreams plus the documentation pass.
Everything below was verified, not assumed.

| | |
|---|---|
| **Starting SHA** | `54e7ba7e4a9abe9c77451e04ae17f7416460adb2` |
| **Final commit SHA** | `134ce699053f15b2434081183a066c5316b65da7` |
| **Pushed range** | `54e7ba7..134ce69` on `origin/main` (fast-forward, non-force) |
| **Unit tests** | 393 passed / 0 failed |
| **Browser tests** | 346 passed / 0 failed (complete Playwright suite) |
| **GitHub Pages** | built OK for `134ce69` |
| **Live site** | verified at desktop 1440×900 and mobile 375×812 |

---

## 1. Starting SHA

`54e7ba7e4a9abe9c77451e04ae17f7416460adb2`
— *docs(stage1): record the 3-column desktop layout report and final SHA*

`origin/main` was also at `54e7ba7` at fetch time, so the local tree was the
only place the integrated work existed.

## 2. Final commit SHA

`134ce699053f15b2434081183a066c5316b65da7`
— *feat(stage1): integrate floating field and water management dashboard*

One combined integration commit, as approved: `index.html` carries all three
briefs semantically interleaved (floating rails, the 水管理 card markup and
controller, and the signed-measurement write paths all touch the same regions),
so splitting it for commit aesthetics would have produced commits that neither
build nor test on their own.

## 3. Pushed range

```
54e7ba7..134ce69  main -> main
```

Normal non-force push. `git fetch origin` before pushing showed local ahead by
1 and `origin/main` not advanced, so this was a clean fast-forward with no
divergence to resolve.

## 4. Exact files committed

20 files, `+5576 / −129`. Nothing else was staged.

**Modified (7)**

| File | Change |
|---|---|
| `index.html` | +1110 — floating-rail desktop layout, 水管理 card markup + controller, signed measurement write paths, header NMEA button, `fitBounds` wrapper |
| `README.md` | +237/−… — rewritten around the water model |
| `css/stage1-basic.css` | +11 — `min-width: 0` / `minmax(0, …)` sizing fixes |
| `js/cloud/user-scope.js` | +8 — `suimonNaviFieldGrowthStageV1` added to `SCOPED_STORAGE_KEYS` |
| `tests/browser/basic-field-water-dashboard.spec.js` | +68 — date-fixture fix (§7) |
| `tests/browser/stage1-basic-workflow.spec.js` | +5 — mobile touch target now measured on the header upload |
| `tests/unit/user-scope.test.js` | +3 — scoped-key list assertion |

**New (13)**

| File | Role |
|---|---|
| `js/water/growth-stage-model.js` | 11-stage table; mode + cited mm range or explicit "no numeric target" |
| `js/water/water-recommendation.js` | the pure engine; the only place `L = m² × mm` happens |
| `js/water/water-measurement.js` | `{ valueMm, valueCm, reference, source, measuredAt }` record + legacy normalisation |
| `js/water/water-management-sources.js` | provenance registry with per-source verification level |
| `tests/unit/growth-stage-model.test.js` | stage-table guards |
| `tests/unit/water-measurement.test.js` | record, signs, datum, legacy cm |
| `tests/unit/water-recommendation.test.js` | engine, signed arithmetic, AWD cases |
| `tests/browser/water-management-card.spec.js` | the card end-to-end |
| `tests/browser/basic-floating-map-dashboard.spec.js` | floating layout + phone header upload |
| `docs/ARCHITECTURE.md` | system architecture, implementation status, §6 signed levels |
| `docs/PADDY_WATER_MANAGEMENT.md` | the water model in detail |
| `docs/RESEARCH_REFERENCES.md` | bibliographic records and verification status |
| `docs/STAGE1_BASIC_FLOATING_MAP_DASHBOARD.md` | the layout stage report |

**Deliberately not committed** (all `.gitignore`d, none touched):
`.DS_Store`, `test-results/`, `node_modules/`, and a stale local worktree at
`.claude/worktrees/great-benz-51b8fd` (branch `claude/great-benz-51b8fd` at
`7e4281e`, dated 2026-08-17, unrelated to this work and left exactly as found).

**Pre-commit safety review:** `git diff --check` clean; no conflict markers
anywhere in the tree; no `debugger`, `console.log`, `TODO`/`FIXME` or
`test.only`/`.only(` introduced; no API keys, tokens, credentials or private
keys in the staged diff; no binary, generated or lock files staged
(`package-lock.json` untouched); no duplicate element IDs in `index.html`
(576 `id` attributes, all unique — the one apparent `pilotPanel` duplicate is a
mention inside a JS comment and is pre-existing).

## 5. Unit result

```
npm test  →  tests 393 · pass 393 · fail 0 · cancelled 0 · skipped 0 · todo 0
```

Matches the expected ~393/0 exactly.

## 6. Browser result

Focused suites first, then the complete run:

| Run | Result |
|---|---|
| `basic-field-water-dashboard.spec.js` (before fixture fix) | 10 passed, **1 failed** (§7) |
| `basic-field-water-dashboard.spec.js` (after fixture fix) | **11 / 11** |
| water management + floating dashboard + NMEA upload | **57 / 57** |
| Stage-1 workflow + map layout + navigation/basemap + UX consolidation | **57 / 57** |
| **`npx playwright test` (complete suite)** | **346 / 346**, exit 0, 5.5 min |

Zero failed, zero flaky, zero skipped.

## 7. Date-fixture fix

**Diagnosis matched the brief exactly.** The only failure in the whole tree was
`basic-field-water-dashboard.spec.js` › *"the 3-day forecast row renders
today/tomorrow/day-after"*, failing with `locator resolved to 2 elements`.

Its Open-Meteo mock hard-coded an 11-day hourly series starting
`2026-08-10T00:00:00Z`, commented *"8 days before today"*. The app slices
`today … today+2` from the response, so the mock only held while the local date
was ≤ 2026-08-18. At 2026-08-19 it could supply just two future days.

**A test-fixture bug, not a product-behaviour change.** No production forecast
code was touched.

**Fix.** The suite has no deterministic-time convention (no `page.clock`, no
`Date` stubbing anywhere in `tests/browser/`), so the second option in the brief
applies: the window is now built relative to the day the test runs.

```js
const MOCK_PAST_DAYS = 8;
const MOCK_FORECAST_DAYS = 5;      // today + 4; the app reads 3
const MOCK_TODAY_INDEX = MOCK_PAST_DAYS;
```

- `start` is local midnight `MOCK_PAST_DAYS` before today, so day index
  `MOCK_TODAY_INDEX` is always today.
- Days are emitted **one calendar day at a time** (24 labelled hours each)
  rather than by adding `3600000` ms, so a DST boundary cannot shift a label
  into the neighbouring day and shear the day buckets.
- Hour labels are formatted in **local** time (`YYYY-MM-DDTHH:00`, no offset) —
  the shape Open-Meteo returns for `timezone=Asia/Tokyo`, and the shape
  `deriveWeatherFromOpenMeteo()` feeds to `new Date(...)`, which reads an
  offsetless stamp as local. This keeps the fixture's "today" bucket on the same
  calendar day as the browser under test.
- Two spare tail days mean the window cannot expire again.
- Rain still falls on today+1 and today+2, preserving the "dry today, then two
  rainy days" shape the rest of the file depends on.

**The assertion was not weakened.** It still asserts `toHaveCount(3)` and still
checks 今日 / 明日 / 明後日 in order. It was not reduced to 2 days.

## 8. Desktop floating-map verification

Measured on the **live deployed site** at 1440×900, not inferred from CSS:

| Check | Result |
|---|---|
| `main` grid | `1440px` — a single column/row cell |
| `.map-wrap` | `x: 0, w: 1440` — full-bleed, spans the entire viewport width |
| `.panel-left` | floats at `x: 20, w: 320` |
| `.panel-right` | floats at `x: 1020, w: 400` (20px from the right edge) |
| `.panel` | `display: contents` — rails are `main`'s own grid items |
| Rail background | `rgba(0, 0, 0, 0)` — fully transparent |
| Rail pointer-events | `none` — only the cards intercept |
| Horizontal overflow | `scrollWidth 1440 === innerWidth 1440` (none) |

Left rail carries 圃場の管理 / 今日の水門判断 / 水管理; right rail carries
NMEAをアップロード / 登録済み圃場・測量ログ / 水管理ポイント / 水位・観察を記録.
Map imagery is visible behind and between both rails. Basemap toggle inset from
the right, zoom control bottom-right, 水管理ポイント toolbar pinned bottom-left,
empty state centred on the free band between the rails.

Map interactions are covered by the 57-test focused run above, including a real
`page.mouse.click` placing a water point through a rail gap, a marker popup
opening with its 削除 button completing a delete through the `confirm()` dialog,
and independent rail scrolling with `documentElement.scrollTop` staying 0.

## 9. Mobile verification

Measured on the **live deployed site** at 375×812:

- `.panel` is `display: grid`, **not** `contents` — the stacked mobile shell is
  intact, with the map on top and the cards below. No floating leak.
- No horizontal scroll.
- 水管理 card present and rendering.
- Regression guards in the suite additionally cover 390×844 and 393×852, and
  confirm 設定 and ドローン keep the side-by-side map + single-panel shell.

## 10. NMEA upload verification

**Exactly one real Basic-mode NMEA file input.** Enumerated every
`input[type=file]` on the live site:

| Input | Mode gate | Purpose |
|---|---|---|
| `#basicNmeaInput` | `basic` | **the one NMEA input** (no `accept` filter, deliberate — the iOS picker bug) |
| `#recObsImageInput` | `basic settings` | observation photo, `accept="image/*"` — different purpose, pre-existing |
| `fileInput`, `importInput`, `assuranceQz1Input`, `assuranceReferenceInput`, `assuranceImportProject`, `paddyImportInput`, `vegImportInput` | `settings` | all Settings-gated |

**The header control forwards; it does not duplicate.** Verified live by
spying on `#basicNmeaInput`'s click:

```
headerButtonTag:                    "BUTTON"
headerButtonOwnsAnInput:            false
clicksForwardedToBasicNmeaInput:    1
```

**Header composition is exactly `[NMEA upload] [?]`.** The visible buttons in
`.brand-row-actions`, in DOM order, at 375px:

| # | id | accessible name | rect |
|---|---|---|---|
| 1 | `headerNmeaUploadButton` | NMEAをアップロード | `x: 265, y: 8, 44×44` |
| 2 | `basicHelpButton` | 使い方 | `x: 321, y: 8, 44×44` |

Upload is immediately left of help by both DOM order and geometry
(`265 + 44 = 309 ≤ 321`). Both are 44×44 touch targets. Below 480px both drop
their text labels to bare icons, as designed.

On desktop the header control is `display: none` and the upload stays in the
right rail — asserted at 1920×1080 / 1366×768 / 1280×900. The card's own
`.basic-upload-button` is not rendered on phones, so there is exactly **one**
upload affordance per viewport.

## 11. Signed AWD measurement semantics

Verified against the **deployed live modules** (imported from
`https://klayertan.github.io/michibiki-suimon-navi/js/water/`):

| Property | Verified value |
|---|---|
| Datum | `reference: "soil-surface"` |
| Positive | above soil surface (standing water) |
| Zero | exactly at the soil surface |
| Negative | below the soil surface (sub-surface water table) |
| `-150 mm` valid | `true` |
| `null`/`undefined`/`""`/`NaN`/`Infinity` | all → `null`, never a fabricated `0 mm` |

Signed arithmetic, live, target 30–50 mm against a −150 mm reading on 2000 m²:

```
status        below-range
deficit       180 – 200 mm      (not 30, not 120 — no Math.abs, no clamp)
volume        360 – 400 m³
```

`0 mm` is a real reading (`below-range`, deficit 30 mm), **not** "missing".
中干し returns `no-numeric-target` with `standingWaterAdjustment: null` — the
drainage stages refuse to produce a fill volume at all.

**No AWD agronomic target was invented.** 移植直後 still reads `[30, 50]` mm on
the live build: the growth-stage target table is unchanged, `−150 mm` is not a
target for anything, and no AWD recommendation algorithm exists.

## 12. Legacy cm compatibility

Verified live: a legacy `{ valueCm: -15, recordedAt }` entry and a new
`{ valueMm: -150, reference: "soil-surface" }` record normalise to the **same
physical measurement** and produce the **identical** 180–200 mm deficit.

```
legacyCmMatchesMm: true
legacyCm.measurement.valueMm: -150
```

Legacy entries load with no migration step and are never rewritten in storage;
the absent `reference` is resolved to soil-surface in memory only. Both write
paths now agree — this used to be a real divergence where the cm path stored
`{ valueCm: -15 }` with no mm record while the mm path *cleared* the same
reading. A record naming a datum this build does not know is reported as
unreadable rather than silently re-read against the soil surface.

## 13. Documentation updated

`docs/PADDY_WATER_MANAGEMENT.md` now reflects the final implementation, with a
new **"Signed water levels and the soil-surface datum"** section covering: signed
levels implemented; `reference = "soil-surface"`; `+` above / `0` at / `−` below
the soil surface; `−150 mm` representable; non-values never coerced to zero;
legacy cm compatibility including `−15 cm ≡ −150 mm`; and an explicit *"What
this does **not** mean"* — signed measurement support is **not** a complete
AWD-specific recommendation algorithm, and the stage table is unchanged. The
measurement record and the persisted shape now name their `reference` field.

**RealSense is not overclaimed.** The sensor section is retitled in substance as
*a hook, not an integration*: no RealSense, sensor or drone water-level capture
exists in this build, every reading today is `source: "manual"`, and the
`"realsense"` path is exercised only by a unit test, never by hardware.

**Intel "D345" was not silently renamed.** Both this doc and
`docs/ARCHITECTURE.md` §8 report the brief's D345 against Intel's shipping D4xx
line as an **unresolved discrepancy** to be confirmed from the hardware label.
Neither asserts D435, and no model number is hard-coded in any code path.

**No stale "not implemented" claim survives.** A tree-wide search for statements
that signed/negative water levels are unsupported returned nothing.
`docs/ARCHITECTURE.md` and `README.md` already carried the correct pairing —
*signed water levels ✅ implemented* alongside *AWD-specific recommendations 🗓
planned* — and `docs/RESEARCH_REFERENCES.md` §4 states the same distinction.

`docs/STAGE1_BASIC_FLOATING_MAP_DASHBOARD.md` had recorded the suite as 345/346
with the date fixture as a known open failure; that is now updated to 346/346
with the fixture fix described.

**Link check.** The repository has no documentation/link-check script, so every
relative Markdown link in `README.md`, `ARCHITECTURE.md`,
`PADDY_WATER_MANAGEMENT.md`, `RESEARCH_REFERENCES.md` and
`STAGE1_BASIC_FLOATING_MAP_DASHBOARD.md` was resolved against the filesystem
directly: **all resolve, none broken.** One internal section reference
(`ARCHITECTURE.md` §8, the hardware note) was corrected during review.

## 14. GitHub Pages deployment status

```
commit  134ce69
status  built
error   null
```

Source is `main` / `/` (legacy build type), served at
<https://klayertan.github.io/michibiki-suimon-navi/>.

Worth knowing: the **previous** commit `54e7ba7` shows `status: errored`
("Page build failed") from 2026-08-17. That failure predates this work; this
push produced the first successful Pages build since `d0410a8`, so the live site
was serving stale content until now.

## 15. Live-site verification

Everything in §8–§12 was measured against the live deployed build, not a local
server. Additionally:

- All application JS/module requests returned **200**, including the four new
  `js/water/*.js` modules.
- Console errors are **exclusively** the drone panel polling its local MAVLink
  backend at `http://127.0.0.1:8787` (`/api/health`, `/api/drone/status`, and
  the telemetry WebSocket). That backend is a local-only Python service and is
  never expected to exist when the public site is opened. Pre-existing
  behaviour, unrelated to this integration, and the app renders correctly
  regardless.
- No errors from any water-management, layout or NMEA code path.

## 16. Remaining limitations

**Carried in from the completed briefs (documented, not regressions)**

- A map feature that sits directly beneath a floating rail is visually covered.
  `fitBounds` keeps *fields* clear, but a marker panned under a rail stays under
  it, and Leaflet's popup auto-pan does not know about the rails. A rail-aware
  `autoPanPadding` would be the fix.
- Rail widths (320 / 400px) are fixed, not fluid; below 981px the layout
  switches to the stacked mobile shell rather than narrowing.
- `--basic-summary-reserve` is a 200px constant; if `#mapWaterSummary` outgrows
  that band it scrolls internally rather than pushing the reservation.
- `backdrop-filter` blur has a real compositing cost over large areas.
- `suimonNaviCurrentWaterLevelV1` is deliberately **not** in
  `SCOPED_STORAGE_KEYS`: real installs already hold unprefixed values there, and
  listing it now would strand a signed-in farmer's existing readings. Consequence
  (pre-existing, unchanged): water-level readings are visible across accounts on
  a shared device. Fixing it needs a copy-on-first-scope migration.
- `maffCultivation` is a `link-only` source — the URL resolves but the 23-page
  image-only PDF could not be machine-read. A unit test asserts a link-only
  source is never the basis for a number.

**Scope boundaries, by design**

- No AWD recommendation algorithm, no ETc/water-balance term, no automatic gate
  control, and no arm/takeoff/RTL/throttle path in the drone integration.
- No RealSense / sensor / drone water-level capture — the `source` field is the
  seam, nothing more.

**Noted during integration, not acted on**

- The README rewrite dropped the older "Paddy Field Area Intelligence Demo"
  walkthrough sections (grid management, manual annotation, drone flight
  planning). Those features still exist in the app; this was the docs brief's
  deliberate restructure, left as delivered rather than reverted.
- The Pages build for `54e7ba7` had been failing since 2026-08-17 (§14). Cause
  not investigated — it is out of this integration's scope and is now moot,
  since `134ce69` builds cleanly.
- A stale local git worktree exists at `.claude/worktrees/great-benz-51b8fd`
  (branch `claude/great-benz-51b8fd` @ `7e4281e`). Ignored by git, untouched,
  and flagged only so it is not mistaken for part of this work.

## 17. Confirmation: no destructive git operations

No force push, reset, stash, checkout, revert, clean, or branch deletion was
used at any point. The complete set of git operations performed:

| Operation | Purpose |
|---|---|
| `git status` / `git diff` / `git diff --check` / `git diff --cached` | read-only review |
| `git rev-parse`, `git log`, `git show`, `git rev-list --left-right --count` | read-only inspection |
| `git worktree list` | read-only |
| `git add -- <20 explicit paths>` | staging — **never** `git add -A` or `git add .` |
| `git commit` | the single integration commit |
| `git fetch origin` | divergence check before pushing |
| `git push origin main` | normal fast-forward push, no `--force`, no `--force-with-lease` |

No existing work was discarded, reset, restored, checked out, stashed, cleaned
or overwritten. The interleaved `index.html` changes were kept intact in one
commit rather than split.

---

**Working tree after the push: clean.** `git status --short` returns nothing
except this report, which is intentionally left uncommitted — it documents the
commit it would otherwise have to precede.
