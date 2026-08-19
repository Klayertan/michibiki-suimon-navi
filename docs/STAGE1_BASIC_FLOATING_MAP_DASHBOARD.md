# Stage 1: Basic Mode Floating Map Dashboard (desktop)

Desktop 基本モード (`>=981px`) is now a **map-first** workspace: the Leaflet
map is the full-bleed canvas of the whole area below the header, and the two
panel groups float **on top of it** as translucent cards. Map imagery is
visible outside both rails and between them, so the map reads as one
continuous surface rather than a middle column.

`設定` and `ドローンモード` are untouched. Mobile (`<=980px`) keeps the map +
single scrollable `.panel` shell exactly as before, with **one deliberate,
separately-requested exception**: the NMEA upload moves into the header (see
"Phone-only: NMEA upload in the header" below).

## Why the previous 3-column layout was not enough

docs/STAGE1_BASIC_3COL_DESKTOP_LAYOUT.md introduced a literal
`320px | map | 430px` grid. It put the right content on the right, but it
still *read* as three columns: the map was a middle track bounded by two
opaque, full-height beige strips running edge to edge. Nothing of the map
existed behind the panels, because the map's box genuinely stopped at the
column boundary.

## New architecture: one grid cell, three layers

All three items now share a single grid cell and are separated by z-index
instead of by column:

```
main (grid: 1 col x 1 row)
 └── grid-area 1/1
      ├── .map-wrap   z-index: 0   <- full bleed, own stacking context
      ├── .panel-left  z-index: 1  <- floats, justify-self: start
      └── .panel-right z-index: 1  <- floats, justify-self: end
```

- `body[data-mode="basic"] main` collapses to
  `grid-template-columns: minmax(0, 1fr)` / `grid-template-rows: minmax(0, 1fr)`.
  The row stays explicit for the same reason as the 3-column version: items
  with a definite `grid-area` never depend on auto-placement, so
  `.map-wrap`'s `height: 100%` always has a definite row and cannot collapse
  to 0px.
- `.map-wrap` takes `grid-area: 1 / 1; z-index: 0`. The `z-index: 0` is
  load-bearing, not cosmetic: it makes `.map-wrap` a **stacking context**, so
  every Leaflet pane inside it (tiles 200 … markers 600, popups 700, controls
  800) is contained *below* the rails' `z-index: 1`. Without it those panes
  leak into `main`'s stacking context and render straight through the frosted
  cards.
- `aside.panel` becomes `display: contents` so `.panel-left` / `.panel-right`
  are promoted to `main`'s own grid items.

Rail geometry is driven by custom properties on `main`, so the rails and
every piece of map chrome that must dodge them can never drift apart:

```css
--basic-rail-left-width: 320px;
--basic-rail-right-width: 400px;
--basic-rail-inset: 20px;
--basic-rail-left-clear:  calc(left-width  + inset + 12px);
--basic-rail-right-clear: calc(right-width + inset + 12px);
--basic-summary-reserve: 200px;
```

## The rails are transparent; the cards are the glass

The rail element itself has **no background and `pointer-events: none`**. It
is only a scroll container and a column of positions. Each `.card` inside it
opts back in with `pointer-events: auto` and carries the frosted treatment.

Two things fall out of this, both intended:

1. Visually these read as **separate floating cards stacked vertically**
   (Option B in the brief), not one long translucent slab — and no card ends
   up nested inside a second card.
2. The map stays **clickable in the gaps between cards**, even inside the
   rail's own box. There is no invisible full-screen overlay anywhere; the
   only thing that intercepts a pointer is a card you can actually see.

```css
background: rgba(251, 250, 245, 0.84);
backdrop-filter: blur(8px) saturate(110%);
-webkit-backdrop-filter: blur(8px) saturate(110%);
border: 1px solid rgba(24, 49, 40, 0.12);
border-radius: 16px;
box-shadow: 0 8px 28px rgba(24, 49, 40, 0.14);
```

**Fallback.** Where `backdrop-filter` is unsupported, the same 0.84 alpha
would let map imagery read through the text, so an `@supports not (...)`
block raises the card to `rgba(251, 250, 245, 0.97)` — the project's usual
off-white, just without live blur. Text legibility never depends on the
filter being available.

## Panel contents

Unchanged from the 3-column layout; only the presentation moved.

- **Left rail (320px)** — 圃場の管理 (`#basicFieldManagementCard`: register
  button, 現在の圃場 selector, satellite thumbnail, field metadata, water
  points, observations, registered-field list) and 今日の水門判断
  (`.gate-card`, the full quantitative hero).
- **Right rail (400px)** — NMEAをアップロード (`#basicStage1Card`) plus
  登録済み圃場・測量ログ, 水管理ポイント, 水位・観察を記録.

**NMEA upload is on the RIGHT** and is asserted there geometrically at all
three desktop widths (`inRightRail === true`, `inLeftRail === false`, and its
rect inside the right rail's box).

`現在の圃場` stacks in the left rail
(`.basic-field-current { grid-template-columns: minmax(0, 1fr) }`): its
`190px + metadata` two-up was sized for the old ~380–430px panel and starved
the metadata column inside a 320px rail. Stacked, the satellite preview gets
the rail's full width and every metadata row has room.

## Map chrome placement

| Element | Desktop 基本モード position |
|---|---|
| Leaflet zoom `+/-` | bottom-right, unchanged (`control.setPosition`), with the whole `.leaflet-bottom.leaflet-right` corner inset by the right rail's width so it is never underneath it |
| Attribution | same bottom-right corner, so the same single inset covers it |
| 地図 / 航空写真 toggle | top, inset from the right by `--basic-rail-right-clear` |
| 水管理ポイント toolbar | bottom, inset from the left by `--basic-rail-left-clear` |
| `#mapWaterSummary` | top of the free band, at `--basic-rail-left-clear`, capped to `--basic-summary-reserve` |
| `#emptyState` | centred **on the free band between the rails**, below the toggle's row |

The zoom control is *not* recreated or duplicated — Leaflet still owns it at
`bottomright`; only the corner container is inset via CSS margin.

`#emptyState` was previously centred on the viewport. With a full-bleed map
the viewport centre is no longer the centre of the usable canvas, and at
1366px the 420px card landed underneath the 地図/航空写真 toggle. It is now
centred on the gap and dropped below the toggle's band.

## Phone-only: NMEA upload in the header

Requested separately from the floating-rail work, and the one intentional
change to the mobile layout: at `<=980px` in 基本モード the NMEA upload sits in
the header **immediately to the left of 使い方**, so it is reachable without
scrolling the panel.

- `#headerNmeaUploadButton` is a `<button>`, **not** a second
  `<input type="file">`. It forwards its click to the single existing
  `#basicNmeaInput`. There is still exactly one NMEA input in Basic mode, so
  the parse/register flow, the deliberate absence of an `accept` filter (the
  iOS picker bug) and every existing test binding stay on that one element.
- The card's own `.basic-upload-button` is `display: none` at `<=980px`, so
  there is exactly **one** upload affordance per viewport — matching the
  app's existing "exactly one X" conventions (one help control, one verdict
  surface, one active-field selector). `#basicStage1Card` itself stays: it
  still carries the 測位点 count, the rejection message and the boundary
  picker, and it still contains `#basicNmeaInput`.
- Gated on `body[data-mode="basic"]` rather than a `data-mode` attribute on
  the element. The mode gate works by rolling `display` back to the UA
  default, which would fight an author `display` rule — the same trap
  documented above `<main>`.
- Styled as a 44x44 pill matching 使い方, and it drops its "NMEA" wording at
  `<=480px` exactly as 使い方 drops its label, keeping both as bare icons on
  a 390/393px header.
- Desktop is unaffected: the header control is `display: none` above 980px
  and the upload stays in the right rail's 圃場を登録する card.
- The ドローンモード -> "圃場を測る" handoff focuses whichever upload control is
  actually rendered, since the card's button is `display: none` on phones.

## Redundant register button removed; map empty-state tied to registered fields

Two related fixes, requested separately, to `#basicFieldManagementCard` and
the map's `#emptyState` overlay:

**`#basicMeasureFieldButton` ("＋ 新しい圃場を測る・登録する") removed.** Its
click handler only ever scrolled to `#basicStage1Card` and focused the NMEA
input there -- with that card now permanently visible in the right rail
(desktop) and reachable from the header (mobile), a second entry point that
just jumped to the first was pure duplication. The dangling
`onRequestNewField: () => document.getElementById("basicMeasureFieldButton")?.click()`
forwarding (already dead in practice -- its only other caller,
`accountFieldsNewButton` in `js/auth/auth-controller.js`, binds to an element
ID that does not exist anywhere in `index.html`) was removed alongside it.

**`#emptyState` ("QZ1ログが未読込です") now reflects registered fields, not
just this session's live track.** Previously its visibility was driven
entirely by `parsedPoints.length > 0 || phonePoints.length > 0` -- ephemeral,
session-only arrays that reset to empty on every reload. A returning farmer
with real, persisted fields therefore saw "no data" plastered over their own
field every time they opened the app, because the registered-field polygons
render through a completely separate path
(`fieldAnnotationController`/`renderMapLayers()`) that this check never
looked at.

Fixed with one shared `updateEmptyStateVisibility()`, called from both
existing render sites (`renderPoints()`, the phone-points renderer) and from
`onFieldsChanged` (which `FieldAnnotationController.renderAll()` already
calls at the end of mount, registration, deletion, and import alike -- so
this needs exactly one hook, not one per mutation):

```js
function updateEmptyStateVisibility() {
  const hasFields = (fieldAnnotationController?.fields?.length ?? 0) > 0;
  emptyState.hidden = parsedPoints.length > 0 || phonePoints.length > 0 || hasFields;
}
```

The default copy is now mode-aware: 基本モード gets the farmer-facing
"圃場はまだ登録されていません" / "NMEAをアップロードしてください" (設定/ドローン
keep the fuller technical copy, since 現地測量ワークフロー also offers 測量JSON
as an entry point that Basic does not expose). `switchMode()` calls
`resetEmptyState()` on every transition so the wording is never stale after a
tab switch or deep link, immediately followed by `updateEmptyStateVisibility()`
to re-derive the correct hidden state -- `setEmptyState()` forces the card
visible as a side effect (see below), so the second call is what prevents
that from sticking when it shouldn't.

**Error messages still surface even when fields already exist.** A parse
failure or rejected upload calls `setEmptyState(title, detail)` with its own
message; that function now also does `emptyState.hidden = false` explicitly,
rather than depending on the incidental fact that a failed parse leaves
`parsedPoints.length === 0`. Without this, the fields-aware visibility rule
above would have silently swallowed every rejection message for any farmer
who already had one registered field -- verified directly: uploading a
garbage file with a field already registered still shows "NMEAデータを確認
できませんでした" (`emptyState.hidden === false`).

## fitBounds must know about the floating chrome

With the map running underneath the rails, the container's centre is no
longer the centre of what the farmer can see, so fitting a field to the raw
container parks part of the polygon behind a rail — and behind the bottom
map-summary card.

Rather than patch each of the several `fitBounds()` call sites (and every
future one), padding is injected **once**, right after the map is created, by
wrapping `map.fitBounds` and merging Leaflet's own
`paddingTopLeft` / `paddingBottomRight` options computed from the rails' live
measured geometry:

- Outside desktop 基本モード the rails are `display: contents`,
  `floatingChromeInset()` returns `null`, and every call behaves exactly as
  before.
- A caller's own `padding` is preserved — the larger of the two wins per
  axis — so nothing loses breathing room it asked for.
- The top inset reserves the **whole `--basic-summary-reserve` band, not the
  summary's live rect**. The fit normally runs while the card is still hidden
  (it is only revealed once `renderWaterHero()` has a field to describe), so
  measuring it there would reserve nothing and drop the field exactly where
  the card is about to appear. Reserving a CSS-declared constant makes this
  deterministic instead of timing-dependent.

This is the only JavaScript change in this stage. No decision logic was
touched: `computeWaterNeed()`, `evaluateGate()`, weather state, and the
single active-field state are all untouched, and there is still exactly one
water-decision engine feeding both the hero and the map summary.

## Scrolling

- The map is a fixed canvas; the page itself never scrolls in either axis.
- Each rail scrolls independently (`overflow-y: auto`, capped by
  `max-height: calc(100% - 2 * inset)`).
- Verified by geometry, not CSS strings: setting `.panel-right.scrollTop`
  moves the rail while `documentElement.scrollTop` and `body.scrollTop` stay 0.
- No `overflow-x: hidden` was added anywhere. The horizontal overflow found
  during this work was fixed at its actual cause (see below).

`scrollWithinPanel()` (js/fields/field-annotation-controller.js) was already
made layout-aware in the previous stage — it walks past any `display: contents`
wrapper to whichever of `.panel` / `.panel-left` / `.panel-right` is the real
scrolling box. That logic is unchanged here and still resolves correctly in
desktop Basic (left and right), Settings, Drone, and mobile.

## Pre-existing horizontal overflow, fixed

The new long-name/long-filename test surfaced a rail overflow. It is **not a
regression from this change** — measured against the starting commit
`54e7ba7` the same case overflowed by **158px**, worse than the 139px seen
here. Root causes, all fixed at the sizing level:

1. `.input-row` / `.input-row input, select` — grid items default to
   `min-width: auto`, and a `<select>`'s min-content is the width of its
   **longest option**, so one long 圃場名 made `#basicActiveFieldSelect` ~440px
   wide. Fixed with `min-width: 0` (same root cause as the existing
   `.card { min-width: 0 }`).
2. `.kv strong` — a long unbroken NMEA filename has no wrap opportunity, so
   its min-content became the min-content of the whole 圃場の管理 grid track.
   Fixed with `min-width: 0; overflow-wrap: anywhere`.
3. `#basicFieldCurrentGroup` and `.basic-field-current` — `min-width: 0` and
   `minmax(0, …)` tracks so the group can shrink inside a fixed-width rail.

Final measured horizontal overflow in both rails: **0px**.

## Files changed

- `index.html` — the `@media (min-width: 981px) body[data-mode="basic"]`
  floating block (rails, frosted cards, `@supports` fallback, chrome insets,
  summary/empty-state repositioning); `.input-row` and `.kv strong`
  `min-width`/`overflow-wrap`; `floatingChromeInset()` + the `map.fitBounds`
  wrapper.
- `css/stage1-basic.css` — `#basicFieldCurrentGroup { min-width: 0 }` and
  `.basic-field-current` `minmax(0, …)` tracks.
- `tests/browser/basic-floating-map-dashboard.spec.js` — new, 32 tests.
- `tests/browser/stage1-basic-workflow.spec.js` — the mobile touch-target
  check now measures `#headerNmeaUploadButton` instead of
  `.basic-upload-button`, because on phones that is where the upload now is.
  Still asserted at >=44px; nothing was relaxed.

## Tests

- `npm test`: **393 / 393**.
- `npx playwright test` (full suite): **346 / 346**.

  At integration time one spec failed, and it was **not** a regression from
  this stage: `basic-field-water-dashboard.spec.js` "the 3-day forecast row
  renders today/tomorrow/day-after". Its Open-Meteo mock hardcoded an 11-day
  series 2026-08-10 … 2026-08-20 commented "8 days before today", so it only
  held while the local date was <= 2026-08-18. The hero slices
  `today … today+2`, so from 2026-08-19 the mock could supply only two days and
  `toHaveCount(3)` failed. **Fixed as a test-fixture bug**, in the fixture
  only: the window is now built relative to the day the test runs
  (`MOCK_PAST_DAYS` before today through `MOCK_FORECAST_DAYS` after, emitted a
  calendar day at a time so DST cannot shear the buckets), with two spare tail
  days so it cannot expire again. The assertion is unchanged — still three
  days, still 今日/明日/明後日 — and no production forecast behaviour was
  touched.
- `tests/browser/basic-floating-map-dashboard.spec.js` (this stage): **32 / 32**
  (24 floating-layout + 8 for the phone header upload).
- `tests/browser/basic-map-layout-polish.spec.js`: 14 / 14, with **no
  assertion weakened**. Its "the map summary does not obscure the field
  polygon" case genuinely broke mid-implementation and was fixed by the
  fitBounds work above, not by relaxing the test.
- New spec is geometry-based throughout (measured rects, `elementFromPoint`
  hit-testing, real `page.mouse.click`), never CSS-string assertions.

Coverage includes: map full-bleed and rails strictly inside it at 1920×1080 /
1366×768 / 1280×900; tiles actually present underneath both rails; rail
pointer-transparency vs card interception; a real map click placing a water
point; a real marker click opening a popup and its 削除 button completing a
delete through the `confirm()` dialog; all map chrome clear of both rails;
zoom bottom-right and inset; NMEA upload in the right rail; independent rail
scrolling; zero / one / four fields; long field name and long NMEA filename;
and regression guards proving mobile 390×844 / 393×852, 設定 and ドローン keep
the stacked / side-by-side shells with no floating, z-index, pointer-events
or backdrop-filter leak.

## Viewports actually verified

Measured in a real browser, not inferred: **1920×1080**, **1366×768**,
**1280×900**, **390×844**, **393×852**, plus 設定 and ドローン at 1440×900.

## Known limitations

- A map feature that happens to sit directly beneath a floating rail is
  visually covered. `fitBounds` keeps *fields* clear of the rails, but a
  marker the farmer pans under a rail is still under it. Leaflet's popup
  auto-pan does not know about the rails either, so a popup opened from such
  a marker can be partially covered until the map is panned. Panning is the
  workaround; a rail-aware `autoPanPadding` would be the fix.
- Rail widths (320px / 400px) are fixed, not fluid. Below 981px the layout
  switches to the stacked mobile shell rather than narrowing the rails.
- `backdrop-filter` blur has a real compositing cost on large areas; the
  blur radius is kept at 8px partly for that reason.
- `--basic-summary-reserve` is a constant (200px). If `#mapWaterSummary`'s
  content ever grows past that band it will scroll internally rather than
  push the reservation, by design.
