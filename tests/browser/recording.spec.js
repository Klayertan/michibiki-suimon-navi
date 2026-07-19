import { test, expect } from "@playwright/test";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// A GGA sentence with a verified-correct checksum (see recording-core.test.js
// for the same fixture) so the real checksum verifier in recording-core.js
// counts it as valid, not as a failure.
const VALID_GGA = "$GNGGA,012345.00,3439.2705,N,13549.8410,E,2,14,0.9,45.0,M,30.0,M,,*44";

function installFakeSerialPort(page, { intervalMs = 40 } = {}) {
  return page.addInitScript(({ sentence, intervalMs }) => {
    class FakeSerialPort {
      getInfo() {
        return {};
      }
      async open() {
        const encoder = new TextEncoder();
        this.readable = new ReadableStream({
          start: (controller) => {
            this._timer = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(`${sentence}\r\n`));
              } catch {
                clearInterval(this._timer);
              }
            }, intervalMs);
          },
          cancel: () => clearInterval(this._timer)
        });
        window.__fakeSerialStop = () => clearInterval(this._timer);
      }
      async close() {
        this.readable = null;
      }
    }
    const fakeSerial = {
      _granted: [],
      async getPorts() { return this._granted; },
      async requestPort() {
        const port = new FakeSerialPort();
        this._granted.push(port);
        return port;
      },
      addEventListener() {}
    };
    Object.defineProperty(Navigator.prototype, "serial", { configurable: true, get: () => fakeSerial });
  }, { sentence: VALID_GGA, intervalMs });
}

async function openFieldRecordingCard(page) {
  await page.goto("/#survey");
  await page.getByRole("button", { name: "QZ1測量" }).click();
  await page.evaluate(() => {
    document.querySelectorAll("details[data-workspace='survey']").forEach((card) => { card.open = true; });
  });
  await expect(page.locator("#recStartButton")).toBeAttached({ timeout: 15_000 });
}

async function connect(page) {
  await page.locator("#serialConnectButton").click();
  await expect(page.locator("#serialStatus")).toHaveText("接続中");
}

test("recording lifecycle persists incrementally, flushes on pause, and exports read from IndexedDB", async ({ page }) => {
  await installFakeSerialPort(page);
  await openFieldRecordingCard(page);
  await connect(page);

  await expect(page.locator("#recStartButton")).toBeEnabled();
  await page.locator("#recStartButton").click();
  await expect(page.locator("#recRecordingStateLabel")).toHaveText("記録中");
  await expect(page.locator("#recStartButton")).toBeDisabled();
  await expect(page.locator("#recPauseButton")).toBeEnabled();

  // Let a few GGA sentences stream in and get batched to IndexedDB.
  await expect.poll(async () => Number(await page.locator("#recReceivedLineCount").textContent())).toBeGreaterThan(0);
  const sessionId = await page.locator("#recSessionIdLabel").textContent();

  await page.locator("#recPauseButton").click();
  await expect(page.locator("#recRecordingStateLabel")).toHaveText("一時停止");
  // Pausing forces a flush: the pending in-memory queue must drain to zero.
  await expect(page.locator("#recPendingCount")).toHaveText("0");

  // Persistence check: query IndexedDB directly, independent of the UI counters.
  const storedLineCount = await page.evaluate(async (id) => {
    const { RecordingStore } = await import("/js/recording/recording-store.js");
    const store = new RecordingStore();
    return store.countRawLines(id);
  }, sessionId);
  expect(storedLineCount).toBeGreaterThan(0);

  await page.locator("#recResumeButton").click();
  await expect(page.locator("#recRecordingStateLabel")).toHaveText("記録中");

  await page.locator("#recStopButton").click();
  await expect(page.locator("#recRecordingStateLabel")).toHaveText("終了");
  await expect(page.locator("#recStartButton")).toBeEnabled();

  const dir = await mkdtemp(path.join(tmpdir(), "rec-export-"));

  const rawDownload = await Promise.all([page.waitForEvent("download"), page.locator("#recExportRawButton").click()]).then((r) => r[0]);
  const rawPath = path.join(dir, "raw.nmea");
  await rawDownload.saveAs(rawPath);
  expect(await readFile(rawPath, "utf8")).toContain("$GNGGA,012345.00");

  const csvDownload = await Promise.all([page.waitForEvent("download"), page.locator("#recExportFixesCsvButton").click()]).then((r) => r[0]);
  const csvPath = path.join(dir, "fixes.csv");
  await csvDownload.saveAs(csvPath);
  const csvText = await readFile(csvPath, "utf8");
  expect(csvText.split("\r\n")[0]).toContain("lat");
  expect(csvText).toContain("34.65450833333333"); // 34°39.2705' -> decimal

  const jsonDownload = await Promise.all([page.waitForEvent("download"), page.locator("#recExportSessionJsonButton").click()]).then((r) => r[0]);
  const jsonPath = path.join(dir, "complete.json");
  await jsonDownload.saveAs(jsonPath);
  const payload = JSON.parse(await readFile(jsonPath, "utf8"));
  expect(payload.session.sessionId).toBe(sessionId);
  expect(payload.rawNmeaLines.length).toBeGreaterThan(0);
  expect(payload.structuredFixes.length).toBeGreaterThan(0);
  expect(Array.isArray(payload.markedObservations)).toBe(true);
});

test("an interrupted session survives reload and can be resumed from the recovery card", async ({ page }) => {
  await installFakeSerialPort(page);
  await openFieldRecordingCard(page);
  await connect(page);

  await page.locator("#recStartButton").click();
  await expect.poll(async () => Number(await page.locator("#recReceivedLineCount").textContent())).toBeGreaterThan(3);
  const sessionId = await page.locator("#recSessionIdLabel").textContent();
  // Force a flush so data is actually on disk before the "crash". The fake
  // port keeps streaming in the background, so poll rather than assert once
  // immediately after — a line can land between the flush and the check.
  await expect.poll(async () => {
    await page.evaluate(() => window.recordingController.flushPending());
    return Number(await page.locator("#recPendingCount").textContent());
  }).toBe(0);

  // Simulate a crash/refresh: no stop(), no explicit save — just reload.
  await page.reload();
  await expect(page.locator("#recStartButton")).toBeAttached({ timeout: 15_000 });
  await page.evaluate(() => {
    document.querySelectorAll("details[data-workspace='survey']").forEach((card) => { card.open = true; });
  });

  const recoveryCard = page.locator(".rec-recovery-card").first();
  await expect(recoveryCard).toBeVisible();
  await expect(recoveryCard).toContainText("保存済み行数");
  // The unresolved recovery state blocks starting a fresh session outright.
  await expect(page.locator("#recStartButton")).toBeDisabled();

  await recoveryCard.getByRole("button", { name: "再開する" }).click();
  await expect(page.locator("#recRecordingStateLabel")).toHaveText("記録中");
  await expect(page.locator("#recSessionIdLabel")).toHaveText(sessionId);
});

test("duplicate session protection refuses a second recording session while one is unfinished", async ({ page }) => {
  await installFakeSerialPort(page);
  await openFieldRecordingCard(page);
  await connect(page);
  await page.locator("#recStartButton").click();
  await expect(page.locator("#recRecordingStateLabel")).toHaveText("記録中");

  // Bypass the (already-disabled) button to exercise the store-level guard
  // directly, simulating a race or a second caller invoking the API.
  const result = await page.evaluate(async () => {
    window.recordingController.recordingState = "idle";
    return window.recordingController.startRecording();
  });
  expect(result).toBe(false);
  await expect(page.locator("#recMessage")).toContainText("未終了の記録セッション");
});

test("marking current position requires a fresh valid fix and refuses when stale", async ({ page }) => {
  await installFakeSerialPort(page);
  await openFieldRecordingCard(page);
  await connect(page);
  await page.locator("#recStartButton").click();

  await expect.poll(async () => await page.locator("#recRecordPositionButton").isEnabled()).toBe(true);
  await page.locator("#recObsNoteInput").fill("畦際に雑草密集");
  await page.locator("#recRecordPositionButton").click();
  await expect(page.locator("#recObsMessage")).toContainText("観測を記録しました");
  await expect(page.locator(".rec-observation-row")).toHaveCount(1);

  // Stop the stream and shrink the staleness window so the test doesn't
  // need to wait out the real 10s default.
  await page.evaluate(() => {
    window.__fakeSerialStop?.();
    window.recordingController.fixStaleMs = 300;
  });
  await page.waitForTimeout(600);
  await expect(page.locator("#recRecordPositionButton")).toBeDisabled();

  const refused = await page.evaluate(() => window.recordingController.recordCurrentPosition());
  expect(refused).toBeNull();
  await expect(page.locator("#recObsMessage")).toContainText("古すぎます");
  await expect(page.locator(".rec-observation-row")).toHaveCount(1);
});

test("wake lock gracefully degrades when unsupported", async ({ page }) => {
  await page.addInitScript(() => {
    try {
      delete Navigator.prototype.wakeLock;
    } catch {}
  });
  await installFakeSerialPort(page);
  await openFieldRecordingCard(page);
  await connect(page);

  await expect(page.locator("#recWakeLockStatus")).toContainText("非対応");
  await page.locator("#recStartButton").click();
  await expect(page.locator("#recRecordingStateLabel")).toHaveText("記録中");
  await expect(page.locator("#recWakeLockStatus")).toContainText("非対応");
});

test("quota errors are handled without losing already-queued data", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { RecordingSessionController } = await import("/js/recording/recording-controller.js");
    const { QuotaExceededStorageError } = await import("/js/recording/recording-store.js");

    let failAppends = true;
    const fakeStore = {
      async listUnfinishedSessions() { return []; },
      async createSession() {},
      async updateSession() {},
      async appendRawLines() {
        if (failAppends) throw new QuotaExceededStorageError("simulated quota error");
      },
      async appendStructuredFixes() {},
      async estimateUsage() { return null; }
    };

    const controller = new RecordingSessionController({ store: fakeStore, flushBatchSize: 1000, flushIntervalMs: 60_000 });
    await controller.startRecording();
    for (let i = 0; i < 5; i += 1) {
      controller.ingestSerialLine({ rawLine: `$GPTXT,${i}*00`, looksLikeGga: false, point: null, noFix: false });
    }
    await controller.flushPending();
    const afterFailure = { pending: controller.pendingLines.length, error: controller.persistenceError };

    failAppends = false;
    await controller.flushPending();
    const afterRecovery = { pending: controller.pendingLines.length, error: controller.persistenceError };

    return { afterFailure, afterRecovery };
  });

  expect(result.afterFailure.pending).toBe(5);
  expect(result.afterFailure.error).toContain("容量");
  expect(result.afterRecovery.pending).toBe(0);
  expect(result.afterRecovery.error).toBeNull();
});

test("diagnostics distinguish a byte-level stall from a fix-only stall", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { RecordingSessionController } = await import("/js/recording/recording-controller.js");
    const { classifySerialDiagnostics } = await import("/js/recording/recording-core.js");

    const controller = new RecordingSessionController({ thresholds: { byteStallMs: 150, lineStallMs: 150, staleFixMs: 150 } });
    const nowFn = () => Date.now();

    // Bytes and lines flow, but never a fix: should classify as "no-fix", not a generic stall.
    controller.noteSerialByte(nowFn());
    controller.ingestSerialLine({ rawLine: "$GPGSA,A,3,,,,,,,,,,,,,1.0,1.0,1.0*33", looksLikeGga: false, point: null, noFix: false });
    const noFixTier = classifySerialDiagnostics(controller.diagTimes, nowFn(), controller.thresholds).tier;

    // Now let the byte-level clock go stale while a stale line timestamp remains.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const byteTier = classifySerialDiagnostics(controller.diagTimes, Date.now(), controller.thresholds).tier;

    return { noFixTier, byteTier };
  });
  expect(result.noFixTier).toBe("no-fix");
  expect(result.byteTier).toBe("byte");
});

test("mobile field mode gives a single column with large touch targets", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await installFakeSerialPort(page);
  await openFieldRecordingCard(page);

  await expect(page.locator("#recPanel")).toHaveClass(/field-mode/);
  const box = await page.locator("#recRecordPositionButton").boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(44);
  const startBox = await page.locator("#recStartButton").boundingBox();
  expect(startBox?.height).toBeGreaterThanOrEqual(44);

  const columns = await page.locator(".rec-buttons").evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
  expect(columns).toBe(1);
});

test("diagnostics show neutral states before connection and only stall after prior data reception", async ({ page }) => {
  await installFakeSerialPort(page);
  await openFieldRecordingCard(page);

  // Before any successful connection: neutral, never "stalled".
  await expect(page.locator("#recDiagnosticBanner")).toHaveAttribute("data-tier", "not-connected");
  await expect(page.locator("#recDiagnosticBanner")).not.toContainText(/stalled/i);

  await connect(page);
  // Shrink the byte-stall threshold so the genuine-stall assertion below
  // doesn't need a real 8-second wait.
  await page.evaluate(() => { window.recordingController.thresholds.byteStallMs = 300; });

  // Wait for an actual byte to have been received (not merely "connected"),
  // otherwise stopping the stream here would just observe "no-data" again
  // rather than a genuine post-data stall.
  await expect.poll(async () => await page.locator("#recByteAge").textContent()).not.toBe("—");
  await page.evaluate(() => window.__fakeSerialStop?.());
  await expect.poll(async () => await page.locator("#recDiagnosticBanner").getAttribute("data-tier"), { timeout: 5000 })
    .toBe("byte");
  await expect(page.locator("#recDiagnosticBanner")).toContainText(/stalled/i);
});

test("raw NMEA export produces exactly one complete sentence per persisted line", async ({ page }) => {
  await installFakeSerialPort(page);
  await openFieldRecordingCard(page);
  await connect(page);
  await page.locator("#recStartButton").click();
  await expect.poll(async () => Number(await page.locator("#recReceivedLineCount").textContent())).toBeGreaterThan(4);
  await page.locator("#recStopButton").click();
  await expect(page.locator("#recRecordingStateLabel")).toHaveText("終了");

  const sessionId = await page.locator("#recSessionIdLabel").textContent();
  const storedCount = await page.evaluate(async (id) => {
    const { RecordingStore } = await import("/js/recording/recording-store.js");
    return new RecordingStore().countRawLines(id);
  }, sessionId);
  expect(storedCount).toBeGreaterThan(4);

  const dir = await mkdtemp(path.join(tmpdir(), "rec-nmea-"));
  const download = await Promise.all([page.waitForEvent("download"), page.locator("#recExportRawButton").click()]).then((r) => r[0]);
  const filePath = path.join(dir, "raw.nmea");
  await download.saveAs(filePath);
  const text = await readFile(filePath, "utf8");

  // Exactly one physical line per stored record, CRLF-terminated, and every
  // line is one complete, non-truncated NMEA sentence with its checksum.
  const lines = text.split("\r\n").filter((line) => line.length > 0);
  expect(lines.length).toBe(storedCount);
  lines.forEach((line) => {
    expect(line).toMatch(/^\$[^$*]*\*[0-9A-Fa-f]{2}$/);
    expect(line).not.toContain("\n");
  });
});

test("image compression respects a configurable size cap and falls back gracefully when it can't be met", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    // Per-pixel white noise is close to worst-case for JPEG (near-zero
    // compressibility even at low quality) and isn't representative of a
    // real photo. A blocky pattern (flat within each block, sharp between
    // them) still resists compression more than a real photo but actually
    // responds to quality/dimension reduction the way a real photo would.
    function makeBlockyJpegFile(size, blockPx, name) {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      for (let y = 0; y < size; y += blockPx) {
        for (let x = 0; x < size; x += blockPx) {
          const r = Math.floor(Math.random() * 256);
          const g = Math.floor(Math.random() * 256);
          const b = Math.floor(Math.random() * 256);
          ctx.fillStyle = `rgb(${r},${g},${b})`;
          ctx.fillRect(x, y, blockPx, blockPx);
        }
      }
      return new Promise((resolve) => {
        canvas.toBlob((blob) => resolve(new File([blob], name, { type: "image/jpeg" })), "image/jpeg", 0.95);
      });
    }

    const { RecordingSessionController } = await import("/js/recording/recording-controller.js");
    const { RecordingStore } = await import("/js/recording/recording-store.js");

    // A cap that the first attempt (quality 0.9) misses but that repeated
    // quality reduction reaches — proving the iterative loop actually runs.
    const capped = new RecordingSessionController({
      store: new RecordingStore({ dbName: "test-image-cap" }),
      imageMaxBytes: 150_000,
      imageMaxDimensionPx: 1920,
      imageQuality: 0.9
    });
    const bigFile = await makeBlockyJpegFile(1400, 20, "noisy.jpg");
    await capped.handleImageSelected({ target: { files: [bigFile], value: "" } });
    const cappedOk = capped.pendingObservationImage !== null;
    const cappedSize = capped.pendingObservationImage?.blob.size ?? null;

    // A cap no real photo could ever satisfy: compression must fail cleanly,
    // and the caller must still be able to record the observation itself.
    const impossible = new RecordingSessionController({
      store: new RecordingStore({ dbName: "test-image-impossible" }),
      imageMaxBytes: 50,
      imageMaxDimensionPx: 1920,
      imageQuality: 0.9
    });
    const smallFile = await makeBlockyJpegFile(400, 20, "small.jpg");
    await impossible.handleImageSelected({ target: { files: [smallFile], value: "" } });
    const impossibleFallback = impossible.pendingObservationImage === null;
    const impossibleMessage = impossible.elements.recObsMessage?.textContent || null;

    return { cappedOk, cappedSize, impossibleFallback, impossibleMessage };
  });

  expect(result.cappedOk).toBe(true);
  expect(result.cappedSize).toBeLessThanOrEqual(150_000);
  expect(result.impossibleFallback).toBe(true);
});

test("resuming after reload never touches the serial connection and cannot start a second read loop", async ({ page }) => {
  await installFakeSerialPort(page);
  await openFieldRecordingCard(page);
  await connect(page);
  await page.locator("#recStartButton").click();
  await expect.poll(async () => Number(await page.locator("#recReceivedLineCount").textContent())).toBeGreaterThan(2);
  await page.evaluate(() => window.recordingController.flushPending());

  await page.reload();
  await expect(page.locator("#recStartButton")).toBeAttached({ timeout: 15_000 });
  await page.evaluate(() => {
    document.querySelectorAll("details[data-workspace='survey']").forEach((card) => { card.open = true; });
  });

  // Serial was never reconnected on this fresh load.
  await expect(page.locator("#serialStatus")).toHaveText("未接続");
  await page.locator(".rec-recovery-card").first().getByRole("button", { name: "再開する" }).click();
  await expect(page.locator("#recRecordingStateLabel")).toHaveText("記録中");
  // Resuming a recording session must not, by itself, open or reopen a
  // serial port — that remains an entirely separate, user-driven action.
  await expect(page.locator("#serialStatus")).toHaveText("未接続");
});

test("exactly-once ingestion and monotonic sequence values survive a reload+resume boundary", async ({ page }) => {
  await installFakeSerialPort(page);
  await openFieldRecordingCard(page);
  await connect(page);
  await page.locator("#recStartButton").click();
  await expect.poll(async () => Number(await page.locator("#recReceivedLineCount").textContent())).toBeGreaterThan(4);
  const sessionId = await page.locator("#recSessionIdLabel").textContent();
  await page.evaluate(() => window.recordingController.flushPending());
  const countBeforeReload = await page.locator("#recReceivedLineCount").textContent();

  await page.reload();
  await expect(page.locator("#recStartButton")).toBeAttached({ timeout: 15_000 });
  await page.evaluate(() => {
    document.querySelectorAll("details[data-workspace='survey']").forEach((card) => { card.open = true; });
  });
  await page.locator(".rec-recovery-card").first().getByRole("button", { name: "再開する" }).click();
  await expect(page.locator("#recRecordingStateLabel")).toHaveText("記録中");

  // Serial must be reconnected by hand after a reload — reconnect and let a
  // few more sentences arrive under the resumed session.
  await connect(page);
  await expect.poll(async () => Number(await page.locator("#recReceivedLineCount").textContent()))
    .toBeGreaterThan(Number(countBeforeReload));
  await page.locator("#recStopButton").click();
  await expect(page.locator("#recRecordingStateLabel")).toHaveText("終了");

  const analysis = await page.evaluate(async (id) => {
    const { RecordingStore } = await import("/js/recording/recording-store.js");
    const store = new RecordingStore();
    const lines = await store.getRawLines(id);
    const fixes = await store.getStructuredFixes(id);
    const seqValues = [...lines, ...fixes].map((record) => record.seq).sort((a, b) => a - b);
    const uniqueSeqCount = new Set(seqValues).size;
    let monotonic = true;
    for (let i = 1; i < seqValues.length; i += 1) {
      if (seqValues[i] <= seqValues[i - 1]) monotonic = false;
    }
    return { lineCount: lines.length, seqCount: seqValues.length, uniqueSeqCount, monotonic };
  }, sessionId);

  // One persisted raw-line record per incoming complete sentence — no
  // duplication and no gaps from any accidental second read loop.
  expect(analysis.lineCount).toBe(Number(await page.locator("#recReceivedLineCount").textContent()));
  // No seq collisions between pre-reload and post-resume records.
  expect(analysis.uniqueSeqCount).toBe(analysis.seqCount);
  expect(analysis.monotonic).toBe(true);
});

test("repeated Resume presses are ignored while a resume is already in progress", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { RecordingSessionController } = await import("/js/recording/recording-controller.js");
    const { RecordingStore } = await import("/js/recording/recording-store.js");

    const store = new RecordingStore({ dbName: "test-duplicate-resume" });
    let getSessionCalls = 0;
    const originalGetSession = store.getSession.bind(store);
    store.getSession = async (id) => {
      getSessionCalls += 1;
      // Give a concurrent second call a real chance to race in.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return originalGetSession(id);
    };

    const controller = new RecordingSessionController({ store });
    const sessionId = "rec-duplicate-test";
    await store.createSession({
      sessionId, startedAt: new Date().toISOString(), endedAt: null, status: "paused",
      totalReceivedLines: 0, validFixCount: 0, checksumFailureCount: 0, malformedLineCount: 0,
      lastValidFix: null, notes: "", updatedAt: new Date().toISOString()
    });

    await Promise.all([controller.resumeSession(sessionId), controller.resumeSession(sessionId)]);

    return { getSessionCalls, recordingState: controller.recordingState, activeSessionId: controller.activeSessionId };
  });

  expect(result.getSessionCalls).toBe(1);
  expect(result.recordingState).toBe("recording");
  expect(result.activeSessionId).toBe("rec-duplicate-test");
});
