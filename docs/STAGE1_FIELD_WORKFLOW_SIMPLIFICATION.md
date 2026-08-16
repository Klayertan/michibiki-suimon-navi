# Stage-1 Field Workflow Simplification

Basic mode (基本モード) rebuilt around the Stage-1 field workflow:
**QZ1/NMEA → boundary → polygon → area → register 田圃 → water management.**

Target: a farmer with an iPhone standing in a paddy, who has not read a manual.

---

## 1. Executive summary

Basic mode was showing the whole engineering surface of the app. Before this
change, a farmer opening 基本モード saw a five-step 現地調査ワークフロー
checklist, a full QZ1 survey-tools card (JSON import/export, layer filters,
parse-quality counters), a registration dialog that asked them to classify
their walk as a polygon / a boundary track / a set of water points, and a
Field Recording card exposing WebSerial, baud rate, session IDs and HDOP.

Three things changed:

1. **The technical surfaces moved to 設定.** Nothing was deleted. The workflow
   checklist, survey tools, the legacy registration dialog and the whole Field
   Recording card are all still there, still working, under 設定 → その他の機能.

2. **The farmer now chooses the boundary.** Registration used to consume the
   entire recording, which includes walking *to* the paddy and walking away
   again — producing a polygon closed across the approach leg and a confusing
   "始点と終点が離れています（距離：約26.5m）" prompt. The farmer now taps two
   existing measured points to say where the boundary starts and ends.

3. **Registration is field-only.** Name, memo, register. The ID is generated
   and unique, so `ID "paddy-005" は既に使用されています。` cannot occur.

Everything is additive against the stored data model: no schema, coordinate
convention, area algorithm, or parser semantics changed.

---

## 2. Before vs after UX

| Surface | Before (Basic mode) | After (Basic mode) |
|---|---|---|
| 現地調査ワークフロー | Five-step checklist card, always expanded, growing less relevant with every field registered | A single `? 使い方` button; the checklist is intact in 設定 → 圃場データ |
| Loading QZ1 data | `survey-tools` card: NMEA upload + 測量JSON import/export + 現在地 + スマホGPS + 4 layer checkboxes + 6 parse counters | One `NMEAをアップロード` button and a `測位点 N` count |
| Choosing the boundary | None — the whole recording was the polygon | `開始点` / `終了点`, each picked by tapping a measured point on the map; `選択範囲 N点（測位点a 〜 測位点b）` |
| Closure prompt | `始点と終点が離れています。このログを圃場ポリゴンとして閉じますか？（距離：約26.5m）` with three buttons: ポリゴンとして閉じる / 境界トラックとして保存 / キャンセル | `開始点と終了点は約26.5m離れています。` / `この2点を結んで圃場を作りますか？` with two: `この範囲で圃場を作る` / `選び直す` |
| Registration dialog | 圃場名 + 圃場ID + **測量タイプ** radio group (圃場ポリゴン / 境界トラック / 水門・給水口・排水口ポイント) + メモ | 圃場名 + メモ, with the auto-generated ID read-only under `詳細` |
| Field Recording | Full card: フィールド記録モード, ソース, QZ1 USB/Bluetooth SPP, ボーレート, 接続状態, QZ1に接続, 記録開始/停止, セッションID, ライブGNSS, HDOP, 保存, 診断 | Absent. Unchanged and fully functional in 設定 → QZ1測量 |
| 水位・観察を記録 | Buried inside the Field Recording card | Its own Basic-mode card (`#basicWaterRecordCard`), same element ids, same controller |
| Track markers | Uniform 8px dots at 0.84 fill opacity — a dark mass over the GSI aerial photo | 4–5px at 0.4–0.85 opacity, START/END as 10px high-contrast pins, candidate boundary drawn as a line |

### What "boundary track" became

`境界トラックとして保存` and `境界トラックとして登録` are **gone from the Basic
flow only**. The concept, its storage, its export shape and its report wording
are untouched:

- `buildBoundaryTrack()`, `nextBoundaryTrackId()`, `BOUNDARY_TRACK_STYLE`,
  `registerBoundaryTrack()` — unchanged
- `#fieldRegTypeTrack` and `#fieldRegSaveAsTrackButton` still exist on the
  legacy dialog under 設定
- Existing stored boundary tracks still render, still appear in
  `境界トラック数`, and still produce the same 圃場レポート note

### What water-point registration became

The `水門・給水口・排水口ポイントとして登録` measurement type is gone from the
Basic registration dialog — a farmer registering a paddy is registering a
paddy. Water points are still created through their own dedicated UI
(`水管理ポイント` panel and the floating map toolbar), which is unchanged and
still present in Basic mode.

---

## 3. Start/end boundary algorithm

All index arithmetic lives in `js/fields/boundary-selection.js` (pure, no DOM,
no Leaflet). Geometry and area are **not** reimplemented there.

### Point indexing

`parsedPoints` is the parser's output in original measurement order. A point's
index is its position in that array. Markers carry it as a class
(`qz1-point-<index>`), and it survives the `DGNSS fixのみ` filter — the filter
changes which markers are drawn, never what index a point has.

Labels shown to the farmer are 1-based (`測位点1` = index 0) to match the map
popups.

### Selected range

`normalizeBoundarySelection({ startIndex, endIndex, pointCount })` returns
`{ valid, startIndex, endIndex, count, reversed, error }`:

- Either endpoint unpicked, non-integer, or out of range → `valid: false`,
  error `開始点と終了点を選んでください。`
- `count < 3` → `valid: false`, error `圃場を作るには測位点が3点以上必要です。`
  (a polygon needs three vertices; two can never enclose an area)
- Otherwise `valid: true`

`selectBoundaryPoints(points, selection)` then returns
`points.slice(startIndex, endIndex + 1)` and its `[lat, lon]` ring.

### Measurement order

The candidate boundary **preserves original walk order**. For P0…P150 with
START = P20 and END = P130 the boundary is P20 → P21 → … → P130. Nothing sorts
by latitude/longitude, takes a convex hull, or reorders spatially — the walk
order *is* the boundary order. Pinned by
`the documented P20 -> P130 example produces exactly 111 ordered points`.

### Reversed selection

**Behavior: auto-swap with a visible relabel.** If the farmer picks an END that
was measured before their START, the earlier index becomes 開始点 and the later
becomes 終了点; the panel labels update and show
`終了点が開始点より前だったため、開始点と終了点を入れ替えました。`

There is deliberately **no wrap-around** (…P130 → P150 → P0 → P20…). The data
model has no notion of a cyclic track, so inventing one would fabricate
boundary segments the farmer never walked. Pinned by
`a reversed pick relabels to measurement order rather than guessing or wrapping`.

### Polygon closure

The ring is returned **open**. Closing END → START is left to the existing
polygon path, which treats a ring as implicitly closed — so the closing segment
is never added twice. On the map it is drawn as a dashed line, distinct from the
solid line over points the farmer actually walked, which is what makes the
closure gap legible before they commit.

### Validation and area

The trimmed ring goes through the **existing** helpers, unchanged:

```
selected ordered points
  → evaluateClosure(coordinates, DEFAULT_AUTO_CLOSE_THRESHOLD_M)   [existing]
      → validateBoundary()  (closure gap + self-intersection)       [existing]
  → gap <= 5m ? auto-close : simplified closure warning
  → registerFieldPolygon()                                          [existing]
      → buildField() → polygonAreaSquareMeters()                    [existing]
      → buildSurveySession() → localStorage                         [existing]
```

`polygonAreaSquareMeters()` (turf when available, shoelace on a local planar
approximation otherwise) is untouched. A browser test recomputes the area from
the stored ring with that same helper and asserts it equals
`field.properties.areaM2`.

### Field ID generation

`nextAvailableFieldDefaults(existingFieldIds)` returns the first `paddy-NNN`
not already in use, and a suggested name `田圃N`. The old
`nextFieldDefaults(count)` numbered purely by field count, so after deleting
one of five fields it handed back an id a surviving field already owned — the
exact cause of `ID "paddy-005" は既に使用されています。` `resolveBasicFieldId()`
additionally repairs a taken id rather than rejecting it, so the farmer can
never be blocked by a collision. The id **format is unchanged**, so
Basic-registered fields are indistinguishable from previously stored ones.

---

## 4. Data compatibility — what was NOT changed

Verified unchanged:

- **localStorage schema** — `SCHEMA_VERSION` still 3, key still
  `suimonNaviFieldAnnotationsV2`, same five persisted arrays
- **IndexedDB schema** — recording store untouched
- **Coordinate order** — `[lat, lon]` throughout, Leaflet-first
- **NMEA parser semantics** — `js/gnss/nmea-parser.js` not touched
- **Area algorithm** — `polygonAreaSquareMeters()` not touched
- **Field record shape** — `buildField()` not touched; Basic registrations
  produce byte-identical records to the legacy path for the same ring
- **Boundary tracks / water points / observations** — builders and export
  types untouched
- **Water data** — target water level storage and the 適正/低め verdict
  unchanged; element ids preserved across the DOM move
- **Drone / pilot / MAVLink / backend** — untouched
- **React frontend (`frontend/`)** — untouched

A field registered before this change loads, renders, reports and exports
exactly as before; a reload test asserts geometry and area survive round-trip.

---

## 5. Files changed

**New:**

| File | Purpose |
|---|---|
| `js/fields/boundary-selection.js` | Pure START/END trimming logic |
| `css/stage1-basic.css` | Stage-1 Basic-mode styles |
| `tests/unit/boundary-selection.test.js` | 11 unit tests |
| `tests/browser/stage1-basic-workflow.spec.js` | 20 browser tests |
| `docs/STAGE1_FIELD_WORKFLOW_SIMPLIFICATION.md` | This report |

**Modified:**

| File | Change |
|---|---|
| `index.html` | Stage-1 card, `?` help control + dialog, boundary trimming UI and map glue, field-only registration dialog, marker restyle, `data-mode` retagging, Basic button targets |
| `js/fields/field-annotation-core.js` | `nextAvailableFieldDefaults()`, `basicClosureWarningText()` (both additive) |
| `js/fields/field-annotation-controller.js` | Stage-1 field-only registration path (`beginBasicFieldRegistration`, `confirmBasicFieldRegistration`, `resolveBasicClosure`, `cancelBasicFieldRegistration`, `finishBasicRegistration`, `resolveBasicFieldId`) |
| `tests/unit/field-annotation-core.test.js` | 2 tests for the above |

---

## 6. Tests

```bash
npm test
```

```bash
npx playwright test
```

- **Unit: 232 passed, 0 failed** (388ms). Includes 11 new in
  `boundary-selection.test.js` and 2 new in `field-annotation-core.test.js`
  (36 total in that file).
- **Browser: 211 passed, 0 failed** (1.3m) across 16 spec files, including the
  20 new Stage-1 tests.

New Stage-1 browser coverage, by requirement group:

*Help* — small `?` control present and ≥44px; 現地調査ワークフロー absent from
Basic but present in 設定 → 圃場データ; opens; closes via button, Escape and
outside tap; content teaches the four Stage-1 steps; no developer vocabulary;
map center/zoom unchanged after opening and closing.

*Boundary selection* — upload arms trimming and defaults to the whole track; a
real hit-tested tap selects a marker through the boundary overlay; START/END
picked by tapping trims the range; measurement order preserved; reversed pick
relabels without wrapping; a 2-point range is rejected and cannot register;
only the selected range reaches the polygon; the ring is stored open; area
matches the existing geometry helper recomputed from the stored ring.

*Registration* — field-only (no `fieldRegType` inputs, no 境界トラック, no
water-point option) while the legacy dialog keeps all three under 設定;
name-first with a generated read-only id under 詳細; simplified two-button
closure warning; 選び直す creates nothing; force-close sets `closedManually`;
a registered field survives reload with geometry and area intact.

*UI cleanup* — Field Recording card and its eight technical controls hidden in
Basic and visible in 設定; water-level verdict and water-management points
still work in Basic; 結果を見る reaches the report; three fields register as
`paddy-001/002/003` with no repeated checklist.

*Map* — START/END markers and both boundary lines survive 地図 ↔ 航空写真;
unselected points are smaller and more translucent than selected ones, and all
11 measured fixes remain drawn.

*Mobile* — the whole flow completes at 390×844 and 393×852.

### Bugs found and fixed while testing

1. **Unpicked endpoint read as point 0.** `Number(null) === 0` and
   `Number.isInteger(0)` is true, so a null "not chosen yet" endpoint coerced
   to index 0. `toIndex()` now rejects `null`/`undefined`/`""`/booleans before
   coercing.
2. **The candidate boundary swallowed taps.** The polyline is drawn directly
   over the markers the farmer must tap; without `interactive: false` it
   intercepted every pointer event meant for a point. This would have broken
   START/END selection on a real phone.
3. **Upload button below the touch target.** `.basic-upload-button` measured
   42px because `.action-button` in index.html's inline `<style>` wins at equal
   specificity by source order. Qualified to `.action-button.basic-upload-button`.

---

## 7. Mobile verification

Verified at **390×844** and **393×852** (browser tests, plus the existing
navigation/basemap spec at the same sizes):

- No horizontal page scroll (`documentElement.scrollWidth <= innerWidth`)
- Map height ≥ 300px — the map stays the dominant element
- `? 使い方` ≥ 44px; `NMEAをアップロード` ≥ 44px (46px)
- START/END pick buttons ≥ 44px, stacking to full width below 720px
- The closure warning's two buttons stack to one column below 720px
- The complete flow — upload → pick START → pick END → 圃場を作る → 登録する —
  completes, and 水位を記録 reaches the water inputs

Also checked at 1920×1080 and 1366×768 via the existing responsive specs.

Web Bluetooth was not attempted, per scope. NMEA upload remains the iPhone
workflow.

---

## 8. Known limitations

1. **Overlapping fixes are ambiguous to tap.** Two points within ~1m render as
   overlapping circles at the map's max zoom (~0.5 m/px), so a tap cannot
   distinguish them. The farmer can zoom in; the browser tests dispatch the
   click directly for those cases and cover the realistic tap separately.
2. **`結果を見る` leaves Basic mode.** 圃場レポート is owned by 設定 → 圃場データ,
   so the button switches mode rather than rendering a reports panel inside
   Basic. Deliberate — it keeps Basic uncluttered — but it is a mode change the
   farmer did not explicitly ask for. Worth revisiting.
3. **No numeric/list fallback for picking points.** Selection is map-tap only
   in Basic. The 詳細解析 advanced card still offers index dropdowns.
4. **No undo after registration.** The trimming UI clears once the field
   exists; correcting a boundary means deleting the field in 設定 and
   re-uploading.
5. **`現在地を記録` still requires an active recording session**, which requires
   the Settings-side serial connection. Unchanged behavior, but it means that
   one button in the Basic water card is inert without a session.
6. **Default selection is the whole track**, which for a real walk with
   approach and return legs will usually trigger the closure warning on first
   attempt. Intentional — it makes trimming discoverable — but a farmer who
   ignores the hint meets the warning immediately.
7. **The Stage-1 card is not the first card in Basic mode.** The concurrent
   workspace change (see §10) promoted 対象圃場 / 今日の水門判断 / QZ1測位品質
   into Basic, so on a phone the farmer scrolls past three decision cards to
   reach 圃場を登録する. That ordering is the other task's design decision and
   was left intact; worth a joint review, since §17 of the Stage-1 brief
   expected the upload control near the top.

---

## 9. Screenshots / visual observations

Verified in-browser at desktop width:

- **Basic mode, empty:** header + mode tabs, then map (dominant), then a
  compact panel: `圃場を登録する / QZ1データから圃場を作る` with the `? 使い方`
  button on the same row, one full-width `NMEAをアップロード` button, then
  `現在の圃場`, then `登録済み圃場・測量ログ`. The old five-step checklist,
  survey-tools card and Field Recording card are absent.
- **Help dialog:** centered card over a dimmed backdrop, four numbered steps in
  plain Japanese, the 設定 pointer as a footnote, and a 44px `×`. The map behind
  it does not move.
- **Track loaded:** `測位点 11`, boundary controls with 開始点/終了点 rows
  (green and red chips matching the map markers), `選択範囲 11点（測位点1 〜
  測位点11）`, and `この範囲で圃場を作る`.
- **After trimming to the perimeter:** `選択範囲 5点（測位点4 〜 測位点8）`; on
  the map a green START pin, a red END pin, three emphasised points between
  them, six faded points on the approach and return legs, a solid green line
  along the walked perimeter and a dashed line closing END → START. The GSI
  aerial photo is clearly visible between markers — the previous uniform dark
  dots are gone.
- **Registration:** `圃場名` prefilled `田圃1`, memo, `詳細` collapsed over a
  read-only `paddy-001`. No measurement-type radios.
- **Registered:** `現在の圃場` shows `1,639 m² / 16.39 a / 0.164 ha`, and
  水位を記録 / 結果を見る become enabled.
- **結果を見る:** navigates to `#settings/fields` and generates
  `圃場レポート: 田圃1` with basic info, QZ1 survey log and reliability.

---

## 10. Git information

- **Branch:** `main`
- **Starting commit:** `a63cf6f` (`ui border`)
- **Commit:** `491dc88` — `feat(stage1): simplify field registration workflow`
  (16 files, +2477 / −143)
- **Push status:** pushed to `origin/main` as a fast-forward
  (`a63cf6f..491dc88`), non-force. `git fetch` beforehand showed 0 behind /
  1 ahead, so no remote work was overwritten.
- **GitHub Pages:** legacy build from `main` / root, published at
  <https://klayertan.github.io/michibiki-suimon-navi/>. The push triggered a
  build for `491dc88`, which completed successfully in 19.3s. The live page
  returns 200 and serves the new markup (`#basicStage1Card`,
  `#basicHelpButton`, `#basicNmeaInput`, `#basicBoundaryControls`,
  `#basicFieldRegDialog`), with `#workflowGuidePanel` correctly gated to
  `data-mode="settings"`. Both new assets are reachable:
  `css/stage1-basic.css` and `js/fields/boundary-selection.js` return 200.

### Concurrency note

This work shared a checkout with a second, concurrent session that restructured
the Settings workspaces (`survey` → `fields`, new `圃場データ` and `開発ツール`
tabs, and `workspaceGated` so workspace gating applies only in Settings mode).
That session's changes were **preserved in full** and this work was adapted to
them, not the reverse:

- Basic-mode cards are gated by `data-mode` alone, which is what the new
  `workspaceGated` rule intends
- The Stage-1 panels that carry a workspace sit in `fields` alongside the other
  field panels
- `圃場レポート`'s reassignment to 設定 was respected; `結果を見る` navigates
  there rather than pulling the panel back into Basic

Because both sessions edited `index.html`, that file's diff contains both sets
of changes.
