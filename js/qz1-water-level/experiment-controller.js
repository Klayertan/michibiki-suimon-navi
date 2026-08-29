// DOM wiring for the QZ1 water-level experiment card.
//
// This file owns the DOM, the timers and the file downloads. Every decision —
// what a step is, when a dwell ends, which samples count, what the numbers
// mean, whether a step size was resolved — lives in the pure modules beside
// it and is unit tested there. Following the same split as
// recording-controller.js / recording-core.js in this repo.
//
// WHAT THIS CARD IS ALLOWED TO SAY
// --------------------------------
// Three quantities, always separately labelled, never merged into one number:
//
//   生の標高        raw GNSS altitude, as received
//   相対変位        displacement relative to the run's own baseline
//   較正水深        calibrated water depth — SHOWN ONLY when a validated
//                   calibration exists, and otherwise replaced by the reason
//                   it cannot be shown
//
// The third one is the dangerous one. `calibration.js` decides whether it may
// appear; this file never computes a depth itself and has no fallback path
// that would let one through.
//
// It reuses the page's existing QZ1 serial connection rather than opening its
// own: index.html forwards each live GGA fix through `ingestLiveFix`. There is
// exactly one serial pipeline on this page.

import { DWELL_DURATION_PRESETS_S, DEFAULT_REFERENCE_HEIGHTS_MM, buildExperimentMetadata, buildExperimentPlan, normalizeExperimentConfig, planDurationSeconds } from "./experiment-config.js";
import { ExperimentRun } from "./experiment-run.js";
import { serialPointToSample } from "./experiment-samples.js";
import { analyzeExperiment, summarizeOutcome } from "./displacement-analysis.js";
import { experimentToCsv } from "./experiment-csv.js";
import { renderTextReport, renderHtmlReport } from "./experiment-report.js";
import { buildAllPlots } from "./experiment-plots.js";
import { PRESET_FILTER_CHAINS } from "./altitude-filters.js";
import { describeForDisplay } from "./calibration.js";

const ELEMENT_IDS = [
  "wlxPanel", "wlxExperimentId", "wlxSensorSelect", "wlxStageSelect", "wlxHeightsInput",
  "wlxDwellSelect", "wlxSettleInput", "wlxToleranceInput", "wlxDescendingToggle",
  "wlxPlanSummary", "wlxConfigError",
  "wlxStartButton", "wlxConfirmButton", "wlxSkipButton", "wlxAbortButton",
  "wlxRunState", "wlxCurrentTarget", "wlxCountdown", "wlxStepProgress", "wlxStepSamples",
  "wlxLiveFix", "wlxLiveSatellites", "wlxLiveHdop", "wlxLiveRawAltitude",
  "wlxLiveBaseline", "wlxLiveRelative", "wlxLiveDepth", "wlxLiveDepthNote",
  "wlxFilterSelect", "wlxAnalyzeButton", "wlxResultTable", "wlxOutcome", "wlxWarnings",
  "wlxPlots", "wlxExportCsvButton", "wlxExportHtmlButton", "wlxExportJsonButton",
  "wlxMessage"
];

export class WaterLevelExperimentController {
  constructor(options = {}) {
    this.run = null;
    this.analysis = null;
    this.config = null;
    this.calibration = options.calibration ?? null;
    this.elements = {};
    this.tickTimer = null;
    this.latestSample = null;
    // Samples collected while no run is active are still shown live but never
    // enter an experiment: a reading with no reference height is not data
    // about a displacement.
    this.liveOnlySampleCount = 0;
  }

  mount() {
    ELEMENT_IDS.forEach((id) => { this.elements[id] = document.getElementById(id); });
    if (!this.elements.wlxStartButton) {
      return false;
    }
    this.populateStaticControls();
    this.bindEvents();
    this.refreshPlanSummary();
    this.render();
    this.tickTimer = setInterval(() => this.tick(), 500);
    return true;
  }

  unmount() {
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  populateStaticControls() {
    const { wlxDwellSelect, wlxHeightsInput, wlxFilterSelect, wlxExperimentId } = this.elements;
    if (wlxDwellSelect && wlxDwellSelect.options.length === 0) {
      for (const seconds of DWELL_DURATION_PRESETS_S) {
        const option = document.createElement("option");
        option.value = String(seconds);
        option.textContent = `${seconds} 秒`;
        wlxDwellSelect.append(option);
      }
      wlxDwellSelect.value = String(DWELL_DURATION_PRESETS_S[1]);
    }
    if (wlxHeightsInput && !wlxHeightsInput.value) {
      wlxHeightsInput.value = DEFAULT_REFERENCE_HEIGHTS_MM.join(", ");
    }
    if (wlxFilterSelect && wlxFilterSelect.options.length === 0) {
      for (const name of Object.keys(PRESET_FILTER_CHAINS)) {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        wlxFilterSelect.append(option);
      }
      wlxFilterSelect.value = "none";
    }
    if (wlxExperimentId && !wlxExperimentId.value) {
      wlxExperimentId.value = `vertical-displacement-${new Date().toISOString().slice(0, 10)}`;
    }
  }

  bindEvents() {
    const on = (id, event, handler) => this.elements[id]?.addEventListener(event, handler);
    on("wlxStartButton", "click", () => this.handleStart());
    on("wlxConfirmButton", "click", () => this.handleConfirm());
    on("wlxSkipButton", "click", () => this.handleSkip());
    on("wlxAbortButton", "click", () => this.handleAbort());
    on("wlxAnalyzeButton", "click", () => this.handleAnalyze());
    on("wlxExportCsvButton", "click", () => this.handleExportCsv());
    on("wlxExportHtmlButton", "click", () => this.handleExportHtml());
    on("wlxExportJsonButton", "click", () => this.handleExportJson());
    for (const id of ["wlxHeightsInput", "wlxDwellSelect", "wlxSettleInput", "wlxToleranceInput", "wlxDescendingToggle", "wlxExperimentId", "wlxSensorSelect", "wlxStageSelect"]) {
      on(id, "change", () => this.refreshPlanSummary());
      on(id, "input", () => this.refreshPlanSummary());
    }
  }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  readConfig() {
    const heights = String(this.elements.wlxHeightsInput?.value ?? "")
      .split(/[,\s]+/)
      .filter(Boolean)
      .map(Number);
    return normalizeExperimentConfig({
      experiment: this.elements.wlxExperimentId?.value,
      stage: this.elements.wlxStageSelect?.value,
      sensor: this.elements.wlxSensorSelect?.value,
      reference_heights_mm: heights,
      include_descending: this.elements.wlxDescendingToggle?.checked ?? true,
      sampling_configuration: {
        dwell_seconds: Number(this.elements.wlxDwellSelect?.value),
        settle_seconds: Number(this.elements.wlxSettleInput?.value)
      },
      tolerance_mm: Number(this.elements.wlxToleranceInput?.value)
    });
  }

  refreshPlanSummary() {
    const { config, errors } = this.readConfig();
    const summary = this.elements.wlxPlanSummary;
    const errorBox = this.elements.wlxConfigError;
    if (errorBox) {
      errorBox.textContent = errors.join(" / ");
      errorBox.hidden = errors.length === 0;
    }
    if (!config) {
      if (summary) summary.textContent = "—";
      if (this.elements.wlxStartButton) this.elements.wlxStartButton.disabled = true;
      return;
    }
    const plan = buildExperimentPlan(config);
    const totalSeconds = planDurationSeconds(plan);
    if (summary) {
      summary.textContent =
        `${plan.length} 段（${plan.map((step) => step.referenceHeightMm).join(" → ")} mm）`
        + ` ／ 滞在 ${config.dwellSeconds}s・整定 ${config.settleSeconds}s`
        + ` ／ 移動時間を除く合計 約${Math.round(totalSeconds / 60)}分`;
    }
    if (this.elements.wlxStartButton && this.run?.state !== "dwelling") {
      this.elements.wlxStartButton.disabled = false;
    }
  }

  // -------------------------------------------------------------------------
  // Run control
  // -------------------------------------------------------------------------

  handleStart() {
    // A run in progress is never replaced silently. ExperimentRun refuses a
    // mid-run restart for this reason, and constructing a fresh one here
    // would route around that refusal and drop the operator's data with no
    // warning -- the one destructive thing this card could do.
    if (this.run && (this.run.state === "dwelling" || this.run.state === "awaiting-position")) {
      this.setMessage("実験の途中です。新しく始めるには先に「中止」を押してください（取得済みデータは残ります）。");
      return;
    }
    const { config, errors } = this.readConfig();
    if (!config) {
      this.setMessage(`設定を確認してください: ${errors.join(" / ")}`);
      return;
    }
    this.config = config;
    this.run = new ExperimentRun(config);
    const result = this.run.start(Date.now());
    if (!result.ok) {
      this.setMessage(result.reason);
      return;
    }
    this.analysis = null;
    this.setMessage("受信機を最初の基準位置へ移動し、「位置に到達」を押してください。押すまで滞在時間は始まりません。");
    this.render();
  }

  handleConfirm() {
    if (!this.run) return;
    const result = this.run.confirmPosition(Date.now());
    if (!result.ok) {
      this.setMessage(result.reason);
      return;
    }
    this.setMessage(`${result.step.referenceHeightMm} mm で滞在中。最初の ${result.step.settleSeconds} 秒は整定として除外されます。`);
    this.render();
  }

  handleSkip() {
    if (!this.run) return;
    this.run.endStepEarly(Date.now());
    this.setMessage("滞在を途中で終了しました。この段のサンプル数は他より少なくなります（解析にそのまま反映されます）。");
    this.render();
  }

  handleAbort() {
    if (!this.run) return;
    this.run.abort(Date.now());
    this.setMessage("実験を中止しました。取得済みのデータは保持されています。書き出しと解析はできます。");
    this.render();
  }

  tick() {
    if (!this.run) return;
    const before = this.run.state;
    this.run.tick(Date.now());
    if (this.run.state !== before) {
      if (this.run.state === "complete") {
        this.setMessage("全ての段が終了しました。「解析する」で結果を計算できます。");
      } else {
        const step = this.run.currentStep();
        this.setMessage(`次は ${step.referenceHeightMm} mm です。移動してから「位置に到達」を押してください。`);
      }
    }
    this.render();
  }

  // -------------------------------------------------------------------------
  // Live data in
  // -------------------------------------------------------------------------

  /**
   * Called by index.html for every live GGA fix. `point` is the existing
   * shared parser's point; `receivedAtMs` is the host clock at arrival.
   * See serialPointToSample() for why the host clock is the right one here.
   */
  ingestLiveFix(point, receivedAtMs = Date.now(), rawLine = "") {
    if (!point) return;
    this.latestSample = serialPointToSample(point, receivedAtMs, rawLine);
    if (this.run) {
      this.run.ingestSample(this.latestSample);
    } else {
      this.liveOnlySampleCount += 1;
    }
    this.renderLive();
  }

  // -------------------------------------------------------------------------
  // Analysis
  // -------------------------------------------------------------------------

  handleAnalyze() {
    if (!this.run || this.run.marks.length === 0) {
      this.setMessage("解析できる段がまだありません。少なくとも1段を完了してください。");
      return;
    }
    const analysis = analyzeExperiment({
      samples: this.run.allSamples(),
      marks: this.run.marks,
      config: this.config,
      filterChain: this.elements.wlxFilterSelect?.value || []
    });
    if (!analysis.ok) {
      this.analysis = null;
      this.setMessage(`解析できません: ${analysis.errors.join(" / ")}`);
      this.render();
      return;
    }
    this.analysis = analysis;
    this.setMessage("");
    this.render();
  }

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  handleExportCsv() {
    if (!this.run) return;
    const csv = experimentToCsv(this.run.allSamples(), {
      experimentId: this.config.experimentId,
      stage: this.config.stage
    });
    this.download(`${this.config.experimentId}.csv`, csv, "text/csv");
    // The metadata sidecar goes out with the CSV, always: a data file whose
    // experimental design is only in someone's memory is not a record.
    this.download(
      `${this.config.experimentId}.meta.json`,
      `${JSON.stringify(buildExperimentMetadata(this.config, { createdAt: new Date().toISOString() }), null, 2)}\n`,
      "application/json"
    );
    this.download(
      `${this.config.experimentId}.marks.json`,
      `${JSON.stringify({ marks: this.run.marks }, null, 2)}\n`,
      "application/json"
    );
  }

  handleExportHtml() {
    if (!this.analysis) {
      this.setMessage("先に「解析する」を押してください。");
      return;
    }
    this.download(`${this.config.experimentId}.report.html`, renderHtmlReport(this.analysis), "text/html");
  }

  handleExportJson() {
    if (!this.analysis) {
      this.setMessage("先に「解析する」を押してください。");
      return;
    }
    const json = JSON.stringify(this.analysis, (key, value) =>
      (key === "filteredSamples" ? undefined : value), 2);
    this.download(`${this.config.experimentId}.analysis.json`, `${json}\n`, "application/json");
  }

  download(filename, content, type) {
    const blob = new Blob([content], { type: `${type};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  render() {
    this.renderRunState();
    this.renderLive();
    this.renderResult();
  }

  renderRunState() {
    const nowMs = Date.now();
    const progress = this.run ? this.run.progress(nowMs) : null;
    const set = (id, text) => { if (this.elements[id]) this.elements[id].textContent = text; };

    set("wlxRunState", progress ? RUN_STATE_LABELS[progress.state] ?? progress.state : "未開始");
    set("wlxCurrentTarget", progress?.step ? `${progress.step.referenceHeightMm} mm （${DIRECTION_LABELS[progress.step.direction] ?? ""}）` : "—");
    set("wlxCountdown", progress?.remainingMs === null || progress?.remainingMs === undefined
      ? "—"
      : `${Math.ceil(progress.remainingMs / 1000)} 秒`);
    set("wlxStepProgress", progress ? `${progress.completedSteps} / ${progress.totalSteps} 段` : "—");
    set("wlxStepSamples", progress ? `${progress.currentStepSampleCount} 件（この段）／ ${progress.totalSampleCount} 件（合計）` : "—");

    const state = progress?.state ?? "idle";
    this.setDisabled("wlxConfirmButton", state !== "awaiting-position");
    this.setDisabled("wlxSkipButton", state !== "dwelling");
    this.setDisabled("wlxAbortButton", state !== "awaiting-position" && state !== "dwelling");
    this.setDisabled("wlxStartButton", state === "dwelling" || state === "awaiting-position");
    this.setDisabled("wlxAnalyzeButton", !this.run || this.run.marks.length === 0);
    this.setDisabled("wlxExportCsvButton", !this.run || this.run.allSamples().length === 0);
    this.setDisabled("wlxExportHtmlButton", !this.analysis);
    this.setDisabled("wlxExportJsonButton", !this.analysis);
  }

  /**
   * The live readout. Three separately labelled quantities; the depth slot
   * carries a refusal reason rather than a number whenever calibration does
   * not license one, which is the normal state of this project today.
   */
  renderLive() {
    const sample = this.latestSample;
    const set = (id, text) => { if (this.elements[id]) this.elements[id].textContent = text; };

    set("wlxLiveFix", sample?.fix === null || sample?.fix === undefined ? "—" : String(sample.fix));
    set("wlxLiveSatellites", sample?.satellites === null || sample?.satellites === undefined ? "—" : String(sample.satellites));
    set("wlxLiveHdop", sample?.hdop === null || sample?.hdop === undefined ? "—" : sample.hdop.toFixed(1));
    set("wlxLiveRawAltitude", sample?.altitudeM === null || sample?.altitudeM === undefined ? "—" : `${sample.altitudeM.toFixed(3)} m`);

    // The baseline is the run's own 0 mm level, and only exists once that
    // level has actually been held. Before then the relative displacement is
    // undefined — not zero.
    const baselineMm = this.baselineAltitudeMm();
    set("wlxLiveBaseline", baselineMm === null ? "未取得（0mm の段が未完了）" : `${(baselineMm / 1000).toFixed(3)} m`);

    const display = describeForDisplay({
      rawAltitudeMm: sample?.altitudeMm ?? null,
      filteredAltitudeMm: sample?.altitudeMm ?? null,
      baselineAltitudeMm: baselineMm,
      calibration: this.calibration
    });

    set("wlxLiveRelative", display.relativeDisplacementMm === null
      ? "—"
      : `${display.relativeDisplacementMm >= 0 ? "+" : ""}${display.relativeDisplacementMm.toFixed(0)} mm`);
    set("wlxLiveDepth", display.depthMm === null
      ? "表示できません"
      : `${display.depthMm.toFixed(0)} mm ± ${display.depthUncertaintyMm?.toFixed(0) ?? "?"} mm`);
    set("wlxLiveDepthNote", display.depthBlockedReason ?? "");
  }

  /**
   * The current relative displacement in mm, or null.
   *
   * Read-only, and null whenever there is no baseline yet. Exposed for the
   * sensor card's map popup, which is a DISPLAY consumer only: nothing about
   * field detection or sensor assignment depends on this number, so a failed
   * altitude experiment does not degrade any of it. See
   * js/qz1-water-level/sensor-field-controller.js.
   *
   * This is a displacement, never a water depth — the caller is responsible
   * for labelling it as such, and every current caller does.
   */
  currentRelativeDisplacementMm() {
    const baselineMm = this.baselineAltitudeMm();
    const currentMm = this.latestSample?.altitudeMm;
    if (!Number.isFinite(baselineMm) || !Number.isFinite(currentMm)) {
      return null;
    }
    return currentMm - baselineMm;
  }

  /** Mean altitude of the completed 0 mm dwells, or null. */
  baselineAltitudeMm() {
    if (!this.run) return null;
    const values = this.run.samples
      .filter((sample) => sample.referenceHeightMm === 0 && Number.isFinite(sample.altitudeMm))
      .map((sample) => sample.altitudeMm);
    if (values.length === 0) return null;
    return values.reduce((total, value) => total + value, 0) / values.length;
  }

  renderResult() {
    const table = this.elements.wlxResultTable;
    const plots = this.elements.wlxPlots;
    const outcome = this.elements.wlxOutcome;
    const warnings = this.elements.wlxWarnings;
    if (!table) return;

    if (!this.analysis) {
      table.textContent = "";
      if (plots) plots.innerHTML = "";
      if (outcome) outcome.textContent = "";
      if (warnings) warnings.innerHTML = "";
      return;
    }

    // <pre> content, set as text: the report is fixed-width and must never be
    // interpreted as markup.
    table.textContent = renderTextReport(this.analysis);

    if (outcome) {
      outcome.textContent = summarizeOutcome(this.analysis);
    }
    if (warnings) {
      warnings.innerHTML = "";
      for (const warning of this.analysis.warnings) {
        const item = document.createElement("li");
        item.textContent = warning;
        warnings.append(item);
      }
    }
    if (plots) {
      const built = buildAllPlots(this.analysis);
      plots.innerHTML = "";
      for (const svgMarkup of Object.values(built)) {
        const figure = document.createElement("figure");
        figure.className = "wlx-figure";
        // Generated by experiment-plots.js from numbers only; every string it
        // interpolates goes through escapeXml() there.
        figure.innerHTML = svgMarkup;
        plots.append(figure);
      }
    }
  }

  setDisabled(id, disabled) {
    if (this.elements[id]) {
      this.elements[id].disabled = Boolean(disabled);
    }
  }

  setMessage(text) {
    if (this.elements.wlxMessage) {
      this.elements.wlxMessage.textContent = text;
    }
  }
}

const RUN_STATE_LABELS = {
  idle: "未開始",
  "awaiting-position": "位置移動待ち",
  dwelling: "滞在中（記録）",
  complete: "完了",
  aborted: "中止"
};

const DIRECTION_LABELS = {
  ascending: "上昇",
  descending: "下降"
};
