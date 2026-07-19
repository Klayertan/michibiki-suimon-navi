// IndexedDB persistence for QZ1 field recording sessions.
// Every store write is incremental so a page refresh, browser crash,
// Bluetooth disconnect, or accidental navigation never erases data that was
// already flushed — the in-memory queue in recording-controller.js is only a
// short-lived buffer in front of this store, never the sole copy.

const DB_NAME = "suimon-navi-recording";
const DB_VERSION = 1;

export const STORE_SESSIONS = "sessions";
export const STORE_RAW_LINES = "rawNmeaLines";
export const STORE_STRUCTURED_FIXES = "structuredFixes";
export const STORE_MARKED_OBSERVATIONS = "markedObservations";
export const STORE_IMAGE_BLOBS = "imageBlobs";

export class QuotaExceededStorageError extends Error {
  constructor(message) {
    super(message);
    this.name = "QuotaExceededStorageError";
  }
}

export class RecordingStore {
  constructor({ dbName = DB_NAME } = {}) {
    this.dbName = dbName;
    this.dbPromise = null;
  }

  open() {
    if (this.dbPromise) {
      return this.dbPromise;
    }
    this.dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("IndexedDB is not available in this environment."));
        return;
      }
      const request = indexedDB.open(this.dbName, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
          db.createObjectStore(STORE_SESSIONS, { keyPath: "sessionId" });
        }
        if (!db.objectStoreNames.contains(STORE_RAW_LINES)) {
          const store = db.createObjectStore(STORE_RAW_LINES, { keyPath: "id", autoIncrement: true });
          store.createIndex("by_sessionId", "sessionId");
        }
        if (!db.objectStoreNames.contains(STORE_STRUCTURED_FIXES)) {
          const store = db.createObjectStore(STORE_STRUCTURED_FIXES, { keyPath: "id", autoIncrement: true });
          store.createIndex("by_sessionId", "sessionId");
        }
        if (!db.objectStoreNames.contains(STORE_MARKED_OBSERVATIONS)) {
          const store = db.createObjectStore(STORE_MARKED_OBSERVATIONS, { keyPath: "id" });
          store.createIndex("by_sessionId", "sessionId");
        }
        if (!db.objectStoreNames.contains(STORE_IMAGE_BLOBS)) {
          const store = db.createObjectStore(STORE_IMAGE_BLOBS, { keyPath: "id" });
          store.createIndex("by_sessionId", "sessionId");
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Failed to open recording database."));
    });
    return this.dbPromise;
  }

  async transaction(storeNames, mode, executor) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeNames, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => {
        const error = tx.error;
        if (error && error.name === "QuotaExceededError") {
          reject(new QuotaExceededStorageError("IndexedDB quota exceeded while writing recording data."));
        } else {
          reject(error || new Error("Recording database transaction failed."));
        }
      };
      tx.onabort = () => {
        const error = tx.error;
        if (error && error.name === "QuotaExceededError") {
          reject(new QuotaExceededStorageError("IndexedDB quota exceeded while writing recording data."));
        } else {
          reject(error || new Error("Recording database transaction aborted."));
        }
      };
      try {
        result = executor(tx);
      } catch (error) {
        reject(error);
      }
    });
  }

  // ---------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------

  async createSession(session) {
    await this.transaction([STORE_SESSIONS], "readwrite", (tx) => {
      tx.objectStore(STORE_SESSIONS).add(session);
    });
    return session;
  }

  async updateSession(sessionId, patch) {
    return this.transaction([STORE_SESSIONS], "readwrite", (tx) => {
      const store = tx.objectStore(STORE_SESSIONS);
      const getRequest = store.get(sessionId);
      getRequest.onsuccess = () => {
        const existing = getRequest.result;
        if (!existing) {
          return;
        }
        store.put({ ...existing, ...patch });
      };
    });
  }

  async getSession(sessionId) {
    return this.readOne(STORE_SESSIONS, sessionId);
  }

  async listSessions() {
    return this.readAll(STORE_SESSIONS);
  }

  /** Sessions that were recording or paused and never reached "stopped". */
  async listUnfinishedSessions() {
    const sessions = await this.listSessions();
    return sessions.filter((session) => session.status === "recording" || session.status === "paused");
  }

  async deleteSession(sessionId) {
    return this.transaction(
      [STORE_SESSIONS, STORE_RAW_LINES, STORE_STRUCTURED_FIXES, STORE_MARKED_OBSERVATIONS, STORE_IMAGE_BLOBS],
      "readwrite",
      (tx) => {
        tx.objectStore(STORE_SESSIONS).delete(sessionId);
        deleteByIndexCursor(tx.objectStore(STORE_RAW_LINES), sessionId);
        deleteByIndexCursor(tx.objectStore(STORE_STRUCTURED_FIXES), sessionId);
        deleteByIndexCursor(tx.objectStore(STORE_MARKED_OBSERVATIONS), sessionId);
        deleteByIndexCursor(tx.objectStore(STORE_IMAGE_BLOBS), sessionId);
      }
    );
  }

  // ---------------------------------------------------------------------
  // Raw NMEA lines / structured fixes (batched appends)
  // ---------------------------------------------------------------------

  async appendRawLines(sessionId, lines) {
    if (lines.length === 0) {
      return;
    }
    return this.transaction([STORE_RAW_LINES], "readwrite", (tx) => {
      const store = tx.objectStore(STORE_RAW_LINES);
      lines.forEach((line) => store.add({ sessionId, ...line }));
    });
  }

  async appendStructuredFixes(sessionId, fixes) {
    if (fixes.length === 0) {
      return;
    }
    return this.transaction([STORE_STRUCTURED_FIXES], "readwrite", (tx) => {
      const store = tx.objectStore(STORE_STRUCTURED_FIXES);
      fixes.forEach((fix) => store.add({ sessionId, ...fix }));
    });
  }

  async countRawLines(sessionId) {
    return this.countByIndex(STORE_RAW_LINES, sessionId);
  }

  async countStructuredFixes(sessionId) {
    return this.countByIndex(STORE_STRUCTURED_FIXES, sessionId);
  }

  async getRawLines(sessionId) {
    return this.readAllByIndex(STORE_RAW_LINES, sessionId);
  }

  async getStructuredFixes(sessionId) {
    return this.readAllByIndex(STORE_STRUCTURED_FIXES, sessionId);
  }

  /**
   * Highest `seq` already persisted for a session, across both rawNmeaLines
   * and structuredFixes (they share one monotonic per-session counter).
   * Resuming a session must continue from here, not restart at 0, or newly
   * ingested records would collide with already-stored seq values.
   */
  async getMaxSeq(sessionId) {
    const [lines, fixes] = await Promise.all([
      this.readAllByIndex(STORE_RAW_LINES, sessionId),
      this.readAllByIndex(STORE_STRUCTURED_FIXES, sessionId)
    ]);
    const maxOf = (records) => records.reduce((max, record) => Math.max(max, record.seq || 0), 0);
    return Math.max(maxOf(lines), maxOf(fixes));
  }

  // ---------------------------------------------------------------------
  // Marked observations
  // ---------------------------------------------------------------------

  async addMarkedObservation(observation) {
    await this.transaction([STORE_MARKED_OBSERVATIONS], "readwrite", (tx) => {
      tx.objectStore(STORE_MARKED_OBSERVATIONS).add(observation);
    });
    return observation;
  }

  async updateMarkedObservation(id, patch) {
    return this.transaction([STORE_MARKED_OBSERVATIONS], "readwrite", (tx) => {
      const store = tx.objectStore(STORE_MARKED_OBSERVATIONS);
      const getRequest = store.get(id);
      getRequest.onsuccess = () => {
        const existing = getRequest.result;
        if (existing) {
          store.put({ ...existing, ...patch });
        }
      };
    });
  }

  async deleteMarkedObservation(id) {
    return this.transaction([STORE_MARKED_OBSERVATIONS], "readwrite", (tx) => {
      tx.objectStore(STORE_MARKED_OBSERVATIONS).delete(id);
    });
  }

  async listMarkedObservations(sessionId) {
    return this.readAllByIndex(STORE_MARKED_OBSERVATIONS, sessionId);
  }

  // ---------------------------------------------------------------------
  // Image blobs (compressed, referenced from markedObservations.imageRef)
  // ---------------------------------------------------------------------

  async addImageBlob(record) {
    await this.transaction([STORE_IMAGE_BLOBS], "readwrite", (tx) => {
      tx.objectStore(STORE_IMAGE_BLOBS).add(record);
    });
    return record;
  }

  async getImageBlob(id) {
    return this.readOne(STORE_IMAGE_BLOBS, id);
  }

  async listImageBlobsForSession(sessionId) {
    return this.readAllByIndex(STORE_IMAGE_BLOBS, sessionId);
  }

  // ---------------------------------------------------------------------
  // Storage usage
  // ---------------------------------------------------------------------

  async estimateUsage() {
    if (!navigator.storage?.estimate) {
      return null;
    }
    try {
      const { usage, quota } = await navigator.storage.estimate();
      return { usage, quota };
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------
  // Generic helpers
  // ---------------------------------------------------------------------

  async readOne(storeName, key) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([storeName], "readonly");
      const request = tx.objectStore(storeName).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async readAll(storeName) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([storeName], "readonly");
      const request = tx.objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async readAllByIndex(storeName, sessionId) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([storeName], "readonly");
      const request = tx.objectStore(storeName).index("by_sessionId").getAll(sessionId);
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async countByIndex(storeName, sessionId) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([storeName], "readonly");
      const request = tx.objectStore(storeName).index("by_sessionId").count(sessionId);
      request.onsuccess = () => resolve(request.result || 0);
      request.onerror = () => reject(request.error);
    });
  }
}

function deleteByIndexCursor(store, sessionId) {
  const index = store.index("by_sessionId");
  const request = index.openCursor(IDBKeyRange.only(sessionId));
  request.onsuccess = () => {
    const cursor = request.result;
    if (cursor) {
      cursor.delete();
      cursor.continue();
    }
  };
}
