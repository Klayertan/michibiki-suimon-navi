# Vegetation Intelligence

First-stage SLAS-assisted paddy vegetation monitoring built into the 詳細解析
(analysis) workspace. The camera / AI produces vegetation *candidates* (weed
coverage, crop-stress candidates, suspected pest or disease damage); QZ1 /
Michibiki SLAS provides the position used to associate each observation with
the correct paddy field and management-grid cell. The system never claims
confirmed pest or disease detection and never fabricates SLAS status.

## Architecture

| File | Role |
|---|---|
| `js/vegetation/vegetation-core.js` | Pure data / validation / analytics logic (no DOM, no Leaflet). Unit-tested with `node --test`. |
| `js/vegetation/vegetation-controller.js` | Browser controller: panel binding, Leaflet overlay, import UI, review workflow. Mirrors `SatelliteAssuranceController`. |
| `css/vegetation-intelligence.css` | Panel styles. Overlay colors live in `vegetation-core.js` (single style source). |
| `index.html` | Four collapsible cards in the analysis workspace + init wiring. |
| `js/paddy-intelligence.js` | Three optional hooks: `getVegetationExport`, `onVegetationImport`, `onSelectionChanged`. |

The vegetation store lives only in the controller; the paddy module pulls it
at export time through `getVegetationExport` — no duplicated state.

## Observation schema (v1)

```js
{
  id: "veg-…",
  schemaVersion: 1,
  fieldId: "field-…",          // effective (confirmed ?? automatic), set at export
  gridCellId: "G-12",          // effective (confirmed ?? automatic), set at export
  timestamp: "2026-07-18T10:30:00+09:00",
  source: "camera_ai" | "manual" | "import",
  positionSource: "QZ1_SLAS" | "manual" | "unknown" | …,
  latitude: 34.6545,           // original position, never modified
  longitude: 135.8302,
  observationType: "weed" | "crop_stress" | "pest_damage_suspected"
                 | "disease_suspected" | "lodging" | "unknown",
  weedCoveragePercent: 18.2,   // each 0–100 or null
  cropCoveragePercent: 72.5,
  bareSoilPercent: 4.0,
  waterSurfacePercent: 5.3,
  confidence: 0.91,            // 0–1 or null
  severity: "low" | "medium" | "high" | "unknown",
  imageName: "IMG_0231.jpg",
  modelName: "weed-segmentation-v1",
  notes: "",

  // QZ1 / SLAS quality metadata — null when the source did not report it.
  slasActive: true | false | null,
  correctionHealthy: true | false | null,
  satelliteCount: 14 | null,
  hdop: 0.9 | null,
  estimatedUncertaintyM: 0.8 | null,
  positionQuality: "green" | "yellow" | "red" | "unknown",
  positionQualityProvided: false,   // true only when the import supplied it

  // Association — automatic and confirmed values are both preserved.
  automaticFieldId: "field-01" | null,
  automaticGridCellId: "G-12" | null,
  confirmedFieldId: "field-01" | null,
  confirmedGridCellId: "G-12" | null,
  candidateGridCellIds: ["G-12", "G-13"],
  associationStatus: "automatic" | "ambiguous" | "confirmed" | "overridden" | "unassigned",
  distanceToBoundaryM: 30.4 | null,
  createdAt: "…", updatedAt: "…"
}
```

The four coverage percentages are validated individually (0–100). Their sum
is checked against 100 % ± 5 pt; a mismatch produces a **non-blocking
warning** and entered values are never modified.

## Position quality derivation

An explicitly imported `positionQuality` is preserved. Otherwise:

- **red** — invalid coordinates, `correctionHealthy === false`, `hdop > 5`,
  `estimatedUncertaintyM > 5`, or clearly outside the field.
- **yellow** — ambiguous association (near a boundary / multiple candidate
  cells), `slasActive === false`, `hdop > 2`, or `estimatedUncertaintyM > 2`.
- **green** — requires `slasActive === true` **and** `correctionHealthy ===
  true` **and** a clean single-cell (automatic or confirmed) association.
- **unknown** — quality metadata unavailable and no geometric problem.
  Missing SLAS status is shown as *Unknown*, never invented.

## Boundary ambiguity

Observations within the 境界付近しきい値 (shared with the GNSS card, default
2 m) of the field boundary or of more than one grid cell are marked
`ambiguous`, listed in the 位置関連付けレビュー card with their candidate
cells, and are never silently assigned. The user can confirm the automatic
assignment or override it with any cell; original latitude/longitude are
always preserved, and both automatic and confirmed IDs are stored. If the
grid is regenerated and a confirmed cell disappears, the observation drops
back to `ambiguous` for re-review.

## Inspection priority score (rule-based, no ML)

Clamped to 0–100; every triggered rule is listed as a reason string.

| Factor | Points |
|---|---|
| Weed coverage ≥30 / ≥20 / ≥10 / ≥5 % | 25 / 20 / 12 / 6 |
| Weed increase vs previous ≥10 / ≥5 / >2 pt | 20 / 14 / 8 |
| Severity high / medium / unknown / low | 15 / 8 / 4 / 2 |
| AI confidence below threshold (default 0.7) / unknown | 10 / 5 |
| Days since last observation ≥21 / ≥14 / ≥7 | 15 / 12 / 6 |
| Association ambiguous or unassigned / overridden | 10 / 2 |
| Position quality red / yellow / unknown | 5 / 3 / 1 |

Trend uses a ±2 pt tolerance on the weed-coverage delta between the two most
recent observations: Increasing / Decreasing / Stable, and Insufficient data
below two observations. Differences between percentages are always reported
in **percentage points (pt)**, never as percent growth.

## Import (JSON / CSV)

`AI解析結果を読み込む` accepts the Jetson-style JSON
(`{ schemaVersion, observations: [...] }` or a bare array) and CSV with a
header row (aliases like `lat`, `lon`, `type`, `weed`, `crop` are accepted).
Required per row: `timestamp`, `latitude`, `longitude`, `observationType`.
Rows are validated individually — one bad row never aborts the import — and
the result reports 取込 / 重複スキップ / 失敗 counts with per-row errors.
Duplicates are detected on `timestamp | imageName | lat(6dp) | lon(6dp) |
observationType`.

## Export & backward compatibility

The paddy export (`schemaVersion: "paddy-intelligence.v1"`, unchanged) gains
three additive keys: `vegetationObservations`, `vegetationSettings`,
`vegetationSummary`. Older project files without them load normally (the
vegetation store resets to empty); new files re-import losslessly. GNSS,
annotation, field, grid, and drone-plan structures are untouched.

## Connecting real Jetson Nano output

Have the Jetson pipeline write one JSON per flight/session in the import
format above: for each analyzed frame, record the EXIF/PPS-synchronized
QZ1/SLAS fix (`latitude`, `longitude`, plus `slasActive`,
`correctionHealthy`, `satelliteCount`, `hdop`, `estimatedUncertaintyM` read
from the receiver), the segmentation percentages, `confidence`, `imageName`,
and `modelName`. Do not aggregate on the Jetson — this app owns grid
association, dedup, and time-series comparison. Fields the receiver cannot
report should be omitted (they surface as *Unknown*), not guessed.
