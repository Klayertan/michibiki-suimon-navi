// Field polygon & water-control-point annotation controller.
// Converts an already-recorded walked path (QZ1 or phone GPS points, already
// displayed elsewhere in the app) into a closed field polygon, and manages
// water-control-point markers (inlet/outlet/gate/sensor/photo) linked to a
// field by id. Mirrors the VegetationIntelligenceController /
// SatelliteAssuranceController pattern already used in this codebase: an ES
// module class with its own Leaflet layers, bound to panel elements by id,
// fed live data through constructor callbacks rather than duplicated state.
import { makeId } from "../gnss/gnss-store.js";
import {
  CLOSE_WARNING_MESSAGE,
  FEATURE_TYPE_LABELS,
  FIELD_POLYGON_STYLE,
  WATER_CONTROL_STYLES,
  WATER_CONTROL_TYPE_LABELS,
  buildField,
  buildMetadata,
  buildWaterControlPoint,
  evaluateClosure,
  isWaterControlType,
  nextFieldDefaults
} from "./field-annotation-core.js";

const ELEMENT_IDS = [
  "fieldSourceSelect", "fieldUseAllPointsCheckbox", "fieldRangeRow", "fieldStartPointSelect", "fieldEndPointSelect",
  "fieldAutoCloseThresholdInput", "fieldCreateButton", "fieldCreateMessage",
  "fieldCloseWarning", "fieldCloseWarningText", "fieldCloseConfirmButton", "fieldCloseCancelButton",
  "wcpAddTypeSelect", "wcpAddCurrentPositionButton", "wcpAddMapClickButton", "wcpAddMessage",
  "selFeatureEmpty", "selFeatureForm", "selFeatureTypeSelect", "selFeatureNameInput", "selFeatureIdInput",
  "selFeatureMemoInput", "selFeatureRelatedFieldSelect", "selFeatureSaveButton", "selFeatureDeleteButton", "selFeatureMessage",
  "fieldAnnotationLegend", "fieldAnnotationSummaryFields", "fieldAnnotationSummaryPoints"
];

export class FieldAnnotationController {
  constructor(options = {}) {
    this.map = options.map;
    this.getParsedPoints = options.getParsedPoints || (() => []);
    this.getPhonePoints = options.getPhonePoints || (() => []);
    this.getSourceLabel = options.getSourceLabel || (() => null);

    this.fields = [];
    this.waterControlPoints = [];
    this.selected = null; // reference into one of the two arrays above
    this.pendingClosure = null; // { coordinates, gapM } awaiting manual confirm
    this.pendingAddType = null; // water-control type awaiting a map click

    this.layers = { fields: L.layerGroup(), waterPoints: L.layerGroup() };
    this.elements = {};
  }

  mount() {
    ELEMENT_IDS.forEach((id) => { this.elements[id] = document.getElementById(id); });
    if (!this.elements.fieldCreateButton) {
      return;
    }
    this.populateStaticOptions();
    this.bindEvents();
    this.layers.fields.addTo(this.map);
    this.layers.waterPoints.addTo(this.map);
    this.map.on("click", (event) => this.handleMapClick(event));
    this.renderAll();
  }

  populateStaticOptions() {
    const typeSelect = this.elements.wcpAddTypeSelect;
    typeSelect.replaceChildren();
    Object.entries(WATER_CONTROL_TYPE_LABELS).forEach(([value, label]) => typeSelect.append(new Option(label, value)));

    const selType = this.elements.selFeatureTypeSelect;
    selType.replaceChildren();
    Object.entries(FEATURE_TYPE_LABELS).forEach(([value, label]) => selType.append(new Option(label, value)));
  }

  bindEvents() {
    const el = this.elements;
    el.fieldSourceSelect.addEventListener("change", () => this.renderRangeOptions());
    el.fieldUseAllPointsCheckbox.addEventListener("change", () => this.updateRangeVisibility());
    el.fieldCreateButton.addEventListener("click", () => this.handleCreateFieldClick());
    el.fieldCloseConfirmButton.addEventListener("click", () => this.confirmPendingClosure());
    el.fieldCloseCancelButton.addEventListener("click", () => this.cancelPendingClosure());
    el.wcpAddCurrentPositionButton.addEventListener("click", () => this.addWaterControlPointAtCurrentPosition());
    el.wcpAddMapClickButton.addEventListener("click", () => this.toggleMapClickAddMode());
    el.selFeatureSaveButton.addEventListener("click", () => this.saveSelectedFeature());
    el.selFeatureDeleteButton.addEventListener("click", () => this.deleteSelectedFeature());
  }

  // -------------------------------------------------------------------------
  // Create Field Polygon workflow
  // -------------------------------------------------------------------------

  // Raw (unfiltered) source points, in original order. Kept separate from
  // the lat/lon-tuple extraction so that the start/end dropdown indices
  // (built from this same raw array) always line up with the slice taken
  // from it — filtering out any invalid points only happens after slicing,
  // never before, so an occasional bad point can't shift the alignment
  // between "index shown in the dropdown" and "index actually sliced".
  rawSourcePoints() {
    const source = this.elements.fieldSourceSelect.value;
    return (source === "phone" ? this.getPhonePoints() : this.getParsedPoints()) || [];
  }

  renderRangeOptions() {
    const rawPoints = this.rawSourcePoints();
    [this.elements.fieldStartPointSelect, this.elements.fieldEndPointSelect].forEach((select) => select.replaceChildren());
    rawPoints.forEach((point, index) => {
      const time = point.timestamp ? String(point.timestamp).slice(0, 19) : `#${index + 1}`;
      const label = Number.isFinite(point.fixQuality) ? `${index + 1}: ${time} · fix ${point.fixQuality}` : `${index + 1}: ${time}`;
      this.elements.fieldStartPointSelect.append(new Option(label, String(index)));
      this.elements.fieldEndPointSelect.append(new Option(label, String(index)));
    });
    if (rawPoints.length > 0) {
      this.elements.fieldEndPointSelect.value = String(rawPoints.length - 1);
    }
  }

  updateRangeVisibility() {
    const useAll = this.elements.fieldUseAllPointsCheckbox.checked;
    this.elements.fieldRangeRow.hidden = useAll;
  }

  selectedRangeCoordinates() {
    const useAll = this.elements.fieldUseAllPointsCheckbox.checked;
    const raw = this.rawSourcePoints();
    const toCoordinates = (points) => points
      .map((point) => [Number(point.lat), Number(point.lon)])
      .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));
    if (useAll) {
      return toCoordinates(raw);
    }
    const startIndex = Number(this.elements.fieldStartPointSelect.value);
    const endIndex = Number(this.elements.fieldEndPointSelect.value);
    if (!Number.isFinite(startIndex) || !Number.isFinite(endIndex)) {
      return [];
    }
    const from = Math.min(startIndex, endIndex);
    const to = Math.max(startIndex, endIndex);
    return toCoordinates(raw.slice(from, to + 1));
  }

  handleCreateFieldClick() {
    const coordinates = this.selectedRangeCoordinates();
    const thresholdM = Math.max(0, Number(this.elements.fieldAutoCloseThresholdInput.value) || 5);
    const result = evaluateClosure(coordinates, thresholdM);
    if (!result.canClose) {
      this.setFieldCreateMessage(result.warnings.join(" "));
      return;
    }
    if (result.autoClose) {
      this.createField(coordinates, { gapM: result.gapM, closedManually: false });
      if (result.warnings.length > 0) {
        this.setFieldCreateMessage(result.warnings.join(" "));
      }
      return;
    }
    this.pendingClosure = { coordinates, gapM: result.gapM };
    this.elements.fieldCloseWarningText.textContent = `${CLOSE_WARNING_MESSAGE}（距離: 約${result.gapM.toFixed(1)}m）`;
    this.elements.fieldCloseWarning.hidden = false;
    this.setFieldCreateMessage("");
  }

  confirmPendingClosure() {
    if (!this.pendingClosure) {
      return;
    }
    this.createField(this.pendingClosure.coordinates, { gapM: this.pendingClosure.gapM, closedManually: true });
    this.cancelPendingClosure();
  }

  cancelPendingClosure() {
    this.pendingClosure = null;
    this.elements.fieldCloseWarning.hidden = true;
  }

  createField(coordinates, { gapM, closedManually }) {
    const defaults = nextFieldDefaults(this.fields.length);
    const field = buildField({
      id: defaults.id,
      name: defaults.name,
      coordinates,
      gapM,
      closedManually,
      sourcePointCount: coordinates.length
    });
    this.fields.push(field);
    this.setFieldCreateMessage(`${field.name}（${field.id}）を作成しました。`);
    this.selectFeature(field);
    this.renderAll();
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

  addWaterControlPointAtCurrentPosition() {
    const position = this.latestQz1Position();
    if (!position) {
      this.setWcpAddMessage("現在のQZ1位置がありません。QZ1データを読み込むか、ライブ接続してください。");
      return;
    }
    this.createWaterControlPoint(position.lat, position.lon, "qz1-current");
  }

  toggleMapClickAddMode() {
    if (this.pendingAddType) {
      this.pendingAddType = null;
      this.elements.wcpAddMapClickButton.textContent = "地図をクリックして追加";
      this.elements.wcpAddMapClickButton.classList.remove("active");
      this.setWcpAddMessage("");
      return;
    }
    this.pendingAddType = this.elements.wcpAddTypeSelect.value;
    this.elements.wcpAddMapClickButton.textContent = "地図をクリック…（キャンセルはもう一度クリック）";
    this.elements.wcpAddMapClickButton.classList.add("active");
    this.setWcpAddMessage(`地図をクリックして${WATER_CONTROL_TYPE_LABELS[this.pendingAddType] || ""}を配置してください。`);
  }

  handleMapClick(event) {
    if (!this.pendingAddType) {
      return;
    }
    const type = this.pendingAddType;
    this.createWaterControlPoint(event.latlng.lat, event.latlng.lng, "map-click", type);
    this.pendingAddType = null;
    this.elements.wcpAddMapClickButton.textContent = "地図をクリックして追加";
    this.elements.wcpAddMapClickButton.classList.remove("active");
  }

  createWaterControlPoint(lat, lon, positionSource, typeOverride) {
    const type = typeOverride || this.elements.wcpAddTypeSelect.value;
    const point = buildWaterControlPoint({
      id: makeId("wcp"),
      type,
      lat,
      lon,
      positionSource
    });
    this.waterControlPoints.push(point);
    this.setWcpAddMessage(`${WATER_CONTROL_TYPE_LABELS[point.type] || point.type} を追加しました。`);
    this.selectFeature(point);
    this.renderAll();
  }

  // -------------------------------------------------------------------------
  // Selected-feature editor
  // -------------------------------------------------------------------------

  selectFeature(feature) {
    this.selected = feature;
    // Only an explicit selection change clears the message box — a re-render
    // triggered by saving/deleting the *current* feature (via renderAll())
    // must not wipe out the confirmation it just set.
    this.setSelFeatureMessage("");
    this.renderSelectedFeature();
  }

  clearSelection() {
    this.selected = null;
    this.setSelFeatureMessage("");
    this.renderSelectedFeature();
  }

  saveSelectedFeature() {
    const feature = this.selected;
    if (!feature) {
      return;
    }
    const el = this.elements;
    const newId = el.selFeatureIdInput.value.trim();
    if (!newId) {
      this.setSelFeatureMessage("IDを入力してください。");
      return;
    }
    const collision = this.allFeatures().find((candidate) => candidate !== feature && candidate.id === newId);
    if (collision) {
      this.setSelFeatureMessage(`ID "${newId}" は既に使用されています。`);
      return;
    }

    feature.id = newId;
    feature.name = el.selFeatureNameInput.value;
    feature.memo = el.selFeatureMemoInput.value;
    if (feature.type !== "field") {
      const nextType = el.selFeatureTypeSelect.value;
      feature.type = isWaterControlType(nextType) ? nextType : feature.type;
      feature.relatedFieldId = el.selFeatureRelatedFieldSelect.value || null;
    }
    feature.updatedAt = new Date().toISOString();
    this.setSelFeatureMessage("保存しました。");
    this.renderAll();
  }

  deleteSelectedFeature() {
    const feature = this.selected;
    if (!feature) {
      return;
    }
    if (!window.confirm(`${feature.name || feature.id} を削除しますか？`)) {
      return;
    }
    if (feature.type === "field") {
      this.fields = this.fields.filter((candidate) => candidate !== feature);
      // Water-control points that pointed at the deleted field lose that
      // link rather than silently keeping a reference to nothing.
      this.waterControlPoints.forEach((point) => {
        if (point.relatedFieldId === feature.id) {
          point.relatedFieldId = null;
        }
      });
    } else {
      this.waterControlPoints = this.waterControlPoints.filter((candidate) => candidate !== feature);
    }
    this.clearSelection();
    this.renderAll();
  }

  allFeatures() {
    return [...this.fields, ...this.waterControlPoints];
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
    this.renderSelectedFeature();
  }

  renderMapLayers() {
    this.layers.fields.clearLayers();
    this.layers.waterPoints.clearLayers();

    this.fields.forEach((field) => {
      const polygon = L.polygon(field.coordinates, FIELD_POLYGON_STYLE)
        .bindTooltip(field.name || field.id, { permanent: true, direction: "center", className: "field-annotation-label" })
        .on("click", (event) => {
          event.originalEvent?.stopPropagation();
          this.selectFeature(field);
        });
      polygon.addTo(this.layers.fields);
    });

    this.waterControlPoints.forEach((point) => {
      const style = WATER_CONTROL_STYLES[point.type] || WATER_CONTROL_STYLES.gate;
      L.circleMarker([point.lat, point.lon], {
        radius: 8,
        color: "#ffffff",
        weight: 2,
        fillColor: style.fillColor,
        fillOpacity: 0.95
      })
        .bindTooltip(point.name || WATER_CONTROL_TYPE_LABELS[point.type] || point.type)
        .on("click", (event) => {
          event.originalEvent?.stopPropagation();
          this.selectFeature(point);
        })
        .addTo(this.layers.waterPoints);
    });
  }

  renderLegend() {
    const container = this.elements.fieldAnnotationLegend;
    if (!container) {
      return;
    }
    container.replaceChildren();
    const entries = [
      { label: FEATURE_TYPE_LABELS.field, color: FIELD_POLYGON_STYLE.fillColor },
      ...Object.entries(WATER_CONTROL_STYLES).map(([type, style]) => ({ label: WATER_CONTROL_TYPE_LABELS[type], color: style.fillColor }))
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
    setText(this.elements.fieldAnnotationSummaryPoints, String(this.waterControlPoints.length));
  }

  renderSelectedFeature() {
    const el = this.elements;
    const feature = this.selected;
    if (!feature) {
      el.selFeatureEmpty.hidden = false;
      el.selFeatureForm.hidden = true;
      return;
    }
    el.selFeatureEmpty.hidden = true;
    el.selFeatureForm.hidden = false;

    const isField = feature.type === "field";
    el.selFeatureTypeSelect.value = feature.type;
    el.selFeatureTypeSelect.disabled = isField;
    el.selFeatureNameInput.value = feature.name || "";
    el.selFeatureIdInput.value = feature.id || "";
    el.selFeatureMemoInput.value = feature.memo || "";

    el.selFeatureRelatedFieldSelect.replaceChildren(new Option("なし", ""));
    this.fields.forEach((candidateField) => {
      if (candidateField === feature) {
        return;
      }
      el.selFeatureRelatedFieldSelect.append(new Option(`${candidateField.name}（${candidateField.id}）`, candidateField.id));
    });
    el.selFeatureRelatedFieldSelect.disabled = isField;
    if (!isField) {
      el.selFeatureRelatedFieldSelect.value = feature.relatedFieldId || "";
    }
  }

  setFieldCreateMessage(message) {
    if (this.elements.fieldCreateMessage) {
      this.elements.fieldCreateMessage.textContent = message;
    }
  }

  setWcpAddMessage(message) {
    if (this.elements.wcpAddMessage) {
      this.elements.wcpAddMessage.textContent = message;
    }
  }

  setSelFeatureMessage(message) {
    if (this.elements.selFeatureMessage) {
      this.elements.selFeatureMessage.textContent = message;
    }
  }

  // -------------------------------------------------------------------------
  // Export / import (paddy-intelligence.js optional hooks)
  // -------------------------------------------------------------------------

  getExportData() {
    const points = this.getParsedPoints() || [];
    return {
      fields: this.fields,
      waterControlPoints: this.waterControlPoints,
      measurements: points,
      metadata: buildMetadata({ sourceFileName: this.getSourceLabel?.() || null, points })
    };
  }

  applyImportedProject(data) {
    const rawFields = Array.isArray(data?.fields) ? data.fields : [];
    const rawPoints = Array.isArray(data?.waterControlPoints) ? data.waterControlPoints : [];

    this.fields = rawFields
      .filter((raw) => Array.isArray(raw?.coordinates) && raw.coordinates.length >= 3)
      .map((raw) => buildField({
        id: raw.id || makeId("field"),
        name: raw.name,
        coordinates: raw.coordinates,
        memo: raw.memo,
        gapM: raw.closureGapM,
        closedManually: raw.closedManually,
        sourcePointCount: raw.sourcePointCount,
        nowIso: raw.createdAt || new Date().toISOString()
      }));

    this.fields.forEach((field, index) => {
      const original = rawFields[index];
      if (original?.updatedAt) {
        field.updatedAt = original.updatedAt;
      }
    });

    this.waterControlPoints = rawPoints
      .filter((raw) => Number.isFinite(Number(raw?.lat)) && Number.isFinite(Number(raw?.lon)))
      .map((raw) => buildWaterControlPoint({
        id: raw.id || makeId("wcp"),
        name: raw.name,
        type: raw.type,
        lat: raw.lat,
        lon: raw.lon,
        relatedFieldId: raw.relatedFieldId,
        memo: raw.memo,
        positionSource: raw.positionSource || "import",
        nowIso: raw.createdAt || new Date().toISOString()
      }));

    this.clearSelection();
    this.renderAll();
  }
}

function setText(element, value) {
  if (element) {
    element.textContent = value;
  }
}
