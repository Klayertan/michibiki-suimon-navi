// The 水位センサー card: DOM plumbing for sensor management.
//
// WHAT LIVES HERE AND WHAT DOES NOT
// ---------------------------------
// Here: elements, clicks, view switching, and turning a model into text.
// Not here: what "online" means, whether a depth may be shown, which field is
// suggested, whether a setting is valid. Those are in sensor-view-model.js,
// sensor-settings.js, calibration.js and the detection modules, where they are
// unit tested without a browser.
//
// FOUR VIEWS, ONE AT A TIME
// -------------------------
// list → add → settings → data, mutually exclusive inside one card. The
// alternative — every panel permanently visible — would push the map off the
// screen and bury the four questions the normal view exists to answer: which
// sensor, which field, connected, current reading. Deeper information is one
// click away, not always on.
//
// SECURITY
// --------
// Sensor display names, field names and imported metadata are farmer- or
// device-supplied strings. Every one of them reaches the DOM through
// `textContent` or `createTextNode`. There is no `innerHTML` with
// interpolated data anywhere in this file.

import {
  FloatingSensorRegistry,
  nextAvailableSensorId,
  normalizeSensorId,
  sensorDisplayName
} from "./sensor-registry.js";
import {
  DEVICE_MODELS,
  CALIBRATION_STATES,
  MEASUREMENT_QUALITY,
  defaultSensorSettings,
  deviceModelFor,
  normalizeDeviceModel,
  validateSettingsPatch
} from "./sensor-settings.js";
import { PRESET_FILTER_CHAINS } from "./altitude-filters.js";
import {
  TRANSPORT_DESCRIPTORS,
  TRANSPORT_PREFERENCE_AUTO,
  describeTransports
} from "./sensor-transport.js";
import {
  detectCapabilities,
  refineBluetoothAvailability
} from "./platform-capabilities.js";
import {
  CONNECTION_STATES,
  buildSensorListModel,
  buildSensorModel
} from "./sensor-view-model.js";
import { buildCalibration, summarizeValidation } from "./calibration.js";
import { fieldDisplayName } from "./field-boundary.js";

const ELEMENT_IDS = [
  "waterSensorCard",
  "wsmListView", "wsmAddButton", "wsmSensorList", "wsmEmptyState",
  "wsmPlatformMatrix", "wsmPlatformNote",
  "wsmWizardView", "wsmWizardBackButton", "wsmWizardStepLabel",
  "wsmStep1", "wsmStep2", "wsmStep3", "wsmStep4", "wsmStep5",
  "wsmNewSensorId", "wsmNewDisplayName", "wsmNewDeviceModel",
  "wsmWizardTransports",
  "wsmWizardSuggestion", "wsmWizardSuggestedField", "wsmWizardSuggestedConsistency",
  "wsmWizardUseSuggestion", "wsmWizardFieldSelect",
  "wsmWizardFilterProfile", "wsmWizardMinSatellites", "wsmWizardMaxHdop",
  "wsmWizardReview", "wsmWizardError",
  "wsmWizardPrevButton", "wsmWizardNextButton", "wsmWizardFinishButton",
  "wsmSettingsView", "wsmSettingsBackButton", "wsmSettingsTitle",
  "wsmSettingsSensorId", "wsmSettingsDisplayName", "wsmSettingsDeviceModel",
  "wsmSettingsFieldSelect", "wsmSettingsAssignmentNote",
  "wsmSettingsTransport", "wsmSettingsOnlineTimeout",
  "wsmSettingsConnection", "wsmSettingsLastSeen",
  "wsmSettingsCalibrationState", "wsmSettingsCalibratedAt", "wsmSettingsCalibrationNote",
  "wsmCalibrationDepth", "wsmCalibrationAltitude", "wsmCalibrateButton",
  "wsmClearCalibrationButton", "wsmCalibrationError",
  "wsmSettingsFilterProfile", "wsmSettingsMinSatellites", "wsmSettingsMaxHdop",
  "wsmSettingsShowDepth", "wsmSettingsError", "wsmSettingsMessage",
  "wsmSettingsSaveButton", "wsmSettingsDataButton", "wsmSettingsDeleteButton",
  "wsmDataView", "wsmDataBackButton", "wsmDataTitle",
  "wsmDataField", "wsmDataConnection",
  "wsmDataAltitude", "wsmDataRelative", "wsmDataDepth", "wsmDataDepthNote",
  "wsmDataDecision",
  "wsmDataLatitude", "wsmDataLongitude", "wsmDataFix",
  "wsmDataQuality", "wsmDataQualityReasons",
  "wsmDataDetectedField", "wsmDataAssignedField", "wsmDataConsistency",
  "wsmDataMovedWarning", "wsmDataMovedDetail", "wsmDataSettingsButton"
];

const VIEWS = ["list", "wizard", "settings", "data"];
const WIZARD_STEPS = 5;

export class SensorManagementController {
  constructor(options = {}) {
    this.registry = options.registry || new FloatingSensorRegistry({ storage: options.storage ?? null });
    this.getFields = options.getFields || (() => []);
    /** Live snapshot for the sensor currently receiving fixes, or null. */
    this.getLiveState = options.getLiveState || (() => null);
    this.getRelativeDisplacementMm = options.getRelativeDisplacementMm || (() => null);
    /** Existing water-management evaluation. Never reimplemented here. */
    this.evaluateWaterDecision = options.evaluateWaterDecision || (() => null);
    this.onAssignmentChanged = options.onAssignmentChanged || (() => {});
    this.capabilities = options.capabilities ?? null;
    this.confirm = options.confirm || ((message) => globalThis.confirm?.(message) === true);
    /**
     * The vertical-displacement analysis that licenses a depth claim, or null.
     *
     * Supplied by whoever owns the experiment. Null is the honest default and
     * the normal state of this project: until the controlled 0/10/…/100 mm
     * run has actually been performed, no calibration may license an absolute
     * depth, and calibration.js enforces that independently of this class.
     */
    this.getCalibrationValidation = options.getCalibrationValidation || (() => null);

    this.view = "list";
    this.activeSensorId = null;
    this.wizardStep = 1;
    this.wizardDraft = null;
    this.elements = {};
    this.tickTimer = null;
  }

  mount() {
    ELEMENT_IDS.forEach((id) => { this.elements[id] = document.getElementById(id); });
    if (!this.elements.wsmSensorList) {
      return false;
    }
    this.registry.hydrate();
    if (!this.capabilities) {
      this.capabilities = detectCapabilities({
        storage: typeof localStorage === "undefined" ? null : localStorage,
        cloudConfigured: Boolean(globalThis.SUISUI_CLOUD_CONFIG?.supabaseUrl)
      });
    }
    // The radio check is async; the card renders immediately on the
    // synchronous answer and refines afterwards rather than blocking boot.
    refineBluetoothAvailability(this.capabilities)
      .then((refined) => { this.capabilities = refined; this.render(); })
      .catch(() => {});

    this.populateStaticControls();
    this.bindEvents();
    this.registry.addEventListener("change", () => this.render());
    // "Last seen" ages and the online dot go stale with no new event.
    this.tickTimer = setInterval(() => this.renderTick(), 1000);
    this.render();
    return true;
  }

  unmount() {
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  populateStaticControls() {
    for (const id of ["wsmNewDeviceModel", "wsmSettingsDeviceModel"]) {
      const select = this.elements[id];
      if (!select || select.options.length > 0) continue;
      for (const model of Object.values(DEVICE_MODELS)) {
        select.append(new Option(model.labelJa, model.id));
      }
    }
    for (const id of ["wsmWizardFilterProfile", "wsmSettingsFilterProfile"]) {
      const select = this.elements[id];
      if (!select || select.options.length > 0) continue;
      for (const name of Object.keys(PRESET_FILTER_CHAINS)) {
        select.append(new Option(name, name));
      }
    }
  }

  bindEvents() {
    const on = (id, event, handler) => this.elements[id]?.addEventListener(event, handler);
    on("wsmAddButton", "click", () => this.startWizard());
    on("wsmWizardBackButton", "click", () => this.showView("list"));
    on("wsmWizardPrevButton", "click", () => this.moveWizard(-1));
    on("wsmWizardNextButton", "click", () => this.moveWizard(1));
    on("wsmWizardFinishButton", "click", () => this.finishWizard());
    on("wsmWizardUseSuggestion", "click", () => this.acceptWizardSuggestion());
    on("wsmSettingsBackButton", "click", () => this.showView("list"));
    on("wsmSettingsSaveButton", "click", () => this.saveSettings());
    on("wsmSettingsDataButton", "click", () => this.showView("data"));
    on("wsmSettingsDeleteButton", "click", () => this.deleteSensor());
    on("wsmCalibrateButton", "click", () => this.calibrate());
    on("wsmClearCalibrationButton", "click", () => this.clearCalibration());
    on("wsmDataBackButton", "click", () => this.showView("list"));
    on("wsmDataSettingsButton", "click", () => this.showView("settings"));
  }

  // -------------------------------------------------------------------------
  // View switching
  // -------------------------------------------------------------------------

  showView(view) {
    this.view = VIEWS.includes(view) ? view : "list";
    this.render();
    return this.view;
  }

  openSensor(sensorId, view = "settings") {
    const sensor = this.registry.get(sensorId);
    if (!sensor) {
      return false;
    }
    this.activeSensorId = sensor.sensorId;
    this.showView(view);
    return true;
  }

  // -------------------------------------------------------------------------
  // Models
  // -------------------------------------------------------------------------

  liveStateFor(sensorId) {
    const live = this.getLiveState();
    return live && live.sensorId === sensorId ? live : null;
  }

  listModel(nowMs = Date.now()) {
    return buildSensorListModel({
      sensors: this.registry.list(),
      fields: this.currentFields(),
      liveStateFor: (id) => this.liveStateFor(id),
      capabilities: this.capabilities,
      relativeDisplacementMm: this.getRelativeDisplacementMm(),
      nowMs
    });
  }

  activeModel(nowMs = Date.now()) {
    const sensor = this.registry.get(this.activeSensorId);
    if (!sensor) {
      return null;
    }
    return buildSensorModel({
      sensor,
      fields: this.currentFields(),
      liveState: this.liveStateFor(sensor.sensorId),
      capabilities: this.capabilities,
      relativeDisplacementMm: this.liveStateFor(sensor.sensorId) ? this.getRelativeDisplacementMm() : null,
      nowMs
    });
  }

  currentFields() {
    const fields = this.getFields() || [];
    return Array.isArray(fields) ? fields : [];
  }

  // -------------------------------------------------------------------------
  // Wizard
  // -------------------------------------------------------------------------

  startWizard() {
    this.wizardStep = 1;
    this.wizardDraft = {
      sensorId: nextAvailableSensorId(this.registry.list().map((sensor) => sensor.sensorId)),
      displayName: "",
      deviceModel: normalizeDeviceModel(null),
      transportPreference: TRANSPORT_PREFERENCE_AUTO,
      assignedFieldId: "",
      settings: defaultSensorSettings()
    };
    this.showView("wizard");
  }

  /** Reads the current step's inputs into the draft. */
  captureWizardStep() {
    const draft = this.wizardDraft;
    if (!draft) return;
    if (this.wizardStep === 1) {
      draft.sensorId = this.elements.wsmNewSensorId?.value ?? draft.sensorId;
      draft.displayName = this.elements.wsmNewDisplayName?.value ?? "";
      draft.deviceModel = normalizeDeviceModel(this.elements.wsmNewDeviceModel?.value);
    } else if (this.wizardStep === 3) {
      draft.assignedFieldId = this.elements.wsmWizardFieldSelect?.value ?? "";
    } else if (this.wizardStep === 4) {
      draft.settings.quality.filterProfile = this.elements.wsmWizardFilterProfile?.value ?? "none";
      draft.settings.quality.minSatellites = Number(this.elements.wsmWizardMinSatellites?.value);
      draft.settings.quality.maxHdop = Number(this.elements.wsmWizardMaxHdop?.value);
    }
  }

  moveWizard(delta) {
    this.captureWizardStep();
    const next = this.wizardStep + delta;
    if (delta > 0) {
      const error = this.validateWizardStep();
      if (error) {
        this.setWizardError(error);
        return this.wizardStep;
      }
    }
    this.setWizardError("");
    this.wizardStep = Math.min(WIZARD_STEPS, Math.max(1, next));
    this.render();
    return this.wizardStep;
  }

  validateWizardStep() {
    const draft = this.wizardDraft;
    if (this.wizardStep === 1) {
      const id = normalizeSensorId(draft.sensorId);
      if (!id) {
        return "センサーIDが不正です。英数字・ハイフン・アンダースコアのみ使用できます。";
      }
      if (this.registry.get(id)) {
        return `センサーID ${id} は既に登録されています。`;
      }
    }
    if (this.wizardStep === 4) {
      const { errors } = validateSettingsPatch(draft.settings, {
        quality: {
          filterProfile: draft.settings.quality.filterProfile,
          minSatellites: draft.settings.quality.minSatellites,
          maxHdop: draft.settings.quality.maxHdop
        }
      });
      if (errors.length > 0) {
        return errors.join(" / ");
      }
    }
    return null;
  }

  acceptWizardSuggestion() {
    const live = this.getLiveState();
    const suggested = live?.detectedFieldId;
    if (!suggested || !this.elements.wsmWizardFieldSelect) {
      return;
    }
    this.elements.wsmWizardFieldSelect.value = suggested;
    this.wizardDraft.assignedFieldId = suggested;
    this.render();
  }

  finishWizard() {
    this.captureWizardStep();
    const draft = this.wizardDraft;
    const id = normalizeSensorId(draft.sensorId);
    if (!id) {
      this.setWizardError("センサーIDが不正です。");
      return null;
    }
    const { sensor, error, alreadyRegistered } = this.registry.register({
      sensorId: id,
      displayName: draft.displayName,
      deviceModel: draft.deviceModel,
      settings: draft.settings
    });
    if (error) {
      this.setWizardError(error);
      return null;
    }
    if (alreadyRegistered) {
      this.setWizardError(`センサーID ${id} は既に登録されています。`);
      return null;
    }
    this.registry.updateSettings(id, {
      ...draft.settings,
      acquisition: { ...draft.settings.acquisition, transportPreference: draft.transportPreference }
    });
    // Assignment is an explicit act even inside the wizard: the farmer chose a
    // field on step 3 and is confirming it here.
    if (draft.assignedFieldId) {
      this.registry.assign(id, draft.assignedFieldId, { note: "registered via sensor wizard" });
      this.onAssignmentChanged();
    }
    this.activeSensorId = sensor.sensorId;
    this.wizardDraft = null;
    this.showView("list");
    return sensor;
  }

  setWizardError(text) {
    const box = this.elements.wsmWizardError;
    if (!box) return;
    box.textContent = text ?? "";
    box.hidden = !text;
  }

  // -------------------------------------------------------------------------
  // Settings actions
  // -------------------------------------------------------------------------

  saveSettings() {
    const sensor = this.registry.get(this.activeSensorId);
    if (!sensor) return null;

    const patch = {
      acquisition: {
        transportPreference: this.elements.wsmSettingsTransport?.value,
        onlineTimeoutMs: Number(this.elements.wsmSettingsOnlineTimeout?.value) * 1000
      },
      quality: {
        filterProfile: this.elements.wsmSettingsFilterProfile?.value,
        minSatellites: Number(this.elements.wsmSettingsMinSatellites?.value),
        maxHdop: Number(this.elements.wsmSettingsMaxHdop?.value)
      },
      display: { showAbsoluteDepth: Boolean(this.elements.wsmSettingsShowDepth?.checked) }
    };
    const { settings, errors } = validateSettingsPatch(sensor.settings, patch);
    if (!settings) {
      this.setSettingsError(errors.join(" / "));
      return null;
    }
    this.setSettingsError("");
    this.registry.rename(sensor.sensorId, this.elements.wsmSettingsDisplayName?.value ?? "");
    this.registry.setDeviceModel(sensor.sensorId, this.elements.wsmSettingsDeviceModel?.value);
    this.registry.updateSettings(sensor.sensorId, settings);
    this.applyFieldSelection(sensor);
    this.setSettingsMessage("保存しました。");
    return this.registry.get(sensor.sensorId);
  }

  /**
   * Applies a field change from the settings select.
   *
   * Reassignment is deliberate: it asks first, naming both the current and the
   * proposed paddy. A mis-click here would silently re-file every future
   * measurement under the wrong field, and the sensor may already be
   * calibrated against the old one.
   */
  applyFieldSelection(sensor) {
    const chosen = this.elements.wsmSettingsFieldSelect?.value ?? "";
    const current = sensor.assignedFieldId ?? "";
    if (chosen === current) {
      return;
    }
    const fields = this.currentFields();
    const nameFor = (id) => {
      const field = fields.find((candidate) => String(candidate.id) === String(id));
      return field ? `${fieldDisplayName(field)} / ${id}` : String(id);
    };
    if (!chosen) {
      if (!this.confirm(`${sensorDisplayName(sensor)} の割当を解除しますか？\n\n現在: ${nameFor(current)}\n\n過去の測定記録の圃場IDは変更されません。`)) {
        return;
      }
      this.registry.unassign(sensor.sensorId);
      this.onAssignmentChanged();
      return;
    }
    const message = current
      ? `このセンサーの割当圃場を変更しますか？\n\n現在:\n${nameFor(current)}\n\n変更後:\n${nameFor(chosen)}\n\n過去の測定記録の圃場IDは変更されません。`
      : `${sensorDisplayName(sensor)} を ${nameFor(chosen)} に割り当てますか？`;
    if (!this.confirm(message)) {
      return;
    }
    this.registry.assign(sensor.sensorId, chosen, { note: "changed from sensor settings" });
    this.onAssignmentChanged();
  }

  /**
   * Takes a calibration from a ruler reading plus the current GNSS altitude.
   *
   * The arithmetic is `calibration.js`'s, not this file's. What happens here
   * is collecting the two inputs and refusing when either is missing —
   * fabricating a baseline from a stale altitude would produce a depth that
   * looks authoritative and is not.
   */
  calibrate() {
    const sensor = this.registry.get(this.activeSensorId);
    if (!sensor) return null;
    const live = this.liveStateFor(sensor.sensorId);
    const altitudeM = live?.altitudeM;
    const depthMm = Number(this.elements.wsmCalibrationDepth?.value);

    if (!Number.isFinite(altitudeM)) {
      this.setCalibrationError("現在のGNSS標高がありません。センサーが受信中であることを確認してください。");
      return null;
    }
    if (!Number.isFinite(depthMm)) {
      this.setCalibrationError("実測水深を入力してください。");
      return null;
    }
    // No validating vertical-displacement experiment is attached here, so
    // calibration.js will still refuse to derive a depth. That refusal is
    // correct and is shown to the farmer rather than worked around: this
    // project has not yet demonstrated that GNSS altitude resolves a
    // water-level change at all. See EXPERIMENT.md.
    const { calibration, errors } = buildCalibration({
      baselineAltitudeMm: altitudeM * 1000,
      knownDepthMm: depthMm,
      deviceId: sensor.sensorId,
      experimentId: `field-calibration-${sensor.sensorId}`,
      fieldId: sensor.assignedFieldId,
      validation: this.getCalibrationValidation() ?? null,
      notes: "設定画面からの実測入力"
    });
    if (!calibration) {
      this.setCalibrationError(errors.join(" / "));
      return null;
    }
    this.setCalibrationError("");
    this.registry.setCalibration(sensor.sensorId, calibration);
    this.setSettingsMessage("較正を保存しました。");
    return calibration;
  }

  clearCalibration() {
    const sensor = this.registry.get(this.activeSensorId);
    if (!sensor?.calibration) return;
    if (!this.confirm(`${sensorDisplayName(sensor)} の較正を解除しますか？`)) {
      return;
    }
    this.registry.setCalibration(sensor.sensorId, null);
    this.setSettingsMessage("較正を解除しました。");
  }

  deleteSensor() {
    const sensor = this.registry.get(this.activeSensorId);
    if (!sensor) return;
    if (!this.confirm(`${sensorDisplayName(sensor)} (${sensor.sensorId}) を削除しますか？\n\nこの操作は取り消せません。`)) {
      return;
    }
    this.registry.remove(sensor.sensorId);
    this.activeSensorId = null;
    this.showView("list");
  }

  setSettingsError(text) {
    const box = this.elements.wsmSettingsError;
    if (!box) return;
    box.textContent = text ?? "";
    box.hidden = !text;
  }

  setSettingsMessage(text) {
    if (this.elements.wsmSettingsMessage) {
      this.elements.wsmSettingsMessage.textContent = text ?? "";
    }
  }

  setCalibrationError(text) {
    const box = this.elements.wsmCalibrationError;
    if (!box) return;
    box.textContent = text ?? "";
    box.hidden = !text;
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  /** Cheap per-second refresh: only the views that show ages. */
  renderTick() {
    if (this.view === "list" || this.view === "data" || this.view === "settings") {
      this.render();
    }
  }

  render() {
    if (!this.elements.wsmSensorList) return;
    const show = (id, visible) => { if (this.elements[id]) this.elements[id].hidden = !visible; };
    show("wsmListView", this.view === "list");
    show("wsmWizardView", this.view === "wizard");
    show("wsmSettingsView", this.view === "settings");
    show("wsmDataView", this.view === "data");

    if (this.view === "list") this.renderList();
    if (this.view === "wizard") this.renderWizard();
    if (this.view === "settings") this.renderSettings();
    if (this.view === "data") this.renderData();
  }

  renderList() {
    const container = this.elements.wsmSensorList;
    const models = this.listModel();
    container.replaceChildren();
    if (this.elements.wsmEmptyState) {
      this.elements.wsmEmptyState.hidden = models.length > 0;
    }
    for (const model of models) {
      container.append(this.buildSensorCard(model));
    }
    this.renderPlatformMatrix();
  }

  /** One compact card. Deliberately five facts, not fifteen. */
  buildSensorCard(model) {
    const card = document.createElement("article");
    card.className = `wsm-sensor-card${model.movedWarning ? " wsm-sensor-card-warning" : ""}`;
    card.setAttribute("role", "listitem");

    const header = document.createElement("div");
    header.className = "wsm-card-header";
    const title = document.createElement("h4");
    title.className = "wsm-card-title";
    title.textContent = model.displayName;
    const status = document.createElement("span");
    status.className = `wsm-status wsm-status-${model.connection}`;
    // Never colour alone: the dot carries a text label beside it.
    status.append(dot(model.connection), document.createTextNode(model.connectionLabelJa));
    header.append(title, status);

    const subtitle = document.createElement("p");
    subtitle.className = "wsm-card-subtitle";
    subtitle.textContent = `${model.deviceLabel} · ${model.sensorId}`;

    const rows = document.createElement("div");
    rows.className = "wsm-card-rows";
    rows.append(kv("圃場", model.assignedFieldId
      ? `${model.assignedFieldName ?? "—"} / ${model.assignedFieldId}${model.assignedFieldMissing ? "（未登録）" : ""}`
      : "未設定"));
    // The three quantities stay distinct even in the compact card: a depth is
    // shown only when licensed, and otherwise the relative figure is labelled
    // as relative rather than being quietly promoted.
    if (Number.isFinite(model.depthMm)) {
      rows.append(kv("現在水位", `${model.depthMm.toFixed(0)} mm`));
    } else if (Number.isFinite(model.relativeDisplacementMm)) {
      rows.append(kv("相対高度変化", `${signed(model.relativeDisplacementMm)} mm`));
    } else {
      rows.append(kv("現在水位", "—"));
    }
    if (Number.isFinite(model.detectionConsistency)) {
      rows.append(kv("検出一貫性", `${Math.round(model.detectionConsistency * 100)}%`));
    }

    const actions = document.createElement("div");
    actions.className = "wsm-card-actions";
    const settingsButton = document.createElement("button");
    settingsButton.type = "button";
    settingsButton.className = "panel-button";
    settingsButton.textContent = "設定";
    settingsButton.addEventListener("click", () => this.openSensor(model.sensorId, "settings"));
    const dataButton = document.createElement("button");
    dataButton.type = "button";
    dataButton.className = "panel-button";
    dataButton.textContent = "データを見る";
    dataButton.addEventListener("click", () => this.openSensor(model.sensorId, "data"));
    actions.append(settingsButton, dataButton);

    card.append(header, subtitle, rows);
    if (model.movedWarning) {
      const warning = document.createElement("p");
      warning.className = "wsm-card-warning-text";
      warning.textContent = `⚠ 移動の可能性: 検出 ${model.detectedFieldId ?? "—"} / 割当 ${model.assignedFieldId ?? "—"}`;
      card.append(warning);
    }
    card.append(actions);
    return card;
  }

  renderPlatformMatrix() {
    const container = this.elements.wsmPlatformMatrix;
    if (!container) return;
    container.replaceChildren();
    for (const transport of describeTransports(this.capabilities)) {
      const row = document.createElement("div");
      row.className = "kv";
      const label = document.createElement("span");
      label.textContent = transport.labelJa;
      const value = document.createElement("strong");
      value.className = transport.available ? "wsm-available" : "wsm-unavailable";
      value.textContent = transport.available ? "利用可能" : `利用不可（${transport.reasonTextJa}）`;
      row.append(label, value);
      container.append(row);
    }
    if (this.elements.wsmPlatformNote) {
      // The honest iOS message: a route is missing, the application is not.
      this.elements.wsmPlatformNote.textContent = this.capabilities?.iosLikeBluetoothBlock
        ? "iPhone/iPadのブラウザは直接接続用のAPIに対応していません。NMEAファイル読込またはクラウド経由でご利用ください。センサーが故障しているわけではありません。"
        : "接続方法はブラウザと端末の対応状況によって変わります。";
    }
  }

  renderWizard() {
    const draft = this.wizardDraft;
    if (!draft) return;
    for (let step = 1; step <= WIZARD_STEPS; step += 1) {
      const element = this.elements[`wsmStep${step}`];
      if (element) element.hidden = step !== this.wizardStep;
    }
    if (this.elements.wsmWizardStepLabel) {
      this.elements.wsmWizardStepLabel.textContent = `ステップ ${this.wizardStep} / ${WIZARD_STEPS}`;
    }
    setValue(this.elements.wsmNewSensorId, draft.sensorId);
    setValue(this.elements.wsmNewDisplayName, draft.displayName);
    setValue(this.elements.wsmNewDeviceModel, draft.deviceModel);
    setValue(this.elements.wsmWizardFilterProfile, draft.settings.quality.filterProfile);
    setValue(this.elements.wsmWizardMinSatellites, draft.settings.quality.minSatellites);
    setValue(this.elements.wsmWizardMaxHdop, draft.settings.quality.maxHdop);

    if (this.wizardStep === 2) this.renderWizardTransports();
    if (this.wizardStep === 3) this.renderWizardField();
    if (this.wizardStep === 5) this.renderWizardReview();

    if (this.elements.wsmWizardPrevButton) this.elements.wsmWizardPrevButton.disabled = this.wizardStep === 1;
    if (this.elements.wsmWizardNextButton) this.elements.wsmWizardNextButton.hidden = this.wizardStep === WIZARD_STEPS;
    if (this.elements.wsmWizardFinishButton) this.elements.wsmWizardFinishButton.hidden = this.wizardStep !== WIZARD_STEPS;
  }

  renderWizardTransports() {
    const container = this.elements.wsmWizardTransports;
    if (!container) return;
    container.replaceChildren();
    const device = deviceModelFor(this.wizardDraft.deviceModel);

    const auto = this.buildTransportOption({
      value: TRANSPORT_PREFERENCE_AUTO,
      labelJa: "自動（この端末で使える最良の方法）",
      descriptionJa: "端末を変えても同じセンサー設定がそのまま使えます。",
      available: true
    });
    container.append(auto);

    for (const transport of describeTransports(this.capabilities)) {
      // Hardware capability AND browser capability. A QZ1 has no GATT profile
      // here, so Bluetooth is not offered for it even in a browser that
      // supports Web Bluetooth.
      const supportedByDevice = device.transports.includes(transport.kind);
      if (!supportedByDevice) continue;
      container.append(this.buildTransportOption({
        value: transport.kind,
        labelJa: transport.labelJa,
        descriptionJa: transport.available
          ? transport.descriptionJa
          : `利用不可（${transport.reasonTextJa}）`,
        available: transport.available
      }));
    }
  }

  buildTransportOption({ value, labelJa, descriptionJa, available }) {
    const wrapper = document.createElement("label");
    wrapper.className = `wsm-transport-option${available ? "" : " wsm-transport-unavailable"}`;
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "wsm-transport";
    input.value = value;
    input.disabled = !available;
    input.checked = this.wizardDraft.transportPreference === value;
    input.addEventListener("change", () => { this.wizardDraft.transportPreference = value; });
    const text = document.createElement("span");
    const strong = document.createElement("strong");
    strong.textContent = labelJa;
    const description = document.createElement("span");
    description.className = "meta";
    description.textContent = descriptionJa;
    text.append(strong, description);
    wrapper.append(input, text);
    return wrapper;
  }

  renderWizardField() {
    const select = this.elements.wsmWizardFieldSelect;
    if (select) {
      this.fillFieldOptions(select, this.wizardDraft.assignedFieldId);
    }
    const live = this.getLiveState();
    const suggestion = this.elements.wsmWizardSuggestion;
    const hasSuggestion = Boolean(live?.detectedFieldId);
    if (suggestion) suggestion.hidden = !hasSuggestion;
    if (hasSuggestion) {
      const field = this.currentFields().find((candidate) => String(candidate.id) === String(live.detectedFieldId));
      setText(this.elements.wsmWizardSuggestedField,
        field ? `${fieldDisplayName(field)} / ${live.detectedFieldId}` : String(live.detectedFieldId));
      setText(this.elements.wsmWizardSuggestedConsistency,
        Number.isFinite(live.fieldDetectionConfidence) ? `${Math.round(live.fieldDetectionConfidence * 100)}%` : "—");
    }
  }

  renderWizardReview() {
    const container = this.elements.wsmWizardReview;
    if (!container) return;
    const draft = this.wizardDraft;
    const field = this.currentFields().find((candidate) => String(candidate.id) === String(draft.assignedFieldId));
    container.replaceChildren(
      kv("センサーID", draft.sensorId),
      kv("表示名", draft.displayName || "（未設定）"),
      kv("機種", deviceModelFor(draft.deviceModel).labelJa),
      kv("接続方法", draft.transportPreference === TRANSPORT_PREFERENCE_AUTO
        ? "自動"
        : TRANSPORT_DESCRIPTORS[draft.transportPreference]?.labelJa ?? draft.transportPreference),
      kv("割当圃場", field ? `${fieldDisplayName(field)} / ${field.id}` : "未設定"),
      kv("フィルタ", draft.settings.quality.filterProfile),
      kv("最小衛星数", String(draft.settings.quality.minSatellites)),
      kv("HDOP上限", String(draft.settings.quality.maxHdop)),
      kv("較正", "未較正（登録後に設定できます）")
    );
  }

  renderSettings() {
    const model = this.activeModel();
    if (!model) {
      this.showView("list");
      return;
    }
    setText(this.elements.wsmSettingsTitle, `${model.displayName} の設定`);
    setText(this.elements.wsmSettingsSensorId, model.sensorId);
    setValueIfUnfocused(this.elements.wsmSettingsDisplayName, model.displayName);
    setValue(this.elements.wsmSettingsDeviceModel, model.deviceModel);
    this.fillFieldOptions(this.elements.wsmSettingsFieldSelect, model.assignedFieldId ?? "");
    setText(this.elements.wsmSettingsAssignmentNote, model.assignedFieldMissing
      ? "割り当てられた圃場が見つかりません（削除された可能性があります）。"
      : "圃場を変更すると確認を求めます。過去の測定記録の圃場IDは変更されません。");

    this.fillTransportOptions(this.elements.wsmSettingsTransport, model);
    setValueIfUnfocused(this.elements.wsmSettingsOnlineTimeout,
      String(Math.round(model.settings.acquisition.onlineTimeoutMs / 1000)));
    setText(this.elements.wsmSettingsConnection, model.connectionLabelJa);
    setText(this.elements.wsmSettingsLastSeen, formatAge(model.lastSeenAtMs));

    setText(this.elements.wsmSettingsCalibrationState, model.calibrationLabelJa);
    setText(this.elements.wsmSettingsCalibratedAt, model.calibratedAtMs
      ? new Date(model.calibratedAtMs).toLocaleString("ja-JP")
      : "—");
    setText(this.elements.wsmSettingsCalibrationNote, model.calibrationState === CALIBRATION_STATES.CALIBRATED
      ? "較正済みです。ただし絶対水深の表示は、鉛直変位実験による裏付けがある場合にのみ行われます。"
      : "較正するまで絶対水深は表示されず、相対高度変化のみを表示します。");
    setText(this.elements.wsmCalibrationAltitude,
      Number.isFinite(model.altitudeM) ? `${model.altitudeM.toFixed(3)} m` : "—（受信待ち）");
    if (this.elements.wsmClearCalibrationButton) {
      this.elements.wsmClearCalibrationButton.disabled = model.calibrationState === CALIBRATION_STATES.UNCALIBRATED;
    }

    setValueIfUnfocused(this.elements.wsmSettingsFilterProfile, model.settings.quality.filterProfile);
    setValueIfUnfocused(this.elements.wsmSettingsMinSatellites, String(model.settings.quality.minSatellites));
    setValueIfUnfocused(this.elements.wsmSettingsMaxHdop, String(model.settings.quality.maxHdop));
    if (this.elements.wsmSettingsShowDepth && document.activeElement !== this.elements.wsmSettingsShowDepth) {
      this.elements.wsmSettingsShowDepth.checked = model.settings.display.showAbsoluteDepth;
    }
  }

  renderData() {
    const model = this.activeModel();
    if (!model) {
      this.showView("list");
      return;
    }
    setText(this.elements.wsmDataTitle, `${model.displayName}`);
    setText(this.elements.wsmDataField, model.assignedFieldId
      ? `${model.assignedFieldName ?? "—"} / ${model.assignedFieldId}`
      : "未設定");
    setText(this.elements.wsmDataConnection, model.connectionLabelJa);

    setText(this.elements.wsmDataAltitude, Number.isFinite(model.altitudeM) ? `${model.altitudeM.toFixed(3)} m` : "—");
    setText(this.elements.wsmDataRelative, Number.isFinite(model.relativeDisplacementMm)
      ? `${signed(model.relativeDisplacementMm)} mm`
      : "—");
    // Three distinct states, three distinct labels. A farmer who has just
    // calibrated must not be told "未較正" -- the calibration exists; what is
    // missing is the experimental evidence that GNSS altitude can resolve a
    // water-level change at all, and the note below says exactly that.
    setText(this.elements.wsmDataDepth, Number.isFinite(model.depthMm)
      ? `${model.depthMm.toFixed(0)} mm ± ${model.depthUncertaintyMm?.toFixed(0) ?? "?"} mm`
      : (model.calibrationState === CALIBRATION_STATES.UNCALIBRATED ? "未較正" : "表示できません"));
    setText(this.elements.wsmDataDepthNote, model.depthBlockedReason ?? "");

    this.renderDecision(model);

    setText(this.elements.wsmDataLatitude, Number.isFinite(model.latitude) ? model.latitude.toFixed(8) : "—");
    setText(this.elements.wsmDataLongitude, Number.isFinite(model.longitude) ? model.longitude.toFixed(8) : "—");
    const live = this.liveStateFor(model.sensorId);
    setText(this.elements.wsmDataFix, live
      ? `${live.fixQuality ?? "—"} / ${live.satellites ?? "—"} / ${live.hdop ?? "—"}`
      : "—");
    setText(this.elements.wsmDataQuality, qualityLabel(model.measurementQuality));
    setText(this.elements.wsmDataQualityReasons, model.measurementQualityReasons.join(" / "));

    setText(this.elements.wsmDataDetectedField, model.detectedFieldId
      ? `${model.detectedFieldName ?? "—"} / ${model.detectedFieldId}`
      : "—");
    setText(this.elements.wsmDataAssignedField, model.assignedFieldId ?? "—");
    setText(this.elements.wsmDataConsistency, Number.isFinite(model.detectionConsistency)
      ? `${Math.round(model.detectionConsistency * 100)}%`
      : "—");
    if (this.elements.wsmDataMovedWarning) {
      this.elements.wsmDataMovedWarning.hidden = !model.movedWarning;
    }
    if (model.movedWarning) {
      setText(this.elements.wsmDataMovedDetail,
        `割当 ${model.assignedFieldId} ／ 検出 ${model.detectedFieldId ?? "—"}。割当は自動では変更していません。`);
    }
  }

  /**
   * The agronomic verdict, from the EXISTING water-management engine.
   *
   * This controller supplies measurement evidence and nothing else: no
   * threshold, no target depth and no recommendation is computed here. When
   * there is no calibrated depth there is no evidence to supply, and the
   * section says so rather than feeding a relative displacement into a model
   * that expects an absolute one.
   */
  renderDecision(model) {
    const container = this.elements.wsmDataDecision;
    if (!container) return;
    container.replaceChildren();
    if (!Number.isFinite(model.depthMm)) {
      const note = document.createElement("p");
      note.className = "meta";
      note.textContent = "較正済みの水深がないため、水管理の判定は行えません。相対高度変化は水深ではありません。";
      container.append(note);
      return;
    }
    const decision = this.evaluateWaterDecision({
      fieldId: model.assignedFieldId,
      depthMm: model.depthMm,
      measuredAtMs: model.lastSeenAtMs
    });
    if (!decision) {
      const note = document.createElement("p");
      note.className = "meta";
      note.textContent = "この圃場の目標水位が設定されていないため判定できません。";
      container.append(note);
      return;
    }
    container.append(kv("現在水深", `${model.depthMm.toFixed(0)} mm`));
    if (decision.targetText) container.append(kv("目標水深", decision.targetText));
    if (decision.verdictText) container.append(kv("判定", decision.verdictText));
  }

  fillFieldOptions(select, selectedId) {
    if (!select) return;
    select.replaceChildren();
    select.append(new Option("未設定", ""));
    for (const field of this.currentFields()) {
      select.append(new Option(`${fieldDisplayName(field)} / ${field.id}`, String(field.id)));
    }
    select.value = selectedId ?? "";
  }

  fillTransportOptions(select, model) {
    if (!select) return;
    const previous = select.value;
    select.replaceChildren();
    select.append(new Option("自動", TRANSPORT_PREFERENCE_AUTO));
    const device = deviceModelFor(model.deviceModel);
    for (const transport of describeTransports(this.capabilities)) {
      if (!device.transports.includes(transport.kind)) continue;
      const label = transport.available
        ? transport.labelJa
        : `${transport.labelJa}（利用不可: ${transport.reasonTextJa}）`;
      const option = new Option(label, transport.kind);
      option.disabled = !transport.available;
      select.append(option);
    }
    select.value = previous || model.settings.acquisition.transportPreference;
  }
}

// ---------------------------------------------------------------------------
// Small DOM helpers. textContent throughout — see the header.
// ---------------------------------------------------------------------------

function kv(label, value) {
  const row = document.createElement("div");
  row.className = "kv";
  const key = document.createElement("span");
  key.textContent = label;
  const strong = document.createElement("strong");
  strong.textContent = String(value);
  row.append(key, strong);
  return row;
}

function dot(connection) {
  const span = document.createElement("span");
  span.className = `wsm-dot wsm-dot-${connection}`;
  span.setAttribute("aria-hidden", "true");
  return span;
}

function setText(element, text) {
  if (element) element.textContent = text ?? "";
}

function setValue(element, value) {
  if (element) element.value = value === null || value === undefined ? "" : String(value);
}

/** Never clobbers what someone is typing mid-edit (the 1 Hz re-render). */
function setValueIfUnfocused(element, value) {
  if (element && document.activeElement !== element) {
    element.value = value === null || value === undefined ? "" : String(value);
  }
}

function signed(value) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(0)}`;
}

function formatAge(timestampMs) {
  if (!Number.isFinite(timestampMs)) return "—";
  const seconds = Math.round((Date.now() - timestampMs) / 1000);
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分前`;
  return new Date(timestampMs).toLocaleString("ja-JP");
}

function qualityLabel(quality) {
  switch (quality) {
    case MEASUREMENT_QUALITY.VALID: return "有効";
    case MEASUREMENT_QUALITY.REJECTED: return "品質基準を満たさない";
    case MEASUREMENT_QUALITY.INSUFFICIENT: return "データ不足";
    default: return String(quality);
  }
}

export { CONNECTION_STATES, summarizeValidation };
