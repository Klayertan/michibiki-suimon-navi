// GNSS Analyzer-style live signal view: a status badge that turns green when
// the signal is good, per-satellite C/N0 bars and a sky plot. DOM only; all the
// decisions come from gnss-quality.js and satellite-tracker.js.

import { classifyFix, QUALITY_LEVELS } from "./gnss-quality.js";
import { CONSTELLATION_ORDER, skyPlotPosition, snrColor } from "./satellite-tracker.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const MAX_BARS = 36;
const FIX_STALE_MS = 5000;

const FIX_QUALITY_NAMES = Object.freeze({
  0: "測位なし",
  1: "単独測位 GPS",
  2: "DGNSS（補強）",
  4: "RTK Fixed",
  5: "RTK Float"
});

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svg(tag, attributes = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}

export function describeFix(fix, fixAgeMs) {
  if (!fix || !Number.isFinite(fixAgeMs) || fixAgeMs > FIX_STALE_MS) {
    return { ...QUALITY_LEVELS.none, label: "受信待ち", labelEn: "Waiting for fix", detail: "測位データを待っています" };
  }
  const quality = classifyFix(fix);
  const parts = [FIX_QUALITY_NAMES[fix.fixQuality] || `Fix ${fix.fixQuality}`];
  if (Number.isFinite(fix.satellites)) parts.push(`使用衛星 ${fix.satellites}`);
  if (Number.isFinite(fix.hdop)) parts.push(`HDOP ${fix.hdop.toFixed(1)}`);
  return { ...quality, detail: parts.join(" ・ ") };
}

export function createGnssSignalView(container) {
  container.textContent = "";
  container.classList.add("gnss-signal");

  const badge = el("div", "gnss-badge gnss-badge--none");
  const badgeDot = el("span", "gnss-badge-dot");
  const badgeText = el("div", "gnss-badge-text");
  const badgeLabel = el("strong", "gnss-badge-label", "受信待ち");
  const badgeDetail = el("span", "gnss-badge-detail", "測位データを待っています");
  badgeText.append(badgeLabel, badgeDetail);
  badge.append(badgeDot, badgeText);

  const summary = el("p", "gnss-summary meta", "");
  const plotWrap = el("div", "gnss-plot-wrap");
  const bars = el("div", "gnss-bars");
  const legend = el("p", "gnss-legend meta");
  for (const level of [QUALITY_LEVELS.good, QUALITY_LEVELS.fair, QUALITY_LEVELS.poor]) {
    const swatch = el("span", "gnss-legend-dot", "●");
    swatch.style.color = level.color;
    legend.append(swatch, ` ${level.label}　`);
  }
  legend.append("バー＝信号強度 C/N0 (dB-Hz)　太い黒枠＝測位に使用中");
  container.append(badge, summary, plotWrap, bars, legend);

  function renderSkyPlot(satellites) {
    const size = 200;
    const centre = size / 2;
    const radius = 84;
    const plot = svg("svg", { viewBox: `0 0 ${size} ${size}`, class: "gnss-sky", role: "img", "aria-label": "衛星の空の配置（スカイプロット）" });
    for (const scale of [1, 0.66, 0.33]) {
      plot.append(svg("circle", { cx: centre, cy: centre, r: radius * scale, class: "gnss-sky-ring" }));
    }
    plot.append(svg("line", { x1: centre, y1: centre - radius, x2: centre, y2: centre + radius, class: "gnss-sky-axis" }));
    plot.append(svg("line", { x1: centre - radius, y1: centre, x2: centre + radius, y2: centre, class: "gnss-sky-axis" }));
    for (const [text, x, y] of [["N", centre, 10], ["E", size - 6, centre + 4], ["S", centre, size - 2], ["W", 6, centre + 4]]) {
      const label = svg("text", { x, y, class: "gnss-sky-label", "text-anchor": "middle" });
      label.textContent = text;
      plot.append(label);
    }
    for (const satellite of satellites) {
      const position = skyPlotPosition(satellite, radius);
      if (!position) continue;
      const group = svg("g", { class: "gnss-sat" });
      const circle = svg("circle", {
        cx: centre + position.x,
        cy: centre + position.y,
        r: satellite.used ? 8 : 7,
        fill: satellite.tracked ? snrColor(satellite.snr) : "#94a3b8",
        "fill-opacity": satellite.tracked ? 0.9 : 0.45,
        stroke: satellite.used ? "#0f172a" : "#ffffff",
        "stroke-width": satellite.used ? 2 : 1
      });
      const number = svg("text", { x: centre + position.x, y: centre + position.y + 3, class: "gnss-sat-id", "text-anchor": "middle" });
      number.textContent = satellite.prn.replace(/^0+/, "") || "0";
      const title = svg("title");
      title.textContent = `${satellite.constellation} ${satellite.prn} / 仰角 ${satellite.elevation ?? "—"}° 方位 ${satellite.azimuth ?? "—"}° / C/N0 ${satellite.snr ?? "—"}`;
      group.append(circle, number, title);
      plot.append(group);
    }
    plotWrap.textContent = "";
    plotWrap.append(plot);
  }

  function renderBars(satellites) {
    bars.textContent = "";
    if (satellites.length === 0) {
      bars.append(el("p", "meta", "衛星情報（GSV）をまだ受信していません。"));
      return;
    }
    const shown = [...satellites]
      .sort((a, b) => (CONSTELLATION_ORDER.indexOf(a.constellation) - CONSTELLATION_ORDER.indexOf(b.constellation)) || (b.snr ?? -1) - (a.snr ?? -1))
      .slice(0, MAX_BARS);
    for (const satellite of shown) {
      const row = el("div", `gnss-bar-row${satellite.used ? " gnss-bar-row--used" : ""}`);
      row.append(el("span", "gnss-bar-name", `${satellite.constellation} ${satellite.prn}`));
      const track = el("span", "gnss-bar-track");
      const fill = el("span", "gnss-bar-fill");
      const width = satellite.tracked ? Math.min(100, Math.max(2, (satellite.snr / 50) * 100)) : 0;
      fill.style.width = `${width}%`;
      fill.style.background = snrColor(satellite.snr);
      track.append(fill);
      row.append(track, el("span", "gnss-bar-value", satellite.tracked ? String(Math.round(satellite.snr)) : "—"));
      bars.append(row);
    }
  }

  return {
    /** @param {{ fix: object|null, fixAgeMs: number|null, snapshot: object }} state */
    update({ fix, fixAgeMs, snapshot }) {
      const described = describeFix(fix, fixAgeMs);
      badge.className = `gnss-badge gnss-badge--${described.level}`;
      badgeLabel.textContent = `${described.label}　${described.labelEn}`;
      badgeDetail.textContent = described.detail;
      const satellites = snapshot?.stale ? [] : (snapshot?.satellites || []);
      summary.textContent = satellites.length
        ? `視野内 ${snapshot.inView} / 受信中 ${snapshot.tracked} / 使用中 ${snapshot.used} ・ みちびき(QZSS) ${snapshot.qzssTracked}/${snapshot.qzssInView}`
        : "衛星の配置は GSV 文を受信すると表示されます。";
      renderSkyPlot(satellites);
      renderBars(satellites);
      return described;
    }
  };
}
