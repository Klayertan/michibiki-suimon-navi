# Stage 1: Field Water Management Dashboard

Basic Mode (基本モード) redesigned around one field-management card and a
quantitative water-need hero, so a farmer can answer three questions in
about five seconds: which 圃場 am I looking at, what is happening there, and
how much water should I add or remove today.

## 1. Design goal

The previous Basic Mode showed field registration, the active field's
metadata, and the gate verdict as three separate, disconnected cards, and
the verdict itself was purely categorical (開ける/閉じる/様子見) with no
numeric water amount. This redesign:

- Merges field registration + the active-field context + the registered-field
  list into one 圃場の管理 card.
- Makes 今日の水門判断 the visual center of Basic Mode, and gives it a
  quantitative primary message ("水を 2.3 cm 入れてください") with the
  existing categorical verdict kept as a secondary "推奨操作" line.
- Adds a small satellite thumbnail of the selected field, and a compact
  multi-field summary carousel so a farmer with several paddies can scan all
  of them at once.

## 2. Old vs. new Basic layout

**Old**: あなたの圃場 (signed-in tile list, hidden for guests) → 現在の田圃
(active field + metadata) → 対象圃場/使用データ (Settings-only) → gate-card
(categorical verdict only).

**New**: 圃場の管理 (register button + active-field selector + satellite
thumbnail + metadata + registered-field list, for guests and signed-in
farmers alike) → 今日の水門判断 (multi-field mini-cards + quantitative hero +
weather + secondary verdict).

The app's outer shell (map + one scrollable right panel) is unchanged — this
was a deliberate scope decision to avoid rewriting the main grid and every
absolutely-positioned map overlay for a literal 3-column layout. Prominence
comes from card order and size, not from a new page structure.

## 3. Single active-field model

Unchanged: `#basicActiveFieldSelect` (backed by localStorage key
`suimonNaviActiveFieldV1`) remains the one authoritative active field.
Three surfaces now drive it — the dropdown, a registered-field list row, and
a 今日の水門判断 mini-card — and all three converge on the same
`"change"` event cascade that already fanned out to every other dependent
surface (map highlight, decision context, water-quick-toolbar, weather).

`js/auth/auth-controller.js`'s `renderAccountFields()` (formerly gated to
signed-in users only) now renders unconditionally, since the merged
registered-field list is shown to guests and signed-in farmers alike; it
stays hidden only when there are zero fields, to avoid a second "no fields"
message directly under 圃場の管理's own empty state.

## 4. Satellite-preview implementation

A second, small `L.map()` instance (`#basicFieldThumbnail`,
~190×130px desktop) using the same GSI seamless aerial-photo tile source as
the main map's 航空写真 toggle
(`cyberjapandata.gsi.go.jp/xyz/seamlessphoto`). Interaction controls
(`dragging`, `scrollWheelZoom`, `zoomControl`, etc.) are disabled at
construction so it cannot steal scroll/touch from the surrounding page. It
is built once and re-fit (`fitBounds` with 8px padding) only when the active
field id actually changes, not on every render pass, to avoid unnecessary
tile/network work.

## 5. Field-list behavior

The registered-field list (`#accountFieldsList`, reused from the former
あなたの圃場 tiles) and the hero's mini-card carousel are two different,
intentionally allowed summaries: the list is name + area, always visible;
the carousel is name + water need, shown only with 2+ fields. Both drive the
same active-field selection path — neither is a second field store.

## 6. Water-depth calculation

`js/water/water-need.js` — a pure, DOM-free module:

```
requiredDepthCm = targetWaterLevelCm - currentWaterLevelCm
```

`targetWaterLevelCm` was already persisted per field
(`suimonNaviTargetWaterLevelV1`). `currentWaterLevelCm` was previously typed
into an observation field and never saved — this stage adds
`suimonNaviCurrentWaterLevelV1`, written the moment the farmer types into
水位 (cm・任意), timestamped, so a real deficit can be computed and its
staleness tracked. Both stores are namespaced through the existing
`accountScopedStorage` wrapper.

No agronomic target is invented: with either value missing, the module
returns `direction: "unknown"` and the hero shows "現在の水位を記録すると、
必要な入水量を計算できます。" instead of a fabricated number.

## 7. Water-volume formula

```
volumeLiters = areaM2 * requiredDepthCm * 10   (1 mm over 1 m² = 1 L)
volumeM3 = volumeLiters / 1000
```

Example: 4,286 m² × 2.3 cm → 4,286 × 2.3 × 10 = 98,578 L = 98.578 m³,
displayed as "約 98.6 m³" (rounded to 1 decimal m³; depth rounded to 1
decimal cm). Volume is always reported as a positive amount to move — for
"remove" the magnitude of the deficit is used, never a negative number.

## 8. Exact units

- Depth: cm, 1 decimal.
- Area: m² (primary), with a / ha shown alongside (existing `formatAreaBasic`).
- Volume: m³ (primary, 1 decimal) — chosen over L because a paddy-scale
  volume in liters reads as five to six digits and is easy to misread; L is
  not hidden, just not the lead unit.

## 9. Weather integration

`fetchLiveWeather()` now resolves its coordinates from
`activeWeatherLocation()`: the active field's polygon centroid (a plain
vertex average — adequate for a weather lookup, not reused for area/geometry
math) when available, falling back to the registered gate, then the Nara
demo constant, exactly as before this existed. A short-lived in-memory
`Map` (10-minute TTL, keyed by field id) avoids refetching Open-Meteo on
every toggle between a farmer's few fields within one session. The
`forecast_days` parameter moved from 2 to 3 (Open-Meteo counts today as day
1) so the hero's 今日/明日/明後日 row has three real days instead of two.

## 10. Stale/missing measurement behavior

- Missing current or target level: `direction: "unknown"`, no volume
  shown, no fabricated 0 cm.
- A current-level reading ≥3 days old (a presentation-only threshold, not an
  agronomic validity cutoff) sets `isStale: true`: the hero shows "最終水位
  記録: N日前 — この水位記録は古い可能性があります。現地で確認してくださ
  い。" and 信頼度 drops from 高 to 低. The number is still shown — the
  farmer is warned, not blocked.

## 11. Multiple-field summary

With 2+ registered fields, a horizontal-scrolling mini-card row appears
above the hero: each card shows the field name, its delta ("+2.3cm",
"−4.0cm", "維持", or "水位未記録") and its volume when known. Clicking a
card sets that field active through the same selection path as the dropdown
and the registered-field list row — there is exactly one active-field state
in the whole app.

## 12. Mobile design

Below 980px, the map keeps its existing 45dvh top slot and the panel scrolls
below it (unchanged shell). Within that panel, 今日の水門判断 is reordered
(`order: -1`) ahead of 圃場の管理, so the water recommendation is the first
thing a farmer sees under the map, matching the product intent even though
the map itself could not be relocated within this stage's scope. The
satellite thumbnail stays visible rather than becoming a disclosure trigger
— the panel already scrolls independently, so the extra height was judged
not to warrant a second interaction just to see the imagery.

## 13. Files changed

- `js/water/water-need.js` — new, pure water-need calculation.
- `index.html` — merged left card + hero markup, current-water-level store,
  field-centroid weather + cache, thumbnail map, `renderWaterHero()` and
  supporting render functions.
- `css/stage1-basic.css` — new styles for the merged card and hero.
- `js/auth/auth-controller.js` — `renderAccountFields()` no longer gated to
  signed-in users; hidden only with zero fields.
- `tests/browser/stage1-navigation-basemap.spec.js`,
  `tests/browser/basic-ux-consolidation.spec.js`,
  `tests/browser/auth-cloud-fields.spec.js` — updated for the renamed/merged
  card id and copy (`#basicFieldSummaryCard` → `#basicFieldManagementCard`,
  "あなたの圃場" → "登録済みの圃場", the folded-in register button, and the
  verdict badge now living inside the hero's field-gated content).
- `tests/unit/water-need.test.js`, `tests/browser/basic-field-water-dashboard.spec.js` — new tests.

## 14. Tests

- `npm test` — 325 passing (314 pre-existing + 11 new `water-need.test.js`
  cases: the 4,286 m² × 2.3 cm example, hold/add/remove directions, missing
  current/target/area inputs, an explicit `Number(null)`/non-numeric guard
  case, rounding, non-negative volume, and staleness).
- `npx playwright test` — 285 passing (274 pre-existing + 11 new
  `basic-field-water-dashboard.spec.js` cases covering the zero/one/multiple
  field states, the three convergent selection paths, weather following the
  field's centroid, the 3-day forecast row, staleness, reload persistence,
  and an explicit "exactly one selector / exactly one hero" assertion).
  Weather is mocked via Playwright route interception on
  `api.open-meteo.com` — no live network calls in the suite.

## 15. Limitations

- The required-water volume is a **geometric standing-water estimate only**:
  `area × depth`. It does not model soil infiltration, leakage, evaporation,
  or hydraulic delivery losses, and the hero's own disclaimer says so.
- The 3-day-stale threshold and the 実施目安 timing label ("今日〜明日" /
  "現地で確認") are presentation heuristics, not agronomic thresholds.
- **Superseded 2026-08-18** by docs/STAGE1_BASIC_3COL_DESKTOP_LAYOUT.md: the
  desktop layout now IS a literal 3-column grid (圃場管理/今日の水門判断 left,
  map centre, NMEA upload/action cards right). Mobile is unaffected by that
  change and keeps the ordering described here (hero first in the panel,
  panel below the map's fixed 45dvh slot).
- The known session-id collision when two fields are registered inside the
  same second (documented separately, pre-existing) can still cause a
  freshly registered field to briefly show the previous field's source-file
  metadata; this stage did not touch it.

## 16. Screenshots

See the chat session for verified renders at 1920×1080/1366×768 (2-field
carousel + quantitative hero + satellite thumbnail) and 390×844/393×852
(hero ordered ahead of 圃場の管理).

## 17. Git information

- Starting commit: `1e187f5` ("fix(auth): correct sync-chip spacing and
  reported unit test count").
- This work: `0ccd062` ("feat(stage1): add field water management
  dashboard"), on `main`.
