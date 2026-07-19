// QZ1 Android/desktop field-recording controller.
// Owns a recording state machine that is deliberately independent from the
// serial connection state machine in index.html: connecting to QZ1 never
// implicitly starts a permanent recording session, and this controller only
// learns about connection changes through handleConnectionStateChange /
// ingestSerialLine / noteSerialByte hooks that index.html calls explicitly.
//
// All recorded data is written incrementally to IndexedDB (recording-store.js)
// through a small, bounded in-memory queue — the queue is a short-lived
// buffer, never the only copy, so a crash/refresh/BT-drop cannot erase
// already-flushed data.
import {
  DEFAULT_DIAGNOSTIC_THRESHOLDS_MS,
  DEFAULT_FIX_STALE_MS,
  DEFAULT_IMAGE_MAX_BYTES,
  DEFAULT_IMAGE_MAX_DIMENSION_PX,
  DEFAULT_IMAGE_QUALITY,
  OBSERVATION_TYPES,
  buildMarkedObservation,
  canTransitionRecording,
  classifySerialDiagnostics,
  formatBytes,
  makeObservationId,
  makeSessionId,
  markedObservationsToCsv,
  recordingFilename,
  structuredFixesToCsv,
  validateObservationCreation,
  verifyNmeaChecksum
} from "./recording-core.js";
import { QuotaExceededStorageError, RecordingStore } from "./recording-store.js";

const ELEMENT_IDS = [
  "recPanel", "recRecordingStateLabel", "recConnectionNote", "recSessionIdLabel",
  "recFieldNameInput", "recElapsedTime", "recStartButton", "recPauseButton",
  "recResumeButton", "recStopButton", "recMessage",
  "recCurrentLat", "recCurrentLon", "recFixQualityLabel", "recSatelliteCountLabel",
  "recHdopLabel", "recLastFixAge", "recReceivedLineCount", "recDiagnosticBanner",
  "recByteAge", "recLineAge", "recChecksumAge", "recFixAgeDetail",
  "recChecksumFailureCount", "recMalformedLineCount",
  "recPendingCount", "recStorageUsage", "recImageStorageUsage", "recLastPersisted", "recPersistenceError", "recWakeLockStatus",
  "recRecoveryContainer", "recFieldModeToggle",
  "recObsTypeSelect", "recObsWaterLevelInput", "recObsNoteInput", "recObsImageInput",
  "recRecordPositionButton", "recObsMessage", "recObsHistoryContainer",
  "recExportRawButton", "recExportFixesCsvButton", "recExportSessionJsonButton",
  "recExportObservationsCsvButton", "recExportObservationsJsonButton"
];

const FIELD_MODE_STORAGE_KEY = "suimonNaviFieldMode";

export class RecordingSessionController {
  constructor(options = {}) {
    this.store = options.store || new RecordingStore();
    this.getActiveField = options.getActiveField || (() => null);
    this.getSelectedGridCellId = options.getSelectedGridCellId || (() => null);
    this.thresholds = { ...DEFAULT_DIAGNOSTIC_THRESHOLDS_MS, ...(options.thresholds || {}) };
    this.fixStaleMs = options.fixStaleMs ?? DEFAULT_FIX_STALE_MS;
    this.flushIntervalMs = options.flushIntervalMs ?? 1000;
    this.flushBatchSize = options.flushBatchSize ?? 25;
    this.maxPendingQueue = options.maxPendingQueue ?? 2000;
    this.imageOptions = {
      maxDimension: options.imageMaxDimensionPx ?? DEFAULT_IMAGE_MAX_DIMENSION_PX,
      quality: options.imageQuality ?? DEFAULT_IMAGE_QUALITY,
      maxBytes: options.imageMaxBytes ?? DEFAULT_IMAGE_MAX_BYTES
    };

    this.recordingState = "idle";
    this.connectionState = "disconnected";
    this.connectionMeta = null;
    // Sticky for the life of the page: distinguishes "never successfully
    // connected yet" (neutral diagnostics) from a genuine post-connection
    // stall. Never reset back to false once a connection has succeeded.
    this.everConnected = false;
    this.activeSessionId = null;
    this.sessionMeta = null;
    this.sessionSeq = 0;
    this.sessionStartMs = null;

    this.pendingLines = [];
    this.pendingFixes = [];
    this.sessionCountersDirty = false;
    this.flushTimer = null;
    this.persistenceError = null;
    this.lastPersistedAtMs = null;
    this.storageEstimate = null;

    this.latestFix = null;
    this.diagTimes = { lastByteMs: null, lastLineMs: null, lastChecksumMs: null, lastFixMs: null };

    this.wakeLock = null;
    this.wakeLockSupported = "wakeLock" in navigator;
    this.wakeLockActive = false;

    this.recoverySessions = [];
    this.recoveryInProgress = false;
    this.observationHistory = [];
    this.pendingObservationImage = null;
    this.sessionImageBytes = 0;
    this.fieldMode = false;

    this.elements = {};
    this.tickTimer = null;
  }

  async mount() {
    ELEMENT_IDS.forEach((id) => { this.elements[id] = document.getElementById(id); });
    if (!this.elements.recStartButton) {
      return;
    }
    this.populateObservationTypes();
    this.bindEvents();
    await this.refreshRecoveryList();
    await this.refreshStorageEstimate();
    this.applyFieldModePreference();
    this.startTicking();
    this.render();

    document.addEventListener("visibilitychange", () => this.handleVisibilityChange());
    window.addEventListener("beforeunload", (event) => this.handleBeforeUnload(event));
    window.addEventListener("pagehide", () => { this.flushPending({ force: true }); });
  }

  populateObservationTypes() {
    const select = this.elements.recObsTypeSelect;
    if (!select) {
      return;
    }
    select.replaceChildren();
    Object.entries(OBSERVATION_TYPES).forEach(([value, label]) => select.append(new Option(label, value)));
  }

  bindEvents() {
    const el = this.elements;
    el.recStartButton.addEventListener("click", () => this.startRecording());
    el.recPauseButton.addEventListener("click", () => this.pauseRecording());
    el.recResumeButton.addEventListener("click", () => this.resumeRecording());
    el.recStopButton.addEventListener("click", () => this.stopRecording());
    el.recRecordPositionButton.addEventListener("click", () => this.recordCurrentPosition());
    el.recObsImageInput?.addEventListener("change", (event) => this.handleImageSelected(event));
    el.recFieldModeToggle?.addEventListener("change", () => this.toggleFieldMode());
    el.recExportRawButton?.addEventListener("click", () => this.exportRawNmea());
    el.recExportFixesCsvButton?.addEventListener("click", () => this.exportFixesCsv());
    el.recExportSessionJsonButton?.addEventListener("click", () => this.exportCompleteSessionJson());
    el.recExportObservationsCsvButton?.addEventListener("click", () => this.exportObservationsCsv());
    el.recExportObservationsJsonButton?.addEventListener("click", () => this.exportObservationsJson());
    el.recRecoveryContainer?.addEventListener("click", (event) => this.handleRecoveryClick(event));
    el.recObsHistoryContainer?.addEventListener("click", (event) => this.handleObservationHistoryClick(event));
  }

  // -------------------------------------------------------------------------
  // Connection-state relay (called from index.html; never triggers recording)
  // -------------------------------------------------------------------------

  handleConnectionStateChange(state, meta = {}) {
    this.connectionState = state;
    if (state === "connected") {
      this.everConnected = true;
      this.connectionMeta = { transportLabel: meta.transportLabel || null, baudRate: meta.baudRate || null, portInfo: meta.portInfo || {} };
    }
    if (state === "disconnected" || state === "error" || state === "disconnecting") {
      this.flushPending();
    }
    if (this.recordingState === "recording" && (state === "disconnected" || state === "error")) {
      this.setMessage("接続が切れました。記録セッションは継続していますが、新しいデータは記録されません。再接続すると自動的に記録を続けます。");
    }
    this.render();
  }

  noteSerialByte(nowMs = Date.now()) {
    this.diagTimes.lastByteMs = nowMs;
  }

  /**
   * point/noFix/malformed mirror what index.html's shared parseNmea call
   * already computed for the existing map layer — this never re-parses NMEA
   * itself, it only classifies the result for diagnostics and, while
   * recording, appends to the persisted log.
   */
  ingestSerialLine({ rawLine, looksLikeGga = false, point = null, noFix = false }) {
    const nowMs = Date.now();
    const looksLikeNmea = typeof rawLine === "string" && rawLine.startsWith("$");

    if (looksLikeNmea) {
      this.diagTimes.lastLineMs = nowMs;
      const checksumOk = verifyNmeaChecksum(rawLine);
      if (checksumOk === true) {
        this.diagTimes.lastChecksumMs = nowMs;
      } else {
        this.bumpCounterIfRecording("checksumFailureCount");
      }
    }

    if (point) {
      this.diagTimes.lastFixMs = nowMs;
      this.latestFix = {
        lat: point.lat, lon: point.lon, altitude: point.altitude, timestamp: point.timestamp,
        fixQuality: point.fixQuality, satellites: point.satellites, hdop: point.hdop,
        augmented: point.augmented === true, rawLine, receivedAtMs: nowMs
      };
    } else if (looksLikeGga && !noFix) {
      this.bumpCounterIfRecording("malformedLineCount");
    }

    if (this.recordingState === "recording") {
      this.bumpCounterIfRecording("totalReceivedLines");
      // Exactly one persisted record per incoming complete NMEA sentence.
      // `rawLine` here is already terminator-stripped (CRLF/CR/LF cannot
      // survive index.html's line-splitting by construction) and has already
      // gone through that same pipeline's mid-line "$G" recovery for
      // logger-prefixed input — this is the complete sentence actually used
      // for parsing/checksum verification, not raw pre-split wire bytes.
      // exportRawNmea() reconstructs a standard CRLF terminator per line on
      // export, so the exported file is one complete sentence per line.
      this.pendingLines.push({ seq: this.nextSeq(), receivedAt: new Date(nowMs).toISOString(), line: rawLine });
      if (point) {
        this.bumpCounterIfRecording("validFixCount");
        this.pendingFixes.push({
          seq: this.nextSeq(), receivedAt: new Date(nowMs).toISOString(), timestamp: point.timestamp,
          lat: point.lat, lon: point.lon, altitude: point.altitude, fixQuality: point.fixQuality,
          satellites: point.satellites, hdop: point.hdop, rawLine
        });
      }
      this.scheduleFlush();
    }
    this.render();
  }

  bumpCounterIfRecording(field) {
    if (this.recordingState !== "recording" || !this.sessionMeta) {
      return;
    }
    this.sessionMeta[field] = (this.sessionMeta[field] || 0) + 1;
    this.sessionCountersDirty = true;
  }

  nextSeq() {
    this.sessionSeq += 1;
    return this.sessionSeq;
  }

  // -------------------------------------------------------------------------
  // Batched persistence
  // -------------------------------------------------------------------------

  scheduleFlush() {
    if (this.pendingLines.length + this.pendingFixes.length >= this.flushBatchSize) {
      this.flushPending();
      return;
    }
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushPending();
    }, this.flushIntervalMs);
  }

  async flushPending() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.activeSessionId) {
      return;
    }
    if (this.pendingLines.length === 0 && this.pendingFixes.length === 0 && !this.sessionCountersDirty) {
      return;
    }

    const linesToWrite = this.pendingLines.splice(0, this.pendingLines.length);
    const fixesToWrite = this.pendingFixes.splice(0, this.pendingFixes.length);
    let hadError = false;

    if (linesToWrite.length > 0) {
      try {
        await this.store.appendRawLines(this.activeSessionId, linesToWrite);
      } catch (error) {
        hadError = true;
        this.requeue(linesToWrite, "pendingLines");
        this.setPersistenceError(error);
      }
    }
    if (fixesToWrite.length > 0) {
      try {
        await this.store.appendStructuredFixes(this.activeSessionId, fixesToWrite);
      } catch (error) {
        hadError = true;
        this.requeue(fixesToWrite, "pendingFixes");
        this.setPersistenceError(error);
      }
    }
    if (this.sessionCountersDirty) {
      try {
        await this.store.updateSession(this.activeSessionId, this.sessionCounterPatch());
        this.sessionCountersDirty = false;
      } catch (error) {
        hadError = true;
        this.setPersistenceError(error);
      }
    }
    if (!hadError) {
      this.lastPersistedAtMs = Date.now();
      this.persistenceError = null;
      this.refreshStorageEstimate();
    }
    this.render();
  }

  requeue(items, queueName) {
    this[queueName] = items.concat(this[queueName]).slice(-this.maxPendingQueue);
  }

  setPersistenceError(error) {
    this.persistenceError = error instanceof QuotaExceededStorageError
      ? "保存容量が不足しています。画像を含めずに書き出すか、不要なセッションを削除してください。"
      : `保存エラー: ${error.message}`;
  }

  sessionCounterPatch() {
    if (!this.sessionMeta) {
      return {};
    }
    const { totalReceivedLines, validFixCount, checksumFailureCount, malformedLineCount } = this.sessionMeta;
    return {
      totalReceivedLines, validFixCount, checksumFailureCount, malformedLineCount,
      lastValidFix: this.latestFix
        ? { timestamp: this.latestFix.timestamp, lat: this.latestFix.lat, lon: this.latestFix.lon, fixQuality: this.latestFix.fixQuality }
        : null,
      updatedAt: new Date().toISOString()
    };
  }

  // -------------------------------------------------------------------------
  // Recording lifecycle
  // -------------------------------------------------------------------------

  async startRecording() {
    if (!canTransitionRecording(this.recordingState, "start")) {
      this.setMessage("記録を開始できません。未終了のセッションを先に解決してください。");
      return false;
    }
    const unfinished = await this.store.listUnfinishedSessions();
    if (unfinished.length > 0) {
      this.setMessage("未終了の記録セッションがあります。再開・書き出し・終了のいずれかを行ってから新しい記録を開始してください。");
      await this.refreshRecoveryList();
      return false;
    }

    const sessionId = makeSessionId();
    const nowIso = new Date().toISOString();
    const field = this.getActiveField?.() || null;
    const fieldNameOverride = this.elements.recFieldNameInput?.value?.trim();
    const session = {
      sessionId,
      startedAt: nowIso,
      endedAt: null,
      status: "recording",
      fieldId: field?.id || null,
      fieldName: fieldNameOverride || field?.name || null,
      transportLabel: this.connectionMeta?.transportLabel || null,
      baudRate: this.connectionMeta?.baudRate || null,
      deviceInfo: this.connectionMeta?.portInfo || {},
      totalReceivedLines: 0,
      validFixCount: 0,
      checksumFailureCount: 0,
      malformedLineCount: 0,
      lastValidFix: null,
      notes: "",
      updatedAt: nowIso
    };
    try {
      await this.store.createSession(session);
    } catch (error) {
      this.setMessage(`セッションを作成できませんでした: ${error.message}`);
      return false;
    }

    this.activeSessionId = sessionId;
    this.sessionMeta = session;
    this.sessionSeq = 0;
    this.sessionStartMs = Date.now();
    this.recordingState = "recording";
    this.pendingLines = [];
    this.pendingFixes = [];
    this.sessionCountersDirty = false;
    this.persistenceError = null;
    this.observationHistory = [];
    this.sessionImageBytes = 0;
    await this.requestWakeLock();
    this.setMessage(`記録を開始しました（${sessionId}）。`);
    await this.refreshRecoveryList();
    this.render();
    return true;
  }

  async pauseRecording() {
    if (!canTransitionRecording(this.recordingState, "pause")) {
      return;
    }
    // Flip state before awaiting the flush, not after: ingestSerialLine only
    // queues/counts a line while recordingState === "recording", so a
    // sentence arriving during flushPending's own await must be rejected by
    // that guard immediately, not left counted-but-unflushed forever.
    this.recordingState = "paused";
    await this.flushPending();
    await this.persistStatus("paused");
    this.setMessage("記録を一時停止しました。");
    this.render();
  }

  async resumeRecording() {
    if (!canTransitionRecording(this.recordingState, "resume")) {
      return;
    }
    this.recordingState = "recording";
    await this.persistStatus("recording");
    await this.requestWakeLock();
    this.setMessage("記録を再開しました。");
    this.render();
  }

  async stopRecording() {
    if (!canTransitionRecording(this.recordingState, "stop")) {
      return;
    }
    // See pauseRecording: flip state first so a sentence arriving during the
    // flush's own await is cleanly rejected rather than counted-but-lost.
    this.recordingState = "stopped";
    await this.flushPending();
    const nowIso = new Date().toISOString();
    await this.persistStatus("stopped", { endedAt: nowIso });
    this.releaseWakeLock();
    this.setMessage("記録を終了しました。書き出しを行うか、新しい記録を開始できます。");
    await this.refreshRecoveryList();
    this.render();
  }

  async persistStatus(status, extraPatch = {}) {
    if (!this.activeSessionId) {
      return;
    }
    const patch = { status, ...this.sessionCounterPatch(), ...extraPatch };
    this.sessionCountersDirty = false;
    try {
      await this.store.updateSession(this.activeSessionId, patch);
      if (this.sessionMeta) {
        Object.assign(this.sessionMeta, patch);
      }
    } catch (error) {
      this.setPersistenceError(error);
    }
  }

  // -------------------------------------------------------------------------
  // Recovery workflow
  // -------------------------------------------------------------------------

  async refreshRecoveryList() {
    this.recoverySessions = await this.store.listUnfinishedSessions();
    if (this.recoverySessions.length > 0 && this.recordingState === "idle") {
      this.recordingState = "recovery_available";
    }
    const counts = await Promise.all(this.recoverySessions.map(async (session) => ({
      sessionId: session.sessionId,
      lineCount: await this.store.countRawLines(session.sessionId)
    })));
    this.recoveryLineCounts = Object.fromEntries(counts.map((entry) => [entry.sessionId, entry.lineCount]));
    this.renderRecovery();
  }

  async resumeSession(sessionId) {
    // Guards against duplicate concurrent invocations (e.g. a double-tap on
    // the recovery card's Resume button firing two overlapping calls) —
    // without this, both calls would race to read/write the same session
    // and could each recompute an independent (and now stale) sessionSeq.
    if (this.recoveryInProgress) {
      return;
    }
    this.recoveryInProgress = true;
    this.renderRecovery();
    try {
      const session = await this.store.getSession(sessionId);
      if (!session) {
        return;
      }
      this.activeSessionId = sessionId;
      this.sessionMeta = session;
      // Continue the session's existing monotonic seq counter — resetting
      // to 0 here would collide with seq values already persisted from
      // before the reload, corrupting ordering across both stores.
      this.sessionSeq = await this.store.getMaxSeq(sessionId);
      this.sessionStartMs = Date.parse(session.startedAt) || Date.now();
      this.pendingLines = [];
      this.pendingFixes = [];
      this.recordingState = "recording";
      // Resuming only changes recording state — it never touches the serial
      // connection subsystem, so it cannot start a second serial read loop;
      // the user must separately connect QZ1 if not already connected.
      await this.persistStatus("recording");
      await this.requestWakeLock();
      await this.refreshObservationHistory();
      await this.refreshImageStorageEstimate();
      this.setMessage(`セッション ${sessionId} を再開しました。`);
      await this.refreshRecoveryList();
    } finally {
      this.recoveryInProgress = false;
      this.render();
    }
  }

  async finishSession(sessionId) {
    const nowIso = new Date().toISOString();
    await this.store.updateSession(sessionId, { status: "stopped", endedAt: nowIso, updatedAt: nowIso });
    if (this.activeSessionId === sessionId) {
      this.recordingState = "stopped";
    }
    this.setMessage(`セッション ${sessionId} を終了としてマークしました。`);
    await this.refreshRecoveryList();
    this.render();
  }

  async deleteSession(sessionId) {
    if (!window.confirm(`セッション ${sessionId} を削除しますか？記録済みデータは失われます。`)) {
      return;
    }
    await this.store.deleteSession(sessionId);
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null;
      this.sessionMeta = null;
      this.recordingState = "idle";
    }
    this.setMessage(`セッション ${sessionId} を削除しました。`);
    await this.refreshRecoveryList();
    this.render();
  }

  handleRecoveryClick(event) {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }
    const { action, sessionId } = button.dataset;
    if (action === "resume") {
      this.resumeSession(sessionId);
    } else if (action === "export") {
      this.exportCompleteSessionJson(sessionId);
    } else if (action === "finish") {
      this.finishSession(sessionId);
    } else if (action === "delete") {
      this.deleteSession(sessionId);
    }
  }

  // -------------------------------------------------------------------------
  // Wake Lock (independent of the app-level connection wake lock)
  // -------------------------------------------------------------------------

  async requestWakeLock() {
    if (!this.wakeLockSupported) {
      this.wakeLockActive = false;
      this.render();
      return;
    }
    try {
      this.wakeLock = await navigator.wakeLock.request("screen");
      this.wakeLock.addEventListener("release", () => {
        this.wakeLockActive = false;
        this.render();
      });
      this.wakeLockActive = true;
    } catch {
      this.wakeLockActive = false;
    }
    this.render();
  }

  releaseWakeLock() {
    if (this.wakeLock) {
      this.wakeLock.release().catch(() => {});
    }
    this.wakeLock = null;
    this.wakeLockActive = false;
    this.render();
  }

  handleVisibilityChange() {
    if (document.visibilityState === "visible" && this.recordingState === "recording"
      && this.wakeLockSupported && !this.wakeLockActive) {
      this.requestWakeLock();
    }
    if (document.visibilityState === "hidden") {
      this.flushPending();
    }
  }

  handleBeforeUnload(event) {
    if (this.recordingState === "recording" || this.recordingState === "paused") {
      event.preventDefault();
      event.returnValue = "";
    }
  }

  // -------------------------------------------------------------------------
  // Marked observations ("現在地を記録")
  // -------------------------------------------------------------------------

  async recordCurrentPosition() {
    const nowMs = Date.now();
    if (this.recordingState !== "recording") {
      this.setObservationMessage("記録セッションが開始されていません。");
      return null;
    }
    const validation = validateObservationCreation(this.latestFix, nowMs, this.fixStaleMs);
    if (!validation.ok) {
      this.setObservationMessage(validation.reason);
      return null;
    }

    let imageRef = null;
    let imageName = null;
    if (this.pendingObservationImage) {
      const imageId = `img-${makeObservationId().slice(4)}`;
      try {
        await this.store.addImageBlob({
          id: imageId,
          sessionId: this.activeSessionId,
          blob: this.pendingObservationImage.blob,
          mimeType: this.pendingObservationImage.blob.type,
          width: this.pendingObservationImage.width,
          height: this.pendingObservationImage.height,
          originalName: this.pendingObservationImage.originalName,
          createdAt: new Date(nowMs).toISOString()
        });
        imageRef = imageId;
        imageName = this.pendingObservationImage.originalName;
        await this.refreshImageStorageEstimate();
      } catch (error) {
        this.setPersistenceError(error);
        this.setObservationMessage(`画像を保存できませんでした（観測は画像なしで記録します）: ${error.message}`);
      }
    }

    const observation = buildMarkedObservation({
      id: makeObservationId(),
      sessionId: this.activeSessionId,
      fix: this.latestFix,
      fieldId: this.getActiveField?.()?.id || null,
      gridCellId: this.getSelectedGridCellId?.() || null,
      observationType: this.elements.recObsTypeSelect?.value || "other",
      note: this.elements.recObsNoteInput?.value || "",
      waterLevel: this.elements.recObsWaterLevelInput?.value || null,
      imageRef,
      imageName,
      positionSource: this.connectionMeta?.transportLabel || "qz1_serial",
      nowIso: new Date(nowMs).toISOString()
    });

    try {
      await this.store.addMarkedObservation(observation);
    } catch (error) {
      this.setPersistenceError(error);
      this.setObservationMessage(`観測を保存できませんでした: ${error.message}`);
      return null;
    }

    this.pendingObservationImage = null;
    if (this.elements.recObsImageInput) {
      this.elements.recObsImageInput.value = "";
    }
    if (this.elements.recObsNoteInput) {
      this.elements.recObsNoteInput.value = "";
    }
    this.setObservationMessage(`観測を記録しました（${OBSERVATION_TYPES[observation.observationType]}）。`);
    await this.refreshObservationHistory();
    this.render();
    return observation;
  }

  async refreshObservationHistory() {
    this.observationHistory = this.activeSessionId
      ? await this.store.listMarkedObservations(this.activeSessionId)
      : [];
    this.renderObservationHistory();
  }

  async deleteObservation(id) {
    await this.store.deleteMarkedObservation(id);
    await this.refreshObservationHistory();
  }

  handleObservationHistoryClick(event) {
    const button = event.target.closest("button[data-delete-id]");
    if (button) {
      this.deleteObservation(button.dataset.deleteId);
    }
  }

  // -------------------------------------------------------------------------
  // Camera capture (Android + desktop file picker)
  // -------------------------------------------------------------------------

  async handleImageSelected(event) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    try {
      const { blob, width, height } = await compressImageFile(file, this.imageOptions);
      this.pendingObservationImage = { blob, width, height, originalName: file.name };
      this.setObservationMessage(`写真を添付しました（${file.name}, ${formatBytes(blob.size)}）。「現在地を記録」で観測に添付されます。`);
    } catch (error) {
      // Compression/size failures never block recording the observation
      // itself — the position is still recorded, just without a photo.
      this.pendingObservationImage = null;
      this.setObservationMessage(`写真の処理に失敗しました（画像なしで観測を記録できます）: ${error.message}`);
    }
    this.render();
  }

  // -------------------------------------------------------------------------
  // Storage status
  // -------------------------------------------------------------------------

  async refreshStorageEstimate() {
    this.storageEstimate = await this.store.estimateUsage();
    this.render();
  }

  async refreshImageStorageEstimate() {
    if (!this.activeSessionId) {
      this.sessionImageBytes = 0;
      this.render();
      return;
    }
    const blobs = await this.store.listImageBlobsForSession(this.activeSessionId);
    this.sessionImageBytes = blobs.reduce((sum, record) => sum + (record.blob?.size || 0), 0);
    this.render();
  }

  // -------------------------------------------------------------------------
  // Field mode (mobile compact layout)
  // -------------------------------------------------------------------------

  applyFieldModePreference() {
    let stored = null;
    try {
      stored = localStorage.getItem(FIELD_MODE_STORAGE_KEY);
    } catch {}
    const auto = typeof window.matchMedia === "function" && window.matchMedia("(max-width: 640px)").matches;
    this.fieldMode = stored === "1" ? true : stored === "0" ? false : auto;
    if (this.elements.recFieldModeToggle) {
      this.elements.recFieldModeToggle.checked = this.fieldMode;
    }
    this.applyFieldModeClass();
  }

  toggleFieldMode() {
    this.fieldMode = Boolean(this.elements.recFieldModeToggle?.checked);
    try {
      localStorage.setItem(FIELD_MODE_STORAGE_KEY, this.fieldMode ? "1" : "0");
    } catch {}
    this.applyFieldModeClass();
  }

  applyFieldModeClass() {
    this.elements.recPanel?.classList.toggle("field-mode", this.fieldMode);
  }

  // -------------------------------------------------------------------------
  // Exports (always read from IndexedDB, never only in-memory queues)
  // -------------------------------------------------------------------------

  async exportRawNmea(sessionId = this.activeSessionId) {
    if (!sessionId) {
      return;
    }
    if (sessionId === this.activeSessionId) {
      await this.flushPending();
    }
    const lines = (await this.store.getRawLines(sessionId)).sort((a, b) => a.seq - b.seq);
    // NMEA-0183 sentences are conventionally CRLF-terminated; each persisted
    // record is already exactly one complete sentence (see ingestSerialLine),
    // so joining with CRLF here reconstructs a standard-conformant file with
    // one complete NMEA sentence per line.
    const text = lines.map((line) => line.line).join("\r\n") + (lines.length > 0 ? "\r\n" : "");
    downloadBlob(text, "text/plain", recordingFilename(sessionId, "raw", "nmea"));
  }

  async exportFixesCsv(sessionId = this.activeSessionId) {
    if (!sessionId) {
      return;
    }
    if (sessionId === this.activeSessionId) {
      await this.flushPending();
    }
    const fixes = (await this.store.getStructuredFixes(sessionId)).sort((a, b) => a.seq - b.seq);
    downloadBlob(structuredFixesToCsv(fixes), "text/csv", recordingFilename(sessionId, "fixes", "csv"));
  }

  async exportObservationsCsv(sessionId = this.activeSessionId) {
    if (!sessionId) {
      return;
    }
    const observations = await this.store.listMarkedObservations(sessionId);
    downloadBlob(markedObservationsToCsv(observations), "text/csv", recordingFilename(sessionId, "observations", "csv"));
  }

  async exportObservationsJson(sessionId = this.activeSessionId) {
    if (!sessionId) {
      return;
    }
    const observations = await this.store.listMarkedObservations(sessionId);
    downloadBlob(JSON.stringify(observations, null, 2), "application/json", recordingFilename(sessionId, "observations", "json"));
  }

  async exportCompleteSessionJson(sessionId = this.activeSessionId) {
    if (!sessionId) {
      return;
    }
    if (sessionId === this.activeSessionId) {
      await this.flushPending();
    }
    const [session, rawLines, fixes, observations] = await Promise.all([
      this.store.getSession(sessionId),
      this.store.getRawLines(sessionId),
      this.store.getStructuredFixes(sessionId),
      this.store.listMarkedObservations(sessionId)
    ]);
    rawLines.sort((a, b) => a.seq - b.seq);
    fixes.sort((a, b) => a.seq - b.seq);
    const payload = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      session,
      rawNmeaLines: rawLines.map((line) => ({ seq: line.seq, receivedAt: line.receivedAt, line: line.line })),
      structuredFixes: fixes,
      markedObservations: observations
    };
    downloadBlob(JSON.stringify(payload, null, 2), "application/json", recordingFilename(sessionId, "complete", "json"));
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  startTicking() {
    this.stopTicking();
    this.tickTimer = setInterval(() => this.render(), 1000);
  }

  stopTicking() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  setMessage(message) {
    if (this.elements.recMessage) {
      this.elements.recMessage.textContent = message;
    }
  }

  setObservationMessage(message) {
    if (this.elements.recObsMessage) {
      this.elements.recObsMessage.textContent = message;
    }
  }

  render() {
    const el = this.elements;
    if (!el.recStartButton) {
      return;
    }
    const nowMs = Date.now();

    setText(el.recRecordingStateLabel, RECORDING_STATE_LABELS[this.recordingState] || this.recordingState);
    setText(el.recSessionIdLabel, this.activeSessionId || "—");
    setText(el.recElapsedTime, this.sessionStartMs && (this.recordingState === "recording" || this.recordingState === "paused")
      ? formatElapsed(nowMs - this.sessionStartMs)
      : "—");
    el.recConnectionNote.hidden = !(this.recordingState === "recording" && (this.connectionState === "disconnected" || this.connectionState === "error"));

    el.recStartButton.disabled = !canTransitionRecording(this.recordingState, "start");
    el.recPauseButton.disabled = !canTransitionRecording(this.recordingState, "pause");
    el.recResumeButton.disabled = !canTransitionRecording(this.recordingState, "resume");
    el.recStopButton.disabled = !canTransitionRecording(this.recordingState, "stop");

    const fix = this.latestFix;
    setText(el.recCurrentLat, Number.isFinite(fix?.lat) ? fix.lat.toFixed(6) : "—");
    setText(el.recCurrentLon, Number.isFinite(fix?.lon) ? fix.lon.toFixed(6) : "—");
    setText(el.recFixQualityLabel, Number.isFinite(fix?.fixQuality) ? String(fix.fixQuality) : "—");
    setText(el.recSatelliteCountLabel, Number.isFinite(fix?.satellites) ? String(fix.satellites) : "—");
    setText(el.recHdopLabel, Number.isFinite(fix?.hdop) ? fix.hdop.toFixed(1) : "—");
    setText(el.recLastFixAge, fix ? `${Math.round((nowMs - fix.receivedAtMs) / 1000)}秒前` : "—");
    setText(el.recReceivedLineCount, String(this.sessionMeta?.totalReceivedLines || 0));
    setText(el.recChecksumFailureCount, String(this.sessionMeta?.checksumFailureCount || 0));
    setText(el.recMalformedLineCount, String(this.sessionMeta?.malformedLineCount || 0));

    const diagnostics = classifySerialDiagnostics(this.diagTimes, nowMs, this.thresholds, { everConnected: this.everConnected });
    el.recDiagnosticBanner.textContent = diagnostics.message;
    el.recDiagnosticBanner.hidden = diagnostics.tier === "ok";
    el.recDiagnosticBanner.dataset.tier = diagnostics.tier;
    setText(el.recByteAge, formatAge(diagnostics.byteAgeMs));
    setText(el.recLineAge, formatAge(diagnostics.lineAgeMs));
    setText(el.recChecksumAge, formatAge(diagnostics.checksumAgeMs));
    setText(el.recFixAgeDetail, formatAge(diagnostics.fixAgeMs));

    setText(el.recPendingCount, String(this.pendingLines.length + this.pendingFixes.length));
    setText(el.recStorageUsage, this.storageEstimate
      ? `${formatBytes(this.storageEstimate.usage)} / ${formatBytes(this.storageEstimate.quota)}`
      : "不明（このブラウザは容量推定に非対応）");
    setText(el.recImageStorageUsage, this.activeSessionId ? formatBytes(this.sessionImageBytes) : "—");
    setText(el.recLastPersisted, this.lastPersistedAtMs ? new Date(this.lastPersistedAtMs).toLocaleTimeString("ja-JP") : "—");
    el.recPersistenceError.textContent = this.persistenceError || "";
    el.recPersistenceError.hidden = !this.persistenceError;

    setText(el.recWakeLockStatus, !this.wakeLockSupported
      ? "非対応（画面ロックで記録が中断する場合があります）"
      : this.wakeLockActive ? "有効" : "無効");

    const validation = validateObservationCreation(this.latestFix, nowMs, this.fixStaleMs);
    el.recRecordPositionButton.disabled = this.recordingState !== "recording" || !validation.ok;

    this.renderRecovery();
  }

  renderRecovery() {
    const container = this.elements.recRecoveryContainer;
    if (!container) {
      return;
    }
    container.replaceChildren();
    if (this.recoverySessions.length === 0) {
      const empty = document.createElement("p");
      empty.className = "meta";
      empty.textContent = "未終了の記録セッションはありません。";
      container.append(empty);
      return;
    }
    this.recoverySessions.forEach((session) => {
      container.append(this.buildRecoveryCard(session));
    });
  }

  buildRecoveryCard(session) {
    const card = document.createElement("div");
    card.className = "rec-recovery-card";

    const grid = document.createElement("div");
    grid.className = "paddy-detail-grid";
    appendDetailRow(grid, "開始時刻", formatDateTime(session.startedAt));
    appendDetailRow(grid, "保存済み行数", String(this.recoveryLineCounts?.[session.sessionId] ?? "—"));
    appendDetailRow(grid, "有効測位数", String(session.validFixCount || 0));
    appendDetailRow(grid, "最終受信", formatDateTime(session.updatedAt));
    appendDetailRow(grid, "最終座標", session.lastValidFix
      ? `${session.lastValidFix.lat?.toFixed(6)}, ${session.lastValidFix.lon?.toFixed(6)}`
      : "—");
    card.append(grid);

    const actions = document.createElement("div");
    actions.className = "rec-recovery-actions";
    [
      ["resume", "再開する"],
      ["export", "書き出す"],
      ["finish", "終了にする"],
      ["delete", "削除する"]
    ].forEach(([action, label]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = action === "delete" ? "panel-button danger" : "panel-button";
      button.textContent = label;
      button.dataset.action = action;
      button.dataset.sessionId = session.sessionId;
      // Disable every recovery action while a resume is already in flight so
      // a rapid double-tap can't fire two overlapping resumeSession() calls.
      button.disabled = this.recoveryInProgress;
      actions.append(button);
    });
    card.append(actions);
    return card;
  }

  renderObservationHistory() {
    const container = this.elements.recObsHistoryContainer;
    if (!container) {
      return;
    }
    container.replaceChildren();
    if (this.observationHistory.length === 0) {
      const empty = document.createElement("p");
      empty.className = "meta";
      empty.textContent = "この記録セッションにはまだ観測がありません。";
      container.append(empty);
      return;
    }
    this.observationHistory
      .slice()
      .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
      .forEach((observation) => {
        const row = document.createElement("div");
        row.className = "rec-observation-row";
        const label = document.createElement("span");
        label.textContent = `${observation.timestamp} · ${OBSERVATION_TYPES[observation.observationType] || observation.observationType}`;
        const deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.className = "panel-button danger";
        deleteButton.textContent = "削除";
        deleteButton.dataset.deleteId = observation.id;
        row.append(label, deleteButton);
        container.append(row);
      });
  }
}

const RECORDING_STATE_LABELS = {
  idle: "未記録",
  recording: "記録中",
  paused: "一時停止",
  stopped: "終了",
  recovery_available: "復元可能なセッションあり"
};

function setText(element, value) {
  if (element) {
    element.textContent = value;
  }
}

function formatAge(ms) {
  if (ms === null || ms === undefined) {
    return "—";
  }
  return `${Math.round(ms / 1000)}秒前`;
}

function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function formatDateTime(iso) {
  if (!iso) {
    return "—";
  }
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString("ja-JP") : iso;
}

function appendDetailRow(grid, label, value) {
  const labelNode = document.createElement("span");
  labelNode.textContent = label;
  const valueNode = document.createElement("strong");
  valueNode.textContent = value;
  grid.append(labelNode, valueNode);
}

function downloadBlob(content, mimeType, filename) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("画像を読み込めませんでした。"));
    };
    img.src = url;
  });
}

/**
 * Resizes to at most maxDimension px on the long edge and re-encodes as JPEG
 * so a full-resolution phone photo is never dropped whole into IndexedDB.
 * If the result still exceeds maxBytes, quality is stepped down and then,
 * failing that, the target dimension is shrunk further — a handful of
 * attempts, never an unbounded loop. If it still can't fit, this throws so
 * the caller can fall back to recording the observation without a photo.
 */
async function compressImageFile(file, options = {}) {
  const {
    maxDimension = DEFAULT_IMAGE_MAX_DIMENSION_PX,
    quality = DEFAULT_IMAGE_QUALITY,
    maxBytes = DEFAULT_IMAGE_MAX_BYTES
  } = options;
  const img = await loadImageFromFile(file);
  try {
    let currentMaxDimension = maxDimension;
    let currentQuality = quality;
    let result = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const scale = Math.min(1, currentMaxDimension / Math.max(img.naturalWidth, img.naturalHeight));
      const width = Math.max(1, Math.round(img.naturalWidth * scale));
      const height = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((candidate) => (candidate ? resolve(candidate) : reject(new Error("画像の圧縮に失敗しました。"))), "image/jpeg", currentQuality);
      });
      result = { blob, width, height };
      if (blob.size <= maxBytes) {
        return result;
      }
      if (currentQuality > 0.4) {
        currentQuality = Math.max(0.4, currentQuality - 0.15);
      } else {
        currentMaxDimension = Math.round(currentMaxDimension * 0.75);
      }
    }
    throw new Error(`圧縮後も上限（${formatBytes(maxBytes)}）を超えています（${formatBytes(result.blob.size)}）。`);
  } finally {
    URL.revokeObjectURL(img.src);
  }
}
