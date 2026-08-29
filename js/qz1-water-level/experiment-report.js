// Rendering an analysis for humans: a fixed-width table for the terminal and
// a self-contained HTML page for the record.
//
// WHAT A REPORT FROM THIS MODULE ALWAYS CARRIES
// ---------------------------------------------
// A number without its conditions is not a result, so no output here can be
// produced without:
//   * the filter chain that was applied (or "none");
//   * the sample count behind every mean, and how many were rejected;
//   * the confidence interval, and the note that it is optimistic;
//   * the telemetry the receiver never sent, listed by name;
//   * every warning the analysis raised, printed in full, not summarised.
//
// A report where 10 mm and 20 mm read FAIL is a successful report. The
// formatting gives negative and positive verdicts identical prominence for
// exactly that reason.

import { buildResultTable, summarizeOutcome } from "./displacement-analysis.js";
import { buildAllPlots, escapeXml } from "./experiment-plots.js";

/** The brief's table, as fixed-width text. */
export function renderResultTable(analysis) {
  const rows = buildResultTable(analysis);
  const header = ["Reference", "ΔRef", "Raw est.", "Filtered est.", "Error", "n", "SD", "±95%CI", "Verdict"];
  const body = rows.map((row) => [
    `${row.referenceMm} mm`,
    formatMm(row.deltaReferenceMm),
    formatMm(row.rawEstimateMm),
    formatMm(row.filteredEstimateMm),
    row.referenceMm === 0 ? "—" : formatMm(row.errorMm),
    String(row.sampleCount),
    formatNumber(row.sdMm),
    formatNumber(row.ci95Mm),
    row.verdict ?? "baseline"
  ]);

  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...body.map((line) => line[index].length)));
  const line = (cells) => cells.map((cell, index) => cell.padStart(widths[index])).join("  ");

  return [
    line(header),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...body.map(line)
  ].join("\n");
}

/** Full plain-text report. */
export function renderTextReport(analysis) {
  const config = analysis.config;
  const out = [];

  out.push("QZ1 VERTICAL DISPLACEMENT EXPERIMENT");
  out.push("=".repeat(72));
  out.push(`experiment      ${config.experimentId}`);
  out.push(`stage           ${config.stage}`);
  out.push(`sensor          ${config.sensor}`);
  if (config.location) out.push(`location        ${config.location}`);
  out.push(`dwell / settle  ${config.dwellSeconds} s / ${config.settleSeconds} s`);
  out.push(`tolerance       ±${config.toleranceMm} mm`);
  out.push(`filter chain    ${describeChain(analysis.filterChain)}`);
  out.push("");

  out.push("RESULT");
  out.push("-".repeat(72));
  out.push(renderResultTable(analysis));
  out.push("");
  out.push(summarizeOutcome(analysis));
  out.push("");

  out.push("VERDICT REASONING");
  out.push("-".repeat(72));
  for (const level of analysis.levels) {
    if (level.referenceHeightMm === 0) continue;
    out.push(`${String(level.referenceHeightMm).padStart(5)} mm  ${level.resolvability.verdict}`);
    for (const reason of level.resolvability.reasons) {
      out.push(`          - ${reason}`);
    }
  }
  out.push("");

  const hysteresis = analysis.levels.filter((level) => level.hysteresis?.differenceMm !== null
    && level.hysteresis?.differenceMm !== undefined);
  if (hysteresis.length > 0) {
    out.push("HYSTERESIS (descending mean − ascending mean at the same height)");
    out.push("-".repeat(72));
    for (const level of hysteresis) {
      out.push(`${String(level.referenceHeightMm).padStart(5)} mm  ${formatMm(level.hysteresis.differenceMm)}`);
    }
    out.push("A large value means the altitude drifted during the run, so part of every");
    out.push("displacement above is elapsed time rather than movement.");
    out.push("");
  }

  out.push("DATA ACCOUNTING");
  out.push("-".repeat(72));
  out.push(`settling samples discarded   ${analysis.settlingSampleCount}`);
  out.push(`samples outside any mark     ${analysis.unassignedSampleCount}`);
  out.push(`samples with no timestamp    ${analysis.undatableSampleCount}`);
  for (const level of analysis.levels) {
    out.push(`  ${String(level.referenceHeightMm).padStart(5)} mm: `
      + `${level.rawSampleCount} accepted → ${level.filtered.count} after filtering `
      + `(${level.rejectedByFilter} rejected)`);
  }
  out.push("");

  out.push("TELEMETRY ACTUALLY PROVIDED BY THIS RECEIVER");
  out.push("-".repeat(72));
  for (const [field, entry] of Object.entries(analysis.telemetryCoverage)) {
    out.push(`  ${field.padEnd(20)} ${entry.present} / ${entry.total}`);
  }
  out.push("");

  out.push("UNCERTAINTY");
  out.push("-".repeat(72));
  out.push("The ±95% CI column uses an AR(1) effective sample size, because consecutive");
  out.push("GNSS fixes are correlated. It is still OPTIMISTIC: real GNSS error has longer");
  out.push("memory than one lag. Treat it as a lower bound on the uncertainty.");
  out.push("");

  if (analysis.warnings.length > 0) {
    out.push("WARNINGS");
    out.push("-".repeat(72));
    for (const warning of analysis.warnings) {
      out.push(`  ! ${warning}`);
    }
    out.push("");
  }

  out.push("This result describes THIS receiver at THIS site with THIS filter chain.");
  out.push("It is not a statement about GNSS water-level sensing in general.");

  return out.join("\n");
}

/** Self-contained HTML report with the plots inlined. */
export function renderHtmlReport(analysis) {
  const plots = buildAllPlots(analysis);
  const rows = buildResultTable(analysis);
  const config = analysis.config;

  const tableRows = rows.map((row) => `
      <tr class="${row.verdict ? row.verdict.toLowerCase() : "baseline"}">
        <td>${row.referenceMm} mm</td>
        <td>${formatMm(row.deltaReferenceMm)}</td>
        <td>${formatMm(row.rawEstimateMm)}</td>
        <td>${formatMm(row.filteredEstimateMm)}</td>
        <td>${row.referenceMm === 0 ? "—" : formatMm(row.errorMm)}</td>
        <td>${row.sampleCount}</td>
        <td>${formatNumber(row.sdMm)}</td>
        <td>${formatNumber(row.ci95Mm)}</td>
        <td><span class="verdict">${escapeXml(row.verdict ?? "baseline")}</span></td>
      </tr>`).join("");

  const reasoning = analysis.levels
    .filter((level) => level.referenceHeightMm !== 0)
    .map((level) => `
      <li><strong>${level.referenceHeightMm} mm — ${escapeXml(level.resolvability.verdict)}</strong>
        <ul>${level.resolvability.reasons.map((reason) => `<li>${escapeXml(reason)}</li>`).join("")}</ul>
      </li>`).join("");

  const warnings = analysis.warnings.length === 0 ? "" : `
    <section>
      <h2>警告 / Warnings</h2>
      <ul class="warnings">${analysis.warnings.map((warning) => `<li>${escapeXml(warning)}</li>`).join("")}</ul>
    </section>`;

  const coverage = Object.entries(analysis.telemetryCoverage)
    .map(([field, entry]) => `<tr><td>${escapeXml(field)}</td><td>${entry.present} / ${entry.total}</td></tr>`)
    .join("");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QZ1 水位実験レポート — ${escapeXml(config.experimentId)}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: system-ui, -apple-system, "Hiragino Sans", sans-serif; margin: 0 auto; max-width: 900px;
         padding: 24px 16px 64px; color: #1e293b; background: #f8fafc; line-height: 1.6; }
  h1 { font-size: 1.4rem; margin-bottom: 4px; }
  h2 { font-size: 1.05rem; margin-top: 32px; border-bottom: 1px solid #cbd5e1; padding-bottom: 4px; }
  .meta { color: #475569; font-size: 0.85rem; }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; background: #fff; }
  th, td { border: 1px solid #e2e8f0; padding: 6px 8px; text-align: right; }
  th:first-child, td:first-child { text-align: left; }
  th { background: #f1f5f9; }
  .verdict { font-weight: 600; }
  tr.pass .verdict { color: #16a34a; }
  tr.inconclusive .verdict { color: #ca8a04; }
  tr.fail .verdict { color: #dc2626; }
  tr.insufficient .verdict { color: #64748b; }
  figure { margin: 16px 0; background: #fff; border: 1px solid #e2e8f0; border-radius: 6px; padding: 8px; }
  .warnings li { color: #92400e; }
  .caveat { background: #fff7ed; border-left: 4px solid #ea580c; padding: 8px 12px; font-size: 0.85rem; }
  ul ul { color: #475569; font-size: 0.85rem; }
  .outcome { font-size: 1rem; font-weight: 600; background:#fff; border:1px solid #cbd5e1; border-radius:6px; padding:12px; }
</style>
</head>
<body>
<h1>QZ1 鉛直変位実験レポート</h1>
<p class="meta">
  experiment <strong>${escapeXml(config.experimentId)}</strong> ·
  stage ${escapeXml(config.stage)} ·
  sensor ${escapeXml(config.sensor)} ·
  dwell ${config.dwellSeconds}s / settle ${config.settleSeconds}s ·
  tolerance ±${config.toleranceMm} mm<br>
  filter chain: <code>${escapeXml(describeChain(analysis.filterChain))}</code>
</p>

<p class="outcome">${escapeXml(summarizeOutcome(analysis))}</p>

<section>
  <h2>結果 / Result</h2>
  <table>
    <thead><tr>
      <th>Reference</th><th>ΔRef</th><th>Raw est.</th><th>Filtered est.</th>
      <th>Error</th><th>n</th><th>SD</th><th>±95%CI</th><th>Verdict</th>
    </tr></thead>
    <tbody>${tableRows}</tbody>
  </table>
  <p class="caveat">
    ±95%CI は AR(1) の有効サンプル数で補正済みですが、それでも楽観的です
    （GNSS誤差の相関はラグ1より長く続きます）。不確かさの下限として読んでください。
    この結果はこの受信機・この設置条件・このフィルタについてのものであり、
    GNSS水位計測一般についての主張ではありません。
  </p>
</section>

<section>
  <h2>判定理由 / Verdict reasoning</h2>
  <ul>${reasoning}</ul>
</section>

<section>
  <h2>図 / Plots</h2>
  <figure>${plots.altitudeTimeSeries}</figure>
  <figure>${plots.referenceVsEstimate}</figure>
  <figure>${plots.errorVsReference}</figure>
  <figure>${plots.distribution}</figure>
</section>

<section>
  <h2>受信機が実際に出力した項目 / Telemetry actually provided</h2>
  <table><thead><tr><th>field</th><th>present / total</th></tr></thead><tbody>${coverage}</tbody></table>
</section>
${warnings}
</body>
</html>
`;
}

function describeChain(chain) {
  if (!chain || chain.length === 0) {
    return "none (raw only)";
  }
  return chain.map((stage) => {
    const parameters = Object.entries(stage)
      .filter(([key]) => key !== "kind")
      .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join("|") : value}`)
      .join(" ");
    return parameters ? `${stage.kind}(${parameters})` : stage.kind;
  }).join(" → ");
}

function formatMm(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}`;
}

function formatNumber(value) {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : value.toFixed(1);
}
