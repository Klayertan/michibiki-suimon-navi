// DOM wiring for the QZ1 float's identity and its field assignment.
//
// Lives inside the existing QZ1 水位実験 card (index.html) rather than on a
// page of its own: a farmer installing a float is doing one job, and the
// altitude readout and the "which paddy is this in" readout are two views of
// the same device at the same moment.
//
// INDEPENDENT OF THE ALTITUDE EXPERIMENT, ON PURPOSE
// --------------------------------------------------
// This controller shares the parsed GNSS fix with
// experiment-controller.js and shares nothing else. index.html hands the same
// `point` to both; neither calls the other for anything a decision depends on.
//
// That is a requirement, not a tidiness preference. Whether GNSS ALTITUDE can
// resolve a 10 mm water-level change is an open question this project may well
// answer with "no". Whether GNSS LATITUDE/LONGITUDE can tell which 30 m × 30 m
// paddy a float is sitting in is a different question with a different answer,
// and horizontal positioning is the part GNSS is actually good at. If the
// altitude experiment fails completely, everything in this file still works.
//
// The one link that does exist runs the other way and is display-only: the
// map popup shows the current relative displacement when the experiment
// controller happens to have one. It is read through an injected getter that
// may return null, and nothing here branches on it.
//
// All decisions live in the pure modules beside this one — field-detection.js
// (containment), detection-window.js (jitter), sensor-registry.js (identity,
// state machine, movement). This file owns elements, timers and clicks.

import { DETECTION_STATUS, detectFieldForPosition } from "./field-detection.js";
import { fieldBoundaryCoordinates, fieldDisplayName, findFieldById } from "./field-boundary.js";
import {
  DEFAULT_CANDIDATE_THRESHOLD,
  DEFAULT_WINDOW_SIZE,
  FieldDetectionWindow
} from "./detection-window.js";
import {
  ASSIGNMENT_STATES,
  DEFAULT_MOVEMENT_THRESHOLD,
  FloatingSensorRegistry,
  MovementWatch,
  buildSensorMeasurement,
  canAssignFromDetection,
  deriveAssignmentStatus,
  nextAvailableSensorId,
  normalizeSensorId
} from "./sensor-registry.js";

const ELEMENT_IDS = [
  "wlxSensorIdInput", "wlxSensorRegisterButton", "wlxSensorOnlineDot", "wlxSensorOnlineLabel",
  "wlxSensorLatitude", "wlxSensorLongitude", "wlxSensorAltitude", "wlxSensorLastSeen",
  "wlxDetectedField", "wlxDetectionConfidence", "wlxDetectionSamples",
  "wlxAssignedField", "wlxAssignmentStatus",
  "wlxAssignButton", "wlxUnassignButton", "wlxSensorMessage",
  "wlxAmbiguousList", "wlxMovementWarning", "wlxMovementDetail",
  "wlxFieldSensorList", "wlxSensorDebug"
];

/** A fix older than this stops counting the sensor as online. */
export const DEFAULT_ONLINE_TIMEOUT_MS = 15000;

export const ASSIGNMENT_STATUS_LABELS = {
  [ASSIGNMENT_STATES.UNASSIGNED]: "未割り当て",
  [ASSIGNMENT_STATES.DETECTING]: "検出中…",
  [ASSIGNMENT_STATES.CANDIDATE]: "候補あり（未確定）",
  [ASSIGNMENT_STATES.LOCKED]: "確定（LOCKED）",
  [ASSIGNMENT_STATES.OUTSIDE_KNOWN_FIELDS]: "登録圃場の外",
  [ASSIGNMENT_STATES.AMBIGUOUS]: "圃場が重複（判定不能）",
  [ASSIGNMENT_STATES.MOVED_WARNING]: "⚠ 移動の可能性"
};

export class SensorFieldController {
  constructor(options = {}) {
    this.map = options.map ?? null;
    this.getFields = options.getFields || (() => []);
    // Display-only, may return null. See the header.
    this.getRelativeDisplacementMm = options.getRelativeDisplacementMm || (() => null);
    this.onAssignmentChanged = options.onAssignmentChanged || (() => {});

    this.registry = options.registry || new FloatingSensorRegistry({ storage: options.storage ?? null });
    this.window = new FieldDetectionWindow({
      windowSize: options.windowSize ?? DEFAULT_WINDOW_SIZE,
      candidateThreshold: options.candidateThreshold ?? DEFAULT_CANDIDATE_THRESHOLD
    });
    this.movement = new MovementWatch({
      threshold: options.movementThreshold ?? DEFAULT_MOVEMENT_THRESHOLD
    });
    this.onlineTimeoutMs = options.onlineTimeoutMs ?? DEFAULT_ONLINE_TIMEOUT_MS;

    this.activeSensorId = null;
    this.lastFix = null;          // { latitude, longitude, altitudeM, atMs }
    this.lastDetection = null;    // raw detectFieldForPosition() result
    this.lastWindowSummary = null;
    this.lastMovementSummary = this.movement.summary();
    /** Identity of the field set the window's votes were cast against. */
    this.fieldSignature = "";

    this.elements = {};
    this.tickTimer = null;
    this.markerLayer = null;
  }

  mount() {
    ELEMENT_IDS.forEach((id) => { this.elements[id] = document.getElementById(id); });
    if (!this.elements.wlxSensorIdInput) {
      return false;
    }
    this.registry.hydrate();

    // Its own layer group on the SHARED map — the same arrangement
    // vegetation-controller.js and paddy-intelligence.js already use. No
    // second map, and no edits to field-annotation-controller's layers.
    if (this.map && typeof L !== "undefined") {
      this.markerLayer = L.layerGroup().addTo(this.map);
    }

    this.elements.wlxSensorIdInput.value =
      this.registry.list()[0]?.sensorId ?? nextAvailableSensorId(this.registry.list().map((s) => s.sensorId));
    this.useSensor(this.elements.wlxSensorIdInput.value);

    this.bindEvents();
    this.registry.addEventListener("change", () => this.render());
    // The online indicator and the "last seen" age go stale on their own, with
    // no new fix to trigger a render.
    this.tickTimer = setInterval(() => this.render(), 1000);
    this.render();
    return true;
  }

  unmount() {
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.markerLayer?.remove();
  }

  bindEvents() {
    const on = (id, event, handler) => this.elements[id]?.addEventListener(event, handler);
    on("wlxSensorIdInput", "change", () => this.handleSensorIdChanged());
    on("wlxSensorRegisterButton", "click", () => this.handleRegister());
    on("wlxAssignButton", "click", () => this.handleAssign());
    on("wlxUnassignButton", "click", () => this.handleUnassign());
  }

  // -------------------------------------------------------------------------
  // Live position in
  // -------------------------------------------------------------------------

  /**
   * One parsed GNSS fix, from index.html's single serial pipeline.
   *
   * `point` is the shared parser's point ({ lat, lon, altitude, … }). This is
   * the SAME object handed to the altitude experiment; nothing is re-parsed.
   */
  ingestLiveFix(point, receivedAtMs = Date.now()) {
    if (!point) {
      return null;
    }
    // finiteOrNull, NOT Number(): `Number(null)` and `Number("")` are both 0,
    // and 0 is a perfectly valid latitude, longitude and altitude. Coercing
    // here would turn a fix with no position into a confident one in the Gulf
    // of Guinea -- which detectFieldForPosition() would then dutifully report
    // as "outside every field", and that vote would dilute the window against
    // the paddy the float is actually sitting in. A missing altitude would
    // likewise become sea level. Absent has to stay absent all the way to the
    // strict validity check in field-detection.js.
    const latitude = finiteOrNull(point.lat);
    const longitude = finiteOrNull(point.lon);
    const altitudeM = finiteOrNull(point.altitude);

    this.lastFix = { latitude, longitude, altitudeM, atMs: receivedAtMs };

    const fields = this.currentFields();
    this.resetWindowIfFieldsChanged(fields);

    this.lastDetection = detectFieldForPosition({ latitude, longitude, fields });
    this.lastWindowSummary = this.window.push(this.lastDetection);

    const sensor = this.activeSensor();
    this.lastMovementSummary = this.movement.update(sensor?.assignedFieldId ?? null, this.lastWindowSummary);

    if (sensor) {
      this.registry.recordPosition(sensor.sensorId, {
        latitude, longitude, altitudeM, at: new Date(receivedAtMs).toISOString()
      });
      this.registry.updateStatus(sensor.sensorId, {
        assignmentStatus: this.derivedStatus(),
        detectedFieldId: this.lastWindowSummary.detectedFieldId,
        confidence: this.lastWindowSummary.confidence,
        candidateFieldIds: this.lastDetection.fieldIds
      });
      // Deliberately NOT persisted on every fix: at 1 Hz that would be a
      // localStorage write per second for a value nothing depends on being
      // durable. Identity and assignment — the things that must survive a
      // reload — are persisted by register()/assign()/unassign() instead.
    }

    this.render();
    return this.snapshot();
  }

  /**
   * The window's votes are only meaningful against the map they were cast on.
   * When the farmer registers, edits or deletes a field, the old votes are
   * evidence about a different set of polygons, so they are discarded rather
   * than blended with the new ones.
   */
  resetWindowIfFieldsChanged(fields) {
    const signature = fields
      .map((field) => ({ id: field?.id ?? null, coordinates: fieldBoundaryCoordinates(field) }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      .map((field) => JSON.stringify(field))
      .join("|");
    if (signature !== this.fieldSignature) {
      this.fieldSignature = signature;
      this.window.reset();
      this.movement.reset();
      this.lastWindowSummary = this.window.summarize();
      this.lastMovementSummary = this.movement.summary();
    }
  }

  currentFields() {
    const fields = this.getFields() || [];
    return Array.isArray(fields) ? fields : [];
  }

  activeSensor() {
    return this.activeSensorId ? this.registry.get(this.activeSensorId) : null;
  }

  derivedStatus() {
    return deriveAssignmentStatus({
      sensor: this.activeSensor() ?? { assignedFieldId: null },
      windowSummary: this.lastWindowSummary,
      movementSummary: this.lastMovementSummary
    });
  }

  /**
   * Everything the live state exposes, in one object.
   *
   * This is the extension the milestone asks for: the same live fix now yields
   * sensor identity and field association alongside the altitude figures the
   * experiment card already showed.
   */
  snapshot(nowMs = Date.now()) {
    const sensor = this.activeSensor();
    const summary = this.lastWindowSummary;
    return {
      sensorId: this.activeSensorId,
      registered: Boolean(sensor),
      latitude: this.lastFix?.latitude ?? null,
      longitude: this.lastFix?.longitude ?? null,
      altitudeM: this.lastFix?.altitudeM ?? null,
      lastSeenAtMs: this.lastFix?.atMs ?? null,
      online: this.isOnline(nowMs),
      detectedFieldId: summary?.detectedFieldId ?? null,
      fieldDetectionConfidence: summary?.confidence ?? null,
      detectionStatus: this.lastDetection?.status ?? null,
      candidateFieldIds: this.lastDetection?.fieldIds ?? [],
      assignedFieldId: sensor?.assignedFieldId ?? null,
      assignmentStatus: this.derivedStatus(),
      movement: this.lastMovementSummary
    };
  }

  isOnline(nowMs = Date.now()) {
    return Number.isFinite(this.lastFix?.atMs) && (nowMs - this.lastFix.atMs) <= this.onlineTimeoutMs;
  }

  /**
   * A measurement record stamped with the field assigned RIGHT NOW.
   *
   * Callers that persist readings use this so history stays truthful: a
   * reading taken while the float was in FIELD-003 keeps saying FIELD-003
   * after the float is moved to FIELD-005.
   */
  buildMeasurement({ relativeHeightMm = null, timestamp = new Date().toISOString() } = {}) {
    const sensor = this.activeSensor();
    if (!sensor) {
      return null;
    }
    return buildSensorMeasurement({
      sensor,
      relativeHeightMm,
      altitudeM: this.lastFix?.altitudeM ?? null,
      latitude: this.lastFix?.latitude ?? null,
      longitude: this.lastFix?.longitude ?? null,
      timestamp
    });
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /**
   * Points the card at a sensor id.
   *
   * Switching device clears the window and the movement run: those votes were
   * cast about a different piece of hardware, and that run belongs to a
   * different assignment. Returns false for an unusable id rather than
   * inventing one.
   */
  useSensor(sensorId) {
    const id = normalizeSensorId(sensorId);
    if (!id) {
      return false;
    }
    if (id !== this.activeSensorId) {
      this.activeSensorId = id;
      this.window.reset();
      this.movement.reset();
      this.lastWindowSummary = this.window.summarize();
      this.lastMovementSummary = this.movement.summary();
    }
    return true;
  }

  handleSensorIdChanged() {
    const raw = this.elements.wlxSensorIdInput.value;
    if (!this.useSensor(raw)) {
      this.setMessage("センサIDが不正です。英数字・ハイフン・アンダースコアのみ使用できます（例 QZ1-FLOAT-001）。");
      this.render();
      return;
    }
    this.setMessage(this.registry.get(this.activeSensorId) ? "" : "このセンサIDはまだ登録されていません。");
    this.render();
  }

  handleRegister() {
    const id = normalizeSensorId(this.elements.wlxSensorIdInput.value);
    if (!id) {
      this.setMessage("センサIDが不正です（例 QZ1-FLOAT-001）。");
      return;
    }
    const { sensor, error, alreadyRegistered } = this.registry.register({ sensorId: id });
    if (error) {
      this.setMessage(error);
      return;
    }
    this.activeSensorId = sensor.sensorId;
    this.setMessage(alreadyRegistered
      ? `${sensor.sensorId} は登録済みです。`
      : `${sensor.sensorId} を登録しました。圃場への割り当てはまだ行われていません。`);
    this.render();
  }

  /**
   * The one confirmation step: detect automatically, confirm once, lock.
   *
   * Assigns to the field the WINDOW settled on, never to the latest single
   * sample — pressing the button at the instant of a jitter spike must not be
   * able to lock the wrong paddy.
   */
  handleAssign() {
    const summary = this.lastWindowSummary;
    if (!summary?.detectedFieldId) {
      this.setMessage("確定した検出結果がありません。安定するまで待ってください。");
      return;
    }
    const id = normalizeSensorId(this.elements.wlxSensorIdInput.value);
    if (!id) {
      this.setMessage("センサIDが不正です（例 QZ1-FLOAT-001）。");
      return;
    }
    this.registry.register({ sensorId: id });
    this.activeSensorId = id;

    const field = findFieldById(this.currentFields(), summary.detectedFieldId);
    const { sensor, error } = this.registry.assign(id, summary.detectedFieldId, {
      note: `detection confidence ${(summary.confidence * 100).toFixed(0)}%`
    });
    if (error) {
      this.setMessage(error);
      return;
    }
    // The run of mismatches (if any) belonged to the previous assignment.
    this.movement.reset();
    this.lastMovementSummary = this.movement.summary();
    this.setMessage(`${sensor.sensorId} を ${fieldDisplayName(field) || summary.detectedFieldId} に割り当てました。`);
    this.onAssignmentChanged(this.snapshot());
    this.render();
  }

  handleUnassign() {
    const sensor = this.activeSensor();
    if (!sensor?.assignedFieldId) {
      return;
    }
    this.registry.unassign(sensor.sensorId);
    this.movement.reset();
    this.lastMovementSummary = this.movement.summary();
    this.setMessage(`${sensor.sensorId} の割り当てを解除しました。過去の測定記録の圃場IDは変更しません。`);
    this.onAssignmentChanged(this.snapshot());
    this.render();
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  render() {
    if (!this.elements.wlxSensorIdInput) {
      return;
    }
    const nowMs = Date.now();
    const snapshot = this.snapshot(nowMs);
    const fields = this.currentFields();
    const set = (id, text) => { if (this.elements[id]) this.elements[id].textContent = text; };

    // --- device ---
    const online = snapshot.online;
    if (this.elements.wlxSensorOnlineDot) {
      this.elements.wlxSensorOnlineDot.className = `wlx-dot ${online ? "wlx-dot-online" : "wlx-dot-offline"}`;
    }
    set("wlxSensorOnlineLabel", snapshot.registered
      ? (online ? "オンライン" : "受信なし")
      : (online ? "受信中（未登録）" : "未登録・受信なし"));

    // --- GNSS. Eight decimals: at this latitude the 8th is ~1 mm, so the
    // display never rounds away motion the detection layer can see. ---
    set("wlxSensorLatitude", Number.isFinite(snapshot.latitude) ? snapshot.latitude.toFixed(8) : "—");
    set("wlxSensorLongitude", Number.isFinite(snapshot.longitude) ? snapshot.longitude.toFixed(8) : "—");
    set("wlxSensorAltitude", Number.isFinite(snapshot.altitudeM) ? `${snapshot.altitudeM.toFixed(3)} m` : "—");
    set("wlxSensorLastSeen", Number.isFinite(snapshot.lastSeenAtMs)
      ? `${Math.round((nowMs - snapshot.lastSeenAtMs) / 1000)} 秒前`
      : "—");

    // --- detection ---
    set("wlxDetectedField", this.detectedFieldText(fields));
    set("wlxDetectionConfidence", this.lastWindowSummary
      ? `${Math.round(this.lastWindowSummary.confidence * 100)}%`
      : "—");
    set("wlxDetectionSamples", this.lastWindowSummary
      ? `${this.lastWindowSummary.sampleCount} / ${this.lastWindowSummary.windowSize} 件`
      + (this.lastWindowSummary.rejectedSampleCount > 0
        ? `（除外 ${this.lastWindowSummary.rejectedSampleCount} 件）`
        : "")
      : "—");

    // Overlapping polygons: the ids are listed instead of one being chosen.
    const ambiguous = this.lastDetection?.status === DETECTION_STATUS.AMBIGUOUS;
    if (this.elements.wlxAmbiguousList) {
      this.elements.wlxAmbiguousList.hidden = !ambiguous;
      this.elements.wlxAmbiguousList.textContent = ambiguous
        ? this.lastDetection.candidates.map((candidate) => `${candidate.id}（${candidate.name}）`).join(" / ")
        : "";
    }

    // --- assignment ---
    const assignedField = findFieldById(fields, snapshot.assignedFieldId);
    set("wlxAssignedField", snapshot.assignedFieldId
      ? `${snapshot.assignedFieldId}${assignedField ? `（${fieldDisplayName(assignedField)}）` : "（未登録の圃場ID）"}`
      : "—");
    set("wlxAssignmentStatus", ASSIGNMENT_STATUS_LABELS[snapshot.assignmentStatus] ?? snapshot.assignmentStatus);

    const canAssign = canAssignFromDetection({
      sensor: this.activeSensor() ?? { assignedFieldId: null },
      windowSummary: this.lastWindowSummary
    });
    if (this.elements.wlxAssignButton) {
      this.elements.wlxAssignButton.disabled = !canAssign;
      this.elements.wlxAssignButton.textContent = canAssign
        ? `${this.lastWindowSummary.detectedFieldId} に割り当てる`
        : "この圃場に割り当てる";
    }
    if (this.elements.wlxUnassignButton) {
      this.elements.wlxUnassignButton.disabled = !snapshot.assignedFieldId;
    }

    // --- movement warning ---
    const movement = this.lastMovementSummary;
    const warn = snapshot.assignmentStatus === ASSIGNMENT_STATES.MOVED_WARNING;
    if (this.elements.wlxMovementWarning) {
      this.elements.wlxMovementWarning.hidden = !warn;
    }
    if (warn) {
      const detectedField = findFieldById(fields, movement.mismatchFieldId);
      set("wlxMovementDetail",
        `割り当て: ${snapshot.assignedFieldId}`
        + `${assignedField ? `（${fieldDisplayName(assignedField)}）` : ""}`
        + ` ／ 検出: ${movement.mismatchFieldId}`
        + `${detectedField ? `（${fieldDisplayName(detectedField)}）` : ""}`
        + ` ／ ${movement.consecutiveMismatches} 回連続（しきい値 ${movement.threshold}）。`
        + " 割り当ては自動では変更していません。移動した場合のみ、割り当てを解除して付け直してください。");
    }

    this.renderFieldSensorList(fields);
    this.renderDebug();
    this.renderMarker();
  }

  detectedFieldText(fields) {
    const summary = this.lastWindowSummary;
    if (!summary || summary.totalSampleCount === 0) {
      return "—（測位待ち）";
    }
    if (!summary.decided) {
      return "検出中…";
    }
    switch (summary.status) {
      case "candidate": {
        const field = findFieldById(fields, summary.detectedFieldId);
        return `${summary.detectedFieldId}${field ? `（${fieldDisplayName(field)}）` : ""}`;
      }
      case "outside-known-fields":
        // Never "the nearest field": containment and proximity are different
        // questions and only one of them was asked.
        return "登録圃場の外";
      case "ambiguous":
        return "重複（判定不能）";
      default:
        return "検出中…";
    }
  }

  /**
   * The assigned floating sensors for the field currently detected/assigned —
   * the lightweight version of "show sensors on the field panel". The full
   * registered-fields card is left untouched; see the docs for why that is a
   * follow-up rather than part of this milestone.
   */
  renderFieldSensorList(fields) {
    const container = this.elements.wlxFieldSensorList;
    if (!container) {
      return;
    }
    const snapshot = this.snapshot();
    const fieldId = snapshot.assignedFieldId ?? snapshot.detectedFieldId;
    container.innerHTML = "";
    if (!fieldId) {
      container.hidden = true;
      return;
    }
    const sensors = this.registry.listForField(fieldId);
    container.hidden = sensors.length === 0;
    if (sensors.length === 0) {
      return;
    }
    const field = findFieldById(fields, fieldId);
    const heading = document.createElement("p");
    heading.className = "meta";
    heading.textContent = `${fieldId}${field ? `（${fieldDisplayName(field)}）` : ""} に割り当て済みのセンサ`;
    container.append(heading);

    const relativeMm = this.getRelativeDisplacementMm();
    for (const sensor of sensors) {
      const row = document.createElement("div");
      row.className = "kv";
      const label = document.createElement("span");
      label.textContent = sensor.sensorId;
      const value = document.createElement("strong");
      const isActive = sensor.sensorId === this.activeSensorId;
      value.textContent = isActive && Number.isFinite(relativeMm)
        ? `${this.isOnline() ? "● " : "○ "}相対ΔZ ${relativeMm >= 0 ? "+" : ""}${relativeMm.toFixed(0)} mm`
        : `${isActive && this.isOnline() ? "● オンライン" : "○ 受信なし"}`;
      row.append(label, value);
      container.append(row);
    }
  }

  renderDebug() {
    const box = this.elements.wlxSensorDebug;
    if (!box) {
      return;
    }
    const detection = this.lastDetection;
    const summary = this.lastWindowSummary;
    const lines = [
      `detection status : ${detection?.status ?? "—"}`,
      `containing fields: ${(detection?.fieldIds ?? []).join(", ") || "—"}`,
      `polygons checked : ${detection?.checkedFieldCount ?? 0}`,
      `invalid polygons : ${(detection?.invalidFieldIds ?? []).join(", ") || "—"}`,
      `geometry engine  : ${detection?.engine ?? "—"}`,
      `window           : ${summary?.sampleCount ?? 0}/${summary?.windowSize ?? 0}`
      + ` threshold ${summary?.candidateThreshold ?? "—"}`,
      `window counts    : ${summary ? JSON.stringify(summary.counts) : "—"}`,
      `movement run     : ${this.lastMovementSummary.consecutiveMismatches}/${this.lastMovementSummary.threshold}`
      + ` (${this.lastMovementSummary.mismatchFieldId ?? "—"})`
    ];
    box.textContent = lines.join("\n");
  }

  /**
   * The float as a marker on the SHARED map. Own layer group, no changes to
   * anyone else's layers, and nothing is drawn until there is a real position.
   */
  renderMarker() {
    if (!this.markerLayer || typeof L === "undefined") {
      return;
    }
    this.markerLayer.clearLayers();
    const fix = this.lastFix;
    if (!Number.isFinite(fix?.latitude) || !Number.isFinite(fix?.longitude)) {
      return;
    }
    const snapshot = this.snapshot();
    const warned = snapshot.assignmentStatus === ASSIGNMENT_STATES.MOVED_WARNING;
    L.circleMarker([fix.latitude, fix.longitude], {
      radius: 9,
      color: "#ffffff",
      weight: 2,
      fillColor: warned ? "#dc2626" : (snapshot.assignedFieldId ? "#2563eb" : "#64748b"),
      fillOpacity: 0.95,
      className: "wlx-sensor-marker"
    })
      .bindTooltip(snapshot.sensorId || "QZ1 float")
      .bindPopup(this.buildMarkerPopup(snapshot))
      .addTo(this.markerLayer);
  }

  buildMarkerPopup(snapshot) {
    const fields = this.currentFields();
    const assigned = findFieldById(fields, snapshot.assignedFieldId);
    const relativeMm = this.getRelativeDisplacementMm();
    const rows = [
      ["センサID", snapshot.sensorId ?? "—"],
      ["状態", ASSIGNMENT_STATUS_LABELS[snapshot.assignmentStatus] ?? snapshot.assignmentStatus],
      ["緯度", Number.isFinite(snapshot.latitude) ? snapshot.latitude.toFixed(8) : "—"],
      ["経度", Number.isFinite(snapshot.longitude) ? snapshot.longitude.toFixed(8) : "—"],
      ["標高", Number.isFinite(snapshot.altitudeM) ? `${snapshot.altitudeM.toFixed(3)} m` : "—"],
      ["検出圃場", this.detectedFieldText(fields)],
      ["検出一貫性（直近サンプルの一致率）", this.lastWindowSummary ? `${Math.round(this.lastWindowSummary.confidence * 100)}%` : "—"],
      ["割り当て圃場", snapshot.assignedFieldId
        ? `${snapshot.assignedFieldId}${assigned ? `（${fieldDisplayName(assigned)}）` : ""}`
        : "—"],
      // Display-only, and absent whenever the experiment has no baseline. The
      // label repeats that this is a displacement, not a water depth.
      ["相対ΔZ（水深ではありません）", Number.isFinite(relativeMm)
        ? `${relativeMm >= 0 ? "+" : ""}${relativeMm.toFixed(0)} mm`
        : "—"],
      ["最終受信", Number.isFinite(snapshot.lastSeenAtMs)
        ? new Date(snapshot.lastSeenAtMs).toLocaleTimeString("ja-JP")
        : "—"]
    ];
    // textContent throughout: field names are farmer-entered text and must
    // never be interpolated into markup.
    const container = document.createElement("div");
    container.className = "wlx-sensor-popup";
    for (const [label, value] of rows) {
      const row = document.createElement("div");
      row.className = "kv";
      const key = document.createElement("span");
      key.textContent = label;
      const val = document.createElement("strong");
      val.textContent = String(value);
      row.append(key, val);
      container.append(row);
    }
    return container;
  }

  setMessage(text) {
    if (this.elements.wlxSensorMessage) {
      this.elements.wlxSensorMessage.textContent = text;
    }
  }
}

/**
 * A number, or null. Rejects null/undefined/"" BEFORE coercion — see the
 * comment in ingestLiveFix() for what goes wrong otherwise.
 */
function finiteOrNull(value) {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) {
    return null;
  }
  if (typeof value !== "number" && typeof value !== "string") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
