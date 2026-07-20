// 圃場レポート panel: DOM/event glue around field-report.js's pure
// buildFieldReport(). Reads field-annotation-controller.js's live arrays
// directly (fields/boundaryTracks/surveySessions/waterControlPoints/
// fieldObservations) through a single getter — no separate data store.
import { OBSERVATION_TYPE_LABELS } from "../fields/field-annotation-core.js";
import { buildFieldReport, buildReportHtml, buildReportMarkdown, listReportableFields, rawNmeaStatusLabel } from "./field-report.js";

const ELEMENT_IDS = [
  "reportFieldSelect", "reportGenerateButton", "reportExportJsonButton", "reportExportHtmlButton",
  "reportPrintButton", "reportCopyMarkdownButton", "reportMessage", "reportEmptyState", "reportPreview"
];

export class FieldReportController {
  constructor(options = {}) {
    this.getFieldAnnotationController = options.getFieldAnnotationController || (() => null);
    this.elements = {};
    this.currentReport = null;
  }

  mount() {
    ELEMENT_IDS.forEach((id) => { this.elements[id] = document.getElementById(id); });
    if (!this.elements.reportFieldSelect) return;
    this.bindEvents();
    this.refresh();
  }

  bindEvents() {
    const el = this.elements;
    el.reportGenerateButton?.addEventListener("click", () => this.generate());
    el.reportExportJsonButton?.addEventListener("click", () => this.exportJson());
    el.reportExportHtmlButton?.addEventListener("click", () => this.exportHtml());
    el.reportPrintButton?.addEventListener("click", () => this.openPrintView());
    el.reportCopyMarkdownButton?.addEventListener("click", () => this.copyMarkdown());
  }

  getData() {
    const controller = this.getFieldAnnotationController();
    return {
      fields: controller?.fields || [],
      boundaryTracks: controller?.boundaryTracks || [],
      surveySessions: controller?.surveySessions || [],
      waterControlPoints: controller?.waterControlPoints || [],
      fieldObservations: controller?.fieldObservations || []
    };
  }

  /** Repopulates the field selector from live field-annotation data. Call whenever this panel becomes visible, since it isn't wired into a shared render loop. */
  refresh() {
    const el = this.elements;
    if (!el.reportFieldSelect) return;
    const entries = listReportableFields(this.getData());
    const previous = el.reportFieldSelect.value;
    el.reportFieldSelect.replaceChildren();
    entries.forEach((entry) => el.reportFieldSelect.append(new Option(`${entry.fieldName} / ${entry.fieldId}`, entry.fieldId)));
    if (entries.some((entry) => entry.fieldId === previous)) el.reportFieldSelect.value = previous;

    const hasFields = entries.length > 0;
    if (el.reportEmptyState) el.reportEmptyState.hidden = hasFields;
    el.reportFieldSelect.disabled = !hasFields;
    if (el.reportGenerateButton) el.reportGenerateButton.disabled = !hasFields;
    if (!hasFields) {
      this.currentReport = null;
      this.setExportButtonsEnabled(false);
      if (el.reportPreview) {
        el.reportPreview.hidden = true;
        el.reportPreview.replaceChildren();
      }
    }
  }

  generate() {
    const fieldId = this.elements.reportFieldSelect.value;
    if (!fieldId) {
      this.setMessage("対象圃場を選択してください。");
      return;
    }
    this.currentReport = buildFieldReport({ fieldId, ...this.getData() });
    this.renderPreview(this.currentReport);
    this.setExportButtonsEnabled(true);
    this.setMessage("");
  }

  setExportButtonsEnabled(enabled) {
    const el = this.elements;
    [el.reportExportJsonButton, el.reportExportHtmlButton, el.reportPrintButton, el.reportCopyMarkdownButton]
      .forEach((button) => { if (button) button.disabled = !enabled; });
  }

  setMessage(message) {
    if (this.elements.reportMessage) this.elements.reportMessage.textContent = message;
  }

  // -------------------------------------------------------------------------
  // Preview rendering
  // -------------------------------------------------------------------------

  renderPreview(report) {
    const container = this.elements.reportPreview;
    if (!container) return;
    container.replaceChildren();
    container.hidden = false;

    const title = document.createElement("h3");
    title.textContent = `圃場レポート: ${report.fieldName}`;
    container.append(title);

    const badge = document.createElement("p");
    badge.className = "field-report-status-badge";
    badge.dataset.status = report.summary.overallStatus;
    badge.textContent = `総合判定: ${report.summary.overallLabel}`;
    container.append(badge);

    container.append(this.buildListBlock("主な理由", report.summary.keyReasons));
    container.append(this.buildSection("基本情報", this.buildDl([
      ["圃場名", report.basicInfo.fieldName],
      ["圃場ID", report.basicInfo.fieldId],
      ["作成日時", formatDateTime(report.basicInfo.createdAt)],
      ["最終更新日時", formatDateTime(report.basicInfo.updatedAt)],
      ["測量タイプ", report.basicInfo.measurementTypeLabel || "—"],
      ["データ種別", report.basicInfo.dataKind]
    ])));

    container.append(this.buildSection("QZ1測量ログ", this.buildSurveyLogBlock(report.surveyLog)));
    container.append(this.buildSection("測量チェック結果", this.buildReliabilityBlock(report.reliabilityCheck)));
    container.append(this.buildSection("圃場形状・面積", this.buildGeometryBlock(report.geometry)));
    container.append(this.buildSection("水管理ポイント", this.buildWaterPointsBlock(report.waterControlPoints)));
    container.append(this.buildSection("現地観察メモ", this.buildObservationsBlock(report)));
    container.append(this.buildSection("次にやること", this.buildListBlock(null, report.recommendations)));
  }

  buildSection(title, contentNode) {
    const section = document.createElement("div");
    section.className = "field-report-section";
    const heading = document.createElement("h4");
    heading.textContent = title;
    section.append(heading, contentNode);
    return section;
  }

  buildDl(pairs) {
    const dl = document.createElement("dl");
    dl.className = "field-report-dl";
    pairs.forEach(([label, value]) => {
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      dl.append(dt, dd);
    });
    return dl;
  }

  buildListBlock(title, items) {
    const wrap = document.createElement("div");
    if (title) {
      const heading = document.createElement("p");
      heading.className = "field-report-list-title";
      heading.textContent = title;
      wrap.append(heading);
    }
    const ul = document.createElement("ul");
    items.forEach((item) => {
      const li = document.createElement("li");
      li.textContent = item;
      ul.append(li);
    });
    wrap.append(ul);
    return wrap;
  }

  buildSurveyLogBlock(surveyLog) {
    if (!surveyLog.found) {
      const p = document.createElement("p");
      p.textContent = surveyLog.message;
      return p;
    }
    return this.buildDl([
      ["元NMEAファイル名", surveyLog.sourceFileName || "—"],
      ["元NMEA保存状態", rawNmeaStatusLabel(surveyLog)],
      ["NMEA行数", String(surveyLog.rawNmeaLineCount)],
      ["有効測位点", String(surveyLog.validCount)],
      ["GPS単独", String(surveyLog.gpsOnlyCount)],
      ["DGPS/補強あり", String(surveyLog.dgpsCount)],
      ["QZSS使用", String(surveyLog.qzssUsedCount)]
    ]);
  }

  buildReliabilityBlock(reliabilityCheck) {
    const wrap = document.createElement("div");
    const status = document.createElement("p");
    status.textContent = `総合判定: ${reliabilityCheck.label}`;
    wrap.append(status, this.buildListBlock("理由", reliabilityCheck.reasons));
    return wrap;
  }

  buildGeometryBlock(geometry) {
    const wrap = document.createElement("div");
    wrap.append(this.buildDl([
      ["形状タイプ", geometry.geometryType || "—"],
      ["圃場面積", Number.isFinite(geometry.areaM2) ? `${geometry.areaM2.toFixed(1)} m²` : "—"],
      ["境界長", Number.isFinite(geometry.boundaryLengthM) ? `${geometry.boundaryLengthM.toFixed(1)} m` : "—"],
      ["閉合状態", geometry.closed === null ? "—" : geometry.closed ? "閉じている" : "開いている"],
      ["始点と終点の距離", Number.isFinite(geometry.closureGapM) ? `${geometry.closureGapM.toFixed(1)} m` : "—"]
    ]));
    if (geometry.isBoundaryTrackOnly || geometry.isForceClosed) {
      const note = document.createElement("p");
      note.className = "field-report-note";
      note.textContent = geometry.isBoundaryTrackOnly
        ? "このデータは境界トラックです。圃場全体の面積は確定していません。"
        : "この圃場は始点と終点を接続して仮のポリゴンとして保存されています。再測量を推奨します。";
      wrap.append(note);
    }
    return wrap;
  }

  buildWaterPointsBlock(points) {
    if (!points.length) {
      const p = document.createElement("p");
      p.textContent = "水管理ポイントはまだ登録されていません。";
      return p;
    }
    const ul = document.createElement("ul");
    points.forEach((point) => {
      const li = document.createElement("li");
      li.textContent = `${point.typeLabel} ${point.name}（${formatDateTime(point.createdAt)}）${point.memo ? ` — ${point.memo}` : ""}`;
      ul.append(li);
    });
    return ul;
  }

  buildObservationsBlock(report) {
    const wrap = document.createElement("div");
    const summary = document.createElement("p");
    summary.textContent = `観察メモ合計: ${report.observationSummary.total}件`;
    wrap.append(summary);

    const countLines = Object.entries(report.observationSummary.byType)
      .filter(([, count]) => count > 0)
      .map(([type, count]) => `${OBSERVATION_TYPE_LABELS[type] || type}: ${count}件`);
    countLines.push(`緊急: ${report.observationSummary.bySeverity.urgent}件`);
    wrap.append(this.buildListBlock(null, countLines));

    if (report.observations.length) {
      const ul = document.createElement("ul");
      report.observations.forEach((observation) => {
        const li = document.createElement("li");
        li.textContent = `[${observation.severityLabel}] ${observation.typeLabel} ${observation.name}${observation.memo ? ` — ${observation.memo}` : ""}（${formatDateTime(observation.createdAt)}）`;
        ul.append(li);
      });
      wrap.append(ul);
    } else {
      const p = document.createElement("p");
      p.textContent = "現地観察メモはまだ登録されていません。";
      wrap.append(p);
    }
    return wrap;
  }

  // -------------------------------------------------------------------------
  // Export / print
  // -------------------------------------------------------------------------

  exportJson() {
    if (!this.currentReport) return;
    const payload = {
      metadata: {
        appName: "スイスイナビ", reportType: "field_report",
        generatedAt: this.currentReport.generatedAt, dataMode: "real_user_data"
      },
      report: this.currentReport
    };
    downloadText(JSON.stringify(payload, null, 2), `suisui-report-${this.currentReport.fieldId}-${dateStamp()}.json`, "application/json");
  }

  exportHtml() {
    if (!this.currentReport) return;
    downloadText(buildReportHtml(this.currentReport), `suisui-report-${this.currentReport.fieldId}-${dateStamp()}.html`, "text/html");
  }

  openPrintView() {
    if (!this.currentReport) {
      this.setMessage("先にレポートを生成してください。");
      return;
    }
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      this.setMessage("ポップアップがブロックされました。レポートHTMLを書き出してから印刷してください。");
      return;
    }
    printWindow.document.write(buildReportHtml(this.currentReport));
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
  }

  async copyMarkdown() {
    if (!this.currentReport) return;
    const markdown = buildReportMarkdown(this.currentReport);
    try {
      await navigator.clipboard.writeText(markdown);
      this.setMessage("Markdownをコピーしました。");
    } catch {
      this.setMessage("コピーに失敗しました。ブラウザのクリップボード権限を確認してください。");
    }
  }
}

function formatDateTime(iso) {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString("ja-JP") : iso;
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

function downloadText(text, filename, mimeType) {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
