// Field polygon / boundary track / water-control-point registration
// controller. The primary workflow lives in the QZ1測量 (survey) tab:
// uploading an NMEA file immediately offers to register it as a field
// polygon, an (optionally unclosed) boundary track, or a water-control-point
// survey session — the user is never required to hunt for a separate
// "create field polygon" button in 詳細解析.
//
// Persistence: every mutation is written to localStorage immediately so
// registered fields/tracks/points survive a tab switch (trivial — the
// controller instance and its Leaflet layers never unmount) and a full page
// reload (via localStorage). Mirrors the VegetationIntelligenceController /
// SatelliteAssuranceController pattern already used in this codebase: an ES
// module class with its own Leaflet layers, bound to panel elements by id,
// fed live data through constructor callbacks rather than duplicated state.
import { makeId } from "../gnss/gnss-store.js";
import {
  BOUNDARY_TRACK_STYLE,
  CLOSE_WARNING_MESSAGE,
  DEFAULT_AUTO_CLOSE_THRESHOLD_M,
  FEATURE_TYPE_LABELS,
  FIELD_POLYGON_STYLE,
  LOCAL_STORAGE_KEY,
  NEEDS_EXPORT_DATA_MESSAGE,
  NEEDS_FIELD_MESSAGE,
  OBSERVATION_STYLES,
  OBSERVATION_TYPE_LABELS,
  RAW_NMEA_SIZE_WARNING,
  SCHEMA_VERSION,
  SEVERITY_LABELS,
  SEVERITY_MARKER_RADIUS,
  UPLOAD_CLOSE_WARNING_MESSAGE,
  WATER_CONTROL_STYLES,
  WATER_CONTROL_TYPE_LABELS,
  buildBoundaryTrack,
  buildField,
  buildFieldObservation,
  buildMetadata,
  buildSurveySession,
  buildWaterControlPoint,
  computeWorkflowStatus,
  evaluateClosure,
  isObservationType,
  isWaterControlType,
  makeSurveySessionId,
  nextBoundaryTrackId,
  nextFieldDefaults,
  nextObservationName,
  normalizeObservationType,
  normalizePersistedStore,
  normalizeSeverity,
  normalizeWaterControlType,
  summarizeFixQuality,
  waterControlInternalType,
  WATER_CONTROL_EXPORT_TYPES
} from "./field-annotation-core.js";

// The nine observation-type buttons in the 現地観察メモ panel, mapped to
// the internal type key each one records.
const OBSERVATION_TYPE_BUTTON_IDS = {
  obsAddWeedButton: "weed",
  obsAddInsectButton: "insect",
  obsAddDiseaseButton: "disease",
  obsAddWaterShortageButton: "water_shortage",
  obsAddExcessWaterButton: "excess_water",
  obsAddLodgingButton: "lodging",
  obsAddSoilProblemButton: "soil_problem",
  obsAddGateProblemButton: "gate_problem",
  obsAddNoteButton: "note"
};

const ELEMENT_IDS = [
  // Upload-triggered registration dialog (primary workflow, in QZ1測量).
  "fieldRegDialog", "fieldRegSummary", "fieldRegNameInput", "fieldRegIdInput",
  "fieldRegTypePolygon", "fieldRegTypeTrack", "fieldRegTypeWater",
  "fieldRegMemoInput", "fieldRegConfirmButton", "fieldRegCancelButton", "fieldRegMessage",
  "fieldRegCloseWarning", "fieldRegCloseWarningText",
  "fieldRegForceCloseButton", "fieldRegSaveAsTrackButton", "fieldRegCancelCloseButton",
  // Registered fields/logs panel.
  "registeredFieldsContainer", "registeredListMessage", "registeredFieldsPanel",
  // 現地調査ワークフロー guide panel.
  "workflowGuidePanel", "workflowProgressLabel", "workflowNextTask", "workflowStepsContainer",
  "fileInput", "exportAnalysisButton", "waterControlPanel", "fieldObservationsPanel",
  // Water-management-point add workflow.
  "wcpTargetFieldSelect", "wcpAddGateButton", "wcpAddInletButton", "wcpAddOutletButton",
  "wcpAddSensorButton", "wcpAddPhotoButton", "wcpPositionCurrentButton", "wcpPositionMapClickButton",
  "wcpAddMessage",
  // Field-observation (現地観察メモ) add workflow.
  "obsTargetFieldSelect", ...Object.keys(OBSERVATION_TYPE_BUTTON_IDS),
  "obsPositionQz1Button", "obsPositionGpsButton", "obsPositionMapClickButton", "obsAddMessage",
  // Manual/advanced field-polygon creation (詳細解析 — kept for power users).
  "fieldSourceSelect", "fieldUseAllPointsCheckbox", "fieldRangeRow", "fieldStartPointSelect", "fieldEndPointSelect",
  "fieldAutoCloseThresholdInput", "fieldCreateButton", "fieldCreateMessage",
  "fieldCloseWarning", "fieldCloseWarningText", "fieldCloseForceCloseButton", "fieldCloseSaveAsTrackButton", "fieldCloseCancelButton",
  // Selected-feature editor (shared by fields / tracks / water points / observations).
  "selFeatureEmpty", "selFeatureForm", "selFeatureTypeRow", "selFeatureTypeSelect", "selFeatureNameInput", "selFeatureIdInput",
  "selFeatureMemoInput", "selFeatureRelatedFieldSelect", "selFeatureSaveButton", "selFeatureDeleteButton", "selFeatureMessage",
  "selFeatureObsTypeRow", "selFeatureObsTypeSelect", "selFeatureSeverityRow", "selFeatureSeveritySelect",
  // Legend / summary.
  "fieldAnnotationLegend", "fieldAnnotationSummaryFields", "fieldAnnotationSummaryTracks",
  "fieldAnnotationSummaryPoints", "fieldAnnotationSummaryObservations"
];

export class FieldAnnotationController {
  constructor(options = {}) {
    this.map = options.map;
    this.getParsedPoints = options.getParsedPoints || (() => []);
    this.getPhonePoints = options.getPhonePoints || (() => []);
    this.getSourceLabel = options.getSourceLabel || (() => null);
    this.getSmartphonePosition = options.getSmartphonePosition || (() => Promise.reject(new Error("smartphone geolocation not available")));
    this.storage = options.storage || (typeof localStorage !== "undefined" ? localStorage : null);

    this.fields = [];
    this.boundaryTracks = [];
    this.waterControlPoints = [];
    this.surveySessions = [];
    this.fieldObservations = [];
    this.workflowState = { lastExportedAt: null };

    this.selected = null; // { kind: "field" | "track" | "point" | "observation", record }
    this.pendingUploadRegistration = null; // gathered inputs awaiting a closure decision
    this.pendingManualClosure = null; // same, for the advanced/manual card
    this.pendingWaterPointType = null; // internal type key awaiting a position
    this.pendingObservationType = null; // internal observation type key awaiting a position
    this.mapClickAddActiveObservation = false;

    this.layers = { fields: L.layerGroup(), tracks: L.layerGroup(), waterPoints: L.layerGroup(), observations: L.layerGroup() };
    this.elements = {};
  }

  mount() {
    ELEMENT_IDS.forEach((id) => { this.elements[id] = document.getElementById(id); });
    if (!this.elements.fieldRegDialog && !this.elements.fieldCreateButton) {
      return;
    }
    this.hydrateFromStorage();
    this.populateStaticOptions();
    this.bindEvents();
    this.layers.fields.addTo(this.map);
    this.layers.tracks.addTo(this.map);
    this.layers.waterPoints.addTo(this.map);
    this.layers.observations.addTo(this.map);
    this.map.on("click", (event) => this.handleMapClick(event));
    this.renderAll();
  }

  populateStaticOptions() {
    const selType = this.elements.selFeatureTypeSelect;
    if (selType) {
      selType.replaceChildren();
      Object.entries(FEATURE_TYPE_LABELS).forEach(([value, label]) => selType.append(new Option(label, value)));
    }
    const obsType = this.elements.selFeatureObsTypeSelect;
    if (obsType) {
      obsType.replaceChildren();
      Object.entries(OBSERVATION_TYPE_LABELS).forEach(([value, label]) => obsType.append(new Option(label, value)));
    }
    const severity = this.elements.selFeatureSeveritySelect;
    if (severity) {
      severity.replaceChildren();
      Object.entries(SEVERITY_LABELS).forEach(([value, label]) => severity.append(new Option(label, value)));
    }
  }

  bindEvents() {
    const el = this.elements;
    // Upload-triggered registration dialog.
    el.fieldRegConfirmButton?.addEventListener("click", () => this.confirmUploadRegistration());
    el.fieldRegCancelButton?.addEventListener("click", () => this.cancelUploadRegistration());
    el.fieldRegForceCloseButton?.addEventListener("click", () => this.resolvePendingClosure(this.pendingUploadRegistration, "force-close"));
    el.fieldRegSaveAsTrackButton?.addEventListener("click", () => this.resolvePendingClosure(this.pendingUploadRegistration, "save-as-track"));
    el.fieldRegCancelCloseButton?.addEventListener("click", () => this.resolvePendingClosure(this.pendingUploadRegistration, "cancel"));

    // Water-management points.
    el.wcpTargetFieldSelect?.addEventListener("change", () => this.updateWaterPointButtonStates());
    el.wcpAddGateButton?.addEventListener("click", () => this.beginAddWaterPoint("gate"));
    el.wcpAddInletButton?.addEventListener("click", () => this.beginAddWaterPoint("inlet"));
    el.wcpAddOutletButton?.addEventListener("click", () => this.beginAddWaterPoint("outlet"));
    el.wcpAddSensorButton?.addEventListener("click", () => this.beginAddWaterPoint("sensor"));
    el.wcpAddPhotoButton?.addEventListener("click", () => this.beginAddWaterPoint("photo"));
    el.wcpPositionCurrentButton?.addEventListener("click", () => this.addWaterControlPointAtCurrentPosition());
    el.wcpPositionMapClickButton?.addEventListener("click", () => this.toggleMapClickAddMode());

    // Field observations (現地観察メモ).
    el.obsTargetFieldSelect?.addEventListener("change", () => this.updateObservationButtonStates());
    Object.entries(OBSERVATION_TYPE_BUTTON_IDS).forEach(([elementId, type]) => {
      el[elementId]?.addEventListener("click", () => this.beginAddObservation(type));
    });
    el.obsPositionQz1Button?.addEventListener("click", () => this.addObservationAtCurrentQz1Position());
    el.obsPositionGpsButton?.addEventListener("click", () => this.addObservationAtSmartphonePosition());
    el.obsPositionMapClickButton?.addEventListener("click", () => this.toggleMapClickAddObservationMode());

    // Manual/advanced field-polygon creation (詳細解析).
    el.fieldSourceSelect?.addEventListener("change", () => this.renderRangeOptions());
    el.fieldUseAllPointsCheckbox?.addEventListener("change", () => this.updateRangeVisibility());
    el.fieldCreateButton?.addEventListener("click", () => this.handleManualCreateFieldClick());
    el.fieldCloseForceCloseButton?.addEventListener("click", () => this.resolvePendingClosure(this.pendingManualClosure, "force-close"));
    el.fieldCloseSaveAsTrackButton?.addEventListener("click", () => this.resolvePendingClosure(this.pendingManualClosure, "save-as-track"));
    el.fieldCloseCancelButton?.addEventListener("click", () => this.resolvePendingClosure(this.pendingManualClosure, "cancel"));

    // Selected-feature editor.
    el.selFeatureSaveButton?.addEventListener("click", () => this.saveSelectedFeature());
    el.selFeatureDeleteButton?.addEventListener("click", () => this.deleteSelectedFeature());

    // Registered fields/logs panel (event delegation — rows are rebuilt on render).
    el.registeredFieldsContainer?.addEventListener("click", (event) => this.handleRegisteredListClick(event));

    // 現地調査ワークフロー guide (event delegation — steps are rebuilt on render).
    el.workflowStepsContainer?.addEventListener("click", (event) => this.handleWorkflowStepClick(event));
  }

  // -------------------------------------------------------------------------
  // Persistence (localStorage)
  // -------------------------------------------------------------------------

  hydrateFromStorage() {
    if (!this.storage) {
      return;
    }
    try {
      const raw = this.storage.getItem(LOCAL_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const parsed = normalizePersistedStore(JSON.parse(raw));
      this.fields = parsed.fields;
      this.boundaryTracks = parsed.boundaryTracks;
      this.waterControlPoints = this.rehydrateWaterControlPoints(parsed.waterControlPoints);
      this.surveySessions = this.rehydrateSurveySessions(parsed.surveySessions);
      this.fieldObservations = this.rehydrateFieldObservations(parsed.fieldObservations);
      this.workflowState = parsed.workflowState;
    } catch {
      // Corrupted localStorage must never crash the app — start empty.
      this.fields = [];
      this.boundaryTracks = [];
      this.waterControlPoints = [];
      this.surveySessions = [];
      this.fieldObservations = [];
      this.workflowState = { lastExportedAt: null };
    }
  }

  /**
   * Re-runs stored/imported water-control-point records through the builder
   * so both type-string forms (internal or exported) normalize consistently
   * and any missing fields get safe defaults.
   */
  rehydrateWaterControlPoints(rawPoints) {
    return (rawPoints || []).map((point) => buildWaterControlPoint({
      id: point.id,
      name: point.name,
      type: waterControlInternalType(point),
      lat: point.coordinates?.[0],
      lon: point.coordinates?.[1],
      relatedFieldId: point.relatedFieldId,
      memo: point.properties?.memo,
      sourceType: point.properties?.sourceType,
      nowIso: point.properties?.createdAt
    }));
  }

  /**
   * Re-runs stored/imported observation records through the builder so
   * missing fields get safe defaults and unknown type/severity values
   * degrade to "note"/"medium" rather than crashing the app.
   */
  rehydrateFieldObservations(rawObservations) {
    return (rawObservations || []).map((obs) => buildFieldObservation({
      id: obs.id,
      fieldId: obs.fieldId,
      type: obs.type,
      name: obs.name,
      severity: obs.properties?.severity,
      memo: obs.properties?.memo,
      lat: obs.coordinates?.[0],
      lon: obs.coordinates?.[1],
      sourceType: obs.properties?.sourceType,
      nowIso: obs.properties?.createdAt
    }));
  }

  /**
   * Re-runs stored/imported survey sessions through the builder so the
   * MAX_RAW_NMEA_STORAGE_BYTES cap is re-enforced regardless of where the
   * data came from (an oversized rawNmeaText must never round-trip back
   * into localStorage just because it was already present in an import).
   */
  rehydrateSurveySessions(rawSessions) {
    return (rawSessions || []).map((session) => buildSurveySession({
      id: session.id,
      name: session.name,
      fieldId: session.fieldId,
      sourceFileName: session.sourceFileName,
      rawPoints: session.rawPoints,
      measurementType: session.measurementType,
      rawNmeaText: session.rawNmeaText,
      uploadedAt: session.uploadedAt,
      nowIso: session.createdAt
    }));
  }

  persist() {
    if (!this.storage) {
      return;
    }
    try {
      this.storage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        fields: this.fields,
        boundaryTracks: this.boundaryTracks,
        waterControlPoints: this.waterControlPoints,
        surveySessions: this.surveySessions,
        fieldObservations: this.fieldObservations,
        workflowState: this.workflowState
      }));
    } catch {
      // Quota exceeded / private-browsing storage denial: keep working
      // in-memory rather than throwing.
    }
  }

  // -------------------------------------------------------------------------
  // NMEA-upload-triggered registration (primary workflow)
  // -------------------------------------------------------------------------

  /** Called by index.html right after a successful NMEA parse. */
  handleNmeaUploaded({ points, fileName, rawText }) {
    if (!this.elements.fieldRegDialog) {
      return;
    }
    const validPoints = (points || []).filter((point) => Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lon)));
    const defaults = nextFieldDefaults(this.fields.length);
    const el = this.elements;
    el.fieldRegNameInput.value = defaults.name;
    el.fieldRegIdInput.value = defaults.id;
    el.fieldRegTypePolygon.checked = true;
    el.fieldRegMemoInput.value = "";
    const summary = summarizeFixQuality(validPoints);
    el.fieldRegSummary.textContent = `有効な測位点: ${summary.total}点 / DGPS fix: ${summary.byFixQuality["2"] || 0} / GPS単独: ${summary.byFixQuality["1"] || 0}`;
    this.setFieldRegMessage("");
    this.hidePendingClosureUi(this.elements.fieldRegCloseWarning);
    el.fieldRegDialog.hidden = false;
    el.fieldRegDialog.dataset.fileName = fileName || "";
    el.fieldRegDialog.scrollIntoView({ block: "nearest" });
    this.pendingUploadRegistration = { rawPoints: validPoints, fileName: fileName || null, rawText: rawText || null };
  }

  selectedMeasurementType() {
    const el = this.elements;
    if (el.fieldRegTypeTrack.checked) {
      return "boundary_track";
    }
    if (el.fieldRegTypeWater.checked) {
      return "water_points";
    }
    return "field_polygon";
  }

  confirmUploadRegistration() {
    const pending = this.pendingUploadRegistration;
    if (!pending) {
      return;
    }
    const el = this.elements;
    const name = el.fieldRegNameInput.value.trim();
    const id = el.fieldRegIdInput.value.trim();
    const memo = el.fieldRegMemoInput.value;
    if (!name || !id) {
      this.setFieldRegMessage("圃場名とIDを入力してください。");
      return;
    }
    if (this.fields.some((field) => field.id === id)) {
      this.setFieldRegMessage(`ID "${id}" は既に使用されています。`);
      return;
    }
    const measurementType = this.selectedMeasurementType();
    const coordinates = pending.rawPoints.map((point) => [Number(point.lat), Number(point.lon)]);
    const context = {
      name, id, memo, measurementType,
      rawPoints: pending.rawPoints, coordinates, fileName: pending.fileName, rawNmeaText: pending.rawText,
      dialog: "upload"
    };

    if (measurementType === "boundary_track") {
      this.registerBoundaryTrack(context);
      return;
    }
    if (measurementType === "water_points") {
      this.registerWaterPointsSession(context);
      return;
    }

    const closure = evaluateClosure(coordinates, DEFAULT_AUTO_CLOSE_THRESHOLD_M);
    if (!closure.canClose) {
      this.setFieldRegMessage(closure.warnings.join(" "));
      return;
    }
    if (closure.autoClose) {
      this.registerFieldPolygon({ ...context, gapM: closure.gapM, closedManually: false });
      return;
    }
    this.pendingUploadRegistration = { ...pending, context, gapM: closure.gapM };
    el.fieldRegCloseWarningText.textContent = `${UPLOAD_CLOSE_WARNING_MESSAGE}（距離: 約${closure.gapM.toFixed(1)}m）`;
    el.fieldRegCloseWarning.hidden = false;
  }

  cancelUploadRegistration() {
    this.pendingUploadRegistration = null;
    this.hidePendingClosureUi(this.elements.fieldRegCloseWarning);
    if (this.elements.fieldRegDialog) {
      this.elements.fieldRegDialog.hidden = true;
    }
    this.setFieldRegMessage("");
  }

  /**
   * Shared by both the upload dialog and the manual/advanced card: resolves
   * the three-way choice offered when a path's start/end points are too far
   * apart to auto-close — force-close into a polygon, save as an (optionally
   * unclosed) boundary track instead, or cancel the whole registration.
   */
  resolvePendingClosure(pending, action) {
    if (!pending || !pending.context) {
      return;
    }
    const { context, gapM } = pending;
    if (action === "force-close") {
      this.registerFieldPolygon({ ...context, gapM, closedManually: true });
    } else if (action === "save-as-track") {
      this.registerBoundaryTrack(context);
    }
    // "cancel": nothing is created, just tear down whichever dialog asked.
    if (context.dialog === "upload") {
      this.cancelUploadRegistration();
    } else {
      this.cancelManualClosure();
    }
  }

  hidePendingClosureUi(element) {
    if (element) {
      element.hidden = true;
    }
  }

  // -------------------------------------------------------------------------
  // Registration outcomes (shared by upload dialog + manual card + closure resolution)
  // -------------------------------------------------------------------------

  /**
   * Appends the size-limit warning when the session's raw NMEA text was too
   * large to persist, and mirrors it into the always-visible registered-list
   * message area — the upload dialog's own message hides with the dialog
   * right after a successful registration, so that alone isn't enough.
   */
  withRawNmeaWarning(message, session) {
    if (session.rawNmeaStorageReason !== "size_limit") {
      this.setRegisteredListMessage("");
      return message;
    }
    this.setRegisteredListMessage(RAW_NMEA_SIZE_WARNING);
    return `${message} ${RAW_NMEA_SIZE_WARNING}`;
  }

  registerFieldPolygon({ name, id, memo, coordinates, rawPoints, fileName, rawNmeaText, gapM, closedManually }) {
    const sessionId = makeSurveySessionId();
    const uploadedAt = new Date().toISOString();
    const session = buildSurveySession({
      id: sessionId, name: `${name} 測量`, fieldId: id, sourceFileName: fileName,
      rawPoints, measurementType: "field_polygon", rawNmeaText, uploadedAt: rawNmeaText ? uploadedAt : null
    });
    const field = buildField({
      id, name, coordinates, memo, gapM, closedManually,
      sourcePointCount: rawPoints.length, sourceSessionId: sessionId,
      sourceFileName: fileName, fixQualitySummary: summarizeFixQuality(rawPoints)
    });
    this.surveySessions.push(session);
    this.fields.push(field);
    this.persist();
    const message = this.withRawNmeaWarning(`${field.name}（${field.id}）を圃場ポリゴンとして登録しました。`, session);
    this.setFieldRegMessage(message);
    this.setFieldCreateMessage(message);
    this.cancelUploadRegistration();
    this.cancelManualClosure();
    this.selectFeature("field", field);
    this.renderAll();
  }

  registerBoundaryTrack({ name, id, memo, coordinates, rawPoints, fileName, rawNmeaText, dialog }) {
    const sessionId = makeSurveySessionId();
    const uploadedAt = new Date().toISOString();
    const session = buildSurveySession({
      id: sessionId, name: `${name} 測量`, fieldId: id, sourceFileName: fileName,
      rawPoints, measurementType: "boundary_track", rawNmeaText, uploadedAt: rawNmeaText ? uploadedAt : null
    });
    const trackId = nextBoundaryTrackId(id, this.boundaryTracks.filter((track) => track.fieldId === id).length);
    const track = buildBoundaryTrack({
      id: trackId, name: `${name} 下見測定`, fieldId: id, coordinates, memo,
      sourceSessionId: sessionId, sourceFileName: fileName, fixQualitySummary: summarizeFixQuality(rawPoints)
    });
    this.surveySessions.push(session);
    this.boundaryTracks.push(track);
    this.persist();
    const message = this.withRawNmeaWarning(`${track.name}（${track.id}）を境界トラックとして登録しました。`, session);
    this.setFieldRegMessage(message);
    this.setFieldCreateMessage(message);
    if (dialog === "upload") {
      this.cancelUploadRegistration();
    } else {
      this.cancelManualClosure();
    }
    this.selectFeature("track", track);
    this.renderAll();
  }

  registerWaterPointsSession({ name, id, memo, rawPoints, fileName, rawNmeaText }) {
    const sessionId = makeSurveySessionId();
    const uploadedAt = new Date().toISOString();
    const session = buildSurveySession({
      id: sessionId, name: name || `${id} 測量`, fieldId: id, sourceFileName: fileName,
      rawPoints, measurementType: "water_points", rawNmeaText, uploadedAt: rawNmeaText ? uploadedAt : null
    });
    this.surveySessions.push(session);
    this.persist();
    const message = this.withRawNmeaWarning("測量ログを登録しました。「水管理ポイント」から水門・給水口・排水口を追加できます。", session);
    this.setFieldRegMessage(message);
    this.cancelUploadRegistration();
    this.renderAll();
  }

  // -------------------------------------------------------------------------
  // Manual / advanced field-polygon creation (詳細解析) — reuses the same
  // registration outcomes as the upload workflow.
  // -------------------------------------------------------------------------

  rawSourcePoints() {
    const source = this.elements.fieldSourceSelect?.value;
    return (source === "phone" ? this.getPhonePoints() : this.getParsedPoints()) || [];
  }

  renderRangeOptions() {
    const el = this.elements;
    if (!el.fieldStartPointSelect) {
      return;
    }
    const rawPoints = this.rawSourcePoints();
    [el.fieldStartPointSelect, el.fieldEndPointSelect].forEach((select) => select.replaceChildren());
    rawPoints.forEach((point, index) => {
      const time = point.timestamp ? String(point.timestamp).slice(0, 19) : `#${index + 1}`;
      const label = Number.isFinite(point.fixQuality) ? `${index + 1}: ${time} · fix ${point.fixQuality}` : `${index + 1}: ${time}`;
      el.fieldStartPointSelect.append(new Option(label, String(index)));
      el.fieldEndPointSelect.append(new Option(label, String(index)));
    });
    if (rawPoints.length > 0) {
      el.fieldEndPointSelect.value = String(rawPoints.length - 1);
    }
  }

  updateRangeVisibility() {
    if (!this.elements.fieldRangeRow) {
      return;
    }
    this.elements.fieldRangeRow.hidden = this.elements.fieldUseAllPointsCheckbox.checked;
  }

  selectedManualPoints() {
    const useAll = this.elements.fieldUseAllPointsCheckbox.checked;
    const raw = this.rawSourcePoints();
    const filterValid = (points) => points.filter((point) => Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lon)));
    if (useAll) {
      return filterValid(raw);
    }
    const startIndex = Number(this.elements.fieldStartPointSelect.value);
    const endIndex = Number(this.elements.fieldEndPointSelect.value);
    if (!Number.isFinite(startIndex) || !Number.isFinite(endIndex)) {
      return [];
    }
    const from = Math.min(startIndex, endIndex);
    const to = Math.max(startIndex, endIndex);
    return filterValid(raw.slice(from, to + 1));
  }

  handleManualCreateFieldClick() {
    const rawPoints = this.selectedManualPoints();
    const coordinates = rawPoints.map((point) => [Number(point.lat), Number(point.lon)]);
    const thresholdM = Math.max(0, Number(this.elements.fieldAutoCloseThresholdInput.value) || DEFAULT_AUTO_CLOSE_THRESHOLD_M);
    const closure = evaluateClosure(coordinates, thresholdM);
    if (!closure.canClose) {
      this.setFieldCreateMessage(closure.warnings.join(" "));
      return;
    }
    const defaults = nextFieldDefaults(this.fields.length);
    const context = {
      name: defaults.name, id: defaults.id, memo: "", coordinates, rawPoints,
      fileName: this.getSourceLabel?.() || null, measurementType: "field_polygon", dialog: "manual"
    };
    if (closure.autoClose) {
      this.registerFieldPolygon({ ...context, gapM: closure.gapM, closedManually: false });
      return;
    }
    this.pendingManualClosure = { context, gapM: closure.gapM };
    this.elements.fieldCloseWarningText.textContent = `${CLOSE_WARNING_MESSAGE}（距離: 約${closure.gapM.toFixed(1)}m）`;
    this.elements.fieldCloseWarning.hidden = false;
    this.setFieldCreateMessage("");
  }

  cancelManualClosure() {
    this.pendingManualClosure = null;
    this.hidePendingClosureUi(this.elements.fieldCloseWarning);
  }

  // -------------------------------------------------------------------------
  // Water control points
  // -------------------------------------------------------------------------

  latestQz1Position() {
    const points = this.getParsedPoints() || [];
    const last = points.at(-1);
    if (!last || !Number.isFinite(Number(last.lat)) || !Number.isFinite(Number(last.lon))) {
      return null;
    }
    return { lat: Number(last.lat), lon: Number(last.lon) };
  }

  beginAddWaterPoint(internalType) {
    if (this.fields.length === 0) {
      this.setWcpMessage("先に圃場を登録してください。");
      return;
    }
    if (!this.elements.wcpTargetFieldSelect.value) {
      this.setWcpMessage("対象の圃場を選択してください。");
      return;
    }
    this.pendingWaterPointType = internalType;
    this.setWcpMessage(`${WATER_CONTROL_TYPE_LABELS[internalType]}を追加する位置を選んでください。`);
    this.updateWaterPointButtonStates();
  }

  addWaterControlPointAtCurrentPosition() {
    if (!this.pendingWaterPointType) {
      return;
    }
    const position = this.latestQz1Position();
    if (!position) {
      this.setWcpMessage("現在のQZ1位置がありません。QZ1データを読み込むか、ライブ接続してください。");
      return;
    }
    this.createWaterControlPoint(position.lat, position.lon, "qz1_current_position");
  }

  toggleMapClickAddMode() {
    if (!this.pendingWaterPointType) {
      return;
    }
    if (this.mapClickAddActive) {
      this.mapClickAddActive = false;
      this.setWcpMessage("");
      this.render();
      return;
    }
    this.mapClickAddActive = true;
    this.setWcpMessage(`地図をクリックして${WATER_CONTROL_TYPE_LABELS[this.pendingWaterPointType]}を配置してください。`);
    this.render();
  }

  handleMapClick(event) {
    if (this.mapClickAddActive && this.pendingWaterPointType) {
      this.createWaterControlPoint(event.latlng.lat, event.latlng.lng, "manual_map_click");
      this.mapClickAddActive = false;
      return;
    }
    if (this.mapClickAddActiveObservation && this.pendingObservationType) {
      this.createFieldObservation(event.latlng.lat, event.latlng.lng, "manual_map_click");
      this.mapClickAddActiveObservation = false;
    }
  }

  createWaterControlPoint(lat, lon, sourceType) {
    const type = this.pendingWaterPointType;
    const relatedFieldId = this.elements.wcpTargetFieldSelect.value || null;
    const point = buildWaterControlPoint({ id: makeId("wcp"), type, lat, lon, relatedFieldId, sourceType });
    this.waterControlPoints.push(point);
    this.persist();
    this.pendingWaterPointType = null;
    this.mapClickAddActive = false;
    this.setWcpMessage(`${WATER_CONTROL_TYPE_LABELS[waterControlInternalType(point)]}を追加しました。`);
    this.selectFeature("point", point);
    this.renderAll();
  }

  // -------------------------------------------------------------------------
  // Field observations (現地観察メモ)
  // -------------------------------------------------------------------------

  beginAddObservation(internalType) {
    if (this.fields.length === 0) {
      this.setObsMessage("先に圃場を登録してください。");
      return;
    }
    if (!this.elements.obsTargetFieldSelect.value) {
      this.setObsMessage("対象の圃場を選択してください。");
      return;
    }
    this.pendingObservationType = internalType;
    this.setObsMessage(`${OBSERVATION_TYPE_LABELS[internalType]}を記録する位置を選んでください。`);
    this.updateObservationButtonStates();
  }

  addObservationAtCurrentQz1Position() {
    if (!this.pendingObservationType) {
      return;
    }
    const position = this.latestQz1Position();
    if (!position) {
      this.setObsMessage("現在のQZ1位置がありません。QZ1データを読み込むか、ライブ接続してください。");
      return;
    }
    this.createFieldObservation(position.lat, position.lon, "qz1_current_position");
  }

  async addObservationAtSmartphonePosition() {
    if (!this.pendingObservationType) {
      return;
    }
    try {
      const position = await this.getSmartphonePosition();
      if (!position || !Number.isFinite(Number(position.lat)) || !Number.isFinite(Number(position.lon))) {
        this.setObsMessage("スマホGPS位置を取得できません — 位置情報の許可を確認してください。");
        return;
      }
      this.createFieldObservation(Number(position.lat), Number(position.lon), "phone_gps");
    } catch {
      this.setObsMessage("スマホGPS位置を取得できません — 位置情報の許可を確認してください。");
    }
  }

  toggleMapClickAddObservationMode() {
    if (!this.pendingObservationType) {
      return;
    }
    if (this.mapClickAddActiveObservation) {
      this.mapClickAddActiveObservation = false;
      this.setObsMessage("");
      this.render();
      return;
    }
    this.mapClickAddActiveObservation = true;
    this.setObsMessage(`地図をクリックして${OBSERVATION_TYPE_LABELS[this.pendingObservationType]}の位置を指定してください。`);
    this.render();
  }

  createFieldObservation(lat, lon, sourceType) {
    const type = this.pendingObservationType;
    const fieldId = this.elements.obsTargetFieldSelect.value || null;
    const field = this.fields.find((candidate) => candidate.id === fieldId);
    const existingCount = this.fieldObservations.filter((obs) => obs.fieldId === fieldId && obs.type === type).length;
    const name = nextObservationName(field ? field.name : fieldId, type, existingCount);
    const observation = buildFieldObservation({ id: makeId("obs"), fieldId, type, name, lat, lon, sourceType });
    this.fieldObservations.push(observation);
    this.persist();
    this.pendingObservationType = null;
    this.mapClickAddActiveObservation = false;
    this.setObsMessage(`${OBSERVATION_TYPE_LABELS[normalizeObservationType(observation.type)]}を記録しました。`);
    this.selectFeature("observation", observation);
    this.renderAll();
  }

  // -------------------------------------------------------------------------
  // Selected-feature editor (fields / tracks / water points / observations)
  // -------------------------------------------------------------------------

  selectFeature(kind, record) {
    this.selected = { kind, record };
    this.setSelFeatureMessage("");
    this.renderSelectedFeature();
    this.revealSelectedEditor();
  }

  clearSelection() {
    this.selected = null;
    this.setSelFeatureMessage("");
    this.renderSelectedFeature();
  }

  revealSelectedEditor() {
    const details = this.elements.selFeatureForm?.closest("details");
    if (details) {
      details.open = true;
    }
  }

  saveSelectedFeature() {
    const selected = this.selected;
    if (!selected) {
      return;
    }
    const { kind, record } = selected;
    const el = this.elements;
    const newId = el.selFeatureIdInput.value.trim();
    if (!newId) {
      this.setSelFeatureMessage("IDを入力してください。");
      return;
    }
    const collision = this.allRecords().find((candidate) => candidate !== record && candidate.id === newId);
    if (collision) {
      this.setSelFeatureMessage(`ID "${newId}" は既に使用されています。`);
      return;
    }

    const oldId = record.id;
    record.id = newId;
    // A field's id is a foreign key for boundaryTracks.fieldId,
    // surveySessions.fieldId, waterControlPoints.relatedFieldId and
    // fieldObservations.fieldId — rename it everywhere it's referenced, or
    // those links silently go stale.
    if (kind === "field" && oldId !== newId) {
      this.boundaryTracks.forEach((track) => { if (track.fieldId === oldId) track.fieldId = newId; });
      this.surveySessions.forEach((session) => { if (session.fieldId === oldId) session.fieldId = newId; });
      this.waterControlPoints.forEach((point) => { if (point.relatedFieldId === oldId) point.relatedFieldId = newId; });
      this.fieldObservations.forEach((obs) => { if (obs.fieldId === oldId) obs.fieldId = newId; });
    }
    record.name = el.selFeatureNameInput.value;
    if (kind === "point") {
      record.properties.memo = el.selFeatureMemoInput.value;
      const nextType = el.selFeatureTypeSelect.value;
      if (isWaterControlType(nextType)) {
        record.type = WATER_CONTROL_EXPORT_TYPES[nextType];
      }
      record.relatedFieldId = el.selFeatureRelatedFieldSelect.value || null;
      record.properties.updatedAt = new Date().toISOString();
    } else if (kind === "track") {
      record.properties.memo = el.selFeatureMemoInput.value;
      record.fieldId = el.selFeatureRelatedFieldSelect.value || null;
      record.properties.updatedAt = new Date().toISOString();
    } else if (kind === "observation") {
      record.properties.memo = el.selFeatureMemoInput.value;
      const nextType = el.selFeatureObsTypeSelect.value;
      if (isObservationType(nextType)) {
        record.type = nextType;
        record.label = OBSERVATION_TYPE_LABELS[nextType];
      }
      record.properties.severity = normalizeSeverity(el.selFeatureSeveritySelect.value);
      record.fieldId = el.selFeatureRelatedFieldSelect.value || null;
      record.properties.updatedAt = new Date().toISOString();
    } else {
      record.properties.memo = el.selFeatureMemoInput.value;
      record.properties.updatedAt = new Date().toISOString();
    }
    this.persist();
    this.setSelFeatureMessage("保存しました。");
    this.renderAll();
  }

  deleteSelectedFeature() {
    const selected = this.selected;
    if (!selected) {
      return;
    }
    const { kind, record } = selected;
    if (kind === "field") {
      if (!window.confirm("この圃場と関連する測量ログを削除しますか？")) {
        return;
      }
      this.fields = this.fields.filter((candidate) => candidate !== record);
      this.boundaryTracks = this.boundaryTracks.filter((track) => track.fieldId !== record.id);
      this.surveySessions = this.surveySessions.filter((session) => session.fieldId !== record.id);
      this.waterControlPoints.forEach((point) => {
        if (point.relatedFieldId === record.id) {
          point.relatedFieldId = null;
        }
      });
      this.fieldObservations.forEach((obs) => {
        if (obs.fieldId === record.id) {
          obs.fieldId = null;
        }
      });
    } else if (kind === "track") {
      if (!window.confirm(`${record.name || record.id} を削除しますか？`)) {
        return;
      }
      this.boundaryTracks = this.boundaryTracks.filter((candidate) => candidate !== record);
      if (record.sourceSessionId) {
        const stillReferenced = this.fields.some((field) => field.sourceSessionId === record.sourceSessionId)
          || this.boundaryTracks.some((track) => track.sourceSessionId === record.sourceSessionId);
        if (!stillReferenced) {
          this.surveySessions = this.surveySessions.filter((session) => session.id !== record.sourceSessionId);
        }
      }
    } else if (kind === "observation") {
      if (!window.confirm(`${record.name || record.id} を削除しますか？`)) {
        return;
      }
      this.fieldObservations = this.fieldObservations.filter((candidate) => candidate !== record);
    } else {
      if (!window.confirm(`${record.name || record.id} を削除しますか？`)) {
        return;
      }
      this.waterControlPoints = this.waterControlPoints.filter((candidate) => candidate !== record);
    }
    this.persist();
    this.clearSelection();
    this.renderAll();
  }

  allRecords() {
    return [...this.fields, ...this.boundaryTracks, ...this.waterControlPoints, ...this.fieldObservations];
  }

  // -------------------------------------------------------------------------
  // Registered fields/logs panel
  // -------------------------------------------------------------------------

  handleRegisteredListClick(event) {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }
    const { action, kind, id } = button.dataset;
    const record = kind === "field"
      ? this.fields.find((field) => field.id === id)
      : this.boundaryTracks.find((track) => track.id === id);
    if (!record) {
      return;
    }
    if (action === "view") {
      this.focusRecordOnMap(kind, record);
    } else if (action === "edit") {
      this.selectFeature(kind, record);
    } else if (action === "delete") {
      this.selected = { kind, record };
      this.deleteSelectedFeature();
    } else if (action === "export") {
      this.exportScoped(kind, record);
    } else if (action === "export-nmea") {
      this.exportRawNmea(record);
    }
  }

  focusRecordOnMap(kind, record) {
    this.selectFeature(kind, record);
    if (Array.isArray(record.coordinates) && record.coordinates.length > 0) {
      const bounds = kind === "point" ? L.latLngBounds([record.coordinates, record.coordinates]) : L.latLngBounds(record.coordinates);
      this.map.fitBounds(bounds, { padding: [40, 40], maxZoom: 19 });
    }
  }

  exportScoped(kind, record) {
    const fieldId = kind === "field" ? record.id : record.fieldId;
    const fields = this.fields.filter((field) => field.id === fieldId);
    const boundaryTracks = this.boundaryTracks.filter((track) => track.fieldId === fieldId);
    const waterControlPoints = this.waterControlPoints.filter((point) => point.relatedFieldId === fieldId);
    const fieldObservations = this.fieldObservations.filter((obs) => obs.fieldId === fieldId);
    const sessionIds = new Set([...fields, ...boundaryTracks].map((item) => item.sourceSessionId).filter(Boolean));
    const surveySessions = this.surveySessions.filter((session) => sessionIds.has(session.id));
    const measurements = surveySessions.flatMap((session) => session.rawPoints);
    const payload = {
      fields, boundaryTracks, waterControlPoints, fieldObservations, surveySessions, measurements,
      metadata: { exportedAt: new Date().toISOString(), appName: "スイスイナビ", dataMode: "real_user_data" }
    };
    downloadJson(payload, `${record.name || record.id}-export.json`);
  }

  linkedSurveySession(record) {
    return this.surveySessions.find((session) => session.id === record.sourceSessionId) || null;
  }

  exportRawNmea(record) {
    const session = this.linkedSurveySession(record);
    if (!session?.rawNmeaStored || !session.rawNmeaText) {
      return;
    }
    downloadText(session.rawNmeaText, session.sourceFileName || `${record.name || record.id}.nmea.txt`);
  }

  // -------------------------------------------------------------------------
  // 現地調査ワークフロー guide panel (QZ1測量 progress checklist)
  // -------------------------------------------------------------------------

  renderWorkflowPanel() {
    const el = this.elements;
    if (!el.workflowStepsContainer) {
      return;
    }
    const status = this.computeWorkflowSnapshot();
    setText(el.workflowProgressLabel, status.progressLabel);
    setText(el.workflowNextTask, status.nextTaskLine);

    const hasField = this.fields.length > 0;
    const hasExportableData = hasField || this.boundaryTracks.length > 0 || this.surveySessions.length > 0;
    const disabledMessageByStep = { 3: hasField ? null : NEEDS_FIELD_MESSAGE, 4: hasField ? null : NEEDS_FIELD_MESSAGE, 5: hasExportableData ? null : NEEDS_EXPORT_DATA_MESSAGE };

    el.workflowStepsContainer.replaceChildren();
    status.steps.forEach((step) => {
      el.workflowStepsContainer.append(this.buildWorkflowStepCard(step, status.nextStepId, disabledMessageByStep[step.id]));
    });
  }

  buildWorkflowStepCard(step, nextStepId, disabledMessage) {
    const card = document.createElement("div");
    card.className = "workflow-step";
    card.classList.toggle("done", step.done);
    card.classList.toggle("current", !step.done && step.id === nextStepId);
    card.classList.toggle("locked", Boolean(disabledMessage));

    const icon = document.createElement("span");
    icon.className = "workflow-step-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = step.done ? "✅" : "⬜";

    const body = document.createElement("div");
    body.className = "workflow-step-body";
    const title = document.createElement("p");
    title.className = "workflow-step-title";
    title.textContent = `${step.id}. ${step.title}`;
    const description = document.createElement("p");
    description.className = "workflow-step-description";
    description.textContent = step.description;
    body.append(title, description);

    if (disabledMessage) {
      const note = document.createElement("p");
      note.className = "workflow-step-note";
      note.textContent = disabledMessage;
      body.append(note);
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "panel-button";
    button.textContent = step.actionLabel;
    button.dataset.workflowStep = String(step.id);
    button.disabled = Boolean(disabledMessage);
    body.append(button);

    card.append(icon, body);
    return card;
  }

  handleWorkflowStepClick(event) {
    const button = event.target.closest("button[data-workflow-step]");
    if (!button || button.disabled) {
      return;
    }
    const el = this.elements;
    switch (button.dataset.workflowStep) {
      case "1":
        el.fileInput?.scrollIntoView({ block: "center" });
        el.fileInput?.focus();
        break;
      case "2":
        el.registeredFieldsPanel?.scrollIntoView({ block: "start" });
        break;
      case "3":
        if (el.waterControlPanel) {
          el.waterControlPanel.open = true;
          el.waterControlPanel.scrollIntoView({ block: "start" });
        }
        break;
      case "4":
        if (el.fieldObservationsPanel) {
          el.fieldObservationsPanel.open = true;
          el.fieldObservationsPanel.scrollIntoView({ block: "start" });
        }
        break;
      case "5":
        el.exportAnalysisButton?.click();
        break;
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  renderAll() {
    this.renderRangeOptions();
    this.updateRangeVisibility();
    this.renderMapLayers();
    this.renderLegend();
    this.renderSummary();
    this.renderRegisteredList();
    this.renderFieldTargetOptions(this.elements.wcpTargetFieldSelect);
    this.updateWaterPointButtonStates();
    this.renderFieldTargetOptions(this.elements.obsTargetFieldSelect);
    this.updateObservationButtonStates();
    this.renderSelectedFeature();
    this.renderWorkflowPanel();
  }

  renderMapLayers() {
    this.layers.fields.clearLayers();
    this.layers.tracks.clearLayers();
    this.layers.waterPoints.clearLayers();
    this.layers.observations.clearLayers();

    this.fields.forEach((field) => {
      L.polygon(field.coordinates, FIELD_POLYGON_STYLE)
        .bindTooltip(field.name || field.id, { permanent: true, direction: "center", className: "field-annotation-label" })
        .on("click", (event) => {
          event.originalEvent?.stopPropagation();
          this.selectFeature("field", field);
        })
        .addTo(this.layers.fields);
    });

    this.boundaryTracks.forEach((track) => {
      L.polyline(track.coordinates, BOUNDARY_TRACK_STYLE)
        .bindTooltip(track.name || track.id, { permanent: true, className: "field-annotation-track-label" })
        .on("click", (event) => {
          event.originalEvent?.stopPropagation();
          this.selectFeature("track", track);
        })
        .addTo(this.layers.tracks);
    });

    this.waterControlPoints.forEach((point) => {
      const internalType = waterControlInternalType(point);
      const style = WATER_CONTROL_STYLES[internalType] || WATER_CONTROL_STYLES.gate;
      L.circleMarker(point.coordinates, {
        radius: 8, color: "#ffffff", weight: 2, fillColor: style.fillColor, fillOpacity: 0.95
      })
        .bindTooltip(point.name || WATER_CONTROL_TYPE_LABELS[internalType] || internalType)
        .on("click", (event) => {
          event.originalEvent?.stopPropagation();
          this.selectFeature("point", point);
        })
        .addTo(this.layers.waterPoints);
    });

    this.fieldObservations.forEach((obs) => {
      const internalType = normalizeObservationType(obs.type);
      const style = OBSERVATION_STYLES[internalType] || OBSERVATION_STYLES.note;
      const radius = SEVERITY_MARKER_RADIUS[normalizeSeverity(obs.properties?.severity)] || SEVERITY_MARKER_RADIUS.medium;
      L.circleMarker(obs.coordinates, {
        radius, color: "#ffffff", weight: 2, fillColor: style.fillColor, fillOpacity: 0.95
      })
        .bindPopup(this.buildObservationPopup(obs))
        .on("click", (event) => {
          event.originalEvent?.stopPropagation();
          this.selectFeature("observation", obs);
        })
        .addTo(this.layers.observations);
    });
  }

  /** Leaflet popup content for a field-observation marker: read-only summary + 編集/削除 actions. */
  buildObservationPopup(obs) {
    const container = document.createElement("div");
    container.className = "obs-popup";
    const field = this.fields.find((candidate) => candidate.id === obs.fieldId);
    const rows = [
      ["タイプ", OBSERVATION_TYPE_LABELS[normalizeObservationType(obs.type)]],
      ["圃場", field ? field.name : (obs.fieldId || "—")],
      ["重要度", SEVERITY_LABELS[normalizeSeverity(obs.properties?.severity)]],
      ["メモ", obs.properties?.memo || "—"],
      ["作成日時", formatDateTime(obs.properties?.createdAt)]
    ];
    rows.forEach(([label, value]) => {
      const row = document.createElement("div");
      row.className = "obs-popup-row";
      const strong = document.createElement("strong");
      strong.textContent = `${label}: `;
      row.append(strong, document.createTextNode(value));
      container.append(row);
    });

    const actions = document.createElement("div");
    actions.className = "obs-popup-actions";
    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "panel-button";
    editButton.textContent = "編集";
    editButton.addEventListener("click", () => {
      this.selectFeature("observation", obs);
      this.map.closePopup();
    });
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "panel-button danger";
    deleteButton.textContent = "削除";
    deleteButton.addEventListener("click", () => {
      if (!window.confirm(`${obs.name || obs.id} を削除しますか？`)) {
        return;
      }
      this.map.closePopup();
      this.fieldObservations = this.fieldObservations.filter((candidate) => candidate !== obs);
      this.persist();
      if (this.selected?.record === obs) {
        this.clearSelection();
      }
      this.renderAll();
    });
    actions.append(editButton, deleteButton);
    container.append(actions);
    return container;
  }

  renderLegend() {
    const container = this.elements.fieldAnnotationLegend;
    if (!container) {
      return;
    }
    container.replaceChildren();
    const entries = [
      { label: FEATURE_TYPE_LABELS.field, color: FIELD_POLYGON_STYLE.fillColor },
      { label: "境界トラック", color: BOUNDARY_TRACK_STYLE.color },
      ...Object.entries(WATER_CONTROL_STYLES).map(([type, style]) => ({ label: WATER_CONTROL_TYPE_LABELS[type], color: style.fillColor })),
      ...Object.entries(OBSERVATION_STYLES).map(([type, style]) => ({ label: OBSERVATION_TYPE_LABELS[type], color: style.fillColor }))
    ];
    entries.forEach((entry) => {
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
    setText(this.elements.fieldAnnotationSummaryFields, String(this.fields.length));
    setText(this.elements.fieldAnnotationSummaryTracks, String(this.boundaryTracks.length));
    setText(this.elements.fieldAnnotationSummaryPoints, String(this.waterControlPoints.length));
    setText(this.elements.fieldAnnotationSummaryObservations, String(this.fieldObservations.length));
  }

  renderRegisteredList() {
    const container = this.elements.registeredFieldsContainer;
    if (!container) {
      return;
    }
    container.replaceChildren();
    const records = [
      ...this.fields.map((field) => ({ kind: "field", record: field })),
      ...this.boundaryTracks.map((track) => ({ kind: "track", record: track }))
    ];
    if (records.length === 0) {
      const empty = document.createElement("p");
      empty.className = "meta";
      empty.textContent = "まだ圃場データがありません。NMEAログをアップロードするか、地図上で圃場を登録してください。";
      container.append(empty);
      return;
    }
    records.forEach(({ kind, record }) => container.append(this.buildRegisteredCard(kind, record)));
  }

  buildRegisteredCard(kind, record) {
    const card = document.createElement("div");
    card.className = "rec-recovery-card";

    const session = this.linkedSurveySession(record);
    const grid = document.createElement("div");
    grid.className = "paddy-detail-grid";
    appendDetailRow(grid, "圃場名 / ID", `${record.name || "—"} / ${record.id}`);
    appendDetailRow(grid, "測量ファイル", record.properties?.sourceFileName || "—");
    appendDetailRow(grid, "測量タイプ", kind === "field" ? "圃場ポリゴン" : "境界トラック");
    const summary = record.properties?.fixQualitySummary;
    appendDetailRow(grid, "総ポイント", summary ? String(summary.total) : "—");
    appendDetailRow(grid, "DGPS fix", summary ? String(summary.byFixQuality?.["2"] || 0) : "—");
    appendDetailRow(grid, "GPS単独", summary ? String(summary.byFixQuality?.["1"] || 0) : "—");
    appendDetailRow(grid, "作成日時", formatDateTime(record.properties?.createdAt));
    appendDetailRow(grid, "元NMEA", rawNmeaStatusLabel(session));
    appendDetailRow(grid, "行数", session ? String(session.rawNmeaLineCount || 0) : "—");
    card.append(grid);

    const actions = document.createElement("div");
    actions.className = "rec-recovery-actions";
    const actionDefs = [
      ["view", "表示"],
      ["edit", "編集"],
      ["delete", "削除"],
      ["export", "JSON書き出し"]
    ];
    if (session?.rawNmeaStored) {
      actionDefs.push(["export-nmea", "元NMEAを書き出し"]);
    }
    actionDefs.forEach(([action, label]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = action === "delete" ? "panel-button danger" : "panel-button";
      button.textContent = label;
      button.dataset.action = action;
      button.dataset.kind = kind;
      button.dataset.id = record.id;
      actions.append(button);
    });
    card.append(actions);
    return card;
  }

  /** Shared by the water-control-point and observation "対象圃場" selects. */
  renderFieldTargetOptions(select) {
    if (!select) {
      return;
    }
    const previous = select.value;
    select.replaceChildren(new Option("圃場を選択", ""));
    this.fields.forEach((field) => select.append(new Option(`${field.name}（${field.id}）`, field.id)));
    if (this.fields.some((field) => field.id === previous)) {
      select.value = previous;
    }
  }

  updateWaterPointButtonStates() {
    const el = this.elements;
    if (!el.wcpAddGateButton) {
      return;
    }
    const hasFields = this.fields.length > 0;
    const hasTarget = Boolean(el.wcpTargetFieldSelect?.value);
    const canBegin = hasFields && hasTarget;
    [el.wcpAddGateButton, el.wcpAddInletButton, el.wcpAddOutletButton, el.wcpAddSensorButton, el.wcpAddPhotoButton]
      .forEach((button) => { if (button) button.disabled = !canBegin; });
    const canPosition = Boolean(this.pendingWaterPointType);
    if (el.wcpPositionCurrentButton) el.wcpPositionCurrentButton.disabled = !canPosition;
    if (el.wcpPositionMapClickButton) {
      el.wcpPositionMapClickButton.disabled = !canPosition;
      el.wcpPositionMapClickButton.classList.toggle("active", Boolean(this.mapClickAddActive));
    }
  }

  updateObservationButtonStates() {
    const el = this.elements;
    if (!el.obsAddWeedButton) {
      return;
    }
    const hasFields = this.fields.length > 0;
    const hasTarget = Boolean(el.obsTargetFieldSelect?.value);
    const canBegin = hasFields && hasTarget;
    Object.keys(OBSERVATION_TYPE_BUTTON_IDS).forEach((elementId) => {
      if (el[elementId]) el[elementId].disabled = !canBegin;
    });
    const canPosition = Boolean(this.pendingObservationType);
    if (el.obsPositionQz1Button) el.obsPositionQz1Button.disabled = !canPosition;
    if (el.obsPositionGpsButton) el.obsPositionGpsButton.disabled = !canPosition;
    if (el.obsPositionMapClickButton) {
      el.obsPositionMapClickButton.disabled = !canPosition;
      el.obsPositionMapClickButton.classList.toggle("active", Boolean(this.mapClickAddActiveObservation));
    }
  }

  renderSelectedFeature() {
    const el = this.elements;
    if (!el.selFeatureForm) {
      return;
    }
    const selected = this.selected;
    if (!selected) {
      el.selFeatureEmpty.hidden = false;
      el.selFeatureForm.hidden = true;
      return;
    }
    const { kind, record } = selected;
    el.selFeatureEmpty.hidden = true;
    el.selFeatureForm.hidden = false;

    el.selFeatureNameInput.value = record.name || "";
    el.selFeatureIdInput.value = record.id || "";
    el.selFeatureMemoInput.value = record.properties?.memo || "";

    // The generic 種類 select only lists field/water-control types; an
    // observation uses its own type + severity selects instead.
    if (el.selFeatureTypeRow) el.selFeatureTypeRow.hidden = kind === "observation";
    if (el.selFeatureObsTypeRow) el.selFeatureObsTypeRow.hidden = kind !== "observation";
    if (el.selFeatureSeverityRow) el.selFeatureSeverityRow.hidden = kind !== "observation";

    if (kind === "point") {
      el.selFeatureTypeSelect.disabled = false;
      el.selFeatureTypeSelect.value = waterControlInternalType(record);
      el.selFeatureRelatedFieldSelect.disabled = false;
      this.populateRelatedFieldOptions(null);
      el.selFeatureRelatedFieldSelect.value = record.relatedFieldId || "";
    } else if (kind === "track") {
      el.selFeatureTypeSelect.disabled = true;
      el.selFeatureTypeSelect.value = "field";
      el.selFeatureRelatedFieldSelect.disabled = false;
      this.populateRelatedFieldOptions(null);
      el.selFeatureRelatedFieldSelect.value = record.fieldId || "";
    } else if (kind === "observation") {
      el.selFeatureObsTypeSelect.value = normalizeObservationType(record.type);
      el.selFeatureSeveritySelect.value = normalizeSeverity(record.properties?.severity);
      el.selFeatureRelatedFieldSelect.disabled = false;
      this.populateRelatedFieldOptions(null);
      el.selFeatureRelatedFieldSelect.value = record.fieldId || "";
    } else {
      el.selFeatureTypeSelect.disabled = true;
      el.selFeatureTypeSelect.value = "field";
      el.selFeatureRelatedFieldSelect.disabled = true;
      this.populateRelatedFieldOptions(record);
    }
  }

  populateRelatedFieldOptions(excludeField) {
    const select = this.elements.selFeatureRelatedFieldSelect;
    select.replaceChildren(new Option("なし", ""));
    this.fields.forEach((field) => {
      if (field === excludeField) {
        return;
      }
      select.append(new Option(`${field.name}（${field.id}）`, field.id));
    });
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  setFieldRegMessage(message) {
    if (this.elements.fieldRegMessage) {
      this.elements.fieldRegMessage.textContent = message;
    }
  }

  setFieldCreateMessage(message) {
    if (this.elements.fieldCreateMessage) {
      this.elements.fieldCreateMessage.textContent = message;
    }
  }

  /**
   * Unlike fieldRegMessage (inside the upload dialog, which hides itself
   * right after a successful registration), this sits next to the always-
   * visible 登録済み圃場・測量ログ list, so the raw-NMEA size warning is
   * still visible to the user after the dialog closes.
   */
  setRegisteredListMessage(message) {
    if (this.elements.registeredListMessage) {
      this.elements.registeredListMessage.textContent = message;
    }
  }

  setWcpMessage(message) {
    if (this.elements.wcpAddMessage) {
      this.elements.wcpAddMessage.textContent = message;
    }
  }

  setObsMessage(message) {
    if (this.elements.obsAddMessage) {
      this.elements.obsAddMessage.textContent = message;
    }
  }

  setSelFeatureMessage(message) {
    if (this.elements.selFeatureMessage) {
      this.elements.selFeatureMessage.textContent = message;
    }
  }

  render() {
    this.updateWaterPointButtonStates();
    this.updateObservationButtonStates();
  }

  // -------------------------------------------------------------------------
  // Export / import (paddy-intelligence.js optional hooks)
  // -------------------------------------------------------------------------

  /** Shared by getExportData() and the 現地調査ワークフロー panel so both read the same live counts. */
  computeWorkflowSnapshot() {
    const measurements = this.getParsedPoints() || [];
    return computeWorkflowStatus({
      surveySessionCount: this.surveySessions.length,
      measurementCount: measurements.length,
      fieldCount: this.fields.length,
      boundaryTrackCount: this.boundaryTracks.length,
      waterControlPointCount: this.waterControlPoints.length,
      fieldObservationCount: this.fieldObservations.length,
      lastExportedAt: this.workflowState.lastExportedAt
    });
  }

  getExportData() {
    const measurements = this.getParsedPoints() || [];
    // Calling getExportData() *is* the export action (paddy-intelligence.js
    // calls this the instant the user clicks a JSON-export button), so this
    // is the correct place to mark 現地調査ワークフロー's step 5 done.
    const exportedAt = new Date().toISOString();
    this.workflowState.lastExportedAt = exportedAt;
    this.persist();
    const status = this.computeWorkflowSnapshot();
    this.renderWorkflowPanel();
    return {
      fields: this.fields,
      boundaryTracks: this.boundaryTracks,
      waterControlPoints: this.waterControlPoints,
      fieldObservations: this.fieldObservations,
      surveySessions: this.surveySessions,
      measurements,
      metadata: {
        ...buildMetadata({ sourceFileName: this.getSourceLabel?.() || null, points: measurements }),
        exportedAt,
        appName: "スイスイナビ",
        dataMode: "real_user_data",
        workflowCompletedSteps: status.completedCount,
        workflowLastExportedAt: exportedAt
      }
    };
  }

  applyImportedProject(data) {
    const normalized = normalizePersistedStore(data);
    this.fields = normalized.fields;
    this.boundaryTracks = normalized.boundaryTracks;
    this.waterControlPoints = this.rehydrateWaterControlPoints(normalized.waterControlPoints);
    this.surveySessions = this.rehydrateSurveySessions(normalized.surveySessions);
    this.fieldObservations = this.rehydrateFieldObservations(normalized.fieldObservations);
    this.workflowState = normalized.workflowState;
    this.persist();
    this.clearSelection();
    this.renderAll();
  }
}

function setText(element, value) {
  if (element) {
    element.textContent = value;
  }
}

function appendDetailRow(grid, label, value) {
  const labelNode = document.createElement("span");
  labelNode.textContent = label;
  const valueNode = document.createElement("strong");
  valueNode.textContent = value;
  grid.append(labelNode, valueNode);
}

function formatDateTime(iso) {
  if (!iso) {
    return "—";
  }
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString("ja-JP") : iso;
}

/** "—" covers both "no linked survey session" and "session exists but never had raw NMEA text at all" (e.g. manual-panel range selection). */
function rawNmeaStatusLabel(session) {
  if (!session) {
    return "—";
  }
  if (session.rawNmeaStored) {
    return "保存済み";
  }
  return session.rawNmeaStorageReason === "size_limit" ? "未保存（サイズ超過）" : "—";
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function downloadText(text, filename) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
