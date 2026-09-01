# Stage 1: Basic Mode Map/Layout Polish

Desktop-only layout polish on top of the field water management dashboard
(docs/STAGE1_FIELD_WATER_DASHBOARD.md): the main map's zoom control moves to
bottom-right, the freed upper-left corner gets a compact 今日の水門判断
read, and the right panel's horizontal drag/overflow is fixed at its actual
root cause. Mobile (≤980px) is treated as a regression-protected surface,
not a redesign target.

## Root cause of the horizontal scroll

`.panel` and `.card` are CSS Grid containers. Grid items default to
`min-width: auto`, which refuses to shrink below the intrinsic width of
their content. The mini-card carousel (`#waterHeroCarousel`, a flex row with
`overflow-x: auto`) is a grid item three levels deep (`.panel` > `.card` >
carousel); once it held 3+ field cards, its intrinsic content width exceeded
the panel's box, and because nothing in the chain could shrink, `.panel`
itself grew wider than the viewport instead of letting the carousel's own
scrollbar contain it. This affected desktop AND mobile equally (mobile just
happened not to have been tested with 3+ registered fields) — buttons like
航空写真 were cut off the right edge of the screen on a phone too.

**Fix:** `.card { min-width: 0; }` (index.html:283) lets every card in the
grid shrink to its actual track width. No `overflow-x: hidden` masking
anywhere — the carousel's pre-existing `overflow-x: auto` now works exactly
as designed, containing its own scroll instead of blowing out its ancestors.
This single fix eliminates the page/panel-level overflow on both desktop
and mobile, while leaving mobile's carousel *visually and behaviorally*
identical (still `display: flex`, still horizontally swipeable).

## Desktop-only field-selector grid

Above 980px (`@media (min-width: 981px)`, matching the app's existing
breakpoint), `#waterHeroCarousel` switches from `display: flex; overflow-x:
auto` to `display: grid; grid-template-columns: repeat(auto-fit,
minmax(120px, 1fr))` — cards wrap into rows instead of requiring a
horizontal drag. Mobile is untouched below that breakpoint.

## Zoom control

`L.map("map", { zoomControl: false })` + `L.control.zoom({ position })`
added via Leaflet's own control API (not CSS relocation). Position is
`"bottomright"` above 981px and `"topleft"` (Leaflet's original default,
unchanged) at or below it, kept in sync across the breakpoint via
`window.matchMedia("(min-width: 981px)")` and `control.setPosition()`. The
field satellite thumbnail already had `zoomControl: false`; nothing changed
there.

## Map-corner water summary (`#mapWaterSummary`, desktop only)

A compact card, upper-left of the main map, hidden entirely below 980px
(`display: none !important` inside the mobile media query, regardless of
its own `hidden` state). It is a **read**, not a second decision engine:
`renderMapWaterSummary(field, need, decision)` is called from inside
`renderWaterHero()` (index.html) with the exact `need`/`decision` values
that render already computed for the full hero — no recomputation, no
second call into `computeWaterNeed()` or `evaluateGate()`. Changing the
active field anywhere updates both surfaces from that one render pass.

Two defects surfaced and were fixed during implementation:
1. The card intercepted clicks meant for whatever was on the map beneath
   it. Fixed with `pointer-events: none` on the card and `pointer-events:
   auto` only on its own button.
2. A marker popup could still open at the same screen position as the
   card's button specifically (not just its background), which the
   pointer-events split alone didn't cover. Fixed by listening for
   Leaflet's own `popupopen`/`popupclose` map events and toggling a
   `.map-water-summary-yield` class (`display: none !important`) so the
   card steps aside completely while any popup is open.

## Files changed

- `index.html` — `.card{min-width:0}`, desktop carousel-grid media query,
  zoom-control construction/positioning, `#mapWaterSummary` markup/CSS/JS
  (`renderMapWaterSummary`, popup yield listeners).
- `tests/browser/basic-map-layout-polish.spec.js` — new, 16 tests across
  1366×768/1920×1080/1280×900 (desktop) and 390×844/393×852 (mobile
  regression checks), geometry-based (`scrollWidth`/`clientWidth`), not
  CSS-string assertions.
- `tests/browser/basic-ux-consolidation.spec.js` — one assertion narrowed
  to `.gate-card` (the map summary legitimately repeats the "今日の水門判断"
  heading text as a compact read of the same card).

## Tests

`npm test`: 325/325. `npx playwright test`: 299/299 (two consecutive clean
runs). One test (`field-annotation.spec.js`'s water-control marker deletion
case) surfaced the popup/pointer-events regression above during
development; it is green and reproducibly stable now.

## Known limitations

- The map-corner summary's "実施目安" timing label reuses the same simple
  heuristic as the full hero (today〜明日 / 現地で確認) — no new logic.
- Breakpoint for "desktop" is 981px, matching the app's existing
  `max-width: 980px` convention rather than a new value.
