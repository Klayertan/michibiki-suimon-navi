# Research references / 研究・技術資料

Bibliography for the paddy water-management component of スイスイナビ.

**How to read this file.** Every entry separates three things that are easy to
blur together:

- **Source states** — what the cited document itself says. Quoted or closely
  tracked, in its original language where the wording matters.
- **Project interpretation** — how this repository uses that statement. This is
  our reasoning, not the source's claim.
- **Limitation** — what the source does *not* establish, and why it must not be
  generalised.

**Verification status.** Each entry is marked:

| Mark | Meaning |
|---|---|
| ✅ **Primary** | The page or record was fetched and read. Quoted wording comes from it. |
| 🔗 **Link-only** | The URL resolves to the expected document, but its contents could not be machine-read (e.g. an image-only PDF). **Never the basis for a number in this app.** |

All URLs were checked on **2026-08-18**. Where a source is Japanese, the
original wording is given, because translations of water-management terms
(浅水 / 深水 / 中干し / 間断灌漑 / 落水) lose precision.

**Bibliographic integrity.** Author names, journal titles, volumes, pages, DOIs
and dates in this file were taken from the publisher's or repository's own
record, not reconstructed from memory. Where a detail could not be confirmed,
the institutional page is cited instead of an invented citation.

---

## Sources that drive numbers in the application

These four are wired into `js/water/water-management-sources.js` and are
traceable from the UI: every depth range the app displays names the source it
came from.

### 1. NARO — 図説：生育時期別の一般的な水管理 ✅ Primary

**Organization:** 農研機構 東北農業研究センター (NARO Tohoku Agricultural Research Center)
**Series:** 図説：東北の稲作と冷害
**Language:** Japanese
**URL:** <https://agrimet.tarc.naro.go.jp/reigai/zusetu/kangai.html>
**Stated origin (on the page itself):** 福島県稲作指導指針（総合版），平成４年３月，福島県農政部。一部改変

> **Note for anyone re-fetching this page:** it is served as `Shift_JIS`. Naive
> UTF-8 fetching returns mojibake. Use `curl … | iconv -f SHIFT-JIS -t UTF-8`.

**Source states** (verbatim):

- 活着期 — 「日中止水で３〜４ｃｍの浅水とし，水温を上昇させ，夜間は５ｃｍ程度の水深にする」
  and, under cold with wind, 「苗丈の４分の３程度が浸かる程度の深水とし，苗を保護する」
- 分げつ期 — 「分げつ発生を促す水深３ｃｍ前後の浅水管理」
- 有効分げつ決定期〜穂首分化期 — 「目標茎数を確保したら，直ちに中干しに入る」, with the
  degree given as 「田面に１ｃｍ以内の小ヒビが入る程度（足跡がつく程度）」, followed by 間断灌漑
- 穂首分化期〜穂ばらみ期 — 「間断灌漑を行う」; under expected low temperature,
  「可能な限りの深水にして，幼穂を保護する」
- 穂ばらみ期〜開花期 — 「水分補給を重視した湛水（花水）」
- 登熟期 — 「間断灌漑を行い」; 「落水時期は…出穂後３０日が目安」

**Project interpretation:** This is the primary basis for the stage table in
`js/water/growth-stage-model.js`. 分げつ期 is encoded as 25–35 mm (a band centred
on 「３ｃｍ前後」, deliberately not widened beyond what the source supports), and
移植直後/活着期 as 30–50 mm. Critically, the stages this source manages by *state*
rather than by depth — 中干し, 間断灌漑 periods, 登熟期, 落水 — carry **no numeric
target** in the model. The source's own structure is the reason the app refuses
to emit a depth for those stages.

**Limitation:** This is general guidance framed around **Tohoku cold-damage
(冷害) risk**, derived from 1992 Fukushima Prefecture cultivation guidance. It is
not a national standard and not a fixed schedule. Appropriate values vary with
region, variety, soil and season, and the page states conditions under which the
correct action *reverses* (shallow → deep under low temperature). Local
extension guidance takes precedence over anything this app displays.

---

### 2. NARO — 図説：活着期から分げつ期の浅水管理のポイント ✅ Primary

**Organization:** 農研機構 東北農業研究センター
**Language:** Japanese
**URL:** <https://agrimet.tarc.naro.go.jp/reigai/zusetu/water/tillering.html>

**Source states:** Shallow water is the basis during tiller formation *except*
under low temperature or strong wind; shallower water widens the daily
water-temperature range, which promotes tillering.

**Project interpretation:** Supports the 浅水 management mode for 分げつ期 and,
more importantly, supplies the *mechanism* (daily water-temperature swing)
rather than just a number — which is why the app presents a management mode
alongside the range instead of a bare figure.

**Limitation:** The concrete depth meant by 「浅水」 varies by region, variety and
weather. The stated low-temperature / strong-wind exception is carried in the
model as a `conditional` entry that the engine surfaces but **never auto-selects**,
because this app has no reliable per-field temperature history to select it with.

---

### 3. NARO — 気象情報を利用して水田圃場の給排水を最適化・自動化するスマート水管理ソフト ✅ Primary

**Organization:** 農研機構 農業環境変動研究センター
**Type:** 2018 成果情報（普及成果情報）
**Language:** Japanese
**URL:** <https://www.naro.go.jp/project/results/4th_laboratory/niaes/2018/18_062.html>

**Source states** (verbatim): 「栽培期間を最大10期間に分割し、各期間の区切りを発育ステージと
紐付け、さらに各期間の水管理法を4種類(一定水深、間断灌漑、深水管理、排水)の中から選択する」.
The same software obtains 発育予測 through an API based on メッシュ農業気象データ and a
水稲発育モデル, computes an optimal irrigation time from a 水田水温シミュレーション lookup
table, and drives 給排水バルブ制御 through a 圃場水管理システム.

**Project interpretation:** Twofold, and this is the most architecturally
important citation in the file.

1. It validates **the shape of this app's model** — periods tied to growth
   stage, each assigned a management *mode* — which is precisely the structure of
   `growth-stage-model.js`. That design is not invented here.
2. It is the concrete precedent for the **roadmap**: weather-data-driven
   scheduling, developmental-stage prediction, and automated gate control are
   documented NARO work, not speculation. See `docs/ARCHITECTURE.md`.

**Limitation:** It does not prescribe a specific water depth for an individual
field, and this app implements none of its automation. Citing it establishes
that the direction is real and already demonstrated by a national institute —
it does **not** mean any part of it is implemented here.

---

### 4. IRRI Rice Knowledge Bank — Water management / Alternate Wetting and Drying ✅ Primary

**Organization:** International Rice Research Institute (IRRI)
**Language:** English
**URLs:**
<http://www.knowledgebank.irri.org/step-by-step-production/growth/water-management>
<http://www.knowledgebank.irri.org/training/fact-sheets/water-management/saving-water-alternate-wetting-drying-awd>

**Source states** (verbatim, AWD fact sheet):

> "When the water level has dropped to about 15 cm below the surface of the
> soil, irrigation should be applied to re-flood the field to a depth of about
> 5 cm."

> "From one week before to a week after flowering, the field should be kept
> flooded, topping up to a depth of 5 cm as needed."

The field water tube ("pani pipe") is specified as 30 cm long, 10–15 cm in
diameter, hammered in so that 15 cm protrudes above the soil surface. The
general water-management page gives approximately 3 cm after transplanting,
increasing to 5–10 cm as plants grow.

**Project interpretation:** International cross-reference supporting the
出穂・開花期 range (40–60 mm) alongside NARO's 花水 guidance, and the documented
basis for the AWD terminology and the signed-level convention in
[`ARCHITECTURE.md`](./ARCHITECTURE.md) §6.

**Limitation — and a correctness warning.** This is guidance for mainly tropical
Asian systems, not Japanese cultivation instruction. More importantly:

> **−15 cm below the soil surface is not 15 cm of standing water.** They are
> opposite states separated by roughly 20 cm of water. A system that stores
> water level as an unsigned magnitude cannot distinguish them.

The safe-AWD threshold is a **negative** water level relative to the soil
surface. The app now represents this: measurements are signed against an
explicit `soil-surface` datum, so −150 mm can be recorded, stored and compared
correctly (see [`ARCHITECTURE.md`](./ARCHITECTURE.md) §6).

**Supporting the measurement is not supporting the strategy.** No AWD
recommendation algorithm is implemented, and −150 mm is not a target for any
growth stage. AWD and the standing-water, stage-linked targets in §1 are
different management concepts; this project cites IRRI for the datum convention
and the flowering-period guidance, not as authority for an AWD schedule it does
not implement.

---

### 5. MAFF — 水稲の栽培・施肥基準（水管理） 🔗 Link-only

**Organization:** 農林水産省 (Ministry of Agriculture, Forestry and Fisheries)
**Language:** Japanese
**URL:** <https://www.maff.go.jp/j/seisan/kankyo/hozen_type/h_sehi_kizyun/pdf/suito2.pdf>

**Verification:** The URL resolves (HTTP 200, ~1.4 MB, 23 pages) but the PDF is
**image-only with no text layer**, so its contents could not be machine-verified
here.

**Project interpretation:** Retained as corroborating context for
stage-dependent water management generally.

**Limitation:** Because it is unread, **it is not the basis for any numeric
range in this app** — a constraint asserted by a unit test, not merely a
convention. Anyone extending the stage table must not cite this entry to justify
a number.

---

## Evidence about water *loss* — cited, deliberately not applied

### 6. 低平地水田における減水深の空間的ばらつき ✅ Primary

**Title (EN):** Spatial Variation in the Water Requirement Rate for Paddy Fields in Flat and Lower Areas
**Authors:** 福本 昌人 (FUKUMOTO, Masato); 進藤 惣治 (SHINDO, Soji)
**Journal:** 農研機構研究報告 農村工学研究部門 / Bulletin of the NARO, Rural Engineering
**Volume 3, pp. 1–12** · Published 2019-03-30 · ISSN 2432-7883
**DOI:** [10.24514/00001146](https://doi.org/10.24514/00001146) (JaLC)
**Repository:** <https://repository.naro.go.jp/records/1181>
**Language:** Japanese (English abstract)

**Source states:** From a 2007 survey in the 西蒲原 region of Niigata Prefecture,
covering **851 fields** with strongly clayey subsoil and grey soil, across six
rice growth stages: the stage-wise mean water requirement rate rose from
**11.0 to 17.5 mm/day**; the **coefficient of variation was 70.6–79.4**; between
46 and 113 sample fields would be needed to estimate the population mean within
±2 mm/day at 90% confidence; and of five candidate factors, **flooded water
level** was the one most affecting the rate.

**Project interpretation:** This is the evidence for a *negative* design
decision, which is the most important thing this file records. The app computes
a **geometric** standing-water adjustment (`area × Δdepth`) and stops there. It
does **not** add a daily-loss term, because:

- the CV above 70 shows between-field variability is enormous;
- the survey covers one region and one soil type;
- this app knows nothing about a given field's soil, percolation or irrigation
  efficiency.

Applying a research mean as though it were a constant would convert an honest
geometric number into a fabricated agronomic one. The figures are therefore
displayed as *evidence of the size of the losses the geometric number omits*,
never folded into the arithmetic.

**Limitation:** Region- and soil-specific measured values. Not a national
constant, not a default, and not applicable to another field without its own
measurement.

---

## Supporting literature — context, not encoded values

None of the following drive any number in the application. They are cited
because the brief for this component asked which literature supports the
architectural principle that *water-management targets depend on growth stage
and management strategy, and that no single depth is universally correct.*

### 7. Anbumozhi, Yamaji & Tabuchi (1998) ✅ Primary (metadata)

**Title:** Rice crop growth and yield as influenced by changes in ponding water depth, water regime and fertigation level
**Authors:** V. Anbumozhi, E. Yamaji, T. Tabuchi
**Journal:** *Agricultural Water Management* **37**(3): 241–253 · September 1998
**DOI:** [10.1016/S0378-3774(98)00041-9](https://doi.org/10.1016/S0378-3774(98)00041-9)
**ISSN:** 0378-3774 · **Language:** English

**Source states:** Growth and yield were measured across ponding depth
treatments of **0, 3, 6, 9, 12, 15 and 18 cm** under continuous, intermittent
and variable ponding regimes and several fertigation levels; an optimum ponding
depth of **9 cm** is reported for the conditions studied.

**Project interpretation:** Evidence that ponding depth has measurable
agronomic consequences — i.e. that getting depth right *matters*, which is the
premise of the whole feature.

**Limitation:** The 9 cm optimum is **specific to that experiment's site,
cultivar, regime and fertigation levels**. It is explicitly **not** encoded as a
Japanese recommendation anywhere in this repository, and must not be.

> Metadata verified via Crossref. The full text sits behind a publisher
> paywall; the treatment list and optimum above are reported from the abstract
> and secondary summaries, not from a reading of the full article.

### 8. 深水栽培による高品質米生産技術 ✅ Primary

**Title (EN):** High-Quality Rice Production Technology by Deep-Flood Irrigation: Effects of Deep-Flood Irrigation on Rice Growth and Grain Appearance Quality
**Authors:** 千葉 雅大, 松村 修, 寺尾 富夫, 高橋 能彦, 渡邊 肇
**Journal:** 日本作物学会紀事 / *Japanese Journal of Crop Science* **78**(4): 455–464 · 2009
**DOI:** [10.1626/jcs.78.455](https://doi.org/10.1626/jcs.78.455) · **Language:** Japanese

**Source states:** Deep-flood irrigation at a water depth of **18 cm** during
the tillering phase reduced the occurrence of white-belly and milk-white grain.
Panicle number fell but grains per panicle and 1,000-grain weight rose, giving
yields comparable to conventional cultivation — conditional on sufficient stem
density (~330 stems/m²) before treatment.

**Project interpretation:** The clearest single refutation of "there is one
correct paddy water depth." A deliberate, peer-reviewed Japanese strategy uses
**180 mm** during the exact stage for which the NARO guidance above gives
**~30 mm** — a sixfold difference, both correct for their own objectives
(tillering promotion vs. grain appearance quality). This is why the app frames
its output as a *reference range for a stated management mode with a named
source*, never as "the correct depth."

**Limitation:** A specific cultivation strategy with prerequisites, not general
advice. Do not read 18 cm as a target.

### 9. Dong, Mao, Cui, Luo & Li (2020) ✅ Primary (metadata)

**Title:** Controlled Irrigation for Paddy Rice in China
**Journal:** *Irrigation and Drainage* **69**(S2): 61–74 · 2020-09-06
**DOI:** [10.1002/ird.2519](https://doi.org/10.1002/ird.2519) · **Language:** English

**Source states:** Reviews ~40 years of Chinese controlled-irrigation technology
development, reporting water saving, yield increase and improved water
productivity from controlled irrigation adapted to local conditions.

**Project interpretation:** Supports the architectural principle that a
water-management *strategy* (not merely a depth) is the unit of decision, and
that stage-linked control regimes are an established, evaluated practice
internationally.

**Limitation:** A review of Chinese practice under Chinese conditions. No value
from it is used here.

### 10. FAO Irrigation and Drainage Paper 56 ✅ Primary (metadata)

**Title:** Crop evapotranspiration — Guidelines for computing crop water requirements
**Authors:** Richard G. Allen, Luis S. Pereira, Dirk Raes, Martin Smith
**Publisher:** FAO, Rome · 1998 · **ISBN** 92-5-104219-5 · **Language:** English
**URL:** <https://www.fao.org/4/x0490e/x0490e00.htm>

**Source states:** Defines the crop-coefficient approach in which crop
evapotranspiration is obtained from reference evapotranspiration and a
crop coefficient:

```
ETc = Kc × ETo
```

where `ETo` is climate-driven reference evapotranspiration and `Kc` varies
through the crop's development stages.

**Project interpretation:** The intended framework for a **future** water-balance
model, and the reason `ETc` appears in the conceptual formula in
`docs/ARCHITECTURE.md`. Because `Kc` changes through the season, this source is
also independent support for the core claim that crop water requirement is
stage-dependent.

**Limitation:** **Not implemented.** No ET term exists anywhere in this
repository's calculations. The app currently consumes weather data only for
rainfall-based gate advice, and computes no evapotranspiration of any kind.
Citing FAO 56 describes a design target, not a shipped capability.

---

## Source-to-code map

Every displayed number should be traceable from screen → registry entry →
citation above.

| Number in app | Registry entry | Reference |
|---|---|---|
| 移植直後 / 活着期 30–50 mm | `naroGeneralWaterManagement` | §1 |
| 分げつ期 25–35 mm | `naroGeneralWaterManagement`, `naroTillering` | §1, §2 |
| 出穂・開花期 40–60 mm | `naroGeneralWaterManagement`, `irriWaterManagement` | §1, §4 |
| Stages with **no** numeric target | `naroGeneralWaterManagement`, `naroSmartWater` | §1, §3 |
| 11.0–17.5 mm/day loss context | `naroWaterRequirement` | §6 |
| Management-mode vocabulary | `naroSmartWater` | §3 |

Sources §7–§10 intentionally appear **nowhere** in that column.

---

## Excluded on purpose

- **Blogs, content farms and AI-generated summaries.** Not cited, at any point.
- **A universal daily water-loss constant.** No such number is defensible across
  fields; see §6.
- **A single "correct" paddy depth.** See §1 vs §8.
- **Any citation whose metadata could not be confirmed.** Where a figure was
  wanted but its source could not be verified, the figure was dropped rather
  than the citation invented.

## Contributing a new number

1. Fetch and read the source. Record the URL and the date checked.
2. Add an entry to `js/water/water-management-sources.js` with
   `verification: { level, checkedOn }`.
3. Quote the source's own wording in `supportsJa`; state what it does not
   establish in `caveatJa`.
4. Reference the entry's id from the stage rule's `sourceIds`.
5. Add the citation here, keeping *source states* / *project interpretation* /
   *limitation* separate.

A number whose provenance cannot survive step 1 does not go in.
