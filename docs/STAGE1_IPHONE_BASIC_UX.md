# Stage-1: iPhone NMEA upload + 基本モード UX cleanup

Five defects, one change set. Everything below was found by reading and
reproducing the current tree — no behaviour was changed on speculation, and no
calculation (NMEA parsing, area, thresholds, weather, assurance) was touched.

Top-level navigation is unchanged: **基本モード / ドローンモード / 設定**, with
ドローンモード still the second top-level mode.

---

## 1. The iPhone NMEA problem

A farmer taps **NMEAをアップロード** on an iPhone. The iOS Files picker opens,
and their own `.nmea` recording is **greyed out and unselectable**. The exact
same file opens without complaint on a Mac.

## 2. The exact previous `accept` values

Every NMEA input carried the same filter:

```html
<input id="fileInput"             type="file" accept=".nmea,.txt,.log,text/plain">
<input id="basicNmeaInput"        type="file" accept=".nmea,.txt,.log,text/plain">
<input id="assuranceQz1Input"     type="file" accept=".nmea,.txt,.log,text/plain">
<input id="assuranceReferenceInput" type="file" accept=".nmea,.txt,.log,text/plain">
```

## 3. Why picker filtering was removed

`accept` is not a hint on iOS. Safari translates the list into a **UTType**
filter and hands it to the native Files picker, which then greys out anything
that does not resolve to one of those types. `.nmea` is a private extension
with **no registered UTType on iOS**, so:

* `.nmea` → no UTType → not selectable;
* `text/plain` → does not rescue it, because iOS classifies the file by its
  extension-derived UTType, not by sniffing content;
* macOS is more permissive about the same list, which is why the bug looked
  platform-specific rather than like a filter problem.

The fix is to remove the attribute entirely from the four NMEA inputs:

```html
<input id="basicNmeaInput" type="file">
```

**Not** `accept="*/*"`. That is the same filtering machinery with a wildcard
argument; it re-enters the code path being avoided and buys nothing over
having no attribute at all.

JSON inputs (`#importInput`, `#assuranceImportProject`, `#paddyImportInput`)
**keep** `accept=".json,application/json"` — `.json` has a platform UTType, so
they were never affected.

## 4. Post-selection validation strategy

New module: [`js/gnss/nmea-file-intake.js`](../js/gnss/nmea-file-intake.js) —
pure, no DOM, no File API. One shared path, used by
`#basicNmeaInput`, `#typedSurveyUploadInput` (the explicit advanced
measurement-type uploader in `index.html`)
and by the two assurance inputs (via `readNmeaFile()` in
`satellite-assurance-controller.js`).

Validation is **two-stage**, and content is the only thing that decides:

| Stage | Question | Who answers |
|---|---|---|
| 1 | Does this text contain recognisable NMEA sentences? | `describeNmeaCandidate()` — regex `\$[A-Z]{2}[A-Z0-9]{3},` over the first 64 KB |
| 2 | Does it contain **usable fixes**? | the **existing** `parseNmea()` / `applyNmeaText()` — no second parser was written |

Deliberate properties:

* **MIME type is never consulted.** iOS reports `""` or
  `"application/octet-stream"` for a `.nmea` file; both are normal, and
  rejecting on either is the bug.
* **The extension never rejects.** `.nmea` / `.txt` / `.log` are what we
  expect and `hasExpectedNmeaExtension()` reports it, but a valid recording
  named anything else is accepted, and a `.nmea` full of noise is not.
* **Stage 1 runs before any parser state is touched**, so a wrong pick cannot
  wipe the track the farmer already had loaded.
* Sentence matching is wider than the GGA-only pattern the parser uses: a log
  that is all RMC/GSV *is* NMEA, and telling the farmer otherwise would be
  wrong. Whether it yields fixes is stage 2's call.
* An unreadable file (a still-downloading iCloud item) is caught and treated
  as an unusable pick rather than throwing.

Rejection message, in the Stage-1 card (`#basicNmeaMessage`) and the map empty
state:

> NMEAデータを確認できませんでした。QZ1から保存したNMEAログを選んでください。

## 5. What was actually tested vs. the physical-iPhone limitation

**Automated (Playwright + node:test) — proven here:**

* the four NMEA pickers carry no `accept` attribute, and none uses `*/*`;
* the JSON pickers still do;
* a `File` shaped exactly like iOS's — `name: "field01.nmea"`, `type: ""` —
  is read with `file.text()`, run through the existing parser, renders points,
  and arms the Basic START/END workflow;
* the same with `type: "application/octet-stream"`;
* `.txt` + `text/plain` (the Mac/desktop path) still works;
* an arbitrary file is rejected **after** selection with the farmer message;
* a wrong pick does not destroy an already-loaded recording;
* valid NMEA sentences with no usable fix are refused rather than loaded as an
  empty field.

**NOT proven here — needs one physical iPhone tap-test:**

> That the iOS Files picker now shows `.nmea` files as **selectable**.

Playwright cannot drive the native iOS Files picker, and no simulator in this
repo's toolchain reproduces UTType filtering. The removal of `accept` is the
documented cause-side fix; confirming the picker behaviour requires opening
Safari on a real iPhone, tapping NMEAをアップロード, and checking that a
`.nmea` file in Files is no longer greyed out. **This has not been performed.**

## 6. 開発ツール root cause

Reproduced at 1366×768 and 1280×900: 設定 → 開発ツール rendered a full-height
blank band, the map squashed to the bottom, a small raw `今日の水門判断 / 様子見`
line near the top, and the developer cards low on the right.

Root cause, in two parts:

1. **`display: revert` un-hid a phone-only element on desktop.** The mode gate
   is
   ```css
   body [data-mode] { display: none; }
   body[data-mode="settings"] [data-mode~="settings"] { display: revert; }
   ```
   `revert` rolls a declaration back to the **user-agent** origin, not to the
   author's earlier rule. `.mobile-decision` was a `<section>` with
   `data-mode="basic settings"` and an author `display: none` outside the
   phone media query — so in Basic and Settings the gate reverted it to the UA
   default `display: block` and it became visible at every width. (The same
   mechanism made the mobile-only `.gate-card { display: none }` rule dead
   code, so phones were showing **both** verdict surfaces.)

2. **`.app`'s grid had two rows and three children.**
   ```css
   .app { grid-template-rows: auto 1fr; }   /* header, main */
   ```
   With `.mobile-decision` visible, the children were header → strip → main.
   The strip took the `1fr` row and `main` fell into an implicit `auto` row —
   so `main` collapsed to its content height. In 開発ツール the panel holds two
   collapsed `<details>`, so the content height is tiny and the collapse is at
   its most dramatic.

**Fix:** `.mobile-decision` was deleted outright (see §8), which restores
`.app` to exactly two children, and the row list is now explicit and
self-documenting:

```css
.app { grid-template-rows: auto minmax(0, 1fr); }
```

No arbitrary `min-height` was introduced anywhere.

## 7. Verdict-card redesign

One verdict state (`evaluateGate()` → `updateDecision()`), one verdict surface
(`.gate-card`), two sizes:

| | font-size | padding |
|---|---|---|
| desktop side panel (≈380–430 px) | `1.75rem` | `15px` |
| ≤760 px (iPhone) | `clamp(2rem, 9vw, 2.6rem)` | `20px 16px` |

The card keeps its title (今日の水門判断), subtitle (気象と圃場位置からの推奨),
the large 開ける / 閉める / 様子見 badge as the focal point, the reason line, and
the disclaimer. Threshold and weather inputs remain Settings-only.

The desktop rule was previously `clamp(1.7rem, 4vw, 2.3rem)`, which pinned to
its 2.3rem maximum on any laptop — oversized for a 360 px panel.

## 8. Removing the duplicate verdict strip

`<section class="mobile-decision">` and `#mobileVerdictBadge` /
`#mobileVerdictReason` are gone from the DOM, the CSS and `updateDecision()`.
There is now exactly one `.verdict` element and one `.verdict-reason` element
in the document, so no two surfaces can disagree.

A comment at the removal site records why it must not come back as-is: any
phone peek strip has to live **inside** `.gate-card` and must **not** carry
`data-mode`.

## 9. Active-field consolidation

**Before:** 基本モード showed two field cards — `#basicFieldSummaryCard`
(現在の圃場: name + area) near the bottom, and `#decisionFieldCard`
(対象圃場 / 使用データ: a second selector plus all the metadata) at the top.

**After:** one card, first in the panel.

```
現在の田圃
  田圃を選ぶ   [ 圃場1（paddy-001） ▼ ]
  面積           1,639 m² / 16.39 a / 0.164 ha
  元NMEA         4th.nmea
  測位信頼性     要確認
  有効測位点     5点
  水管理ポイント 0件
  観察メモ       0件
  [圃場を測る] [水位を記録] [水管理ポイントを追加] [結果を見る]
```

* `#decisionFieldCard` is now `data-mode="settings"` — it belongs to
  設定 → 判断デモ, where 判断プロファイル and the raw GPS単独/DGPS split live.
* The metadata is **read**, not duplicated: `renderBasicFieldSummary()` calls
  the same `fieldReportController.buildReportFor(fieldId)` that
  `renderDecisionRegisteredField()` uses, so the two cannot disagree.
* `#basicActiveFieldSelect` is **authoritative**. Its existing change handler
  already cascaded to `wcpTargetFieldSelect`, `obsTargetFieldSelect`,
  `decisionFieldSelect` and `reportFieldSelect`; `populateDecisionFieldOptions()`
  now **adopts** the Basic selection instead of independently defaulting to the
  first field, so a re-populate can never silently override the farmer.
* New button `#basicAddWaterPointButton` (水管理ポイントを追加) carries the
  active field straight into 水管理ポイント — the farmer is never asked to pick
  the same field twice.
* **New:** the active field now survives a reload (`suimonNaviActiveFieldV1`).
  `renderFieldTargetOptions()` only auto-selects when exactly *one* field
  exists, so a farmer with two paddies used to reopen the app to an empty
  現在の田圃 despite having fields — and every surface that follows the active
  field started blank with it. `ensureActiveFieldSelected()` restores the
  stored id, falls back to the first field, and only ever acts when nothing
  valid is selected. This is a new key of its own; **no existing schema
  changed**.

## 10. Assurance-card move

`みちびき活用の実証 / QZ1 / DGNSS 測位品質` moved from 基本モード to
**設定 → 測量チェック**, immediately above the existing assurance tooling. It
was **moved, not copied** — there is exactly one `.proof-card` in the document.

The calculation is untouched (`computeQualityStats()`, `renderProofCard()`,
`renderProofStats()` unchanged). It still follows `#decisionFieldSelect`, which
now follows the Basic active field, so 測量チェック shows the quality of the
paddy the farmer is actually working on. A line in the card says so.

One real consequence had to be handled: `syncLayerVisibility()` hides the plain
QZ1 point layer in the assurance workspace (so it does not fight the comparison
layers), which would have made 選択中データの測位点を表示 silently do nothing
now that the button lives there. A `proofPointsRequested` flag makes an
explicit request win until the workspace changes.

## 11. Help button

Preserved from the concurrent Stage-1 work, unchanged by this task: the single
`? 使い方` control lives in `.brand-row-actions` at the upper right of the
header, in every mode. Below 480 px the label drops and the bare `?` remains,
at a 44×44 target with its accessible name from `aria-label`. Modal,
outside-click close, Escape and close button all still work. There is exactly
one help control in the document, and it is not inside the Stage-1 card.

## 12. Files changed

| File | Change |
|---|---|
| `index.html` | accept removal ×2, shared intake + rejection UI, `.mobile-decision` removal (DOM/CSS/JS), `.app` grid, responsive verdict, panel restructure, merged 現在の田圃 card, `#decisionFieldCard` → settings-only, proof-card move, active-field persistence, `proofPointsRequested` |
| `css/stage1-basic.css` | `.basic-nmea-message` rejection notice |
| `js/gnss/nmea-file-intake.js` | **new** — shared, pure intake validation |
| `js/assurance/satellite-assurance-controller.js` | validate assurance NMEA uploads by content |
| `tests/unit/nmea-file-intake.test.js` | **new** — 11 tests |
| `tests/browser/nmea-ios-upload.spec.js` | **new** — 10 tests |
| `tests/browser/basic-ux-consolidation.spec.js` | **new** — 18 tests |
| `docs/STAGE1_IPHONE_BASIC_UX.md` | this document |

## 13. Tests / counts

```
npm test            243 unit tests   pass  (11 new)
npx playwright test 239 browser tests pass  (28 new)
```

New browser coverage, by area:

* **NMEA / iPhone** (10): accept absence ×4 inputs, JSON filters retained,
  iOS `type: ""`, iOS `application/octet-stream`, `.txt` desktop path,
  Settings uploader shares the path, arbitrary-file rejection, wrong pick does
  not destroy loaded data, rejection clears, no-fix NMEA refused.
* **開発ツール** (4): no blank gap (measured against the viewport), cards at
  the top of the panel, no farmer verdict strip, switch-away/back and refresh
  stability, no document scroll drift or horizontal overflow across six routes.
* **Verdict** (4): exactly one verdict + one reason in the document,
  open/close/hold class and reason updates, disclaimer present, thresholds
  Settings-only, compact-vs-large responsive sizing.
* **Active field** (5): one selector in Basic, merged metadata present,
  A→B switching moves area/metadata/map label/water/report/decision together,
  survives reload, never opens empty when fields exist.
* **Assurance move** (3): absent from Basic, present and singular in
  測量チェック, numbers unchanged and 選択中データの測位点を表示 still renders
  points.
* **Structure** (2): three top-level modes with ドローンモード second, six
  Settings workspaces unchanged; exactly one 44 px help control at three
  viewports.

## 14. Screenshots / viewports

Verified in a real browser (Chromium) at:

| Viewport | Checked |
|---|---|
| 1920×1080 | Basic: merged card, polished verdict, no strip, full-height map |
| 1366×768 | Basic; 測量チェック with the moved QZ1/DGNSS card; 開発ツール with no blank gap |
| 1280×900 | full Playwright suite default |
| 393×852 | Basic: bare `?` help, map, merged card, large verdict card |
| 390×844 | Basic: same, plus the existing Stage-1 390 px suite |

## 15. Known limitations

1. **The iPhone Files picker itself is unverified on hardware** (§5). This is
   the one claim that needs a physical device.
2. **Colliding survey session ids (pre-existing, out of scope).**
   `makeSurveySessionId()` stamps to the second with no uniqueness guard, so
   two fields registered inside one second share an id;
   `resolvePrimarySurveySession()` then resolves both to the *first* session,
   and the second field reports the wrong 元NMEA / 有効測位点 / 測位信頼性.
   Newly visible because 現在の田圃 now shows that metadata to farmers.
   `tests/browser/basic-ux-consolidation.spec.js` steps around it with a
   deliberate >1 s gap and a comment; fixing it means changing id generation,
   which this task was told not to touch.
3. 測量チェック's QZ1/DGNSS card follows `#decisionFieldSelect`, which lives on
   the 判断デモ tab. Ownership moved as specified and the calculation was left
   alone, so the card reads a selector on a neighbouring tab; a note in the
   card explains where the dataset comes from.
4. Basic mode still shows 登録済み圃場・測量ログ, 水管理ポイント and
   水位・観察を記録 below the Stage-1 card (they carry
   `data-mode="basic settings"`). Pre-existing and out of this task's scope.
5. Web Bluetooth / native BLE to QZ1 is explicitly **not** implemented. The
   supported iPhone path is Files → NMEA → SuisuiNavi.

## 16. Commit / push / Pages status

**Not committed, not pushed, not deployed.** The work is complete and verified
in the working tree; the commit is deliberately held.

While this task was in progress, a concurrent session added an untracked
auth/cloud login feature and wired it into `index.html`:

```
index.html:16    <link rel="stylesheet" href="css/auth.css">
index.html:3546  <script src="config/cloud-config.js"></script>
index.html:1860  dynamic import js/auth/auth-state.js
index.html:4024  dynamic import js/cloud/user-scope.js
```

`css/auth.css`, `config/`, `js/auth/` and `js/cloud/` are all **untracked**, so
neither half of the commit is safe on its own:

* committing `index.html` without them breaks GitHub Pages — the plain
  `<script src="config/cloud-config.js">` and the stylesheet would 404;
* committing them too would publish another session's unreviewed, untested
  in-progress auth feature under this task's commit.

Most of this task's changes live in `index.html`, so the two cannot be
separated by file. Per the task's own concurrency rule ("do not commit partial
mixed changes unless ownership is explicitly resolved"), the commit waits until
the auth/cloud session is finished and its files are staged by its owner.

Nothing here was reset, restored, checked out or force-pushed; `main` is
unchanged at `7e4281e` and matches `origin/main`.

State when handing over:

```
 M css/stage1-basic.css                             (this task)
 M index.html                                       (this task + concurrent auth work)
 M js/assurance/satellite-assurance-controller.js   (this task)
?? js/gnss/nmea-file-intake.js                      (this task)
?? tests/unit/nmea-file-intake.test.js              (this task)
?? tests/browser/nmea-ios-upload.spec.js            (this task)
?? tests/browser/basic-ux-consolidation.spec.js     (this task)
?? docs/STAGE1_IPHONE_BASIC_UX.md                   (this task)
?? config/ css/auth.css js/auth/ js/cloud/          (concurrent session — untouched)
```

Verified in this exact tree, with both sets of work present:
`npm test` → 243 passed; `npx playwright test` → 239 passed.
