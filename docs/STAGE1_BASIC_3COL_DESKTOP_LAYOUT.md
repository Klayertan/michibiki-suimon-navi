# Stage 1: Basic Mode Desktop 3-Column Layout

基本モード desktop (`>=981px`) now uses a true 3-column grid instead of the
map + single-side-panel shell: 圃場の管理/今日の水門判断 in a left column,
the map centred, and NMEA upload/測量ログ/水管理/観察 action cards in a
right column. 設定/ドローンモード and mobile (`<=980px`) are unaffected —
they keep the original map + single-panel shell byte-for-byte.

This supersedes the desktop-layout limitation noted in
docs/STAGE1_FIELD_WATER_DASHBOARD.md §15 and the "keep 2-col shell" decision
recorded during that stage's build — the user explicitly asked for the
literal 3-column layout on 2026-08-18, and confirmed reversing the earlier
decision.

## Structure

The single `<aside class="panel">` (`index.html`) now wraps two inner
`<div>`s, `.panel-left` and `.panel-right`, split at exactly one cut point —
right after `.gate-card` (今日の水門判断):

- **`.panel-left`**: `#localImportPrompt`, `#basicFieldManagementCard`
  (圃場の管理, which already contains 現在の圃場/satellite thumbnail/
  registered-field list), `#decisionFieldCard` (設定-only), `.gate-card`.
- **`.panel-right`**: everything else that used to follow in the panel —
  NMEA upload (`#basicStage1Card` + `#basicFieldRegDialog`), 登録済み圃場・
  測量ログ (`#registeredFieldsPanel`), 水管理ポイント (`#waterControlPanel`),
  水位・観察を記録 (`#basicWaterRecordCard`), and every deeper 設定/ドローン
  card, unmoved relative to each other.

`.panel-left`/`.panel-right` are `display: contents` by default, so their
children render as direct grid items of `.panel` — 設定/ドローン and mobile
see the exact same flat single-scroll layout as before this split, with the
cut point invisible to them (splitting a DOM list into two containers that
both collapse via `display: contents` does not change the flattened visual
order). Only `body[data-mode="basic"]` at `@media (min-width: 981px)` turns
`.panel` itself `display: contents` and promotes `.panel-left`/
`.panel-right` into real, independently-scrolling boxes assigned to `main`'s
own 3-column grid (`320px minmax(0,1fr) minmax(380px,430px)`).

## Bug found and fixed during verification: map collapsed to 0px height

The first implementation (commit `093184f`) gave `.map-wrap`, `.panel-left`,
and `.panel-right` each a definite `grid-column` but left `grid-row`
implicit. Three items with definite-but-different columns and no definite
row do not reliably auto-place into a single implicit row: observed browser
behaviour split them across **two** implicit rows (`0px` + full height), and
because `.map-wrap` landed in the `0px` row, `#map`'s `height: 100%` resolved
to zero — the map silently failed to render at both 1920×1080 and 1366×768,
with only the floating overlays (basemap toggle, empty-state card) visible.

**Fix** (commit `d0410a8`): pin `main { grid-template-rows: minmax(0, 1fr) }`
and `grid-row: 1` on all three items explicitly, so there is exactly one row
regardless of auto-placement behavior — matching how the pre-existing
2-column shell has always relied on there being exactly one implicit row.

## Frosted-glass side panels

Per a follow-up request, `.panel-left`/`.panel-right`'s desktop-basic
background changed from solid `var(--bg)` to translucent + blurred:

```css
background: rgba(251, 250, 245, 0.82);
backdrop-filter: blur(6px);
-webkit-backdrop-filter: blur(6px);
```

Scoped the same as the rest of the 3-column override (`body[data-mode="basic"]`,
`>=981px` only) — 設定/ドローン/mobile keep the opaque `.panel` background
unchanged.

## `scrollWithinPanel()` fix

`js/fields/field-annotation-controller.js`'s `scrollWithinPanel()` previously
assumed a single `.panel` ancestor is always the scrolling container. With
the split, that flips depending on mode: on desktop 基本モード, `.panel`
itself is `display: contents` (not scrollable) and `.panel-left`/
`.panel-right` are the real boxes; everywhere else it's the reverse. Fixed to
find the closest `.panel-left`/`.panel-right` and fall back to `.panel` only
if that ancestor is computed `display: contents`.

## Regression check (before commit `d0410a8`)

All performed against a local static server, `body[data-mode]` switched via
the nav tabs (not full reloads, so mode-transition state was exercised too):

1. **Basic desktop, 1920×1080 and 1366×768**: real 3-column grid confirmed
   (`grid-template-columns: 320px <map> minmax(380px,430px)`), zero
   `document`/`panel-left`/`panel-right` horizontal overflow, both panels
   independently scroll their own content (`scrollHeight` > `clientHeight`
   on the right panel, as expected with its longer card list), map fills
   its full column height (no clipped overlays — basemap toggle, zoom
   control, `#waterQuickToolbar`, `#emptyState` all measured inside
   `.map-wrap`'s bounds).
2. **Mobile 390×844 and 393×852**: `main` is a single `390px`/`393px`
   column, `.panel`/`.panel-left`/`.panel-right` computed styles confirm
   the `display: contents` fallback is active (no 3-column CSS leak,
   `backdrop-filter: none`), and 今日の水門判断 still renders ahead of
   圃場の管理 (`order: -1`, unchanged) followed by NMEA upload in original
   relative order.
3. **設定 (desktop)**: `main` stayed 2-column (`1010px 430px`), `.panel`
   is the real scrolling box, `.panel-left`/`.panel-right` stayed
   `display: contents`, and `#decisionFieldCard` still renders before
   `.gate-card` — the exact pre-existing relative order.
4. **ドローンモード (desktop)**: same 2-column shell, same `display: contents`
   fallback, confirmed unchanged.
5. **NMEA upload placement**: `#basicStage1Card`'s nearest `.panel-left`/
   `.panel-right` ancestor is `.panel-right`, and its rendered bounding box
   falls entirely inside the right column's bounds at desktop widths.
6. **`scrollWithinPanel()` container resolution**, checked in all 5
   contexts (basic-desktop left, basic-desktop right, 設定, ドローン,
   mobile): resolves to `.panel-left`/`.panel-right` only where one of them
   is the real (non-`contents`) box, otherwise falls back to `.panel` —
   matches design in every context.

## Tests

- `npm test`: 325/325.
- `npx playwright test` (full suite, all `tests/browser/*.spec.js`):
  299/299, including `field-annotation.spec.js:862` ("clicking workflow step
  buttons that scroll never moves documentElement/window — only .panel
  scrolls") and `:851` ("hidden panels ... occupy zero layout height"),
  which directly exercise the `scrollWithinPanel()` code path touched by
  this change.
- `git diff --check`: clean (no whitespace errors).

## Files changed

- `index.html` — `.panel-left`/`.panel-right` split (commit `093184f`);
  `grid-template-rows`/`grid-row` pin and frosted-glass background (commit
  `d0410a8`).
- `js/fields/field-annotation-controller.js` — `scrollWithinPanel()` made
  layout-aware (commit `093184f`).
- `docs/STAGE1_FIELD_WATER_DASHBOARD.md` — §15 limitation note marked
  superseded (this commit's docs update).

## Git information

- Starting commit: `77449ca` ("feat(stage1): polish map water dashboard
  layout").
- Base 3-column implementation: `093184f` ("true 3-column desktop layout").
- This work (row-collapse fix + frosted-glass panels + docs): `d0410a8`
  ("fix(stage1): pin desktop 3-col grid row and add frosted-glass side
  panels"), on `main`.
- Pushed to `origin/main` as a normal fast-forward (`093184f..d0410a8`), no
  force push, no divergence with origin at push time.

## Deployment

GitHub Pages serves `main` directly (`build_type: legacy`, `source:
main:/`). Build for commit `d0410a8` completed with `status: "built"` (~22s
build time). Verified live at
https://klayertan.github.io/michibiki-suimon-navi/index.html: `.map-wrap`
renders at full column height (no collapse) and `.panel-left`'s computed
background/`backdrop-filter` match the frosted-glass values above, at
1920×1080.
