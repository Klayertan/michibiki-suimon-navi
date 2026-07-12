import { parseNmeaSession } from "../gnss/nmea-parser.js";
import { GnssStore, makeId } from "../gnss/gnss-store.js";
import { FieldRegistry } from "../fields/field-registry.js";
import { ASSURANCE_PROFILES, calculateAssurance } from "./assurance-engine.js";

const STATUS_STYLE = {
  green: { color: "#14532d", fillColor: "#2f855a", dashArray: null },
  yellow: { color: "#854d0e", fillColor: "#eab308", dashArray: "7 4" },
  red: { color: "#7f1d1d", fillColor: "#dc2626", dashArray: "2 5" },
  grey: { color: "#4b5563", fillColor: "#9ca3af", dashArray: "6 5" },
  simulated: { color: "#5b21b6", fillColor: "#8b5cf6", dashArray: "3 4" }
};

export class SatelliteAssuranceController {
  constructor(options) {
    this.map = options.map;
    this.getFallbackBoundary = options.getFallbackBoundary || (() => []);
    this.onFieldChanged = options.onFieldChanged || (() => {});
    this.onImportLegacy = options.onImportLegacy || (() => {});
    this.store = new GnssStore();
    this.fields = new FieldRegistry();
    this.result = null;
    this.active = false;
    this.layers = {
      grid: L.layerGroup(),
      pairs: L.layerGroup(),
      qz1: L.layerGroup(),
      reference: L.layerGroup()
    };
    this.elements = {};
  }

  mount() {
    const ids = [
      "assuranceQz1Input", "assuranceReferenceInput", "assuranceCaptureDate", "assuranceQz1Session",
      "assuranceReferenceSession", "assuranceSimulateReference", "assuranceSessionSummary", "assuranceFieldName",
      "assuranceFieldStart", "assuranceFieldEnd", "assuranceFieldDirection", "assuranceSaveField",
      "assuranceActiveField", "assuranceFieldMessage", "assuranceTolerance", "assuranceQz1Offset",
      "assuranceReferenceOffset", "assuranceProfile", "assuranceGridSize", "assuranceRecalculate",
      "assuranceQz1Rate", "assuranceReferenceRate", "assuranceMinimumGrade",
      "assuranceClear", "assuranceShowGrid", "assuranceShowPairs", "assuranceShowQz1", "assuranceShowReference",
      "assurancePairedCount", "assuranceMedianSeparation", "assuranceMaximumSeparation", "assuranceAugmentationRate",
      "assuranceQzssUseRate", "assuranceContinuity", "assuranceMeasuredArea", "assuranceGreenArea", "assuranceYellowArea",
      "assuranceRedArea", "assuranceUnknownArea", "assuranceSimulatedArea", "assuranceWarnings", "assuranceSelectedDetail",
      "assuranceExportProject", "assuranceImportProject"
    ];
    ids.forEach((id) => { this.elements[id] = document.getElementById(id); });
    if (!this.elements.assuranceQz1Session) return;

    Object.entries(ASSURANCE_PROFILES).forEach(([id, profile]) => {
      this.elements.assuranceProfile.append(new Option(profile.label, id));
    });
    this.bindEvents();
    this.store.addEventListener("change", () => this.refreshDatasetControls());
    this.fields.addEventListener("change", () => this.refreshFieldControls());

    const fallback = this.getFallbackBoundary();
    if (fallback.length >= 3) {
      this.fields.addCoordinateField({ id: "field-current", name: "現在の圃場境界", coordinates: fallback, sourceType: "current-app" });
    } else {
      this.refreshFieldControls();
    }
    this.refreshDatasetControls();
  }

  bindEvents() {
    const el = this.elements;
    el.assuranceQz1Input.addEventListener("change", (event) => this.readNmeaFile(event, "qz1"));
    el.assuranceReferenceInput.addEventListener("change", (event) => this.readNmeaFile(event, "reference"));
    el.assuranceQz1Session.addEventListener("change", () => { this.refreshRangeOptions(); this.renderRawLayers(); });
    el.assuranceReferenceSession.addEventListener("change", () => this.renderRawLayers());
    el.assuranceSimulateReference.addEventListener("click", () => this.createSimulatedReference());
    el.assuranceSaveField.addEventListener("click", () => this.saveObservationRangeField());
    el.assuranceActiveField.addEventListener("change", () => {
      if (!this.fields.setActive(el.assuranceActiveField.value)) return;
      const field = this.fields.getActive();
      if (field) this.onFieldChanged(field);
    });
    el.assuranceRecalculate.addEventListener("click", () => this.recalculate());
    el.assuranceClear.addEventListener("click", () => this.clearResult());
    [el.assuranceShowGrid, el.assuranceShowPairs, el.assuranceShowQz1, el.assuranceShowReference]
      .forEach((input) => input.addEventListener("change", () => this.syncLayerVisibility()));
    el.assuranceExportProject.addEventListener("click", () => this.exportProject());
    el.assuranceImportProject.addEventListener("change", (event) => this.importProjectFile(event));
  }

  async readNmeaFile(event, receiverId) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      this.importNmeaText(await file.text(), { receiverId, sourceName: file.name, captureDate: this.elements.assuranceCaptureDate.value || null });
    } catch (error) {
      this.setWarnings([`読み込み失敗: ${error.message}`]);
    } finally {
      event.target.value = "";
    }
  }

  importNmeaText(text, options = {}) {
    const receiverId = options.receiverId || "qz1";
    const receiver = this.store.getReceiver(receiverId);
    if (!receiver) throw new Error(`受信機 ${receiverId} が登録されていません。`);
    const parsed = parseNmeaSession(text, {
      receiver,
      sessionId: options.sessionId || makeId(`${receiverId}-session`),
      sourceName: options.sourceName || "NMEA",
      sourceType: options.sourceType || "file",
      captureDate: options.captureDate || this.elements.assuranceCaptureDate?.value || null,
      captureGroupId: options.captureGroupId || "capture-default",
      expectedRateHz: options.expectedRateHz || 1,
      simulated: Boolean(options.simulated)
    });
    this.store.addParsedSession(parsed);
    const select = receiverId === "qz1" ? this.elements.assuranceQz1Session : this.elements.assuranceReferenceSession;
    if (select) select.value = parsed.session.id;
    this.refreshRangeOptions();
    this.renderRawLayers();
    const summary = parsed.session.parserSummary;
    const warnings = [...parsed.session.warnings];
    if (!summary.validFixCount) warnings.unshift("有効なGGA測位点がありません。fix quality とNMEA形式を確認してください。");
    this.setWarnings(warnings);
    return parsed;
  }

  createSimulatedReference() {
    const sessionId = this.elements.assuranceQz1Session.value;
    const source = this.store.getObservations(sessionId);
    const valid = source.filter((observation) => observation.fixValid);
    if (valid.length === 0) {
      this.setWarnings(["先に有効なQZ1データセットを選択してください。"]);
      return;
    }
    const syntheticSessionId = makeId("simulated-m10-session");
    const observations = source.map((observation, index) => {
      if (!observation.fixValid) {
        return { ...observation, id: `${syntheticSessionId}:obs-${index}`, sessionId: syntheticSessionId, receiverId: "reference", augmentation: { service: null, status: "unknown", evidence: [] }, qzss: { visibleCount: null, satellites: [], usedInFix: null } };
      }
      const jitterM = Math.sin(index * 1.71) * 0.7;
      const jumpM = index > 0 && index % 47 === 0 ? 7 : 0;
      const eastM = 1.2 + jitterM + jumpM;
      const northM = Math.cos(index * 1.17) * 0.5;
      return {
        ...observation,
        id: `${syntheticSessionId}:obs-${index}`,
        sessionId: syntheticSessionId,
        receiverId: "reference",
        lat: observation.lat + northM / 111320,
        lon: observation.lon + eastM / (111320 * Math.cos(observation.lat * Math.PI / 180)),
        satellites: Math.max(4, (observation.satellites || 8) - 2),
        hdop: Number.isFinite(observation.hdop) ? observation.hdop + 0.5 : 2.2,
        augmentation: { service: null, status: "unknown", evidence: ["SIMULATED_REFERENCE"] },
        qzss: { visibleCount: null, satellites: [], usedInFix: null },
        rawRefs: []
      };
    });
    this.store.addParsedSession({
      session: {
        id: syntheticSessionId,
        receiverId: "reference",
        captureGroupId: this.store.getSession(sessionId)?.captureGroupId || "capture-default",
        sourceType: "simulation",
        sourceName: "SIMULATED M10（計算確認用）",
        simulated: true,
        expectedRateHz: this.store.getSession(sessionId)?.expectedRateHz || 1,
        captureDate: this.store.getSession(sessionId)?.captureDate || null,
        manualClockOffsetMs: 0,
        parserSummary: { observationCount: observations.length, validFixCount: observations.filter((point) => point.fixValid).length, noFixCount: observations.filter((point) => !point.fixValid).length, sentenceCounts: {} },
        warnings: ["SIMULATED: 実機M10性能を示すデータではありません。"]
      },
      observations
    });
    this.elements.assuranceReferenceSession.value = syntheticSessionId;
    this.renderRawLayers();
    this.setWarnings(["SIMULATED M10を作成しました。UI・計算確認専用で、運用判断には使えません。"]);
  }

  refreshDatasetControls() {
    this.populateSessionSelect(this.elements.assuranceQz1Session, this.store.getSessionsByRole("qz1"), "QZ1データを選択");
    this.populateSessionSelect(this.elements.assuranceReferenceSession, this.store.getSessionsByRole("reference"), "M10 / 基準データを選択");
    this.refreshRangeOptions();
    this.renderSessionSummary();
  }

  populateSessionSelect(select, sessions, placeholder) {
    if (!select) return;
    const previous = select.value;
    select.replaceChildren(new Option(placeholder, ""));
    sessions.forEach((session) => {
      const receiver = this.store.getReceiver(session.receiverId);
      const simulated = session.simulated ? " [SIMULATED]" : "";
      select.append(new Option(`${receiver?.displayName || session.receiverId} — ${session.sourceName}${simulated}`, session.id));
    });
    select.value = sessions.some((session) => session.id === previous) ? previous : sessions.at(-1)?.id || "";
  }

  renderSessionSummary() {
    const qz1 = this.store.getSession(this.elements.assuranceQz1Session.value);
    const reference = this.store.getSession(this.elements.assuranceReferenceSession.value);
    const format = (session) => session
      ? `${session.sourceName}: ${session.parserSummary.validFixCount || 0}/${session.parserSummary.observationCount || 0} 有効fix${session.simulated ? "（SIM）" : ""}`
      : "未選択";
    this.elements.assuranceSessionSummary.textContent = `QZ1 ${format(qz1)} / 基準 ${format(reference)}`;
  }

  refreshRangeOptions() {
    const observations = this.store.getObservations(this.elements.assuranceQz1Session?.value, { validOnly: true });
    const startPrevious = this.elements.assuranceFieldStart?.value;
    const endPrevious = this.elements.assuranceFieldEnd?.value;
    [this.elements.assuranceFieldStart, this.elements.assuranceFieldEnd].forEach((select) => {
      if (!select) return;
      select.replaceChildren(new Option("点を選択", ""));
      observations.forEach((observation, index) => {
        const time = observation.timeOfDay || (Number.isFinite(observation.timestampUtcMs) ? new Date(observation.timestampUtcMs).toISOString().slice(11, 23) : "時刻不明");
        select.append(new Option(`#${index + 1} ${time} · fix ${observation.fixQuality ?? "—"}`, observation.id));
      });
    });
    if (observations.some((observation) => observation.id === startPrevious)) this.elements.assuranceFieldStart.value = startPrevious;
    else if (observations.length) this.elements.assuranceFieldStart.value = observations[0].id;
    if (observations.some((observation) => observation.id === endPrevious)) this.elements.assuranceFieldEnd.value = endPrevious;
    else if (observations.length) this.elements.assuranceFieldEnd.value = observations.at(-1).id;
    this.renderSessionSummary();
  }

  saveObservationRangeField() {
    try {
      const sessionId = this.elements.assuranceQz1Session.value;
      if (!sessionId) throw new Error("QZ1データセットを選択してください。");
      const field = this.fields.createFromObservationRange({
        name: this.elements.assuranceFieldName.value,
        sessionId,
        observations: this.store.getObservations(sessionId),
        startObservationId: this.elements.assuranceFieldStart.value,
        endObservationId: this.elements.assuranceFieldEnd.value,
        direction: this.elements.assuranceFieldDirection.value
      });
      this.onFieldChanged(field);
      this.elements.assuranceFieldMessage.textContent = field.validation.warnings.length
        ? field.validation.warnings.join(" ")
        : `${field.boundary.coordinates.length}点を「${field.name}」の境界として保存しました。`;
      this.fitCoordinates(field.boundary.coordinates);
    } catch (error) {
      this.elements.assuranceFieldMessage.textContent = error.message;
    }
  }

  refreshFieldControls() {
    const select = this.elements.assuranceActiveField;
    if (!select) return;
    select.replaceChildren();
    [...this.fields.fields.values()].forEach((field) => select.append(new Option(`${field.name}（${field.boundary.coordinates.length}点）`, field.id)));
    select.value = this.fields.activeFieldId || "";
  }

  recalculate() {
    try {
      const qz1Session = this.store.getSession(this.elements.assuranceQz1Session.value);
      const referenceSession = this.store.getSession(this.elements.assuranceReferenceSession.value);
      if (!qz1Session || !referenceSession) throw new Error("QZ1とM10 / 基準受信機の両データセットを選択してください。");
      const field = this.fields.getActive();
      const boundary = field?.boundary.coordinates || this.getFallbackBoundary();
      if (!boundary || boundary.length < 3) throw new Error("圃場境界を設定してください。QZ1点の開始・終了範囲から作成できます。");
      this.result = calculateAssurance({
        qz1Observations: this.store.getObservations(qz1Session.id),
        referenceObservations: this.store.getObservations(referenceSession.id),
        qz1ExpectedRateHz: Number(this.elements.assuranceQz1Rate.value) || qz1Session.expectedRateHz,
        referenceExpectedRateHz: Number(this.elements.assuranceReferenceRate.value) || referenceSession.expectedRateHz,
        toleranceMs: Number(this.elements.assuranceTolerance.value),
        qz1OffsetMs: Number(this.elements.assuranceQz1Offset.value),
        referenceOffsetMs: Number(this.elements.assuranceReferenceOffset.value),
        profileId: this.elements.assuranceProfile.value,
        minimumGrade: this.elements.assuranceMinimumGrade.value || null,
        gridSizeM: Number(this.elements.assuranceGridSize.value),
        fieldId: field?.id || "fallback-field",
        boundary,
        simulated: qz1Session.simulated || referenceSession.simulated
      });
      const qz1HasFullUtc = this.store.getObservations(qz1Session.id).some((observation) => Number.isFinite(observation.timestampUtcMs));
      const referenceHasFullUtc = this.store.getObservations(referenceSession.id).some((observation) => Number.isFinite(observation.timestampUtcMs));
      if (!qz1HasFullUtc || !referenceHasFullUtc) {
        this.result.warnings.unshift("完全なUTC日時がないデータを時刻だけで対応しました。同じ記録セッションか確認してください。");
      }
      if (field?.validation?.warnings?.length) {
        this.result.warnings.unshift(...field.validation.warnings.map((warning) => `圃場境界: ${warning}`));
      }
      this.renderResult();
      this.setWarnings(this.result.warnings);
    } catch (error) {
      this.setWarnings([error.message]);
    }
  }

  renderResult() {
    this.layers.grid.clearLayers();
    this.layers.pairs.clearLayers();
    if (!this.result) return;
    this.result.cells.forEach((cell) => {
      const style = STATUS_STYLE[cell.classification] || STATUS_STYLE.grey;
      L.polygon(cell.coordinates, { ...style, weight: 2, fillOpacity: cell.classification === "grey" ? 0.18 : 0.48 })
        .bindTooltip(`${statusLabel(cell.classification)} · ${cell.evidenceGrade} · ${cell.sampleCount || 0}ペア`)
        .on("click", () => this.inspectCell(cell))
        .addTo(this.layers.grid);
    });
    this.result.pairs.forEach((pairResult) => {
      const pair = pairResult.pair;
      const color = pairResult.jump ? STATUS_STYLE.red.color : "#0e7490";
      L.polyline([[pair.qz1.lat, pair.qz1.lon], [pair.reference.lat, pair.reference.lon]], { color, weight: 2, opacity: 0.7 })
        .bindTooltip(`${pair.separationM.toFixed(2)} m · Δt ${Math.abs(pair.timeDeltaMs)} ms`)
        .on("click", () => this.inspectPair(pairResult))
        .addTo(this.layers.pairs);
    });
    const summary = this.result.summary;
    const values = {
      assurancePairedCount: `${summary.pairedCount}組`,
      assuranceMedianSeparation: formatMeters(summary.medianSeparationM),
      assuranceMaximumSeparation: formatMeters(summary.maximumSeparationM),
      assuranceAugmentationRate: formatPercent(summary.qz1AugmentationPercent),
      assuranceQzssUseRate: formatPercent(summary.qzssUsedPercent),
      assuranceContinuity: formatPercent((summary.qz1Continuity.validFixRatio ?? 0) * 100),
      assuranceMeasuredArea: formatPercent(summary.measuredAreaPercent),
      assuranceGreenArea: formatPercent(summary.greenAreaPercent),
      assuranceYellowArea: formatPercent(summary.yellowAreaPercent),
      assuranceRedArea: formatPercent(summary.redAreaPercent),
      assuranceUnknownArea: formatPercent(summary.unknownAreaPercent),
      assuranceSimulatedArea: formatPercent(summary.simulatedAreaPercent)
    };
    Object.entries(values).forEach(([id, value]) => { this.elements[id].textContent = value; });
    this.elements.assuranceSelectedDetail.textContent = this.result.simulated
      ? "SIMULATED結果です。セルまたは受信機間の線を選ぶと根拠を確認できます。"
      : "セルまたは受信機間の線を選ぶと、分類根拠を確認できます。";
    this.syncLayerVisibility();
  }

  renderRawLayers() {
    this.layers.qz1.clearLayers();
    this.layers.reference.clearLayers();
    const add = (sessionId, layer, color, label) => {
      this.store.getObservations(sessionId, { validOnly: true }).forEach((observation) => {
        L.circleMarker([observation.lat, observation.lon], { radius: 3, color: "#fff", weight: 1, fillColor: color, fillOpacity: 0.85 })
          .bindTooltip(`${label} · fix ${observation.fixQuality ?? "—"} · HDOP ${observation.hdop ?? "—"}`)
          .addTo(layer);
      });
    };
    add(this.elements.assuranceQz1Session?.value, this.layers.qz1, "#0e7490", "QZ1");
    add(this.elements.assuranceReferenceSession?.value, this.layers.reference, "#6d28d9", "基準");
    this.renderSessionSummary();
    this.syncLayerVisibility();
  }

  inspectPair(pairResult) {
    const { pair } = pairResult;
    const lines = [
      `対応観測 ${pair.qz1ObservationId} ↔ ${pair.referenceObservationId}`,
      `QZ1: ${formatCoordinate(pair.qz1)} / ${formatTime(pair.qz1)}`,
      `基準: ${formatCoordinate(pair.reference)} / ${formatTime(pair.reference)}`,
      `時刻差: ${pair.timeDeltaMs} ms / 水平差: ${pair.separationM.toFixed(2)} m`,
      `QZ1 fix ${pair.qz1.fixQuality ?? "—"}, 衛星 ${pair.qz1.satellites ?? "—"}, HDOP ${pair.qz1.hdop ?? "—"}`,
      `補強: ${pair.qz1.augmentation?.status || "unknown"}（${(pair.qz1.augmentation?.evidence || []).join(", ") || "証拠なし"}）`,
      `Assurance: ${pairResult.score ?? "—"} / 証拠充足 ${Math.round(pairResult.completeness * 100)}%${pairResult.jump ? " / 位置ジャンプ警告" : ""}`
    ];
    this.elements.assuranceSelectedDetail.textContent = lines.join("\n");
  }

  inspectCell(cell) {
    const action = recommendationFor(cell.classification, this.result.profile);
    const lines = [
      `${cell.id} — ${statusLabel(cell.classification)}`,
      `サンプル ${cell.sampleCount || 0}組 / 証拠等級 ${cell.evidenceGrade} / Assurance ${cell.score ?? "—"}`,
      `受信機差 中央値 ${formatMeters(cell.medianSeparationM)} / 最大 ${formatMeters(cell.maximumSeparationM)}`,
      `補正・補強推定 ${formatPercent(cell.augmentationPercent)} / HDOP中央値 ${cell.medianHdop?.toFixed(2) ?? "—"} / ジャンプ ${cell.jumpCount || 0}件`,
      ...cell.explanation,
      `推奨: ${action}`
    ];
    this.elements.assuranceSelectedDetail.textContent = lines.join("\n");
  }

  setWorkspaceActive(active) {
    this.active = active;
    this.syncLayerVisibility();
  }

  syncLayerVisibility() {
    if (!this.map) return;
    const toggles = {
      grid: this.elements.assuranceShowGrid?.checked,
      pairs: this.elements.assuranceShowPairs?.checked,
      qz1: this.elements.assuranceShowQz1?.checked,
      reference: this.elements.assuranceShowReference?.checked
    };
    Object.entries(this.layers).forEach(([key, layer]) => {
      const visible = this.active && Boolean(toggles[key]);
      if (visible && !this.map.hasLayer(layer)) layer.addTo(this.map);
      if (!visible && this.map.hasLayer(layer)) this.map.removeLayer(layer);
    });
  }

  clearResult() {
    this.result = null;
    this.layers.grid.clearLayers();
    this.layers.pairs.clearLayers();
    ["assurancePairedCount", "assuranceMedianSeparation", "assuranceMaximumSeparation", "assuranceAugmentationRate", "assuranceQzssUseRate", "assuranceContinuity", "assuranceMeasuredArea", "assuranceGreenArea", "assuranceYellowArea", "assuranceRedArea", "assuranceUnknownArea", "assuranceSimulatedArea"]
      .forEach((id) => { this.elements[id].textContent = "—"; });
    this.elements.assuranceSelectedDetail.textContent = "結果を消去しました。読み込んだ観測データは保持しています。";
    this.setWarnings([]);
  }

  setWarnings(warnings) {
    const container = this.elements.assuranceWarnings;
    if (!container) return;
    container.replaceChildren();
    (warnings || []).forEach((warning) => {
      const item = document.createElement("p");
      item.textContent = warning;
      container.append(item);
    });
  }

  exportProject() {
    const compactResult = this.result ? {
      calculationVersion: this.result.calculationVersion,
      calculatedAt: this.result.calculatedAt,
      profileId: this.result.profile.id,
      simulated: this.result.simulated,
      summary: this.result.summary,
      pairedObservations: this.result.pairs.map((entry) => ({
        id: entry.pair.id,
        qz1ObservationId: entry.pair.qz1ObservationId,
        referenceObservationId: entry.pair.referenceObservationId,
        timeDeltaMs: entry.pair.timeDeltaMs,
        separationM: entry.pair.separationM,
        score: entry.score,
        completeness: entry.completeness,
        jump: entry.jump,
        gridCellId: entry.gridCellId
      })),
      gridResults: this.result.cells.map(({ pairs, ...cell }) => cell)
    } : null;
    const payload = {
      schemaVersion: "2.0.0",
      application: "michibiki-suimon-navi",
      exportedAt: new Date().toISOString(),
      calculationVersions: { assurance: "satellite-assurance.v1", paddy: "legacy-v1" },
      gnss: this.store.serialize(),
      fields: this.fields.serialize(),
      assurance: { configuration: this.getConfiguration(), lastRun: compactResult }
    };
    downloadJson(payload, `satellite-assurance-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  }

  async importProjectFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.schemaVersion?.startsWith("2") && data.gnss) {
        this.store.hydrate(data.gnss);
        this.fields.hydrate(data.fields || {});
        this.applyConfiguration(data.assurance?.configuration || {});
        this.refreshRangeOptions();
        this.renderRawLayers();
        const active = this.fields.getActive();
        if (active) this.onFieldChanged(active);
        this.setWarnings(["Assurance v2プロジェクトを読み込みました。派生結果は現在の計算版で再計算してください。"]);
      } else {
        if (data.schemaVersion === "paddy-intelligence.v1") this.onImportLegacy(data);
        const points = Array.isArray(data)
          ? data
          : data.points || data.gnssPoints || (data.gnssPointAssociations || []).map((association) => ({
            lat: association.coordinates?.[0],
            lon: association.coordinates?.[1],
            timestamp: association.timestamp,
            fixQuality: association.fixQuality
          }));
        if (points.length) this.store.addLegacyPoints(points, { sourceName: file.name });
        this.setWarnings(["旧形式を読み込みました。受信機ID・生NMEA・完全な時刻は復元できません。"]);
      }
    } catch (error) {
      this.setWarnings([`JSON読み込み失敗: ${error.message}`]);
    } finally {
      event.target.value = "";
    }
  }

  getConfiguration() {
    return {
      qz1SessionId: this.elements.assuranceQz1Session.value,
      referenceSessionId: this.elements.assuranceReferenceSession.value,
      toleranceMs: Number(this.elements.assuranceTolerance.value),
      qz1OffsetMs: Number(this.elements.assuranceQz1Offset.value),
      referenceOffsetMs: Number(this.elements.assuranceReferenceOffset.value),
      profileId: this.elements.assuranceProfile.value,
      qz1ExpectedRateHz: Number(this.elements.assuranceQz1Rate.value),
      referenceExpectedRateHz: Number(this.elements.assuranceReferenceRate.value),
      minimumGrade: this.elements.assuranceMinimumGrade.value || null,
      gridSizeM: Number(this.elements.assuranceGridSize.value)
    };
  }

  applyConfiguration(config) {
    const values = {
      assuranceQz1Session: config.qz1SessionId,
      assuranceReferenceSession: config.referenceSessionId,
      assuranceTolerance: config.toleranceMs,
      assuranceQz1Offset: config.qz1OffsetMs,
      assuranceReferenceOffset: config.referenceOffsetMs,
      assuranceProfile: config.profileId,
      assuranceQz1Rate: config.qz1ExpectedRateHz,
      assuranceReferenceRate: config.referenceExpectedRateHz,
      assuranceMinimumGrade: config.minimumGrade,
      assuranceGridSize: config.gridSizeM
    };
    Object.entries(values).forEach(([id, value]) => {
      if (value !== undefined && this.elements[id]) this.elements[id].value = value;
    });
  }

  fitCoordinates(coordinates) {
    if (coordinates.length) this.map.fitBounds(L.latLngBounds(coordinates), { padding: [30, 30], maxZoom: 19 });
  }
}

function recommendationFor(status, profile) {
  if (status === "green") return `${profile.label}で条件付き運用を検討できます。最終判断と現場監視は人が行ってください。`;
  if (status === "yellow") return "低速・監視付き運用、または手動確認を行ってください。";
  if (status === "red") return "自律測位に依存しないでください。手動確認が必要です。";
  if (status === "simulated") return "シミュレーションのため運用判断は禁止です。";
  return "測定を追加するまで自律運用の判断対象にしないでください。";
}

function statusLabel(status) {
  return { green: "緑・十分", yellow: "黄・要注意", red: "赤・使用不可", grey: "灰・証拠なし", simulated: "SIM・検証用" }[status] || status;
}

function formatMeters(value) { return Number.isFinite(value) ? `${value.toFixed(2)} m` : "—"; }
function formatPercent(value) { return Number.isFinite(value) ? `${value.toFixed(1)}%` : "—"; }
function formatCoordinate(point) { return Number.isFinite(point.lat) ? `${point.lat.toFixed(7)}, ${point.lon.toFixed(7)}` : "座標なし"; }
function formatTime(point) { return Number.isFinite(point.timestampUtcMs) ? new Date(point.timestampUtcMs).toISOString() : point.timeOfDay || "時刻不明"; }

function downloadJson(data, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
