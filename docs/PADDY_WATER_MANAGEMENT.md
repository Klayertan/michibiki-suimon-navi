# 水管理 / Paddy Water Management — evidence-based recommendation

Farmer-facing question: **"how deep should the water be in this paddy right now,
and how much water is that?"**

The one scientific rule the whole feature is built around:

```
growth stage + management conditions  ->  target water depth
field area   x required depth change  ->  required water volume
```

Field area **never** determines depth. A 2 ha paddy and a 2 a paddy at the same
growth stage get the same target depth; only the volume differs.

---

## Files

| File | Role |
|---|---|
| `js/water/water-management-sources.js` | Source registry. Every agronomic number traces to an entry here, with organization, title, URL, what it supports, its caveat, and **how it was verified**. |
| `js/water/growth-stage-model.js` | The stage table: 11 stages, each with a management mode and either a numeric mm range or an explicit "no numeric target". Contains no reference to area. |
| `js/water/water-measurement.js` | The measurement record `{ valueMm, valueCm, reference, source, measuredAt }` — **signed**, against an explicit datum — plus normalization of the legacy cm-only entry. |
| `js/water/water-recommendation.js` | The pure engine: target -> status -> depth difference -> theoretical volume -> recommendation + provenance. The only place `L = m² × mm` happens. |
| `index.html` (`#waterManagementCard`, `renderWaterManagementCard()`) | Display and event wiring only. No arithmetic. |
| `js/water/water-need.js` | **Retired.** The former cm-based hero calculation, no longer loaded — the hero now uses `water-recommendation.js` so a water level is optional. Kept with its tests for reference. |

Tests: `tests/unit/water-recommendation.test.js`, `tests/unit/water-measurement.test.js`,
`tests/unit/growth-stage-model.test.js`, `tests/browser/water-management-card.spec.js`.

---

## The calculation

```
1 mm over 1 m² = 1 L
waterLiters = areaM2 * depthIncreaseMm
waterM3     = areaM2 * depthIncreaseMm / 1000
```

Worked example (pinned by test):

```
area    = 2,143 m²
stage   = 移植直後 (target 30–50 mm)
current = 18 mm
deficit = 12–32 mm
volume  = 2143 × 12 / 1000 … 2143 × 32 / 1000 = 25.716 … 68.576 m³
display = 25.7〜68.6 m³ / 25,716〜68,576 L
```

### Two quantities that are never mixed

1. **理論追加水量 / standing-water adjustment** — `area × Δdepth`. Pure geometry.
   This is the number the card shows.
2. **Real irrigation requirement** — additionally covers percolation, evapo-
   transpiration, rainfall, runoff, soil, levelling and conveyance efficiency.
   The card never prints a number for this; it prints the caveat instead.

The NARO 851-field survey is shown as *evidence* of how large those daily losses
are (11.0–17.5 mm/day, CV 70.6–79.4), and is deliberately **not** applied to the
calculation — the coefficient of variation is itself the argument against
treating it as a constant.

---

## Signed water levels and the soil-surface datum

**Implemented.** A water level is meaningless without saying what it is measured
*from*, so every measurement record names its datum explicitly and the value is
signed.

```
reference: "soil-surface"          (the only datum this build uses)

  valueMm  >  0    water surface ABOVE the soil surface (standing water)
  valueMm === 0    water surface exactly AT the soil surface
  valueMm  <  0    water level BELOW the soil surface (sub-surface water table)

   +50 mm  =  5 cm of standing water
     0 mm  =  water exactly at the soil surface
  -150 mm  =  water table 15 cm below the soil surface
```

`-150 mm` is representable, storable and reloadable. That value is not an edge
case: it is where IRRI's safe-AWD re-irrigation threshold sits — *"when the
water level has dropped to about 15 cm below the surface of the soil,
irrigation should be applied"*. Before signed support a farmer practising AWD
could not record the one measurement AWD is defined by.

`+150` and `-150` are opposite field states about 30 cm apart, so the engine
never takes `Math.abs()` of a depth and never clamps a negative to zero. With a
target of 30–50 mm and a measurement of −150 mm the deficit is `30 − (−150) =
180 mm` to the bottom of the range and `200 mm` to the top — not 30 mm, and not
120 mm. Both failure modes invert the advice rather than rounding it, and both
are pinned by unit tests.

Non-values are never coerced into a reading. `null`, `undefined`, `""`, `NaN`
and `Infinity` all yield "no measurement", never `0 mm` — `Number(null)` and
`Number("")` are both `0`, and a fabricated reading exactly at the soil surface
is a real and different answer from "not measured".

### Legacy cm compatibility

The pre-existing `valueCm` entries load unchanged, with no migration step.
`normalizeWaterMeasurement()` accepts both shapes, and the legacy cm input was
always labelled 水位 and always meant water standing on the field — which *is*
the soil-surface datum. So a legacy **−15 cm** entry and a new **−150 mm**
record normalize to the identical physical measurement, and the cm input in
水位・観察を記録 and the mm input in 水管理 are two views of one stored value,
sign included. A record naming some *other* datum is reported as unreadable
rather than silently re-read against the soil surface.

### What this does *not* mean

Supporting the **measurement** is not supporting the **management strategy**.
No AWD-specific recommendation algorithm has been implemented. The growth-stage
target table above is **unchanged** — every stage keeps the range its cited
source supports, and −150 mm has not become a target for anything. AWD and the
standing-water, stage-linked targets are different management concepts, and this
project does not hold the evidence to recommend the former. See
[`ARCHITECTURE.md`](./ARCHITECTURE.md) §6 and
[`RESEARCH_REFERENCES.md`](./RESEARCH_REFERENCES.md) §4.

---

## Stage table

| Stage | Mode | Target | Basis |
|---|---|---|---|
| 移植前（代かき・整地） | 湛水（作業依存） | — | depth follows the work, not the crop |
| 移植直後 | やや深水 | 30–50 mm | NARO 図説 活着期「日中３〜４ｃｍ…夜間５ｃｍ程度」 |
| 活着期 | やや深水 | 30–50 mm | same passage |
| 分げつ期 | 浅水 | 25–35 mm | NARO 図説「水深３ｃｍ前後の浅水管理」 |
| 中干し | 落水・干し | — | drainage: no fill recommendation, ever |
| 幼穂形成期 | 間断灌漑 | — | managed by state; deep water only as a stated cold-weather exception |
| 穂ばらみ期 | 間断灌漑 | — | as above |
| 出穂・開花期 | 湛水 | 40–60 mm | NARO 花水 + IRRI "topping up to a depth of 5 cm" |
| 登熟期 | 飽水・間断 | — | managed by state |
| 落水期 | 落水・干し | — | drainage |
| 未設定・不明 | — | — | the app asks; it never guesses |

`null` targets mean **"no defensible numeric target"**, never `0 mm`. The engine
branches on this before any range comparison, which is what stops "no target →
read as 0 → current 45 mm is 45 mm above 0 → drain 96 m³".

---

## Provenance

Every source entry carries a `verification` block:

- `primary` — the page/record was fetched and read; the quoted wording comes from it.
- `link-only` — the URL resolves to the expected document, but its contents could
  not be machine-read (`maffCultivation` is a 23-page image-only PDF). **A
  link-only source is never the basis for a number** — asserted by a unit test.

The `naroWaterRequirement` entry carries full bibliographic detail (authors,
journal, volume, pages, date, ISSN, DOI) rather than a descriptive paraphrase.

---

## Persistence

| Key | Shape | Notes |
|---|---|---|
| `suimonNaviCurrentWaterLevelV1` | `{ [fieldId]: { valueCm, recordedAt, valueMm, reference, source, measuredAt } }` | **Extended, not replaced.** The legacy `valueCm`/`recordedAt` pair is still written so any older reader sees the shape it always did. A pre-existing cm-only entry loads with no migration step. |
| `suimonNaviFieldGrowthStageV1` | `{ [fieldId]: { stage, source, transplantedOn, variety, updatedAt } }` | New key. Registered in `SCOPED_STORAGE_KEYS`, so it is per-account. |

`suimonNaviCurrentWaterLevelV1` is deliberately **not** added to
`SCOPED_STORAGE_KEYS`: real installs already hold unprefixed values under that
key, and listing it now would make a signed-in farmer's existing readings
unreachable without a migration step. Consequence (pre-existing, unchanged by
this feature): water-level readings are visible across accounts on a shared
device. Fixing it needs a copy-on-first-scope migration — see the report.

---

## Sensor hook (RealSense / water-level sensor / drone)

**A hook, not an integration.** No RealSense, water-level-sensor or drone
water-level capture exists in this build. Every reading in the app today is
typed in by a farmer and stored with `source: "manual"`. What is implemented is
the *shape* that lets such a writer land later without touching the engine.

The engine only ever sees `{ valueMm, reference, source, measuredAt }`, so a
future sensor integration would call one function:

```js
writeWaterMeasurementMm(fieldId, valueMm, "realsense", measuredAtEpochMs);
```

Nothing downstream would change — status, volume, recommendation and staleness
all work identically, and the card shows 取得元: RealSense計測 instead of 手入力.
That path is exercised today only by a unit test, not by hardware.

The project brief names an Intel RealSense **"D345"**; Intel's shipping depth
line is D4xx (D405 / D415 / D435 / D435i / D455). This documentation does not
assert a corrected model number — no model is hard-coded anywhere, and the unit
must be confirmed from the hardware label before it is quoted. See
[`ARCHITECTURE.md`](./ARCHITECTURE.md) §8.
