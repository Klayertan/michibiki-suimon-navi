// Vegetation Intelligence UI / map controller.
// Mirrors the SatelliteAssuranceController pattern: an ES module class that
// owns its own Leaflet layer, binds to panel elements by id, and receives the
// paddy analysis state through callbacks instead of duplicating it.
import {
  ASSOCIATION_LABELS,
  DEFAULT_VEGETATION_SETTINGS,
  NO_DATA_STYLE,
  OBSERVATION_TYPES,
  POSITION_QUALITY_LABELS,
  SEVERITY_LABELS,
  TREND_LABELS,
  VEGETATION_MAP_MODES,
  VEGETATION_SCHEMA_VERSION,
  analyzeCellSeries,
  associateObservation,
  classifyForMode,
  compareRecentObservations,
  computeVegetationSummary,
  derivePositionQuality,
  effectiveFieldId,
  effectiveGridCellId,
  formatPp,
  inspectionPriority,
  legendForMode,
  mergeImportedObservations,
  normalizeObservation,
  observationsForCell,
  parseVegetationImport,
  requiresReview,
  sortByTimestamp,
  toLocalIso,
  validateObservationInput
} from "./vegetation-core.js";

const ELEMENT_IDS = [
  "vegMapModeSelect", "vegLegend", "vegImportInput", "vegImportMessage",
  "vegConfidenceThresholdInput", "vegStaleDaysInput",
  "vegSummaryTotal", "vegSummaryCellsWith", "vegSummaryCellsWithout", "vegSummaryHighSeverity",
  "vegSummaryIncreasing", "vegSummaryReview", "vegSummaryAvgWeed", "vegSummaryLatest",
  "vegSelectedField", "vegSelectedCell", "vegFormCellSelect", "vegObservationType",
  "vegTimestampInput", "vegWeedInput", "vegCropInput", "vegBareInput", "vegWaterInput",
  "vegConfidenceInput", "vegSeveritySelect", "vegImageNameInput", "vegModelNameInput", "vegNotesInput",
  "vegFormWarnings", "vegFormMessage", "vegAddButton", "vegUpdateButton", "vegDeleteButton", "vegClearButton",
  "vegCellSummary", "vegPriorityScore", "vegPriorityReasons", "vegComparisonWarnings",
  "vegHistorySort", "vegHistoryTable", "vegHistoryChart",
  "vegReviewSelect", "vegReviewDetail", "vegReviewCellSelect",
  "vegConfirmAssociationButton", "vegOverrideAssociationButton", "vegReviewMessage"
];

export class VegetationIntelligenceController {
  constructor(options) {
    this.map = options.map;
    this.getGridCells = options.getGridCells || (() => []);
    this.getBoundary = options.getBoundary || (() => []);
    this.getBoundaryThresholdM = options.getBoundaryThresholdM || (() => 2);
    this.getActiveField = options.getActiveField || (() => ({ id: "field-current", name: "圃場" }));
    this.onSelectCellOnMap = options.onSelectCellOnMap || (() => {});
    this.observations = [];
    this.selectedCellId = null;
    this.selectedObservationId = null;
    this.workspaceActive = false;
    this.overlayLayer = L.layerGroup();
    this.elements = {};
  }

  mount() {
    ELEMENT_IDS.forEach((id) => { this.elements[id] = document.getElementById(id); });
    if (!this.elements.vegMapModeSelect) {
      return;
    }
    this.populateStaticOptions();
    this.bindEvents();
    this.resetForm();
    this.renderAll();
  }

  populateStaticOptions() {
    const modeSelect = this.elements.vegMapModeSelect;
    modeSelect.replaceChildren(new Option("表示しない / off", "off"));
    Object.entries(VEGETATION_MAP_MODES).forEach(([mode, definition]) => {
      modeSelect.append(new Option(definition.label, mode));
    });
    modeSelect.value = DEFAULT_VEGETATION_SETTINGS.mapMode;

    const typeSelect = this.elements.vegObservationType;
    typeSelect.replaceChildren();
    Object.entries(OBSERVATION_TYPES).forEach(([value, definition]) => {
      typeSelect.append(new Option(definition.label, value));
    });
    typeSelect.value = "weed";

    const severitySelect = this.elements.vegSeveritySelect;
    severitySelect.replaceChildren();
    ["unknown", "low", "medium", "high"].forEach((severity) => {
      severitySelect.append(new Option(SEVERITY_LABELS[severity], severity));
    });
  }

  bindEvents() {
    const el = this.elements;
    el.vegMapModeSelect.addEventListener("change", () => {
      this.renderOverlay();
      this.renderLegend();
    });
    [el.vegConfidenceThresholdInput, el.vegStaleDaysInput].forEach((input) => {
      input?.addEventListener("input", () => {
        this.renderSummary();
        this.renderCellPanel();
      });
    });
    el.vegImportInput.addEventListener("change", (event) => this.importAnalysisFile(event));
    el.vegFormCellSelect.addEventListener("change", () => {
      this.selectCell(el.vegFormCellSelect.value || null, { fromForm: true });
    });
    [el.vegWeedInput, el.vegCropInput, el.vegBareInput, el.vegWaterInput, el.vegConfidenceInput, el.vegTimestampInput]
      .forEach((input) => input?.addEventListener("input", () => this.renderFormValidation()));
    el.vegAddButton.addEventListener("click", () => this.addObservation());
    el.vegUpdateButton.addEventListener("click", () => this.updateObservation());
    el.vegDeleteButton.addEventListener("click", () => this.deleteObservation());
    el.vegClearButton.addEventListener("click", () => {
      this.selectedObservationId = null;
      this.resetForm();
      this.renderCellPanel();
      this.updateButtonStates();
    });
    el.vegHistorySort.addEventListener("change", () => this.renderCellPanel());
    el.vegReviewSelect.addEventListener("change", () => this.renderReviewDetail());
    el.vegConfirmAssociationButton.addEventListener("click", () => this.confirmAssociation());
    el.vegOverrideAssociationButton.addEventListener("click", () => this.overrideAssociation());
  }

  // -------------------------------------------------------------------------
  // State access used by index.html (export / import / paddy refresh hooks)
  // -------------------------------------------------------------------------

  settings() {
    return {
      ...DEFAULT_VEGETATION_SETTINGS,
      mapMode: this.elements.vegMapModeSelect?.value || DEFAULT_VEGETATION_SETTINGS.mapMode,
      confidenceThreshold: numberOr(this.elements.vegConfidenceThresholdInput?.value, DEFAULT_VEGETATION_SETTINGS.confidenceThreshold),
      staleDays: numberOr(this.elements.vegStaleDaysInput?.value, DEFAULT_VEGETATION_SETTINGS.staleDays)
    };
  }

  getExportData() {
    return {
      vegetationObservations: this.observations.map((observation) => ({
        ...observation,
        fieldId: effectiveFieldId(observation),
        gridCellId: effectiveGridCellId(observation)
      })),
      vegetationSettings: this.settings(),
      vegetationSummary: computeVegetationSummary(this.observations, this.getGridCells(), this.settings())
    };
  }

  /** Hydrate from a project JSON. Older files without vegetation data reset the store. */
  applyImportedProject(data) {
    const rows = Array.isArray(data?.vegetationObservations) ? data.vegetationObservations : [];
    this.observations = rows.map((row) => normalizeObservation(row));
    const settings = data?.vegetationSettings || {};
    if (this.elements.vegMapModeSelect && (settings.mapMode === "off" || VEGETATION_MAP_MODES[settings.mapMode])) {
      this.elements.vegMapModeSelect.value = settings.mapMode;
    }
    if (this.elements.vegConfidenceThresholdInput && Number.isFinite(Number(settings.confidenceThreshold))) {
      this.elements.vegConfidenceThresholdInput.value = settings.confidenceThreshold;
    }
    if (this.elements.vegStaleDaysInput && Number.isFinite(Number(settings.staleDays))) {
      this.elements.vegStaleDaysInput.value = settings.staleDays;
    }
    this.selectedObservationId = null;
    this.reassociateAll();
    this.renderAll();
    if (rows.length > 0) {
      this.setImportMessage(`プロジェクトから植生観測 ${rows.length} 件を読み込みました。`);
    }
  }

  /** Called after every paddy refresh (boundary / grid may have changed). */
  handlePaddyRefresh() {
    this.reassociateAll();
    this.renderAll();
  }

  setWorkspaceActive(active) {
    this.workspaceActive = active;
    this.syncOverlayVisibility();
  }

  // -------------------------------------------------------------------------
  // Association
  // -------------------------------------------------------------------------

  associationGeometry() {
    return {
      fieldId: this.getActiveField()?.id || null,
      boundary: this.getBoundary(),
      cells: this.getGridCells(),
      thresholdM: Math.max(0, this.getBoundaryThresholdM())
    };
  }

  reassociateAll() {
    const geometry = this.associationGeometry();
    const cellIds = new Set(geometry.cells.map((cell) => cell.id));
    this.observations.forEach((observation) => {
      if (observation.associationStatus === "confirmed" || observation.associationStatus === "overridden") {
        // Manual decisions are kept, but flag them when the confirmed cell no
        // longer exists (e.g. the grid was regenerated at another size).
        if (observation.confirmedGridCellId && cellIds.size > 0 && !cellIds.has(observation.confirmedGridCellId)) {
          observation.associationStatus = "ambiguous";
        } else {
          return;
        }
      }
      const association = associateObservation(observation, geometry);
      observation.automaticFieldId = association.automaticFieldId;
      observation.automaticGridCellId = association.automaticGridCellId;
      observation.candidateGridCellIds = association.candidateGridCellIds;
      observation.associationStatus = association.associationStatus;
      observation.distanceToBoundaryM = association.distanceToBoundaryM;
      observation.positionQuality = derivePositionQuality(observation, association);
    });
  }

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  selectCell(cellId, { fromForm = false, fromMap = false } = {}) {
    this.selectedCellId = cellId || null;
    this.selectedObservationId = null;
    if (!fromForm && this.elements.vegFormCellSelect) {
      this.elements.vegFormCellSelect.value = this.selectedCellId || "";
    }
    if (fromMap && this.selectedCellId) {
      this.onSelectCellOnMap(this.selectedCellId);
      const details = this.elements.vegCellSummary?.closest("details");
      if (details) {
        details.open = true;
      }
    }
    this.renderSelectedLabels();
    this.renderCellPanel();
    this.updateButtonStates();
  }

  /** Hook target for paddy grid-cell selection (map click on the grid layer). */
  handlePaddySelection(selected) {
    if (selected?.kind === "grid" && selected.cell?.id) {
      if (selected.cell.id !== this.selectedCellId) {
        this.selectCell(selected.cell.id);
      }
    }
  }

  selectObservation(observationId) {
    const observation = this.observations.find((candidate) => candidate.id === observationId);
    if (!observation) {
      return;
    }
    this.selectedObservationId = observationId;
    this.fillFormFromObservation(observation);
    this.renderCellPanel();
    this.updateButtonStates();
  }

  // -------------------------------------------------------------------------
  // Form handling
  // -------------------------------------------------------------------------

  resetForm() {
    const el = this.elements;
    el.vegObservationType.value = "weed";
    el.vegTimestampInput.value = datetimeLocalValue(new Date());
    [el.vegWeedInput, el.vegCropInput, el.vegBareInput, el.vegWaterInput, el.vegConfidenceInput,
      el.vegImageNameInput, el.vegModelNameInput, el.vegNotesInput].forEach((input) => { input.value = ""; });
    el.vegSeveritySelect.value = "unknown";
    this.setFormMessage("");
    this.renderFormValidation();
  }

  fillFormFromObservation(observation) {
    const el = this.elements;
    el.vegObservationType.value = observation.observationType;
    const ms = Date.parse(observation.timestamp);
    el.vegTimestampInput.value = Number.isFinite(ms) ? datetimeLocalValue(new Date(ms)) : "";
    el.vegWeedInput.value = valueOrEmpty(observation.weedCoveragePercent);
    el.vegCropInput.value = valueOrEmpty(observation.cropCoveragePercent);
    el.vegBareInput.value = valueOrEmpty(observation.bareSoilPercent);
    el.vegWaterInput.value = valueOrEmpty(observation.waterSurfacePercent);
    el.vegConfidenceInput.value = valueOrEmpty(observation.confidence);
    el.vegSeveritySelect.value = observation.severity;
    el.vegImageNameInput.value = observation.imageName;
    el.vegModelNameInput.value = observation.modelName;
    el.vegNotesInput.value = observation.notes;
    this.setFormMessage(`観測 ${observation.id} を編集中`);
    this.renderFormValidation();
  }

  readFormInput() {
    const el = this.elements;
    const timestampRaw = el.vegTimestampInput.value;
    const timestampMs = Date.parse(timestampRaw);
    return {
      timestamp: Number.isFinite(timestampMs) ? toLocalIso(new Date(timestampMs)) : timestampRaw,
      observationType: el.vegObservationType.value,
      weedCoveragePercent: el.vegWeedInput.value,
      cropCoveragePercent: el.vegCropInput.value,
      bareSoilPercent: el.vegBareInput.value,
      waterSurfacePercent: el.vegWaterInput.value,
      confidence: el.vegConfidenceInput.value,
      severity: el.vegSeveritySelect.value,
      imageName: el.vegImageNameInput.value,
      modelName: el.vegModelNameInput.value,
      notes: el.vegNotesInput.value
    };
  }

  renderFormValidation() {
    const validation = validateObservationInput(this.readFormInput(), this.settings());
    const container = this.elements.vegFormWarnings;
    container.replaceChildren();
    validation.errors.forEach((message) => container.append(warningNode(message, "error")));
    validation.warnings.forEach((message) => container.append(warningNode(message, "warn")));
    this.formHasErrors = validation.errors.length > 0;
    this.updateButtonStates();
    return validation;
  }

  addObservation() {
    if (!this.selectedCellId) {
      return;
    }
    const validation = this.renderFormValidation();
    if (validation.errors.length > 0) {
      this.setFormMessage("入力エラーを修正してください。");
      return;
    }
    const cell = this.getGridCells().find((candidate) => candidate.id === this.selectedCellId);
    const centroid = cell ? polygonCentroid(cell.coordinates) : null;
    const field = this.getActiveField();
    const observation = normalizeObservation({
      ...this.readFormInput(),
      source: "manual",
      positionSource: "manual",
      latitude: centroid ? centroid[0] : null,
      longitude: centroid ? centroid[1] : null,
      confirmedFieldId: field?.id || null,
      confirmedGridCellId: this.selectedCellId,
      automaticFieldId: field?.id || null,
      automaticGridCellId: this.selectedCellId,
      associationStatus: "confirmed"
    });
    // Manual entries carry no SLAS metadata, so quality stays "unknown".
    this.observations.push(observation);
    this.selectedObservationId = observation.id;
    this.setFormMessage(`観測を追加しました（${this.selectedCellId}）。`);
    this.renderAll();
  }

  updateObservation() {
    const observation = this.observations.find((candidate) => candidate.id === this.selectedObservationId);
    if (!observation) {
      return;
    }
    const validation = this.renderFormValidation();
    if (validation.errors.length > 0) {
      this.setFormMessage("入力エラーを修正してください。");
      return;
    }
    const input = this.readFormInput();
    Object.assign(observation, normalizeObservation({
      ...observation,
      ...input,
      weedCoveragePercent: emptyToNull(input.weedCoveragePercent),
      cropCoveragePercent: emptyToNull(input.cropCoveragePercent),
      bareSoilPercent: emptyToNull(input.bareSoilPercent),
      waterSurfacePercent: emptyToNull(input.waterSurfacePercent),
      confidence: emptyToNull(input.confidence),
      updatedAt: new Date().toISOString()
    }));
    this.setFormMessage(`観測 ${observation.id} を更新しました。`);
    this.renderAll();
  }

  deleteObservation() {
    const observation = this.observations.find((candidate) => candidate.id === this.selectedObservationId);
    if (!observation) {
      return;
    }
    if (!window.confirm("選択中の植生観測を削除しますか？")) {
      return;
    }
    this.observations = this.observations.filter((candidate) => candidate.id !== observation.id);
    this.selectedObservationId = null;
    this.setFormMessage("観測を削除しました。");
    this.renderAll();
  }

  setFormMessage(message) {
    if (this.elements.vegFormMessage) {
      this.elements.vegFormMessage.textContent = message;
    }
  }

  // -------------------------------------------------------------------------
  // AI result import (JSON / CSV)
  // -------------------------------------------------------------------------

  async importAnalysisFile(event) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    try {
      const parsed = parseVegetationImport(await file.text(), file.name);
      const geometry = this.associationGeometry();
      parsed.records.forEach((record) => {
        const association = associateObservation(record, geometry);
        record.automaticFieldId = association.automaticFieldId;
        record.automaticGridCellId = association.automaticGridCellId;
        record.candidateGridCellIds = association.candidateGridCellIds;
        record.associationStatus = association.associationStatus;
        record.distanceToBoundaryM = association.distanceToBoundaryM;
        record.positionQuality = derivePositionQuality(record, association);
      });
      const { added, skippedDuplicates } = mergeImportedObservations(this.observations, parsed.records);
      this.observations.push(...added);
      const failed = parsed.errors.length;
      const parts = [`取込 ${added.length} 件`, `重複スキップ ${skippedDuplicates} 件`, `失敗 ${failed} 件`];
      const detail = parsed.errors.slice(0, 8);
      this.setImportMessage(`${file.name}: ${parts.join(" / ")}`, detail);
      this.renderAll();
    } catch (error) {
      this.setImportMessage(`読み込みに失敗しました: ${error.message}`);
    } finally {
      event.target.value = "";
    }
  }

  setImportMessage(message, detailLines = []) {
    const container = this.elements.vegImportMessage;
    if (!container) {
      return;
    }
    container.replaceChildren();
    const head = document.createElement("div");
    head.textContent = message;
    container.append(head);
    detailLines.forEach((line) => {
      const item = document.createElement("div");
      item.className = "veg-import-error";
      item.textContent = line;
      container.append(item);
    });
  }

  // -------------------------------------------------------------------------
  // Association review (boundary ambiguity handling)
  // -------------------------------------------------------------------------

  reviewQueue() {
    return this.observations.filter(requiresReview);
  }

  renderReviewQueue() {
    const select = this.elements.vegReviewSelect;
    const previous = select.value;
    select.replaceChildren(new Option("要確認の観測を選択", ""));
    this.reviewQueue().forEach((observation) => {
      const cellLabel = observation.automaticGridCellId || observation.candidateGridCellIds.join("/") || "未割当";
      select.append(new Option(`${observation.timestamp} · ${typeShort(observation.observationType)} · ${cellLabel}`, observation.id));
    });
    if ([...select.options].some((option) => option.value === previous)) {
      select.value = previous;
    }
    this.renderReviewDetail();
  }

  renderReviewDetail() {
    const el = this.elements;
    const observation = this.observations.find((candidate) => candidate.id === el.vegReviewSelect.value);
    el.vegReviewDetail.replaceChildren();
    const cellSelect = el.vegReviewCellSelect;
    cellSelect.replaceChildren(new Option("セルを選択", ""));
    if (!observation) {
      el.vegReviewDetail.append(detailText(this.reviewQueue().length === 0
        ? "確認が必要な観測はありません。"
        : "リストから観測を選ぶと、候補セルと元の座標を確認できます。"));
      this.updateButtonStates();
      return;
    }
    const grid = document.createElement("div");
    grid.className = "paddy-detail-grid";
    appendDetail(grid, "観測", `${observation.timestamp} · ${typeShort(observation.observationType)}`);
    appendDetail(grid, "元の座標", Number.isFinite(observation.latitude)
      ? `${observation.latitude.toFixed(6)}, ${observation.longitude.toFixed(6)}`
      : "なし");
    appendDetail(grid, "状態", ASSOCIATION_LABELS[observation.associationStatus] || observation.associationStatus);
    appendDetail(grid, "自動割当", observation.automaticGridCellId || "なし");
    appendDetail(grid, "候補セル", observation.candidateGridCellIds.join(", ") || "なし");
    appendDetail(grid, "境界距離", Number.isFinite(observation.distanceToBoundaryM) ? `${observation.distanceToBoundaryM.toFixed(1)} m` : "—");
    appendDetail(grid, "測位品質", POSITION_QUALITY_LABELS[observation.positionQuality] || observation.positionQuality);
    el.vegReviewDetail.append(grid);

    const candidates = new Set(observation.candidateGridCellIds);
    this.getGridCells().forEach((cell) => {
      const label = candidates.has(cell.id) ? `${cell.id}（候補）` : cell.id;
      cellSelect.append(new Option(label, cell.id));
    });
    if (observation.automaticGridCellId) {
      cellSelect.value = observation.automaticGridCellId;
    } else if (observation.candidateGridCellIds[0]) {
      cellSelect.value = observation.candidateGridCellIds[0];
    }
    this.updateButtonStates();
  }

  confirmAssociation() {
    const observation = this.observations.find((candidate) => candidate.id === this.elements.vegReviewSelect.value);
    if (!observation || !observation.automaticGridCellId) {
      return;
    }
    observation.confirmedFieldId = observation.automaticFieldId;
    observation.confirmedGridCellId = observation.automaticGridCellId;
    observation.associationStatus = "confirmed";
    observation.updatedAt = new Date().toISOString();
    observation.positionQuality = observation.positionQualityProvided
      ? observation.positionQuality
      : derivePositionQuality(observation, { associationStatus: "confirmed" });
    this.elements.vegReviewMessage.textContent = `自動割当（${observation.confirmedGridCellId}）を確認済みにしました。`;
    this.renderAll();
  }

  overrideAssociation() {
    const observation = this.observations.find((candidate) => candidate.id === this.elements.vegReviewSelect.value);
    const cellId = this.elements.vegReviewCellSelect.value;
    if (!observation || !cellId) {
      return;
    }
    observation.confirmedFieldId = this.getActiveField()?.id || observation.automaticFieldId;
    observation.confirmedGridCellId = cellId;
    observation.associationStatus = cellId === observation.automaticGridCellId ? "confirmed" : "overridden";
    observation.updatedAt = new Date().toISOString();
    this.elements.vegReviewMessage.textContent = `観測を ${cellId} に割り当てました（元の座標は保持されます）。`;
    this.renderAll();
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  renderAll() {
    this.renderCellOptions();
    this.renderSelectedLabels();
    this.renderOverlay();
    this.renderLegend();
    this.renderSummary();
    this.renderCellPanel();
    this.renderReviewQueue();
    this.updateButtonStates();
  }

  renderCellOptions() {
    const select = this.elements.vegFormCellSelect;
    if (!select) {
      return;
    }
    const cells = this.getGridCells();
    select.replaceChildren(new Option("セルを選択", ""));
    cells.forEach((cell) => select.append(new Option(cell.id, cell.id)));
    if (this.selectedCellId && cells.some((cell) => cell.id === this.selectedCellId)) {
      select.value = this.selectedCellId;
    } else if (this.selectedCellId) {
      this.selectedCellId = null;
      this.selectedObservationId = null;
    }
  }

  renderSelectedLabels() {
    const field = this.getActiveField();
    if (this.elements.vegSelectedField) {
      this.elements.vegSelectedField.textContent = field?.name ? `${field.name}（${field.id}）` : "—";
    }
    if (this.elements.vegSelectedCell) {
      this.elements.vegSelectedCell.textContent = this.selectedCellId || "未選択";
    }
  }

  renderOverlay() {
    this.overlayLayer.clearLayers();
    const mode = this.elements.vegMapModeSelect?.value || "off";
    if (mode !== "off") {
      const nowMs = Date.now();
      this.getGridCells().forEach((cell) => {
        const series = observationsForCell(this.observations, cell.id);
        const latest = series.at(-1) || null;
        const classification = classifyForMode(mode, latest, nowMs);
        const style = classification.noData
          ? { color: NO_DATA_STYLE.color, fillColor: NO_DATA_STYLE.fillColor, fillOpacity: NO_DATA_STYLE.fillOpacity, weight: NO_DATA_STYLE.weight, dashArray: NO_DATA_STYLE.dashArray }
          : { color: classification.color, fillColor: classification.color, fillOpacity: 0.45, weight: 1 };
        const tooltip = classification.noData
          ? `${cell.id}: ${NO_DATA_STYLE.label}`
          : `${cell.id}: ${VEGETATION_MAP_MODES[mode].label.split(" / ")[0]} ${classification.label}`;
        L.polygon(cell.coordinates, style)
          .bindTooltip(tooltip)
          .on("click", (event) => {
            event.originalEvent?.stopPropagation();
            this.selectCell(cell.id, { fromMap: true });
          })
          .addTo(this.overlayLayer);
      });
    }
    this.syncOverlayVisibility();
  }

  syncOverlayVisibility() {
    const mode = this.elements.vegMapModeSelect?.value || "off";
    const visible = this.workspaceActive && mode !== "off";
    if (visible && !this.map.hasLayer(this.overlayLayer)) {
      this.overlayLayer.addTo(this.map);
    }
    if (!visible && this.map.hasLayer(this.overlayLayer)) {
      this.map.removeLayer(this.overlayLayer);
    }
  }

  renderLegend() {
    const container = this.elements.vegLegend;
    if (!container) {
      return;
    }
    container.replaceChildren();
    const mode = this.elements.vegMapModeSelect?.value || "off";
    if (mode === "off") {
      container.append(detailText("植生オーバーレイは非表示です。"));
      return;
    }
    legendForMode(mode).forEach((entry) => {
      const item = document.createElement("span");
      item.className = "paddy-legend-item";
      const swatch = document.createElement("span");
      swatch.className = "paddy-legend-swatch";
      swatch.style.background = entry.color;
      swatch.style.color = entry.color;
      item.append(swatch, document.createTextNode(entry.label));
      container.append(item);
    });
  }

  renderSummary() {
    const summary = computeVegetationSummary(this.observations, this.getGridCells(), this.settings());
    const el = this.elements;
    setText(el.vegSummaryTotal, String(summary.totalObservations));
    setText(el.vegSummaryCellsWith, String(summary.cellsWithObservations));
    setText(el.vegSummaryCellsWithout, String(summary.cellsWithoutObservations));
    setText(el.vegSummaryHighSeverity, String(summary.highSeverityCells));
    setText(el.vegSummaryIncreasing, String(summary.increasingWeedCells));
    setText(el.vegSummaryReview, String(summary.reviewRequiredObservations));
    setText(el.vegSummaryAvgWeed, Number.isFinite(summary.averageWeedCoveragePercent)
      ? `${summary.averageWeedCoveragePercent.toFixed(1)}%`
      : "—");
    setText(el.vegSummaryLatest, summary.latestObservationTimestamp || "—");
  }

  renderCellPanel() {
    const el = this.elements;
    const series = observationsForCell(this.observations, this.selectedCellId);
    const analysis = analyzeCellSeries(series, this.settings());

    el.vegCellSummary.replaceChildren();
    if (!this.selectedCellId) {
      el.vegCellSummary.append(detailText("管理グリッドのセルを選択すると、最新・前回の観測と変化を表示します。"));
    } else if (series.length === 0) {
      el.vegCellSummary.append(detailText(`${this.selectedCellId}: 観測がありません（No data）。`));
    } else {
      const grid = document.createElement("div");
      grid.className = "paddy-detail-grid";
      appendDetail(grid, "セル", this.selectedCellId);
      appendDetail(grid, "観測回数", String(analysis.count));
      appendDetail(grid, "最新観測", analysis.latest.timestamp);
      appendDetail(grid, "最新の雑草被覆", formatPercentValue(analysis.latest.weedCoveragePercent));
      appendDetail(grid, "前回の雑草被覆", analysis.previous ? formatPercentValue(analysis.previous.weedCoveragePercent) : "—");
      appendDetail(grid, "雑草の変化", Number.isFinite(analysis.weedDeltaPp) ? `${analysis.weedDeltaPp >= 0 ? "+" : "−"}${formatPp(Math.abs(analysis.weedDeltaPp))}` : "—");
      appendDetail(grid, "稲被覆の変化", Number.isFinite(analysis.cropDeltaPp) ? `${analysis.cropDeltaPp >= 0 ? "+" : "−"}${formatPp(Math.abs(analysis.cropDeltaPp))}` : "—");
      appendDetail(grid, "最終観測からの日数", Number.isFinite(analysis.daysSinceLast) ? `${Math.floor(analysis.daysSinceLast)}日` : "—");
      appendDetail(grid, "傾向", TREND_LABELS[analysis.trend]);
      appendDetail(grid, "深刻度", SEVERITY_LABELS[analysis.latest.severity]);
      appendDetail(grid, "測位品質", POSITION_QUALITY_LABELS[analysis.latest.positionQuality] || analysis.latest.positionQuality);
      appendDetail(grid, "関連付け", ASSOCIATION_LABELS[analysis.latest.associationStatus] || analysis.latest.associationStatus);
      el.vegCellSummary.append(grid);
    }

    const priority = inspectionPriority(analysis, this.settings());
    setText(el.vegPriorityScore, series.length > 0 ? `${priority.score}/100` : "—");
    el.vegPriorityReasons.replaceChildren();
    if (series.length > 0) {
      priority.reasons.forEach((reason) => {
        const item = document.createElement("li");
        item.textContent = reason;
        el.vegPriorityReasons.append(item);
      });
    }

    el.vegComparisonWarnings.replaceChildren();
    compareRecentObservations(analysis, this.settings()).forEach((message) => {
      el.vegComparisonWarnings.append(warningNode(message, "warn"));
    });

    this.renderHistoryTable(series);
    this.renderHistoryChart(series);
  }

  renderHistoryTable(series) {
    const tbody = this.elements.vegHistoryTable;
    tbody.replaceChildren();
    const direction = this.elements.vegHistorySort.value === "asc" ? "asc" : "desc";
    const rows = sortByTimestamp(series, direction);
    rows.forEach((observation) => {
      const row = document.createElement("tr");
      row.tabIndex = 0;
      row.className = observation.id === this.selectedObservationId ? "veg-history-row selected" : "veg-history-row";
      [
        observation.timestamp,
        typeShort(observation.observationType),
        formatPercentValue(observation.weedCoveragePercent),
        formatPercentValue(observation.cropCoveragePercent),
        Number.isFinite(observation.confidence) ? observation.confidence.toFixed(2) : "—",
        observation.severity,
        observation.positionSource,
        observation.imageName || "—"
      ].forEach((value) => {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      });
      const select = () => this.selectObservation(observation.id);
      row.addEventListener("click", select);
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          select();
        }
      });
      tbody.append(row);
    });
  }

  /** Minimal inline SVG time-series chart for weed coverage (no library). */
  renderHistoryChart(series) {
    const container = this.elements.vegHistoryChart;
    container.replaceChildren();
    const points = series
      .map((observation) => ({ ms: Date.parse(observation.timestamp), value: observation.weedCoveragePercent }))
      .filter((point) => Number.isFinite(point.ms) && Number.isFinite(point.value))
      .sort((a, b) => a.ms - b.ms);
    if (points.length < 2) {
      container.hidden = true;
      return;
    }
    container.hidden = false;
    const width = 280;
    const height = 72;
    const pad = 8;
    const minMs = points[0].ms;
    const maxMs = points.at(-1).ms;
    const maxValue = Math.max(20, ...points.map((point) => point.value));
    const x = (ms) => maxMs === minMs ? width / 2 : pad + (ms - minMs) / (maxMs - minMs) * (width - pad * 2);
    const y = (value) => height - pad - (value / maxValue) * (height - pad * 2);
    const svgNs = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNs, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("class", "veg-chart");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `雑草被覆率の推移（最大 ${maxValue.toFixed(0)}%）`);
    const line = document.createElementNS(svgNs, "polyline");
    line.setAttribute("points", points.map((point) => `${x(point.ms).toFixed(1)},${y(point.value).toFixed(1)}`).join(" "));
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", "#216e49");
    line.setAttribute("stroke-width", "2");
    svg.append(line);
    points.forEach((point) => {
      const dot = document.createElementNS(svgNs, "circle");
      dot.setAttribute("cx", x(point.ms).toFixed(1));
      dot.setAttribute("cy", y(point.value).toFixed(1));
      dot.setAttribute("r", "2.5");
      dot.setAttribute("fill", "#216e49");
      svg.append(dot);
    });
    const caption = document.createElement("div");
    caption.className = "veg-chart-caption";
    caption.textContent = `雑草被覆率の推移: ${points[0].value.toFixed(1)}% → ${points.at(-1).value.toFixed(1)}%（縦軸 0–${maxValue.toFixed(0)}%）`;
    container.append(svg, caption);
  }

  updateButtonStates() {
    const el = this.elements;
    const hasCell = Boolean(this.selectedCellId);
    const hasObservation = Boolean(this.selectedObservationId
      && this.observations.some((observation) => observation.id === this.selectedObservationId));
    el.vegAddButton.disabled = !hasCell || Boolean(this.formHasErrors);
    el.vegUpdateButton.disabled = !hasObservation || Boolean(this.formHasErrors);
    el.vegDeleteButton.disabled = !hasObservation;
    const review = this.observations.find((candidate) => candidate.id === el.vegReviewSelect?.value);
    el.vegConfirmAssociationButton.disabled = !review || !review.automaticGridCellId;
    el.vegOverrideAssociationButton.disabled = !review || !el.vegReviewCellSelect?.value;
  }
}

// ---------------------------------------------------------------------------
// DOM / formatting helpers
// ---------------------------------------------------------------------------

function setText(element, value) {
  if (element) {
    element.textContent = value;
  }
}

function warningNode(message, tone) {
  const node = document.createElement("div");
  node.className = tone === "error" ? "veg-message error" : "veg-message";
  node.textContent = message;
  return node;
}

function detailText(message) {
  const node = document.createElement("span");
  node.textContent = message;
  return node;
}

function appendDetail(grid, label, value) {
  const labelNode = document.createElement("span");
  labelNode.textContent = label;
  const valueNode = document.createElement("strong");
  valueNode.textContent = value;
  grid.append(labelNode, valueNode);
}

function typeShort(type) {
  return OBSERVATION_TYPES[type]?.short || type;
}

function formatPercentValue(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : "—";
}

function valueOrEmpty(value) {
  return Number.isFinite(value) ? String(value) : "";
}

function emptyToNull(value) {
  return value === "" || value === undefined ? null : value;
}

function numberOr(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function datetimeLocalValue(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function polygonCentroid(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length === 0) {
    return null;
  }
  const total = coordinates.reduce((sum, [lat, lon]) => [sum[0] + lat, sum[1] + lon], [0, 0]);
  return [total[0] / coordinates.length, total[1] / coordinates.length];
}
