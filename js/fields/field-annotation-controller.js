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
  FIELD_POLYGON_SELECTED_STYLE,
  LOCAL_STORAGE_KEY,
  NEEDS_EXPORT_DATA_MESSAGE,
  NEEDS_FIELD_MESSAGE,
  OBSERVATION_STYLES,
  OBSERVATION_TYPE_LABELS,
  OUTSIDE_FIELD_WARNING_MESSAGE,
  RAW_NMEA_SIZE_WARNING,
  SCHEMA_VERSION,
  SEVERITY_LABELS,
  SEVERITY_MARKER_RADIUS,
  UPLOAD_CLOSE_WARNING_MESSAGE,
  WATER_CONTROL_STYLES,
  WATER_CONTROL_TYPE_LABELS,
  basicClosureWarningText,
  buildBoundaryTrack,
  buildField,
  buildFieldObservation,
  buildMetadata,
  buildSurveySession,
  buildWaterControlPoint,
  computeWorkflowStatus,
  evaluateClosure,
  isObservationType,
  isPointInsideBoundary,
  isWaterControlType,
  makeSurveySessionId,
  nextAvailableFieldDefaults,
  nextBoundaryTrackId,
  nextFieldDefaults,
  nextObservationName,
  nextWaterControlName,
  normalizeObservationType,
  normalizePersistedStore,
  normalizeSeverity,
  normalizeWaterControlType,
  observationSourceLabel,
  polygonAreaSquareMeters,
  straightenBoundary,
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

// Field polygons and analysis boundaries are SVG overlays. They may be
// refreshed after a point is added, which otherwise puts their fill above the
// point and steals its click. Keep actionable point markers in a dedicated
// pane above every overlay, but beneath Leaflet's popup pane.
const FIELD_ANNOTATION_POINT_PANE = "fieldAnnotationPoints";

const ELEMENT_IDS = [
  // Upload-triggered registration dialog (primary workflow, in QZ1測量).
  "fieldRegDialog", "fieldRegSummary", "fieldRegNameInput", "fieldRegIdInput",
  "fieldRegTypePolygon", "fieldRegTypeTrack", "fieldRegTypeWater",
  "fieldRegMemoInput", "fieldRegConfirmButton", "fieldRegCancelButton", "fieldRegMessage",
  "fieldRegCloseWarning", "fieldRegCloseWarningText",
  "fieldRegForceCloseButton", "fieldRegSaveAsTrackButton", "fieldRegCancelCloseButton",
  // Registered fields/logs panel.
  "registeredFieldsContainer", "registeredListMessage", "registeredFieldsPanel",
  // 境界を直線化 (straighten a noisy walked boundary into best-fit straight
  // edges between farmer-picked corner points).
  "boundaryStraightenBar", "boundaryStraightenStatus", "boundaryStraightenConfirmButton",
  "boundaryStraightenResetButton", "boundaryStraightenCancelButton",
  // 現地調査ワークフロー guide panel.
  "workflowGuidePanel", "workflowProgressLabel", "workflowNextTask", "workflowStepsContainer",
  "typedSurveyUploadInput", "exportAnalysisButton", "waterControlPanel", "fieldObservationsPanel",
  // Water-management-point add workflow. The visible panel (and its type/
  // position buttons) was removed in favor of the on-map quick-toolbar
  // below; wcpTargetFieldSelect/wcpAddMessage remain as shared state/
  // feedback the surviving toolbar depends on -- see the comment on
  // #waterControlPanel in index.html.
  "wcpTargetFieldSelect", "wcpAddMessage",
  // Floating map quick-toolbar for water-management points (QZ1測量, fullscreen-friendly).
  "waterQuickToolbar", "waterQuickActiveField", "waterQuickFieldRow", "waterQuickFieldSelect",
  "waterQuickNoFieldMessage", "waterQuickStatus", "waterQuickCancelButton",
  // Field-observation (現地観察メモ) add workflow.
  "obsTargetFieldSelect", ...Object.keys(OBSERVATION_TYPE_BUTTON_IDS),
  "obsPositionQz1Button", "obsPositionGpsButton", "obsPositionMapClickButton", "obsAddMessage",
  "obsOutsideFieldWarning", "obsOutsideFieldWarningText", "obsOutsideFieldContinueButton", "obsOutsideFieldCancelButton",
  // Manual/advanced field-polygon creation (詳細解析 — kept for power users).
  "fieldSourceSelect", "fieldUseAllPointsCheckbox", "fieldRangeRow", "fieldStartPointSelect", "fieldEndPointSelect",
  "fieldAutoCloseThresholdInput", "fieldCreateButton", "fieldCreateMessage",
  "fieldCloseWarning", "fieldCloseWarningText", "fieldCloseForceCloseButton", "fieldCloseSaveAsTrackButton", "fieldCloseCancelButton",
  // Selected-feature editor (shared by fields / tracks / water points / observations).
  "selFeatureEmpty", "selFeatureForm", "selFeatureTypeRow", "selFeatureTypeSelect", "selFeatureNameInput", "selFeatureIdInput",
  "selFeatureMemoInput", "selFeatureRelatedFieldSelect", "selFeatureSaveButton", "selFeatureStraightenButton", "selFeatureDeleteButton", "selFeatureMessage",
  "selFeatureImageRow", "selFeatureImageInput", "selFeatureImagePreview", "selFeatureImageRemoveButton",
  "selFeatureObsTypeRow", "selFeatureObsTypeSelect", "selFeatureSeverityRow", "selFeatureSeveritySelect",
  // Legend / summary.
  "fieldAnnotationLegend", "fieldAnnotationSummaryFields", "fieldAnnotationSummaryTracks",
  "fieldAnnotationSummaryPoints", "fieldAnnotationSummaryObservations",
  // Basic-mode single "current field" control (index.html mode shell) — reuses
  // this same populate function, never a second one.
  "basicActiveFieldSelect",
  // Drone mode's own copy of the same "current field" picker, shown inline in
  // #droneModeGateCard so a field can be chosen without leaving 基本モード's
  // dropdown or hunting for the right polygon on the map.
  "droneActiveFieldSelect",
  // Stage-1 (Basic mode) field-only registration dialog. Deliberately has no
  // measurement-type choice and no 境界トラック escape hatch — both remain
  // available on the Settings dialog above. #basicUploadStep is the upload/
  // trim step it shares one #basicStage1Card with — the two are mutually
  // exclusive, see beginBasicFieldRegistration() and its counterparts below.
  "basicUploadStep",
  "basicFieldRegDialog", "basicFieldRegSummary", "basicFieldRegNameInput", "basicFieldRegIdInput",
  "basicFieldRegMemoInput", "basicFieldRegConfirmButton", "basicFieldRegCancelButton", "basicFieldRegMessage",
  "basicFieldRegCloseWarning", "basicFieldRegCloseWarningText",
  "basicFieldRegForceCloseButton", "basicFieldRegReselectButton"
];

export class FieldAnnotationController {
  constructor(options = {}) {
    this.map = options.map;
    this.getParsedPoints = options.getParsedPoints || (() => []);
    this.getPhonePoints = options.getPhonePoints || (() => []);
    this.getSourceLabel = options.getSourceLabel || (() => null);
    this.getSmartphonePosition = options.getSmartphonePosition || (() => Promise.reject(new Error("smartphone geolocation not available")));
    this.storage = options.storage || (typeof localStorage !== "undefined" ? localStorage : null);
    // Lets index.html cancel other modules' own live map-click modes (e.g.
    // paddy-intelligence.js's drone-mission/annotation drawing) whenever
    // observation placement mode starts — see requirement that observation
    // placement must not conflict with unrelated map-click modes elsewhere.
    this.onEnterPlacementMode = options.onEnterPlacementMode || (() => {});
    // Basic-mode field summary (index.html mode shell) has no render loop of
    // its own -- it reads this.fields/basicActiveFieldSelect after every
    // renderAll(), the same point every other target-field select refreshes.
    this.onFieldsChanged = options.onFieldsChanged || (() => {});
    // Fires once per successful 圃場ポリゴン registration. The raw uploaded
    // QZ1/NMEA measurement points have done their job at that moment -- the
    // polygon now carries the boundary -- and leaving them drawn buries the
    // new field under its own source track. index.html uses this to switch
    // 選択中データの測位点を表示 off; the farmer can bring the points back
    // per field with the registered-list card's GNSS点を表示 button.
    this.onFieldRegistered = options.onFieldRegistered || (() => {});
    // Fires synchronously at the end of every renderQuickToolbar() call, so
    // index.html can re-measure #waterQuickToolbar's height and update the
    // left rail's clip boundary (--basic-quick-toolbar-live-height) in the
    // SAME tick the toolbar's own height might have changed -- e.g. arming
    // placement mode reveals a status line + キャンセル, growing the toolbar.
    // A ResizeObserver alone is not enough here: it is asynchronous (fires
    // on a later frame), so relying on it alone leaves a real, observed
    // window where the rail hasn't shortened yet and can overlap the
    // now-taller toolbar. This hook closes that window; the ResizeObserver
    // remains as a backup for height changes from other causes (viewport
    // resize, font-load reflow).
    this.onWaterQuickToolbarRendered = options.onWaterQuickToolbarRendered || (() => {});
    // Stage-1 only: index.html owns the START/END markers on the map, so it
    // asks to be told when the farmer chooses 選び直す from the closure
    // warning (or cancels) and the selection UI has to come back.
    this.onBasicReselect = options.onBasicReselect || (() => {});
    // Stage-1 success path: lets index.html clear the START/END markers and
    // the trimming panel once the field actually exists.
    this.onBasicRegistered = options.onBasicRegistered || (() => {});
    // 編集 in the registered-fields card opens #selFeatureForm's <details>,
    // which is Settings-only (data-mode="settings") even though the card
    // itself also renders in Basic mode. index.html switches to Settings/
    // 圃場データ and scrolls there so the click has a visible result.
    this.onRequestEdit = options.onRequestEdit || (() => {});

    this.fields = [];
    this.boundaryTracks = [];
    this.waterControlPoints = [];
    this.surveySessions = [];
    this.fieldObservations = [];
    this.workflowState = { lastExportedAt: null };

    this.selected = null; // { kind: "field" | "track" | "point" | "observation", record }
    this.pendingDiscoveryPhoto = null;
    this.pendingUploadRegistration = null; // gathered inputs awaiting a closure decision
    this.pendingManualClosure = null; // same, for the advanced/manual card
    this.pendingBasicRegistration = null; // Stage-1 field-only registration
    this.pendingWaterPointType = null; // internal type key awaiting a position
    this.pendingObservationType = null; // internal observation type key awaiting a position
    this.mapClickAddActiveObservation = false;
    // { lat, lon } captured by a map click outside the target field's
    // boundary, awaiting the user's continue/cancel decision — see
    // confirmOutsideFieldObservation()/cancelOutsideFieldObservation().
    this.pendingOutsideFieldObservation = null;

    this.layers = {
      fields: L.layerGroup(), tracks: L.layerGroup(), waterPoints: L.layerGroup(),
      observations: L.layerGroup(), gnssPoints: L.layerGroup(), cornerPicker: L.layerGroup()
    };
    this.fieldLayerById = new Map();
    // Field/track ids currently showing their linked survey session's raw
    // GNSS points on the map (登録済み圃場・測量ログ card's GNSS点を表示 toggle).
    // Rebuilt from this set on every renderMapLayers() call, the same way
    // fields/tracks themselves render from this.fields/this.boundaryTracks.
    this.gnssVisibleIds = new Set();
    // Field/track ids whose 登録済み圃場・測量ログ card is currently expanded.
    // renderRegisteredList() rebuilds a fresh <details> per record on every
    // call (any action -- delete a different field, straighten, toggle-gnss
    // -- calls renderAll()), so without tracking this separately, an open
    // card would silently re-collapse the moment anything else in the list
    // changed.
    this.expandedRecordIds = new Set();
    // Active 境界を直線化 (straighten boundary) session, or null when not
    // picking corners: { kind: "field" | "track", id, selected: Set<number> }
    // -- selected holds indices into that record's own coordinates array.
    this.cornerPicker = null;
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
    const pointPane = this.map.getPane(FIELD_ANNOTATION_POINT_PANE)
      || this.map.createPane(FIELD_ANNOTATION_POINT_PANE);
    pointPane.style.zIndex = "660";
    this.layers.fields.addTo(this.map);
    this.layers.tracks.addTo(this.map);
    this.layers.waterPoints.addTo(this.map);
    this.layers.observations.addTo(this.map);
    this.layers.gnssPoints.addTo(this.map);
    // Added last so its click-to-toggle vertex markers always sit above the
    // field/track layers during 境界を直線化 (otherwise the polygon fill
    // underneath would eat the click first).
    this.layers.cornerPicker.addTo(this.map);
    this.map.on("click", (event) => this.handleMapClick(event));
    // Bound once here, alongside the single map click listener above — never
    // re-registered per placement-mode toggle, so it can't accumulate either.
    document.addEventListener("keydown", (event) => this.handleGlobalKeydown(event));
    this.renderAll();
    this.syncDialogVisibility();
  }

  /**
   * switchWorkspace() in index.html unhides every `[data-workspace="survey"]`
   * section whenever the user (re)enters QZ1測量 — including on first load
   * straight into #survey, before this controller even exists yet. That
   * generic pass has no way to know whether an NMEA upload is actually
   * pending, so it always forces fieldRegDialog open. Call this right after
   * that generic pass (and once here at mount, for the direct-#survey-load
   * case) to make the dialog's own pending-registration state win instead.
   */
  syncDialogVisibility() {
    if (this.elements.fieldRegDialog) {
      this.elements.fieldRegDialog.hidden = !this.pendingUploadRegistration;
    }
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

    // Stage-1 field-only registration dialog (Basic mode).
    el.basicFieldRegConfirmButton?.addEventListener("click", () => this.confirmBasicFieldRegistration());
    el.basicFieldRegCancelButton?.addEventListener("click", () => this.cancelBasicFieldRegistration());
    el.basicFieldRegForceCloseButton?.addEventListener("click", () => this.resolveBasicClosure("force-close"));
    el.basicFieldRegReselectButton?.addEventListener("click", () => this.resolveBasicClosure("reselect"));

    // Water-management points.
    el.wcpTargetFieldSelect?.addEventListener("change", () => {
      if (el.waterQuickFieldSelect) {
        el.waterQuickFieldSelect.value = el.wcpTargetFieldSelect.value;
      }
      this.updateWaterPointButtonStates();
      this.renderQuickToolbar();
    });

    // Floating map quick-toolbar (mirrors the water-management panel above, but reachable without hunting the side panel in fullscreen).
    el.waterQuickFieldSelect?.addEventListener("change", () => {
      el.wcpTargetFieldSelect.value = el.waterQuickFieldSelect.value;
      this.updateWaterPointButtonStates();
      this.renderQuickToolbar();
    });
    el.waterQuickToolbar?.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-water-quick-type]");
      if (button && !button.disabled) {
        this.beginQuickAddWaterPoint(button.dataset.waterQuickType);
      }
    });
    el.waterQuickCancelButton?.addEventListener("click", () => this.cancelQuickAddWaterPoint());

    // Field observations (現地観察メモ).
    el.obsTargetFieldSelect?.addEventListener("change", () => this.updateObservationButtonStates());
    Object.entries(OBSERVATION_TYPE_BUTTON_IDS).forEach(([elementId, type]) => {
      el[elementId]?.addEventListener("click", () => this.beginAddObservation(type));
    });
    el.obsPositionQz1Button?.addEventListener("click", () => this.addObservationAtCurrentQz1Position());
    el.obsPositionGpsButton?.addEventListener("click", () => this.addObservationAtSmartphonePosition());
    el.obsPositionMapClickButton?.addEventListener("click", () => this.toggleMapClickAddObservationMode());
    el.obsOutsideFieldContinueButton?.addEventListener("click", () => this.confirmOutsideFieldObservation());
    el.obsOutsideFieldCancelButton?.addEventListener("click", () => this.cancelOutsideFieldObservation());

    // Manual/advanced field-polygon creation (詳細解析).
    el.fieldSourceSelect?.addEventListener("change", () => this.renderRangeOptions());
    el.fieldUseAllPointsCheckbox?.addEventListener("change", () => this.updateRangeVisibility());
    el.fieldCreateButton?.addEventListener("click", () => this.handleManualCreateFieldClick());
    el.fieldCloseForceCloseButton?.addEventListener("click", () => this.resolvePendingClosure(this.pendingManualClosure, "force-close"));
    el.fieldCloseSaveAsTrackButton?.addEventListener("click", () => this.resolvePendingClosure(this.pendingManualClosure, "save-as-track"));
    el.fieldCloseCancelButton?.addEventListener("click", () => this.resolvePendingClosure(this.pendingManualClosure, "cancel"));

    // Selected-feature editor.
    el.selFeatureSaveButton?.addEventListener("click", () => this.saveSelectedFeature());
    el.selFeatureImageInput?.addEventListener("change", (event) => this.handleDiscoveryPhotoInput(event));
    el.selFeatureImageRemoveButton?.addEventListener("click", () => this.removeDiscoveryPhoto());
    el.selFeatureStraightenButton?.addEventListener("click", () => {
      if (this.selected) this.beginBoundaryStraighten(this.selected.kind, this.selected.record);
    });
    el.selFeatureDeleteButton?.addEventListener("click", () => this.deleteSelectedFeature());

    // Registered fields/logs panel (event delegation — rows are rebuilt on render).
    el.registeredFieldsContainer?.addEventListener("click", (event) => this.handleRegisteredListClick(event));

    // 境界を直線化 (straighten boundary).
    el.boundaryStraightenConfirmButton?.addEventListener("click", () => this.confirmBoundaryStraighten());
    el.boundaryStraightenResetButton?.addEventListener("click", () => this.resetBoundaryStraighten());
    el.boundaryStraightenCancelButton?.addEventListener("click", () => this.endBoundaryStraighten());

    // 現地調査ワークフロー guide (event delegation — steps are rebuilt on render).
    el.workflowStepsContainer?.addEventListener("click", (event) => this.handleWorkflowStepClick(event));
  }

  // -------------------------------------------------------------------------
  // Persistence (localStorage)
  // -------------------------------------------------------------------------

  /**
   * Replaces the in-memory state with whatever the CURRENT storage scope
   * holds.
   *
   * "Replaces" is load-bearing. This used to return early when the key was
   * absent, which was harmless while it only ran once at mount with empty
   * arrays. It is now also called when the storage scope moves to a different
   * signed-in farmer (js/cloud/user-scope.js), and an early return there
   * would leave the previous farmer's paddies in memory for the next one to
   * see on a shared phone. An empty scope must therefore produce an empty
   * controller, not an unchanged one.
   */
  hydrateFromStorage() {
    if (!this.storage) {
      return;
    }
    this.resetInMemoryState();
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
      this.resetInMemoryState();
    }
  }

  /**
   * Everything that belongs to one farmer's data set. `selected` is included
   * because a selected-feature editor still pointing at the previous scope's
   * record would let it be read — and saved — after a user switch.
   */
  resetInMemoryState() {
    this.fields = [];
    this.boundaryTracks = [];
    this.waterControlPoints = [];
    this.surveySessions = [];
    this.fieldObservations = [];
    this.workflowState = { lastExportedAt: null };
    this.selected = null;
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
    scrollWithinPanel(el.fieldRegDialog, { block: "nearest" });
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

  // -------------------------------------------------------------------------
  // Stage-1 (Basic mode) field-only registration
  //
  // Deliberately narrower than confirmUploadRegistration() above: no
  // measurement-type choice, no 境界トラック outcome, no farmer-entered id.
  // A farmer who has just walked a paddy is registering a paddy — asking
  // them to first classify their walk as a polygon / a boundary track / a
  // set of water-control points is a data-model question, not a field
  // question. Those choices all still exist on the Settings dialog.
  //
  // Geometry is NOT reimplemented here: the START/END range arrives already
  // trimmed from boundary-selection.js, and closure/area/persistence go
  // through the same evaluateClosure() + registerFieldPolygon() path the
  // legacy dialog uses.
  // -------------------------------------------------------------------------

  /** Only ever returns an id that is free, so the farmer never sees a collision error. */
  resolveBasicFieldId(candidate) {
    const taken = this.fields.map((field) => String(field.id));
    const trimmed = String(candidate || "").trim();
    if (trimmed && !taken.includes(trimmed)) {
      return trimmed;
    }
    return nextAvailableFieldDefaults(taken).id;
  }

  /**
   * Opens the Stage-1 dialog for an already-trimmed START..END range.
   * `coordinates` comes from selectBoundaryPoints() — this method never
   * re-derives, re-orders, or re-filters the range itself.
   */
  beginBasicFieldRegistration({ rawPoints = [], coordinates = [], fileName = null, rawText = null, selection = null } = {}) {
    const el = this.elements;
    if (!el.basicFieldRegDialog) {
      return false;
    }
    const defaults = nextAvailableFieldDefaults(this.fields.map((field) => field.id));
    el.basicFieldRegNameInput.value = defaults.name;
    el.basicFieldRegIdInput.value = defaults.id;
    el.basicFieldRegMemoInput.value = "";
    const summary = summarizeFixQuality(rawPoints);
    el.basicFieldRegSummary.textContent =
      `選択範囲: ${rawPoints.length}点 / DGPS fix: ${summary.byFixQuality["2"] || 0} / GPS単独: ${summary.byFixQuality["1"] || 0}`;
    this.setBasicFieldRegMessage("");
    this.hidePendingClosureUi(el.basicFieldRegCloseWarning);
    // #basicUploadStep and #basicFieldRegDialog share one card and are
    // mutually exclusive steps of the same flow — see this element's own
    // comment in index.html.
    if (el.basicUploadStep) {
      el.basicUploadStep.hidden = true;
    }
    el.basicFieldRegDialog.hidden = false;
    scrollWithinPanel(el.basicFieldRegDialog, { block: "nearest" });
    this.pendingBasicRegistration = { rawPoints, coordinates, fileName, rawText, selection };
    return true;
  }

  confirmBasicFieldRegistration() {
    const pending = this.pendingBasicRegistration;
    if (!pending) {
      return;
    }
    const el = this.elements;
    const name = el.basicFieldRegNameInput.value.trim();
    if (!name) {
      this.setBasicFieldRegMessage("圃場名を入力してください。");
      return;
    }
    // Auto-repairs rather than rejects: an edited-but-taken id silently
    // becomes the next free one, which is then shown back under 詳細.
    const id = this.resolveBasicFieldId(el.basicFieldRegIdInput.value);
    el.basicFieldRegIdInput.value = id;

    const context = {
      name, id, memo: el.basicFieldRegMemoInput.value,
      rawPoints: pending.rawPoints, coordinates: pending.coordinates,
      fileName: pending.fileName, rawNmeaText: pending.rawText,
      measurementType: "field_polygon", dialog: "basic"
    };
    const closure = evaluateClosure(pending.coordinates, DEFAULT_AUTO_CLOSE_THRESHOLD_M);
    if (!closure.canClose) {
      this.setBasicFieldRegMessage(closure.warnings.join(" "));
      return;
    }
    if (closure.autoClose) {
      this.registerFieldPolygon({ ...context, gapM: closure.gapM, closedManually: false });
      return;
    }
    this.pendingBasicRegistration = { ...pending, context, gapM: closure.gapM };
    el.basicFieldRegCloseWarningText.textContent = basicClosureWarningText(closure.gapM);
    el.basicFieldRegCloseWarning.hidden = false;
  }

  /**
   * The Stage-1 closure warning offers two outcomes, not three: build the
   * field anyway, or go back and re-pick START/END. 境界トラックとして保存
   * is intentionally absent — see the section comment above.
   */
  resolveBasicClosure(action) {
    const pending = this.pendingBasicRegistration;
    if (!pending || !pending.context) {
      return;
    }
    if (action === "force-close") {
      this.registerFieldPolygon({ ...pending.context, gapM: pending.gapM, closedManually: true });
      return;
    }
    this.cancelBasicFieldRegistration();
  }

  /** Tears the dialog down without creating anything, and hands the map back. */
  cancelBasicFieldRegistration() {
    this.pendingBasicRegistration = null;
    this.hidePendingClosureUi(this.elements.basicFieldRegCloseWarning);
    if (this.elements.basicFieldRegDialog) {
      this.elements.basicFieldRegDialog.hidden = true;
    }
    if (this.elements.basicUploadStep) {
      this.elements.basicUploadStep.hidden = false;
    }
    this.setBasicFieldRegMessage("");
    this.onBasicReselect();
  }

  /**
   * Success-path teardown, called from registerFieldPolygon(). Separate from
   * cancelBasicFieldRegistration() so a completed registration never fires
   * onBasicReselect() and drops the farmer back into point-picking mode.
   * No-ops for the legacy dialogs, which leave pendingBasicRegistration null.
   */
  finishBasicRegistration(field) {
    if (!this.pendingBasicRegistration) {
      return;
    }
    this.pendingBasicRegistration = null;
    this.hidePendingClosureUi(this.elements.basicFieldRegCloseWarning);
    if (this.elements.basicFieldRegDialog) {
      this.elements.basicFieldRegDialog.hidden = true;
    }
    if (this.elements.basicUploadStep) {
      this.elements.basicUploadStep.hidden = false;
    }
    this.setBasicFieldRegMessage("");
    this.onBasicRegistered(field);
  }

  setBasicFieldRegMessage(message) {
    if (this.elements.basicFieldRegMessage) {
      this.elements.basicFieldRegMessage.textContent = message;
    }
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

  /** Never hands back an id an existing session already uses — see makeSurveySessionId(). */
  newSurveySessionId() {
    return makeSurveySessionId(Date.now(), this.surveySessions.map((session) => session.id));
  }

  registerFieldPolygon({ name, id, memo, coordinates, rawPoints, fileName, rawNmeaText, gapM, closedManually }) {
    const sessionId = this.newSurveySessionId();
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
    this.finishBasicRegistration(field);
    this.selectFeature("field", field);
    this.onFieldRegistered(field);
    this.renderAll();
  }

  registerBoundaryTrack({ name, id, memo, coordinates, rawPoints, fileName, rawNmeaText, dialog }) {
    const sessionId = this.newSurveySessionId();
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
    const sessionId = this.newSurveySessionId();
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

  /**
   * The map-click-armed entry point for adding a water-control point: a
   * farmer working fullscreen on the map shouldn't need a side panel for
   * this. This is now the ONLY placement path (the panel-based
   * beginAddWaterPoint()/toggleMapClickAddMode() and the "現在のQZ1位置に追加"
   * live-position shortcut were removed with the panel itself). Sets the
   * same pendingWaterPointType/mapClickAddActive flags handleMapClick()
   * already watches, so placement/creation logic isn't duplicated.
   */
  beginQuickAddWaterPoint(internalType) {
    if (this.fields.length === 0) {
      this.renderQuickToolbar();
      return;
    }
    if (!this.elements.wcpTargetFieldSelect.value) {
      this.setWcpMessage("対象の圃場を選択してください。");
      this.renderQuickToolbar();
      return;
    }
    this.pendingWaterPointType = internalType;
    this.mapClickAddActive = true;
    this.render();
  }

  cancelQuickAddWaterPoint() {
    this.pendingWaterPointType = null;
    this.mapClickAddActive = false;
    this.setWcpMessage("");
    this.render();
  }

  /** Keeps the floating map quick-toolbar in sync with field/target/placement-mode state — called from render()/renderAll(). */
  renderQuickToolbar() {
    const el = this.elements;
    if (!el.waterQuickToolbar) {
      return;
    }
    const hasFields = this.fields.length > 0;
    const targetFieldId = el.wcpTargetFieldSelect?.value || "";
    const activeField = this.fields.find((field) => field.id === targetFieldId);

    if (el.waterQuickNoFieldMessage) {
      el.waterQuickNoFieldMessage.hidden = hasFields;
    }
    setText(el.waterQuickActiveField, activeField ? `現在の対象圃場: ${activeField.name} / ${activeField.id}` : "");
    if (el.waterQuickActiveField) {
      el.waterQuickActiveField.hidden = !activeField;
    }
    if (el.waterQuickFieldRow) {
      // A single field is auto-selected already (renderFieldTargetOptions) —
      // only show the picker when there's an actual choice to make.
      el.waterQuickFieldRow.hidden = this.fields.length <= 1;
    }

    const canBegin = hasFields && Boolean(targetFieldId);
    el.waterQuickToolbar.querySelectorAll("button[data-water-quick-type]").forEach((button) => {
      button.disabled = !canBegin;
      const isActiveSelection = this.mapClickAddActive && this.pendingWaterPointType === button.dataset.waterQuickType;
      button.classList.toggle("active", isActiveSelection);
    });

    if (this.mapClickAddActive && this.pendingWaterPointType) {
      const label = WATER_CONTROL_TYPE_LABELS[this.pendingWaterPointType];
      setText(el.waterQuickStatus, `地図をクリックして「${label}」の位置を登録してください。`);
      el.waterQuickStatus.hidden = false;
      if (el.waterQuickCancelButton) {
        el.waterQuickCancelButton.hidden = false;
      }
    } else {
      if (el.waterQuickStatus) {
        el.waterQuickStatus.hidden = true;
      }
      if (el.waterQuickCancelButton) {
        el.waterQuickCancelButton.hidden = true;
      }
    }
    this.onWaterQuickToolbarRendered();
  }

  handleMapClick(event) {
    if (this.mapClickAddActive && this.pendingWaterPointType) {
      this.createWaterControlPoint(event.latlng.lat, event.latlng.lng, "manual_map_click");
      this.mapClickAddActive = false;
      return;
    }
    if (this.mapClickAddActiveObservation && this.pendingObservationType) {
      this.handleObservationMapClick(event.latlng.lat, event.latlng.lng);
    }
  }

  /** Escape cancels whichever map-click placement mode is currently active — never touches unrelated app state when nothing is armed. */
  handleGlobalKeydown(event) {
    if (event.key !== "Escape") {
      return;
    }
    if (this.pendingOutsideFieldObservation) {
      this.cancelOutsideFieldObservation();
      return;
    }
    if (this.mapClickAddActive) {
      this.cancelQuickAddWaterPoint();
    }
    if (this.mapClickAddActiveObservation) {
      this.cancelQuickAddObservation();
    }
  }

  /** Crosshair cursor whenever any map-click placement mode is armed — a single generic switch driven by state, not duplicated per mode. */
  updateMapCursor() {
    const active = Boolean(this.mapClickAddActive || this.mapClickAddActiveObservation);
    this.map.getContainer().classList.toggle("map-click-armed", active);
  }

  createWaterControlPoint(lat, lon, sourceType) {
    const type = this.pendingWaterPointType;
    const relatedFieldId = this.elements.wcpTargetFieldSelect.value || null;
    const field = this.fields.find((candidate) => candidate.id === relatedFieldId);
    const existingCount = this.waterControlPoints.filter((candidate) => candidate.relatedFieldId === relatedFieldId
      && waterControlInternalType(candidate) === type).length;
    const name = nextWaterControlName(field ? field.name : relatedFieldId, type, existingCount);
    const point = buildWaterControlPoint({ id: makeId("wcp"), name, type, lat, lon, relatedFieldId, sourceType });
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
      this.deactivateObservationPlacementMode("");
      return;
    }
    this.activateObservationPlacementMode(`地図をクリックして${OBSERVATION_TYPE_LABELS[this.pendingObservationType]}の位置を指定してください。`);
  }

  /**
   * Common entry point for any way of arming observation map-click
   * placement (the type-first 現地観察メモ panel flow above, and the
   * click-first Step 4 quick-start below): cancels this controller's own
   * conflicting water-point placement mode, and — via the injected
   * onEnterPlacementMode hook — lets index.html cancel unrelated live
   * map-click modes owned by other modules (e.g. paddy-intelligence.js's
   * drone-mission/annotation drawing), so a single map click can never be
   * claimed by two different features at once.
   */
  activateObservationPlacementMode(instructionMessage) {
    this.cancelQuickAddWaterPoint();
    this.onEnterPlacementMode();
    this.mapClickAddActiveObservation = true;
    this.setObsMessage(instructionMessage);
    this.render();
  }

  deactivateObservationPlacementMode(message) {
    this.mapClickAddActiveObservation = false;
    this.setObsMessage(message);
    this.render();
  }

  /**
   * Step 4 (現地調査ワークフロー) quick-start: unlike beginAddObservation()
   * above, the user hasn't picked a type yet — that happens afterward, in
   * the shared feature editor createFieldObservation() opens. Reuses the
   * exact same pendingObservationType/mapClickAddActiveObservation state
   * machine handleMapClick() already watches, so this is a second on-ramp
   * into the same flow, not a second implementation of it.
   */
  beginQuickAddObservation() {
    if (this.mapClickAddActiveObservation) {
      this.cancelQuickAddObservation();
      return;
    }
    if (this.fields.length === 0) {
      return;
    }
    const fieldSelect = this.elements.obsTargetFieldSelect;
    if (fieldSelect && !fieldSelect.value) {
      // renderFieldTargetOptions() already auto-selects a lone field; with
      // several fields and no prior choice, default to the first rather
      // than silently doing nothing when the workflow button is clicked.
      fieldSelect.value = this.fields[0].id;
    }
    this.pendingObservationType = "note";
    this.activateObservationPlacementMode("地図上の観察位置をクリックしてください");
  }

  cancelQuickAddObservation() {
    this.pendingObservationType = null;
    this.deactivateObservationPlacementMode("");
  }

  /** Routes a click made while observation placement is armed through the outside-boundary check before creating anything. */
  handleObservationMapClick(lat, lon) {
    const fieldId = this.elements.obsTargetFieldSelect.value || null;
    const field = this.fields.find((candidate) => candidate.id === fieldId);
    if (field && !isPointInsideBoundary([lat, lon], field.coordinates)) {
      this.pendingOutsideFieldObservation = { lat, lon };
      this.deactivateObservationPlacementMode(OUTSIDE_FIELD_WARNING_MESSAGE);
      this.showOutsideFieldWarning(true);
      return;
    }
    this.createFieldObservation(lat, lon, "manual_map_click");
    this.mapClickAddActiveObservation = false;
  }

  confirmOutsideFieldObservation() {
    const pending = this.pendingOutsideFieldObservation;
    if (!pending) {
      return;
    }
    this.pendingOutsideFieldObservation = null;
    this.showOutsideFieldWarning(false);
    this.createFieldObservation(pending.lat, pending.lon, "manual_map_click");
  }

  cancelOutsideFieldObservation() {
    this.pendingOutsideFieldObservation = null;
    this.showOutsideFieldWarning(false);
    this.pendingObservationType = null;
    this.setObsMessage("");
    this.render();
  }

  showOutsideFieldWarning(visible) {
    const el = this.elements;
    if (el.obsOutsideFieldWarning) {
      el.obsOutsideFieldWarning.hidden = !visible;
    }
    if (visible && el.obsOutsideFieldWarningText) {
      el.obsOutsideFieldWarningText.textContent = OUTSIDE_FIELD_WARNING_MESSAGE;
    }
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
    if (this.pendingDiscoveryPhoto?.recordId !== record.id) {
      this.pendingDiscoveryPhoto = null;
    }
    this.selected = { kind, record };
    this.setSelFeatureMessage("");
    this.renderSelectedFeature();
    this.revealSelectedEditor();
  }

  /**
   * Clicking a field polygon on the map sets the same #basicActiveFieldSelect
   * ("圃場を選ぶ") that drives Basic mode's summary and Drone mode's gate card
   * (index.html:9234), so a map click is an alternate path to that one
   * dropdown selection rather than a second, independent concept of "selected
   * field". Re-highlights even when the field was already active, so a click
   * always gives visible feedback.
   */
  setActiveField(fieldId) {
    const select = this.elements.basicActiveFieldSelect;
    if (select && fieldId && select.value !== fieldId
      && [...select.options].some((option) => option.value === fieldId)) {
      select.value = fieldId;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    this.highlightActiveField();
  }

  highlightActiveField() {
    const activeFieldId = this.elements.basicActiveFieldSelect?.value || "";
    this.fieldLayerById.forEach((layer, fieldId) => {
      layer.setStyle(fieldId === activeFieldId ? FIELD_POLYGON_SELECTED_STYLE : FIELD_POLYGON_STYLE);
    });
  }

  clearSelection() {
    this.selected = null;
    this.pendingDiscoveryPhoto = null;
    this.setSelFeatureMessage("");
    this.renderSelectedFeature();
  }

  async handleDiscoveryPhotoInput(event) {
    const selected = this.selected;
    const file = event.target?.files?.[0];
    if (!file || selected?.kind !== "point" || waterControlInternalType(selected.record) !== "photo") {
      return;
    }
    try {
      const photo = await prepareDiscoveryPhoto(file);
      this.pendingDiscoveryPhoto = { recordId: selected.record.id, ...photo };
      this.setSelFeatureMessage("写真を追加しました。「保存」で発見に紐付けます。");
      this.renderSelectedFeature();
    } catch (error) {
      event.target.value = "";
      this.setSelFeatureMessage(error?.message || "写真を読み込めませんでした。");
    }
  }

  removeDiscoveryPhoto() {
    const selected = this.selected;
    if (selected?.kind !== "point" || waterControlInternalType(selected.record) !== "photo") {
      return;
    }
    this.pendingDiscoveryPhoto = { recordId: selected.record.id, remove: true };
    this.setSelFeatureMessage("写真を外します。「保存」で反映します。");
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
      const pendingPhoto = this.pendingDiscoveryPhoto?.recordId === oldId ? this.pendingDiscoveryPhoto : null;
      if (nextType === "photo" && pendingPhoto?.remove) {
        delete record.properties.discoveryPhoto;
      } else if (nextType === "photo" && pendingPhoto?.dataUrl) {
        record.properties.discoveryPhoto = {
          dataUrl: pendingPhoto.dataUrl,
          name: pendingPhoto.name,
          attachedAt: new Date().toISOString()
        };
      } else if (nextType !== "photo") {
        delete record.properties.discoveryPhoto;
      }
      this.pendingDiscoveryPhoto = null;
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
      if (!window.confirm("この水管理ポイントを削除しますか？")) {
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
      // #selFeatureForm's <details> is data-mode="settings" only (the
      // registered-fields card itself is "basic settings", so it renders in
      // both -- but the editor it opens does not). Without this, 編集 from
      // Basic mode sets details.open=true on a panel that stays display:none,
      // so the click has no visible effect at all.
      this.onRequestEdit();
    } else if (action === "delete") {
      this.selected = { kind, record };
      this.deleteSelectedFeature();
    } else if (action === "export") {
      this.exportScoped(kind, record);
    } else if (action === "export-nmea") {
      this.exportRawNmea(record);
    } else if (action === "toggle-gnss") {
      this.toggleGnssPoints(record);
    } else if (action === "straighten") {
      this.beginBoundaryStraighten(kind, record);
    }
  }

  toggleGnssPoints(record) {
    if (this.gnssVisibleIds.has(record.id)) {
      this.gnssVisibleIds.delete(record.id);
    } else {
      this.gnssVisibleIds.add(record.id);
    }
    this.renderMapLayers();
    this.renderRegisteredList();
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
  // 境界を直線化 (straighten a noisy walked boundary): the farmer picks which
  // measured points are corners by clicking them on the map; each edge
  // between two picked corners is replaced with straightenBoundary()'s
  // best-fit line, so GPS wobble along a straight paddy edge averages out
  // instead of being traced point-for-point.
  // -------------------------------------------------------------------------

  beginBoundaryStraighten(kind, record) {
    if (!Array.isArray(record.coordinates) || record.coordinates.length < 3) {
      return;
    }
    // record.coordinates is whatever corners were picked LAST time this ran
    // -- offering only those on a re-straighten would make it impossible to
    // add back a corner that got straightened away, or recover from picking
    // too few/wrong ones the first time (see #selFeatureStraightenButton's
    // own comment on why re-straighten is offered at all). The full walked
    // track survives separately on the linked survey session, unaffected by
    // any previous straighten, so prefer that; fall back to
    // record.coordinates only when there is no linked session (e.g. a
    // manually drawn feature).
    const session = this.linkedSurveySession(record);
    const points = session?.rawPoints?.length >= 3
      ? session.rawPoints.map((point) => [Number(point.lat), Number(point.lon)])
      : record.coordinates;
    this.cornerPicker = { kind, id: record.id, points, selected: new Set() };
    if (this.elements.boundaryStraightenBar) {
      this.elements.boundaryStraightenBar.hidden = false;
    }
    this.updateBoundaryStraightenStatus();
    this.renderMapLayers();
    // The map may still be framed for the smaller, already-straightened
    // polygon (e.g. right after 編集 focused it) -- the raw track picked
    // above can wander wider than that, so re-fit to every candidate point
    // now, or some can render bunched together too tightly to click apart.
    this.map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 19 });
  }

  endBoundaryStraighten() {
    this.cornerPicker = null;
    this.layers.cornerPicker.clearLayers();
    if (this.elements.boundaryStraightenBar) {
      this.elements.boundaryStraightenBar.hidden = true;
    }
  }

  toggleCornerIndex(index) {
    if (!this.cornerPicker) {
      return;
    }
    if (this.cornerPicker.selected.has(index)) {
      this.cornerPicker.selected.delete(index);
    } else {
      this.cornerPicker.selected.add(index);
    }
    this.updateBoundaryStraightenStatus();
    this.renderMapLayers();
  }

  resetBoundaryStraighten() {
    if (!this.cornerPicker) {
      return;
    }
    this.cornerPicker.selected.clear();
    this.updateBoundaryStraightenStatus();
    this.renderMapLayers();
  }

  updateBoundaryStraightenStatus() {
    const el = this.elements;
    if (!el.boundaryStraightenStatus) {
      return;
    }
    const count = this.cornerPicker?.selected.size || 0;
    setText(el.boundaryStraightenStatus, count === 0
      ? "角になる点を地図でタップ（3点以上）"
      : count < 3
        ? `角を選択: ${count}点（あと${3 - count}点）`
        : `角を選択: ${count}点`);
    if (el.boundaryStraightenConfirmButton) {
      el.boundaryStraightenConfirmButton.disabled = count < 3;
    }
  }

  confirmBoundaryStraighten() {
    if (!this.cornerPicker || this.cornerPicker.selected.size < 3) {
      return;
    }
    const { kind, id, selected, points } = this.cornerPicker;
    const record = kind === "field"
      ? this.fields.find((field) => field.id === id)
      : this.boundaryTracks.find((track) => track.id === id);
    if (!record) {
      this.endBoundaryStraighten();
      return;
    }
    const straightened = straightenBoundary(points, [...selected]);
    if (!straightened) {
      return;
    }
    record.coordinates = straightened;
    if (kind === "field" && record.properties) {
      record.properties.areaM2 = polygonAreaSquareMeters(straightened);
      record.properties.updatedAt = new Date().toISOString();
    }
    // Drives the FIRST-time-only placement of the 境界を直線化 trigger --
    // see buildRegisteredCard()'s and #selFeatureStraightenButton's own
    // comments.
    if (record.properties) {
      record.properties.hasBeenStraightened = true;
    }
    this.persist();
    this.endBoundaryStraighten();
    this.renderAll();
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
    // Step 4's button doubles as the observation-placement-mode toggle: once
    // armed (from this button or the 現地観察メモ panel below), clicking it
    // again is how the user cancels — matching the "click again to exit
    // cleanly" requirement without a separate Cancel control.
    const isObservationPlacementActive = step.id === 4 && this.mapClickAddActiveObservation;
    button.textContent = isObservationPlacementActive ? "地図クリックをキャンセル" : step.actionLabel;
    button.classList.toggle("active", isObservationPlacementActive);
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
    // The guide card itself now lives under 開発ツール, but every step here
    // predates that move and still jumps to a target on whichever workspace
    // that target has always lived on (1/5's own device-upload card is on
    // 開発ツール too; 2-4's field panels are on 圃場データ; 5's export button
    // is on 詳細解析). Without switching first, "jump to X" would scroll to
    // an element hidden by the workspace it's not currently showing.
    switch (button.dataset.workflowStep) {
      case "1":
        // The ordinary uploader was removed from 開発ツール -- ordinary field
        // registration, NMEA upload included, is now 基本モード-only. Send the
        // farmer there instead of scrolling to an advanced-only control.
        window.switchMode?.("basic");
        document.getElementById("basicNmeaInput")?.focus();
        break;
      case "2":
        window.switchWorkspace?.("fields");
        scrollWithinPanel(el.registeredFieldsPanel, { block: "start" });
        break;
      case "3":
        // Destination is the on-map #waterQuickToolbar now (the removed
        // #waterControlPanel's replacement -- see the comment on that id in
        // index.html). It's a fixed-position overlay on the always-visible
        // map, not a panel card, so there's nothing to scroll into view.
        window.switchWorkspace?.("fields");
        el.waterQuickToolbar?.querySelector('button[data-water-quick-type="gate"]')?.focus();
        break;
      case "4":
        window.switchWorkspace?.("fields");
        if (el.fieldObservationsPanel) {
          el.fieldObservationsPanel.open = true;
          scrollWithinPanel(el.fieldObservationsPanel, { block: "start" });
        }
        this.beginQuickAddObservation();
        break;
      case "5":
        window.switchWorkspace?.("analysis");
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
    this.renderFieldTargetOptions(this.elements.waterQuickFieldSelect);
    this.updateWaterPointButtonStates();
    this.renderQuickToolbar();
    this.renderFieldTargetOptions(this.elements.obsTargetFieldSelect);
    this.renderFieldTargetOptions(this.elements.basicActiveFieldSelect);
    this.renderFieldTargetOptions(this.elements.droneActiveFieldSelect);
    this.updateObservationButtonStates();
    this.renderSelectedFeature();
    this.renderWorkflowPanel();
    this.updateMapCursor();
    this.onFieldsChanged();
  }

  renderMapLayers() {
    this.layers.fields.clearLayers();
    this.layers.tracks.clearLayers();
    this.layers.waterPoints.clearLayers();
    this.layers.observations.clearLayers();
    this.layers.gnssPoints.clearLayers();

    this.fieldLayerById = new Map();
    const activeFieldId = this.elements.basicActiveFieldSelect?.value || "";
    this.fields.forEach((field) => {
      const layer = L.polygon(field.coordinates, field.id === activeFieldId ? FIELD_POLYGON_SELECTED_STYLE : FIELD_POLYGON_STYLE)
        .bindTooltip(field.name || field.id, { permanent: true, direction: "center", className: "field-annotation-label" })
        .on("click", (event) => {
          event.originalEvent?.stopPropagation();
          this.setActiveField(field.id);
          this.selectFeature("field", field);
        })
        .addTo(this.layers.fields);
      this.fieldLayerById.set(field.id, layer);
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
        pane: FIELD_ANNOTATION_POINT_PANE,
        radius: 8, color: "#ffffff", weight: 2, fillColor: style.fillColor, fillOpacity: 0.95
      })
        .bindTooltip(point.name || WATER_CONTROL_TYPE_LABELS[internalType] || internalType)
        .bindPopup(this.buildWaterControlPopup(point))
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
        pane: FIELD_ANNOTATION_POINT_PANE,
        radius, color: "#ffffff", weight: 2, fillColor: style.fillColor, fillOpacity: 0.95
      })
        .bindPopup(this.buildObservationPopup(obs))
        .on("click", (event) => {
          event.originalEvent?.stopPropagation();
          this.selectFeature("observation", obs);
        })
        .addTo(this.layers.observations);
    });

    this.renderGnssPointsLayer();
    this.renderCornerPickerLayer();
  }

  /**
   * Draws the linked survey session's raw measured points for every
   * field/track id currently toggled on via the registered-list card's
   * GNSS点を表示 button. Rebuilt from this.gnssVisibleIds on every
   * renderMapLayers() call, self-healing stale ids (a deleted record simply
   * yields no match and is dropped from the set).
   */
  renderGnssPointsLayer() {
    if (this.gnssVisibleIds.size === 0) {
      return;
    }
    [...this.gnssVisibleIds].forEach((id) => {
      const record = this.fields.find((field) => field.id === id)
        || this.boundaryTracks.find((track) => track.id === id);
      if (!record) {
        this.gnssVisibleIds.delete(id);
        return;
      }
      const session = this.linkedSurveySession(record);
      (session?.rawPoints || []).forEach((point) => {
        const augmented = point.fixQuality === 2 || point.fixQuality === 4 || point.fixQuality === 5;
        L.circleMarker([point.lat, point.lon], {
          radius: 3, weight: 1, color: "#ffffff",
          fillColor: augmented ? "#15803d" : "#d97706", fillOpacity: 0.9
        })
          .bindTooltip(`Fix ${Number.isFinite(point.fixQuality) ? point.fixQuality : "?"}`)
          .addTo(this.layers.gnssPoints);
      });
    });
  }

  /**
   * Draws one clickable marker per candidate point (this.cornerPicker.points
   * -- the record's own coordinates, or the fuller raw walked track when one
   * is linked, see beginBoundaryStraighten()) for the record currently being
   * straightened (境界を直線化), colored by whether the farmer has picked it
   * as a corner yet. Clicking toggles membership in this.cornerPicker.selected
   * — order doesn't matter here, straightenBoundary() sorts by position along
   * the walked path before pairing up edges.
   */
  renderCornerPickerLayer() {
    if (!this.cornerPicker) {
      return;
    }
    const { kind, id, selected, points } = this.cornerPicker;
    const record = kind === "field"
      ? this.fields.find((field) => field.id === id)
      : this.boundaryTracks.find((track) => track.id === id);
    if (!record) {
      this.endBoundaryStraighten();
      return;
    }
    points.forEach((coord, index) => {
      const isCorner = selected.has(index);
      L.circleMarker(coord, {
        radius: isCorner ? 7 : 4, weight: isCorner ? 3 : 1, color: "#ffffff",
        fillColor: isCorner ? "#b45309" : "#2563eb", fillOpacity: 0.95
      })
        .on("click", (event) => {
          event.originalEvent?.stopPropagation();
          this.toggleCornerIndex(index);
        })
        .addTo(this.layers.cornerPicker);
    });
  }

  /** Leaflet popup content for a water-control-point marker: read-only summary + actions. */
  buildWaterControlPopup(point) {
    const container = document.createElement("div");
    container.className = "obs-popup";
    const internalType = waterControlInternalType(point);
    const field = this.fields.find((candidate) => candidate.id === point.relatedFieldId);
    const rows = [
      ["名前", point.name || WATER_CONTROL_TYPE_LABELS[internalType]],
      ["種類", WATER_CONTROL_TYPE_LABELS[internalType]],
      ["関連圃場", field ? field.name : (point.relatedFieldId || "—")],
      ["メモ", point.properties?.memo || "—"]
    ];
    rows.forEach(([label, value]) => {
      const row = document.createElement("div");
      row.className = "obs-popup-row";
      const strong = document.createElement("strong");
      strong.textContent = `${label}: `;
      row.append(strong, document.createTextNode(value));
      container.append(row);
    });
    const photoDataUrl = internalType === "photo" && safeDiscoveryPhotoDataUrl(point.properties?.discoveryPhoto?.dataUrl);
    let photoPreview = null;
    if (photoDataUrl) {
      photoPreview = document.createElement("img");
      photoPreview.className = "discovery-photo-preview";
      photoPreview.alt = point.properties?.discoveryPhoto?.name || "発見時の写真";
      photoPreview.src = photoDataUrl;
      container.append(photoPreview);
    }

    const actions = document.createElement("div");
    actions.className = "obs-popup-actions";
    if (internalType === "photo") {
      const uploadInput = document.createElement("input");
      uploadInput.type = "file";
      uploadInput.accept = "image/jpeg,image/png,image/webp";
      uploadInput.setAttribute("capture", "environment");
      uploadInput.className = "discovery-photo-upload-input";
      uploadInput.hidden = true;
      const uploadButton = document.createElement("button");
      uploadButton.type = "button";
      uploadButton.className = "panel-button";
      uploadButton.textContent = photoDataUrl ? "写真を変更" : "写真をアップロード";
      const uploadStatus = document.createElement("p");
      uploadStatus.className = "meta";
      uploadStatus.setAttribute("role", "status");
      uploadStatus.hidden = true;
      uploadButton.addEventListener("click", () => uploadInput.click());
      uploadInput.addEventListener("change", async () => {
        const file = uploadInput.files?.[0];
        if (!file) return;
        uploadButton.disabled = true;
        uploadStatus.hidden = false;
        uploadStatus.textContent = "写真を保存中…";
        try {
          const photo = await prepareDiscoveryPhoto(file);
          point.properties ||= {};
          point.properties.discoveryPhoto = {
            dataUrl: photo.dataUrl,
            name: photo.name,
            attachedAt: new Date().toISOString()
          };
          point.properties.updatedAt = new Date().toISOString();
          if (this.pendingDiscoveryPhoto?.recordId === point.id) {
            this.pendingDiscoveryPhoto = null;
          }
          this.persist();
          if (!photoPreview) {
            photoPreview = document.createElement("img");
            photoPreview.className = "discovery-photo-preview";
            container.insertBefore(photoPreview, actions);
          }
          photoPreview.alt = photo.name || "発見時の写真";
          photoPreview.src = photo.dataUrl;
          uploadButton.textContent = "写真を変更";
          uploadStatus.textContent = "写真を保存しました。";
        } catch (error) {
          uploadStatus.textContent = error?.message || "写真を読み込めませんでした。";
        } finally {
          uploadButton.disabled = false;
          uploadInput.value = "";
        }
      });
      actions.append(uploadInput, uploadButton);
      container.append(uploadStatus);
    }
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "panel-button danger";
    deleteButton.textContent = "削除";
    deleteButton.addEventListener("click", () => {
      this.map.closePopup();
      this.selected = { kind: "point", record: point };
      this.deleteSelectedFeature();
    });
    if (internalType !== "photo") {
      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.className = "panel-button";
      editButton.textContent = "編集";
      editButton.addEventListener("click", () => {
        this.selectFeature("point", point);
        this.map.closePopup();
      });
      actions.append(editButton);
    }
    actions.append(deleteButton);
    container.append(actions);
    return container;
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
      ["登録方法", observationSourceLabel(obs.properties?.sourceType)],
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

  /**
   * A <details> per record, collapsed by default: with several fields
   * registered this list used to show every field's full point-count/DGPS/
   * source-file breakdown and all six action buttons at once, all the time,
   * pushing the list a long way down the panel. The 圃場名/ID summary line
   * stays visible either way (and is what a farmer scanning the list for a
   * specific field actually needs); the detail grid and action buttons only
   * render once that field's own row is expanded.
   */
  buildRegisteredCard(kind, record) {
    const card = document.createElement("details");
    card.className = "rec-recovery-card";
    card.open = this.expandedRecordIds.has(record.id);
    card.addEventListener("toggle", () => {
      if (card.open) {
        this.expandedRecordIds.add(record.id);
      } else {
        this.expandedRecordIds.delete(record.id);
      }
    });

    const summary = document.createElement("summary");
    summary.className = "rec-recovery-summary";
    summary.textContent = `${record.name || "—"} / ${record.id}`;
    card.append(summary);

    const session = this.linkedSurveySession(record);
    const grid = document.createElement("div");
    grid.className = "paddy-detail-grid";
    appendDetailRow(grid, "測量ファイル", record.properties?.sourceFileName || "—");
    appendDetailRow(grid, "測量タイプ", kind === "field" ? "圃場ポリゴン" : "境界トラック");
    const fixQualitySummary = record.properties?.fixQualitySummary;
    appendDetailRow(grid, "総ポイント", fixQualitySummary ? String(fixQualitySummary.total) : "—");
    appendDetailRow(grid, "DGPS fix", fixQualitySummary ? String(fixQualitySummary.byFixQuality?.["2"] || 0) : "—");
    appendDetailRow(grid, "GPS単独", fixQualitySummary ? String(fixQualitySummary.byFixQuality?.["1"] || 0) : "—");
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
    if (session?.rawPoints?.length > 0) {
      const showingGnss = this.gnssVisibleIds.has(record.id);
      actionDefs.push(["toggle-gnss", showingGnss ? "GNSS点を隠す" : "GNSS点を表示"]);
    }
    // Straightening needs at least a triangle's worth of raw vertices to be
    // worth doing — a boundary already down to 3-4 points is already straight.
    // Only offered here the FIRST time: once a boundary has already been
    // straightened once (hasBeenStraightened), a repeat pass is a rarer,
    // more deliberate touch-up that lives inside 編集 instead (see
    // #selFeatureStraightenButton / renderSelectedFeature()) rather than
    // permanently occupying a slot in this card's button row.
    if (record.coordinates.length > 4 && !record.properties?.hasBeenStraightened) {
      actionDefs.push(["straighten", "境界を直線化"]);
    }
    actionDefs.forEach(([action, label]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = action === "delete" ? "panel-button danger" : "panel-button";
      button.textContent = label;
      button.dataset.action = action;
      button.dataset.kind = kind;
      button.dataset.id = record.id;
      if (action === "toggle-gnss") {
        button.setAttribute("aria-pressed", String(this.gnssVisibleIds.has(record.id)));
      }
      actions.append(button);
    });
    card.append(actions);
    return card;
  }

  /**
   * Shared by the water-control-point / observation / map-toolbar "対象圃場"
   * selects. Preserves a still-valid previous selection; otherwise
   * auto-selects the one field when there's only one, so a farmer with a
   * single registered field never has to pick it manually.
   */
  renderFieldTargetOptions(select) {
    if (!select) {
      return;
    }
    const previous = select.value;
    select.replaceChildren(new Option("圃場を選択", ""));
    this.fields.forEach((field) => select.append(new Option(`${field.name}（${field.id}）`, field.id)));
    if (this.fields.some((field) => field.id === previous)) {
      select.value = previous;
    } else if (this.fields.length === 1) {
      select.value = this.fields[0].id;
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
    const isDiscoveryPoint = kind === "point" && waterControlInternalType(record) === "photo";
    if (el.selFeatureImageRow) {
      el.selFeatureImageRow.hidden = !isDiscoveryPoint;
    }
    if (el.selFeatureImageInput) {
      // Browsers intentionally do not allow a saved file path to be restored.
      // The persisted thumbnail below is the source of truth after reload.
      el.selFeatureImageInput.value = "";
    }
    const pendingPhoto = this.pendingDiscoveryPhoto?.recordId === record.id ? this.pendingDiscoveryPhoto : null;
    const savedPhoto = record.properties?.discoveryPhoto;
    const photo = pendingPhoto?.remove ? null : (pendingPhoto?.dataUrl ? pendingPhoto : savedPhoto);
    const photoDataUrl = safeDiscoveryPhotoDataUrl(photo?.dataUrl);
    if (el.selFeatureImagePreview) {
      el.selFeatureImagePreview.hidden = !isDiscoveryPoint || !photoDataUrl;
      el.selFeatureImagePreview.src = photoDataUrl || "";
    }
    if (el.selFeatureImageRemoveButton) {
      el.selFeatureImageRemoveButton.hidden = !isDiscoveryPoint || !photoDataUrl;
    }

    // Second-and-later 境界を直線化 lives here rather than as a standalone
    // button on the registered-fields card -- see this button's own markup
    // comment in index.html. Deliberately NOT the >4-point floor
    // buildRegisteredCard() uses for the first straightening: that floor
    // means "not worth straightening AT ALL yet", but a re-straighten is
    // requested precisely because the farmer wants to REDO their corner
    // picks -- and most real paddies are quadrilaterals, so the common case
    // is exactly 4 points after the first pass. Using the same floor here
    // would make the button vanish for good the moment a farmer straightens
    // an ordinary rectangular field, with no way back if they picked the
    // wrong corners. The real floor is beginBoundaryStraighten()'s own
    // (>=3 points, below which there is no polygon left to pick corners on).
    if (el.selFeatureStraightenButton) {
      el.selFeatureStraightenButton.hidden = !(
        (kind === "field" || kind === "track")
        && Array.isArray(record.coordinates) && record.coordinates.length >= 3
        && record.properties?.hasBeenStraightened
      );
    }

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
    this.renderQuickToolbar();
    this.renderWorkflowPanel();
    this.updateMapCursor();
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

/**
 * Scrolls `element` into view within its nearest actually-scrolling
 * ancestor only. Never delegates to the native Element.scrollIntoView() for
 * panel content: that method walks every scrollable ancestor including
 * `documentElement`, and — despite `body { overflow: hidden }` — still
 * moves `documentElement.scrollTop` as a side effect in this app's layout.
 * Since the panel is the only container meant to scroll (the map/header sit
 * in a fixed 100vh grid), that side effect desyncs the outer page from the
 * panel's own scroll position and renders as a large blank gap. Computing
 * the offset against the panel directly and calling panel.scrollTo() avoids
 * touching any ancestor outside it.
 *
 * "The panel" is .panel-left/.panel-right on desktop 基本モード (where they
 * are real, independently-scrolling boxes and .panel itself goes
 * `display: contents`), and plain .panel everywhere else (設定/ドローン/
 * mobile, where .panel-left/.panel-right are the boxless `display: contents`
 * ones instead) -- see the .panel-left, .panel-right CSS. A `display:
 * contents` element has no box, so scrollTo()/getBoundingClientRect() on it
 * are no-ops; walk past it to find whichever wrapper is the real box.
 */
function scrollWithinPanel(element, { block = "start" } = {}) {
  if (!element) {
    return;
  }
  let panel = element.closest(".panel-left, .panel-right");
  if (panel && getComputedStyle(panel).display === "contents") {
    panel = null;
  }
  if (!panel) {
    panel = element.closest(".panel");
  }
  if (!panel) {
    element.scrollIntoView({ block });
    return;
  }
  const offsetWithinPanel = element.getBoundingClientRect().top - panel.getBoundingClientRect().top;
  let target = panel.scrollTop + offsetWithinPanel;
  if (block === "center") {
    target -= (panel.clientHeight - element.clientHeight) / 2;
  } else if (block === "nearest") {
    const alreadyVisible = offsetWithinPanel >= 0 && offsetWithinPanel + element.clientHeight <= panel.clientHeight;
    if (alreadyVisible) {
      return;
    }
  }
  panel.scrollTo({ top: Math.max(0, target), behavior: "auto" });
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

const DISCOVERY_PHOTO_MAX_BYTES = 350 * 1024;
const DISCOVERY_PHOTO_MAX_EDGE_PX = 1280;
const DISCOVERY_PHOTO_PREFIX = /^data:image\/(?:jpeg|png|webp);base64,/i;

function dataUrlByteLength(dataUrl) {
  const base64 = String(dataUrl || "").split(",")[1] || "";
  return Math.floor(base64.length * 3 / 4);
}

function safeDiscoveryPhotoDataUrl(dataUrl) {
  const value = String(dataUrl || "");
  return DISCOVERY_PHOTO_PREFIX.test(value) && dataUrlByteLength(value) <= DISCOVERY_PHOTO_MAX_BYTES ? value : null;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("写真を読み込めませんでした。"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onerror = () => reject(new Error("対応していない画像形式です。JPEG、PNG、WebPを選んでください。"));
    image.onload = () => resolve(image);
    image.src = dataUrl;
  });
}

async function prepareDiscoveryPhoto(file) {
  if (!file.type.startsWith("image/")) {
    throw new Error("画像ファイルを選んでください。");
  }
  const original = await readFileAsDataUrl(file);
  if (safeDiscoveryPhotoDataUrl(original)) {
    return { name: file.name || "discovery-photo", dataUrl: original };
  }

  const image = await loadImage(original);
  const scale = Math.min(1, DISCOVERY_PHOTO_MAX_EDGE_PX / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("この端末では写真を縮小できませんでした。");
  }
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  for (const quality of [0.8, 0.65, 0.5]) {
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    if (safeDiscoveryPhotoDataUrl(dataUrl)) {
      return { name: file.name || "discovery-photo.jpg", dataUrl };
    }
  }
  throw new Error("写真が大きすぎます。小さい画像を選んでください。");
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
