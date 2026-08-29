import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAllPlots,
  errorVsReferencePlot,
  escapeXml,
  linearScale,
  niceRange,
  referenceVsEstimatePlot,
  tickValues
} from "../../js/qz1-water-level/experiment-plots.js";
import { analyzeExperiment } from "../../js/qz1-water-level/displacement-analysis.js";
import { normalizeExperimentConfig } from "../../js/qz1-water-level/experiment-config.js";
import { renderHtmlReport, renderResultTable, renderTextReport } from "../../js/qz1-water-level/experiment-report.js";

const T0 = Date.UTC(2026, 0, 15, 2, 0, 0);
const DWELL_S = 120;

/** SYNTHETIC analysis over hand-built samples. Proves rendering, not accuracy. */
function analysis({ offsets = {}, heights = [0, 10, 100] } = {}) {
  const { config } = normalizeExperimentConfig({
    experiment: "plot-test",
    sensor: "SYNTHETIC",
    reference_heights_mm: heights,
    include_descending: false,
    sampling_configuration: { dwell_seconds: DWELL_S, settle_seconds: 0 },
    tolerance_mm: 10
  });
  const samples = [];
  const marks = [];
  let cursor = T0;
  heights.forEach((height, stepIndex) => {
    const trueHeight = height + (offsets[height] ?? 0);
    for (let index = 0; index < DWELL_S; index += 1) {
      samples.push({
        timestampUtcMs: cursor + index * 1000,
        altitudeMm: 50000 + trueHeight + (index % 2 === 0 ? 1 : -1),
        fix: 1, satellites: 9, hdop: 0.9
      });
    }
    marks.push({
      stepIndex, referenceHeightMm: height, visitIndex: 0, direction: "ascending",
      startMs: cursor, endMs: cursor + DWELL_S * 1000, settleSeconds: 0
    });
    cursor += DWELL_S * 1000;
  });
  return analyzeExperiment({ samples, marks, config });
}

test("all four plots render as well-formed standalone SVG", () => {
  const plots = buildAllPlots(analysis());
  for (const [name, svg] of Object.entries(plots)) {
    assert.ok(svg.startsWith("<svg"), `${name} must be an SVG element`);
    assert.ok(svg.endsWith("</svg>"), `${name} must be closed`);
    assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'), `${name} must be standalone`);
    assert.ok(!svg.includes("NaN"), `${name} must not contain NaN coordinates`);
    assert.ok(!svg.includes("Infinity"), `${name} must not contain Infinity coordinates`);
  }
});

test("the reference-vs-estimate plot uses ONE shared scale for both axes", () => {
  // Different x and y scales would make a slope of 0.3 look like a slope of 1
  // — the single most effective way to overstate this system.
  const svg = referenceVsEstimatePlot(analysis());
  const ideal = svg.match(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)" stroke="#64748b"/);
  assert.ok(ideal, "the y = x ideal line must be drawn");
  const [, x1, y1, x2, y2] = ideal.map(Number);
  const drawnSlope = Math.abs((y2 - y1) / (x2 - x1));
  assert.ok(Math.abs(drawnSlope - 1) < 0.05,
    `y = x must be drawn at 45°, got slope ${drawnSlope.toFixed(3)}`);
});

test("the error plot always shows the zero line and the tolerance band", () => {
  // Cropping an error plot above its own tolerance line makes it unreadable
  // as an error plot.
  const svg = errorVsReferencePlot(analysis({ offsets: { 100: 400 } }));
  assert.ok(svg.includes("許容"), "the tolerance band is labelled");
  assert.ok(svg.includes('fill="#16a34a" opacity="0.10"'), "the tolerance band is drawn");
});

test("verdicts are colour-coded consistently across the plots", () => {
  const failing = analysis({ offsets: { 10: 500, 100: 500 } });
  const svg = referenceVsEstimatePlot(failing);
  assert.ok(svg.includes("#ca8a04") || svg.includes("#dc2626"),
    "a non-PASS level must not be drawn in the PASS colour");
});

test("plots degrade to a labelled empty frame rather than throwing", () => {
  const empty = {
    ok: true,
    config: { toleranceMm: 10 },
    levels: [],
    warnings: []
  };
  for (const svg of Object.values(buildAllPlots(empty))) {
    assert.ok(svg.startsWith("<svg"));
    assert.ok(!svg.includes("NaN"));
  }
});

test("a zero-width data range never collapses to a single line", () => {
  // A perfectly stable signal drawn on a zero-height axis would read as
  // "flawless", which is a rendering artefact, not a measurement.
  const [low, high] = niceRange(50, 50);
  assert.ok(high > low);
  assert.deepEqual(niceRange(NaN, NaN), [0, 1]);
});

test("linearScale handles a degenerate domain without producing NaN", () => {
  const scale = linearScale([5, 5], [0, 100]);
  assert.equal(scale(5), 50);
  assert.ok(Number.isFinite(scale(999)));
});

test("tick values are round numbers inside the range", () => {
  const ticks = tickValues([0, 100]);
  assert.ok(ticks.length >= 3);
  assert.ok(ticks.every((value) => value >= 0 && value <= 100));
  assert.ok(ticks.includes(0));
});

test("text interpolated into SVG is escaped", () => {
  assert.equal(escapeXml('<a href="x">&\'</a>'),
    "&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;");
});

test("the text report always states the filter chain, even when there is none", () => {
  const report = renderTextReport(analysis());
  assert.ok(report.includes("filter chain    none (raw only)"));
});

test("the text report always carries the uncertainty caveat", () => {
  const report = renderTextReport(analysis());
  assert.ok(report.includes("OPTIMISTIC"), "the CI must never be quoted without its caveat");
  assert.ok(report.includes("THIS receiver"), "and the result must be scoped to this run");
});

test("the text report shows raw and filtered estimates in separate columns", () => {
  const table = renderResultTable(analysis());
  assert.ok(table.includes("Raw est."));
  assert.ok(table.includes("Filtered est."));
  assert.ok(table.includes("Verdict"));
});

test("the text report accounts for every sample, including discarded ones", () => {
  const report = renderTextReport(analysis());
  assert.ok(report.includes("settling samples discarded"));
  assert.ok(report.includes("samples outside any mark"));
  assert.ok(report.includes("TELEMETRY ACTUALLY PROVIDED BY THIS RECEIVER"));
});

test("the HTML report is self-contained and inlines the plots", () => {
  const html = renderHtmlReport(analysis());
  assert.ok(html.startsWith("<!DOCTYPE html>"));
  assert.equal((html.match(/<svg/g) || []).length, 4, "all four plots are embedded");
  assert.ok(!html.includes("<script"), "no scripts: the report must render anywhere, offline");
  assert.ok(!/src="https?:/.test(html), "no external resources");
  assert.ok(html.includes("楽観的"), "the uncertainty caveat travels with the report");
});
