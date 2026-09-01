// Central provenance registry for every agronomic number this app shows.
//
// Why a registry instead of numbers inline in the recommendation table: this
// project is demonstrated as a research/hackathon system, so a farmer (or a
// reviewer) must be able to ask "who says 3cm?" and get an organization, a
// title, a URL, what the source actually supports, and its caveat. A magic
// number in a UI template cannot answer that.
//
// RULES FOR THIS FILE
//   - Bibliographic metadata is copied from the source itself, never
//     paraphrased into something that looks like a title. Every entry carries
//     a `verification` block saying how and when it was checked, so a
//     reviewer can tell a fetched-and-read page from a live-but-unread one.
//   - `supportsJa` quotes or closely tracks the source's own wording, and is
//     deliberately narrow so we never over-claim. `caveatJa` says what the
//     source does NOT establish.
//   - Nothing here is a universal constant. Research values (減水深) are
//     reported as the surveyed range with its variability, never as a default
//     the engine silently applies.

/** confidence levels a recommendation rule may carry. */
export const CONFIDENCE_LEVELS = {
  // A numeric range supported by cultivation guidance for normal conditions.
  reference: { id: "reference", labelJa: "参考範囲", labelEn: "Reference range" },
  // No defensible numeric target -- the recommendation is a management state.
  managementState: { id: "management-state", labelJa: "管理状態のみ", labelEn: "Management state only" },
  // Stage unknown: we ask rather than guess.
  unknown: { id: "unknown", labelJa: "情報不足", labelEn: "Insufficient information" }
};

/** How a registry entry was checked. Shown in the UI next to the citation. */
export const VERIFICATION_LEVELS = {
  // Page/record fetched and read; the quoted content below comes from it.
  primary: { id: "primary", labelJa: "本文確認済み", labelEn: "Full text checked" },
  // URL resolves and returns the expected document, but its contents could not
  // be machine-read here (e.g. a scanned PDF with no text layer).
  linkOnly: { id: "link-only", labelJa: "リンクのみ確認（本文未確認）", labelEn: "Link resolves; contents unverified" }
};

const CHECKED_ON = "2026-08-18";

export const WATER_MANAGEMENT_SOURCES = {
  naroSmartWater: {
    id: "naroSmartWater",
    organization: "農研機構 農業環境変動研究センター",
    titleJa: "気象情報を利用して水田圃場の給排水を最適化・自動化するスマート水管理ソフト",
    titleEn: "NARO smart paddy water-management software (2018 成果情報, 普及成果情報)",
    url: "https://www.naro.go.jp/project/results/4th_laboratory/niaes/2018/18_062.html",
    supportsJa: "この推奨エンジンの設計思想そのもの。栽培期間を最大10期間に分割し、各期間の区切りを発育ステージと紐付け、各期間の水管理法を「一定水深・間断灌漑・深水管理・排水」の4種類から選ぶ、という構成。",
    supportsEn: "The architecture of this engine: the cultivation period is split into up to 10 stages tied to crop development, each managed with one of four modes -- constant depth, intermittent irrigation, deep water, or drainage.",
    caveatJa: "個々の圃場に対する具体的な水深値を定めるものではありません。",
    caveatEn: "It does not prescribe a specific water depth for an individual field.",
    verification: { level: "primary", checkedOn: CHECKED_ON }
  },
  naroGeneralWaterManagement: {
    id: "naroGeneralWaterManagement",
    organization: "農研機構 東北農業研究センター（図説：東北の稲作と冷害）",
    titleJa: "図説：生育時期別の一般的な水管理",
    titleEn: "Illustrated guide: general water management by growth stage",
    url: "https://agrimet.tarc.naro.go.jp/reigai/zusetu/kangai.html",
    // Verbatim from the page; these are the numbers the stage table encodes.
    supportsJa: "生育時期別の具体的な水深。活着期「日中止水で３〜４ｃｍの浅水とし…夜間は５ｃｍ程度の水深」、分げつ期「水深３ｃｍ前後の浅水管理」、有効分げつ決定期〜穂首分化期「目標茎数を確保したら，直ちに中干しに入る」、穂首分化期〜穂ばらみ期「間断灌漑を行う」、穂ばらみ期〜開花期「水分補給を重視した湛水（花水）」、登熟期「間断灌漑を行い…落水時期は…出穂後３０日が目安」。",
    supportsEn: "Stage-specific depths: 3-4cm shallow water by day and about 5cm at night during establishment; about 3cm shallow water during tillering; begin mid-season drainage as soon as the target tiller count is reached; intermittent irrigation from panicle differentiation to booting; flooding around heading/flowering; intermittent irrigation during ripening with final drainage about 30 days after heading.",
    caveatJa: "出典は「福島県稲作指導指針（総合版），平成４年３月，福島県農政部（一部改変）」で、東北の冷害対策を前提とした一般論です。地域・品種・年次によって適正値は変わり、地域の指導機関の指示が優先します。",
    caveatEn: "Derived from Fukushima Prefecture's 1992 rice cultivation guidance and framed around Tohoku cold-damage risk. Appropriate values vary by region, variety and season; local extension guidance takes precedence.",
    verification: { level: "primary", checkedOn: CHECKED_ON }
  },
  naroTillering: {
    id: "naroTillering",
    organization: "農研機構 東北農業研究センター（図説：東北の稲作と冷害）",
    titleJa: "図説：活着期から分げつ期の浅水管理のポイント",
    titleEn: "Illustrated guide: shallow-water management from establishment to tillering",
    url: "https://agrimet.tarc.naro.go.jp/reigai/zusetu/water/tillering.html",
    supportsJa: "「分げつ形成期は、低温・強風時を除いて、水管理は浅水を基本とする」。浅水ほど水温の日格差が大きくなり、それが分げつ発生を促進するという根拠。",
    supportsEn: "Shallow water is the basis during tiller formation, except under low temperature or strong wind: shallower water widens the daily water-temperature swing, which promotes tillering.",
    caveatJa: "「浅水」の具体的な水深は地域・品種・気象で変わります。低温・強風時は判断が逆転し得ます。",
    caveatEn: "The exact depth of 'shallow' varies by region, variety and weather; under low temperature or wind the correct action can reverse.",
    verification: { level: "primary", checkedOn: CHECKED_ON }
  },
  irriWaterManagement: {
    id: "irriWaterManagement",
    organization: "IRRI (International Rice Research Institute) Rice Knowledge Bank",
    titleJa: "Water management / Saving Water with Alternate Wetting Drying (AWD)",
    titleEn: "Water management / Saving Water with Alternate Wetting Drying (AWD)",
    url: "http://www.knowledgebank.irri.org/step-by-step-production/growth/water-management",
    supportsJa: "出穂・開花前後の湛水。原文「From one week before to a week after flowering, the field should be kept flooded, topping up to a depth of 5 cm as needed.」また再湛水の目安を「a depth of about 5 cm」としています。",
    supportsEn: "Flooding around flowering: 'From one week before to a week after flowering, the field should be kept flooded, topping up to a depth of 5 cm as needed', with re-flooding to about 5 cm.",
    caveatJa: "国際的（主に熱帯アジア）な指針であり、日本の栽培指導そのものではありません。日本の指導指針と併記した参考値として扱ってください。",
    caveatEn: "International (mainly tropical Asia) guidance, not Japanese cultivation instruction; treat as a cross-reference alongside domestic guidance.",
    verification: { level: "primary", checkedOn: CHECKED_ON }
  },
  naroWaterRequirement: {
    id: "naroWaterRequirement",
    organization: "農研機構 農村工学研究部門",
    titleJa: "低平地水田における減水深の空間的ばらつき",
    titleEn: "Spatial Variation in the Water Requirement Rate for Paddy Fields in Flat and Lower Areas",
    authors: ["福本 昌人 (FUKUMOTO, Masato)", "進藤 惣治 (SHINDO, Soji)"],
    journal: "農研機構研究報告 農村工学研究部門 (Bulletin of the NARO, Rural Engineering)",
    volume: "3",
    pages: "1-12",
    publishedOn: "2019-03-30",
    issn: "2432-7883",
    doi: "10.24514/00001146",
    url: "https://repository.naro.go.jp/records/1181",
    supportsJa: "水田の必要水量は湛水量だけでは決まらず、蒸発散・浸透などで日々失われること。新潟県西蒲原地域の851調査圃場・6生育段階で、減水深の生育段階別平均は 11.0〜17.5 mm/日、変動係数は 70.6〜79.4 と報告されています。",
    supportsEn: "Paddy water demand is not standing water alone. Across 851 survey fields in the Nishikanbara Region of Niigata and six growth stages, the average water requirement rate per stage was 11.0-17.5 mm/day, with a coefficient of variation of 70.6-79.4.",
    caveatJa: "特定地域（新潟県西蒲原・強粘質下層土・灰色土）の実測値であり、普遍的な定数ではありません。変動係数が70を超えることが示すとおり圃場間のばらつきは非常に大きく、本アプリの計算には自動適用していません。",
    caveatEn: "Measured values from one region and soil type, not universal constants. The coefficient of variation above 70 shows how large between-field variability is; this app does not apply these figures automatically.",
    verification: { level: "primary", checkedOn: CHECKED_ON }
  },
  maffCultivation: {
    id: "maffCultivation",
    organization: "農林水産省 (MAFF)",
    // Deliberately descriptive, and flagged as such: this document carries no
    // embedded title and no text layer, so no title is quoted from it here.
    titleJa: "都道府県施肥基準等 掲載資料 suito2.pdf（水稲関係資料・全23ページ）",
    titleEn: "MAFF-hosted rice document suito2.pdf (23 pages), listed under prefectural fertilization standards",
    url: "https://www.maff.go.jp/j/seisan/kankyo/hozen_type/h_sehi_kizyun/pdf/suito2.pdf",
    supportsJa: "プロジェクト要件で参照指定された、生育ステージ別の水管理（移植直後のやや深水、活着後の浅水、中干し、間断灌漑、幼穂形成期前後、登熟期の飽水・間断管理）に関する行政資料。",
    supportsEn: "The project brief's cited MAFF reference for stage-differentiated water management (slightly deep water after transplanting, shallow water after establishment, mid-season drainage, intermittent irrigation, management around panicle formation, saturated/intermittent conditions later).",
    caveatJa: "URLは到達し実体はPDFですが、本文がテキスト化されていない画像PDFのため、本アプリでは内容を機械的に検証できていません。したがって具体的な数値の根拠としては使用せず、参考資料として掲示しています。",
    caveatEn: "The URL resolves to a real PDF, but it is image-only with no text layer, so its contents could not be verified here. It is therefore listed as background reading and is NOT used as the basis for any numeric range.",
    verification: { level: "link-only", checkedOn: CHECKED_ON }
  }
};

/**
 * Water-requirement figures from the 851-field NARO survey.
 *
 * Exposed so the UI can show "actual irrigation need also covers daily losses
 * of roughly this much" as EVIDENCE, and deliberately NOT wired into
 * evaluateWaterManagement()'s arithmetic: this app does not know a given
 * field's soil, percolation rate or irrigation efficiency, and the survey's
 * own coefficient of variation (70.6-79.4) says the between-field spread is
 * enormous. Applying such an average as a constant would turn an honest
 * geometric number into a fabricated agronomic one.
 */
export const WATER_REQUIREMENT_REFERENCE = {
  minMmPerDay: 11.0,
  maxMmPerDay: 17.5,
  surveyedFieldCount: 851,
  variationCoefficientRange: [70.6, 79.4],
  regionJa: "新潟県西蒲原地域",
  sourceId: "naroWaterRequirement",
  noteJa: "新潟県西蒲原地域の851調査圃場では、減水深の生育段階別平均は 11.0〜17.5 mm/日 と報告されています（変動係数 70.6〜79.4 と圃場間のばらつきは非常に大きい）。実際の必要用水量にはこの日々の損失が加わります。",
  noteEn: "Across 851 surveyed fields in Niigata, the average water requirement rate per growth stage was 11.0-17.5 mm/day, with very large between-field variability (CV 70.6-79.4). Real irrigation requirement includes these daily losses."
};

/** @returns {object|null} the registry entry, or null for an unknown id. */
export function waterManagementSource(sourceId) {
  return Object.prototype.hasOwnProperty.call(WATER_MANAGEMENT_SOURCES, sourceId)
    ? WATER_MANAGEMENT_SOURCES[sourceId]
    : null;
}

/** Resolves a rule's sourceIds to registry entries, silently dropping unknown ids. */
export function resolveSources(sourceIds = []) {
  return (Array.isArray(sourceIds) ? sourceIds : [])
    .map((id) => waterManagementSource(id))
    .filter(Boolean);
}

/** Human-readable verification label for a source, for display next to it. */
export function verificationLabel(source) {
  const level = source?.verification?.level;
  return VERIFICATION_LEVELS[level]?.labelJa
    || VERIFICATION_LEVELS[level === "primary" ? "primary" : "linkOnly"]?.labelJa
    || "";
}
