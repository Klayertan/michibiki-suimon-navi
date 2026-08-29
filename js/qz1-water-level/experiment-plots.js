// Dependency-free SVG plots for a water-level experiment.
//
// Plain strings, no DOM and no chart library, so the same code draws the
// browser card and the standalone HTML report the CLI writes — and so the
// plots can be unit tested for the properties below rather than eyeballed.
//
// AXIS HONESTY IS ENFORCED HERE, NOT LEFT TO THE CALLER
// -----------------------------------------------------
// It is trivially easy to make GNSS look better than it is with a chart:
// crop the y-axis to ±5 mm and 40 mm of noise becomes a dramatic staircase;
// give the reference-vs-estimate plot different x and y scales and a slope of
// 0.3 looks like a slope of 1. So:
//
//   * `referenceVsEstimatePlot` shares one scale between the axes AND forces
//     the drawing area square, then draws the y = x ideal line. Sharing the
//     domain alone is not enough: on a 720x360 frame the same range maps to
//     628 px across and 288 px down, y = x is drawn at about 25 degrees, and
//     every departure from it reads as less than half its real size.
//   * `errorVsReferencePlot` always includes y = 0 and the whole tolerance
//     band in its range, so the sign and size of the error are read against
//     the "no error" line rather than against a crop.
//   * `distributionPlot` puts every reference height on ONE shared x-scale, so
//     a 3 mm-wide distribution and a 300 mm-wide one cannot look alike.
//   * Every axis states its units in its label.
//   * `niceRange` never returns a zero-width range, so a perfectly stable
//     signal is not drawn as a flawless flat line on a zero-height axis.
//
// The palette is grey/blue/orange with distinct dash patterns, so raw vs
// filtered stays distinguishable in greyscale print and for colour-blind
// readers.

const PALETTE = {
  raw: "#94a3b8",
  filtered: "#2563eb",
  reference: "#ea580c",
  ideal: "#64748b",
  axis: "#475569",
  grid: "#e2e8f0",
  text: "#1e293b",
  settling: "#cbd5e1",
  pass: "#16a34a",
  inconclusive: "#ca8a04",
  fail: "#dc2626"
};

const DEFAULT_SIZE = { width: 720, height: 320, padding: { top: 24, right: 24, bottom: 48, left: 68 } };

/** Plot 1 & 2: altitude against time, raw and filtered on one pair of axes. */
export function altitudeTimeSeriesPlot(analysis, options = {}) {
  const size = { ...DEFAULT_SIZE, ...options };
  const points = [];
  for (const level of analysis.levels) {
    for (const sample of level.filteredSamples) {
      if (Number.isFinite(sample.timestampUtcMs) && Number.isFinite(sample.altitudeMm)) {
        points.push({
          t: sample.timestampUtcMs,
          filtered: sample.altitudeMm,
          raw: Number.isFinite(sample.rawAltitudeMm) ? sample.rawAltitudeMm : sample.altitudeMm,
          referenceHeightMm: level.referenceHeightMm
        });
      }
    }
  }
  points.sort((a, b) => a.t - b.t);

  if (points.length === 0) {
    return emptyPlot("標高の時系列 / Altitude vs time", "有効なサンプルがありません / no usable samples", size);
  }

  const t0 = points[0].t;
  const xValues = points.map((point) => (point.t - t0) / 1000);
  const yValues = [...points.map((point) => point.raw), ...points.map((point) => point.filtered)];
  const x = linearScale(niceRange(Math.min(...xValues), Math.max(...xValues)), [size.padding.left, size.width - size.padding.right]);
  const y = linearScale(niceRange(Math.min(...yValues), Math.max(...yValues)), [size.height - size.padding.bottom, size.padding.top]);

  const rawPath = polyline(points.map((point, index) => [x(xValues[index]), y(point.raw)]));
  const filteredPath = polyline(points.map((point, index) => [x(xValues[index]), y(point.filtered)]));

  // A faint band per reference height, so the steps the operator actually
  // made are visible behind the trace and cannot be confused with it.
  const bands = analysis.levels.flatMap((level) => level.visits
    .filter((visit) => Number.isFinite(visit.startMs) && Number.isFinite(visit.endMs))
    .map((visit) => {
      const left = x((visit.startMs - t0) / 1000);
      const right = x((visit.endMs - t0) / 1000);
      return `<rect x="${left.toFixed(1)}" y="${size.padding.top}" width="${Math.max(0, right - left).toFixed(1)}" `
        + `height="${(size.height - size.padding.bottom - size.padding.top).toFixed(1)}" fill="${PALETTE.grid}" opacity="0.45"/>`
        + `<text x="${((left + right) / 2).toFixed(1)}" y="${size.padding.top + 12}" text-anchor="middle" `
        + `font-size="10" fill="${PALETTE.axis}">${escapeXml(String(level.referenceHeightMm))}</text>`;
    }));

  return svg(size, [
    ...bands,
    axes(size, x, y, "経過時間 (s) / elapsed", "標高 (mm) / altitude"),
    `<path d="${rawPath}" fill="none" stroke="${PALETTE.raw}" stroke-width="1" stroke-dasharray="2 2"/>`,
    `<path d="${filteredPath}" fill="none" stroke="${PALETTE.filtered}" stroke-width="1.6"/>`,
    legend(size, [
      { color: PALETTE.raw, dash: "2 2", label: "生の標高 / raw" },
      { color: PALETTE.filtered, dash: null, label: "フィルタ後 / filtered" }
    ]),
    title(size, "標高の時系列（帯は各基準高さの滞在区間, mm） / Altitude vs time")
  ]);
}

/**
 * Plot 3: known reference displacement against GNSS-estimated displacement.
 *
 * The single most informative plot in the set: a perfect sensor puts every
 * marker on the y = x line. Shared scale, always.
 */
export function referenceVsEstimatePlot(analysis, options = {}) {
  // A SQUARE drawing area, not merely a shared domain.
  //
  // Sharing the domain between the axes is not enough: on a 720x360 frame the
  // same numeric range maps to 628 px horizontally and 288 px vertically, so
  // the y = x line is drawn at about 25 degrees and every deviation from it
  // looks less than half as large as it is. Anyone reading the slope off the
  // picture would systematically overrate the receiver. The plot area is
  // therefore forced square and the frame is sized around it.
  const base = { ...DEFAULT_SIZE, ...options };
  const side = Math.min(
    base.width - base.padding.left - base.padding.right,
    options.maxSide ?? 460
  );
  const size = {
    ...base,
    width: base.padding.left + side + base.padding.right,
    height: base.padding.top + side + base.padding.bottom
  };
  const levels = analysis.levels.filter((level) => level.deltaGnssMm !== null);
  if (levels.length === 0) {
    return emptyPlot("基準変位 vs GNSS推定 / Reference vs estimate", "推定できた位置がありません / no estimates", size);
  }

  const allValues = [
    0,
    ...levels.map((level) => level.deltaReferenceMm),
    ...levels.map((level) => level.deltaGnssMm),
    ...levels.map((level) => level.deltaGnssMm + (level.filtered.ci95Mm ?? 0)),
    ...levels.map((level) => level.deltaGnssMm - (level.filtered.ci95Mm ?? 0))
  ];
  const range = niceRange(Math.min(...allValues), Math.max(...allValues));
  const x = linearScale(range, [size.padding.left, size.width - size.padding.right]);
  const y = linearScale(range, [size.height - size.padding.bottom, size.padding.top]);

  const idealLine = `<line x1="${x(range[0])}" y1="${y(range[0])}" x2="${x(range[1])}" y2="${y(range[1])}" `
    + `stroke="${PALETTE.ideal}" stroke-width="1" stroke-dasharray="5 4"/>`;

  const markers = levels.map((level) => {
    const cx = x(level.deltaReferenceMm);
    const cy = y(level.deltaGnssMm);
    const ci = level.filtered.ci95Mm;
    const bar = Number.isFinite(ci)
      ? `<line x1="${cx}" y1="${y(level.deltaGnssMm - ci)}" x2="${cx}" y2="${y(level.deltaGnssMm + ci)}" `
        + `stroke="${verdictColor(level.resolvability.verdict)}" stroke-width="1.5"/>`
      : "";
    return `${bar}<circle cx="${cx}" cy="${cy}" r="4" fill="${verdictColor(level.resolvability.verdict)}"/>`;
  });

  return svg(size, [
    axes(size, x, y, "実際の変位 (mm) / actual ΔZ", "GNSS推定変位 (mm) / estimated ΔZ"),
    idealLine,
    ...markers,
    legend(size, [
      { color: PALETTE.ideal, dash: "5 4", label: "理想 y = x / ideal" },
      { color: PALETTE.pass, dash: null, label: "PASS" },
      { color: PALETTE.inconclusive, dash: null, label: "INCONCLUSIVE" },
      { color: PALETTE.fail, dash: null, label: "FAIL" }
    ]),
    title(size, "基準変位 vs GNSS推定変位（縦線は95%信頼区間） / Reference vs estimated displacement")
  ]);
}

/** Plot 4: error against reference height, with the tolerance band and y = 0. */
export function errorVsReferencePlot(analysis, options = {}) {
  const size = { ...DEFAULT_SIZE, ...options };
  const levels = analysis.levels.filter((level) => level.errorMm !== null);
  if (levels.length === 0) {
    return emptyPlot("誤差 / Error", "誤差を計算できた位置がありません / no errors computed", size);
  }

  const tolerance = analysis.config.toleranceMm;
  const xRange = niceRange(
    Math.min(0, ...levels.map((level) => level.referenceHeightMm)),
    Math.max(0, ...levels.map((level) => level.referenceHeightMm))
  );
  // Zero and the tolerance band are always in view: an error plot cropped
  // above its own tolerance line would be unreadable as an error plot.
  const yRange = niceRange(
    Math.min(-tolerance * 1.5, ...levels.map((level) => level.errorMm - (level.filtered.ci95Mm ?? 0))),
    Math.max(tolerance * 1.5, ...levels.map((level) => level.errorMm + (level.filtered.ci95Mm ?? 0)))
  );
  const x = linearScale(xRange, [size.padding.left, size.width - size.padding.right]);
  const y = linearScale(yRange, [size.height - size.padding.bottom, size.padding.top]);

  const band = `<rect x="${x(xRange[0])}" y="${y(tolerance)}" `
    + `width="${(x(xRange[1]) - x(xRange[0])).toFixed(1)}" height="${Math.abs(y(-tolerance) - y(tolerance)).toFixed(1)}" `
    + `fill="${PALETTE.pass}" opacity="0.10"/>`;

  const markers = levels.map((level) => {
    const cx = x(level.referenceHeightMm);
    const cy = y(level.errorMm);
    const ci = level.filtered.ci95Mm;
    const bar = Number.isFinite(ci)
      ? `<line x1="${cx}" y1="${y(level.errorMm - ci)}" x2="${cx}" y2="${y(level.errorMm + ci)}" `
        + `stroke="${verdictColor(level.resolvability.verdict)}" stroke-width="1.5"/>`
      : "";
    return `${bar}<circle cx="${cx}" cy="${cy}" r="4" fill="${verdictColor(level.resolvability.verdict)}"/>`;
  });

  return svg(size, [
    band,
    axes(size, x, y, "基準高さ (mm) / reference height", "誤差 (mm) / error"),
    `<line x1="${x(xRange[0])}" y1="${y(0)}" x2="${x(xRange[1])}" y2="${y(0)}" stroke="${PALETTE.axis}" stroke-width="1"/>`,
    ...markers,
    title(size, `誤差 = GNSS推定 − 実際（緑帯は許容 ±${tolerance}mm） / Error vs reference height`)
  ]);
}

/** Plot 5: the distribution of altitude at each held position, as histograms. */
export function distributionPlot(analysis, options = {}) {
  const perPlotHeight = options.rowHeight ?? 74;
  const levels = analysis.levels.filter((level) => level.filteredAltitudesMm.some(Number.isFinite));
  const size = {
    ...DEFAULT_SIZE,
    height: Math.max(160, levels.length * perPlotHeight + 72),
    ...options
  };
  if (levels.length === 0) {
    return emptyPlot("分布 / Distribution", "サンプルがありません / no samples", size);
  }

  // One shared x-scale across all levels: separate per-level scales would let
  // a 3 mm-wide distribution and a 300 mm-wide one look identical.
  const all = levels.flatMap((level) => level.filteredAltitudesMm).filter(Number.isFinite);
  const range = niceRange(Math.min(...all), Math.max(...all));
  const x = linearScale(range, [size.padding.left, size.width - size.padding.right]);

  const rows = levels.map((level, rowIndex) => {
    const top = size.padding.top + 24 + rowIndex * perPlotHeight;
    const values = level.filteredAltitudesMm.filter(Number.isFinite);
    const bins = binValues(values, range, 48);
    const peak = Math.max(1, ...bins.map((bin) => bin.count));
    const bars = bins.map((bin) => {
      const height = (bin.count / peak) * (perPlotHeight - 30);
      return `<rect x="${x(bin.fromMm).toFixed(1)}" y="${(top + (perPlotHeight - 30) - height).toFixed(1)}" `
        + `width="${Math.max(1, x(bin.toMm) - x(bin.fromMm)).toFixed(1)}" height="${height.toFixed(1)}" `
        + `fill="${PALETTE.filtered}" opacity="0.65"/>`;
    });
    const meanLine = level.filtered.meanMm === null ? "" :
      `<line x1="${x(level.filtered.meanMm).toFixed(1)}" y1="${top}" x2="${x(level.filtered.meanMm).toFixed(1)}" `
      + `y2="${top + perPlotHeight - 30}" stroke="${PALETTE.reference}" stroke-width="1.5"/>`;
    const label = `<text x="${size.padding.left - 8}" y="${top + 14}" text-anchor="end" font-size="11" `
      + `fill="${PALETTE.text}">${escapeXml(`${level.referenceHeightMm} mm`)}</text>`
      + `<text x="${size.padding.left - 8}" y="${top + 27}" text-anchor="end" font-size="9" `
      + `fill="${PALETTE.axis}">n=${level.filtered.count}</text>`;
    return `${label}${bars.join("")}${meanLine}`;
  });

  const axisY = size.height - size.padding.bottom + 8;
  const ticks = tickValues(range).map((value) =>
    `<text x="${x(value).toFixed(1)}" y="${axisY + 12}" text-anchor="middle" font-size="10" `
    + `fill="${PALETTE.axis}">${escapeXml(formatTick(value))}</text>`
    + `<line x1="${x(value).toFixed(1)}" y1="${axisY}" x2="${x(value).toFixed(1)}" y2="${axisY + 4}" stroke="${PALETTE.axis}"/>`);

  return svg(size, [
    ...rows,
    `<line x1="${size.padding.left}" y1="${axisY}" x2="${size.width - size.padding.right}" y2="${axisY}" stroke="${PALETTE.axis}"/>`,
    ...ticks,
    `<text x="${size.width / 2}" y="${size.height - 6}" text-anchor="middle" font-size="11" fill="${PALETTE.text}">`
    + "標高 (mm) / altitude — 全段共通スケール, 橙線は平均</text>",
    title(size, "各基準高さでの標高分布 / Distribution at each held position")
  ]);
}

/** All five plots, in the brief's order. */
export function buildAllPlots(analysis, options = {}) {
  return {
    altitudeTimeSeries: altitudeTimeSeriesPlot(analysis, options),
    referenceVsEstimate: referenceVsEstimatePlot(analysis, options),
    errorVsReference: errorVsReferencePlot(analysis, options),
    distribution: distributionPlot(analysis, options)
  };
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export function linearScale([domainMin, domainMax], [rangeMin, rangeMax]) {
  const span = domainMax - domainMin;
  if (!(span > 0)) {
    const mid = (rangeMin + rangeMax) / 2;
    return () => mid;
  }
  return (value) => rangeMin + ((value - domainMin) / span) * (rangeMax - rangeMin);
}

/**
 * Rounds a data range outward to readable bounds, with padding, and never
 * returns a zero-width range (which would collapse every point onto one
 * pixel and read as "perfectly stable").
 */
export function niceRange(min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return [0, 1];
  }
  if (min === max) {
    const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.1 : 1;
    return [min - pad, max + pad];
  }
  const span = max - min;
  const step = niceStep(span / 5);
  return [Math.floor(min / step) * step, Math.ceil(max / step) * step];
}

function niceStep(rough) {
  const magnitude = 10 ** Math.floor(Math.log10(Math.abs(rough) || 1));
  const normalized = Math.abs(rough) / magnitude;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}

export function tickValues([min, max], count = 5) {
  const step = niceStep((max - min) / count);
  const values = [];
  for (let value = Math.ceil(min / step) * step; value <= max + step / 1000; value += step) {
    values.push(Number(value.toFixed(10)));
  }
  return values;
}

function binValues(values, [min, max], binCount) {
  const width = (max - min) / binCount;
  const bins = Array.from({ length: binCount }, (unused, index) => ({
    fromMm: min + index * width,
    toMm: min + (index + 1) * width,
    count: 0
  }));
  for (const value of values) {
    const index = Math.min(binCount - 1, Math.max(0, Math.floor((value - min) / width)));
    bins[index].count += 1;
  }
  return bins;
}

function axes(size, x, y, xLabel, yLabel) {
  const left = size.padding.left;
  const right = size.width - size.padding.right;
  const bottom = size.height - size.padding.bottom;
  const top = size.padding.top;

  const xTicks = tickValues([invert(x, left), invert(x, right)]).map((value) => {
    const px = x(value);
    return `<line x1="${px.toFixed(1)}" y1="${bottom}" x2="${px.toFixed(1)}" y2="${bottom + 4}" stroke="${PALETTE.axis}"/>`
      + `<line x1="${px.toFixed(1)}" y1="${top}" x2="${px.toFixed(1)}" y2="${bottom}" stroke="${PALETTE.grid}" stroke-width="0.5"/>`
      + `<text x="${px.toFixed(1)}" y="${bottom + 16}" text-anchor="middle" font-size="10" fill="${PALETTE.axis}">${escapeXml(formatTick(value))}</text>`;
  });

  const yTicks = tickValues([invert(y, bottom), invert(y, top)]).map((value) => {
    const py = y(value);
    return `<line x1="${left - 4}" y1="${py.toFixed(1)}" x2="${left}" y2="${py.toFixed(1)}" stroke="${PALETTE.axis}"/>`
      + `<line x1="${left}" y1="${py.toFixed(1)}" x2="${right}" y2="${py.toFixed(1)}" stroke="${PALETTE.grid}" stroke-width="0.5"/>`
      + `<text x="${left - 8}" y="${(py + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="${PALETTE.axis}">${escapeXml(formatTick(value))}</text>`;
  });

  return [
    ...xTicks,
    ...yTicks,
    `<line x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}" stroke="${PALETTE.axis}"/>`,
    `<line x1="${left}" y1="${top}" x2="${left}" y2="${bottom}" stroke="${PALETTE.axis}"/>`,
    `<text x="${(left + right) / 2}" y="${size.height - 8}" text-anchor="middle" font-size="11" fill="${PALETTE.text}">${escapeXml(xLabel)}</text>`,
    `<text x="14" y="${(top + bottom) / 2}" text-anchor="middle" font-size="11" fill="${PALETTE.text}" transform="rotate(-90 14 ${(top + bottom) / 2})">${escapeXml(yLabel)}</text>`
  ].join("");
}

/** Recovers the domain value at a pixel, for tick generation. */
function invert(scale, pixel) {
  const a = scale(0);
  const b = scale(1);
  if (a === b) {
    return 0;
  }
  return (pixel - a) / (b - a);
}

function legend(size, entries) {
  const x = size.padding.left + 8;
  return entries.map((entry, index) => {
    const y = size.padding.top + 12 + index * 14;
    const dash = entry.dash ? ` stroke-dasharray="${entry.dash}"` : "";
    return `<line x1="${x}" y1="${y}" x2="${x + 18}" y2="${y}" stroke="${entry.color}" stroke-width="2"${dash}/>`
      + `<text x="${x + 24}" y="${y + 3}" font-size="10" fill="${PALETTE.text}">${escapeXml(entry.label)}</text>`;
  }).join("");
}

function title(size, text) {
  return `<text x="${size.width / 2}" y="14" text-anchor="middle" font-size="12" font-weight="600" fill="${PALETTE.text}">${escapeXml(text)}</text>`;
}

function polyline(points) {
  return points.map(([px, py], index) => `${index === 0 ? "M" : "L"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
}

function svg(size, children) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size.width} ${size.height}" `
    + `width="100%" role="img" font-family="system-ui, -apple-system, sans-serif">`
    + `<rect width="${size.width}" height="${size.height}" fill="#ffffff"/>`
    + children.join("")
    + "</svg>";
}

function emptyPlot(heading, message, size) {
  return svg(size, [
    title(size, heading),
    `<text x="${size.width / 2}" y="${size.height / 2}" text-anchor="middle" font-size="12" fill="${PALETTE.axis}">${escapeXml(message)}</text>`
  ]);
}

function verdictColor(verdict) {
  if (verdict === "PASS") return PALETTE.pass;
  if (verdict === "INCONCLUSIVE") return PALETTE.inconclusive;
  if (verdict === "FAIL") return PALETTE.fail;
  return PALETTE.axis;
}

function formatTick(value) {
  if (Math.abs(value) >= 1000) {
    return value.toFixed(0);
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
