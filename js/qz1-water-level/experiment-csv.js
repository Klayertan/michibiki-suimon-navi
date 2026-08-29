// The on-disk experiment format: one CSV row per GNSS fix, plus a JSON
// sidecar describing the run (see buildExperimentMetadata in
// experiment-config.js).
//
// WHY CSV, AND WHY THE RAW SENTENCE IS IN IT
// ------------------------------------------
// The CSV is the archival artefact. Everything downstream — statistics,
// verdicts, plots — is derived and reproducible; this file is not. So each
// row carries the raw GGA sentence it was built from, which makes every
// derived number auditable by eye against the wire data years later, without
// this codebase. It roughly doubles the file size. That is the correct
// trade for a research log.
//
// MISSING IS EMPTY, NEVER ZERO
// ----------------------------
// A receiver that does not emit VDOP produces an empty vdop cell, not 0 and
// not 99.9. `parseExperimentCsv` reads empty back as null. A tool that treats
// blank as zero will therefore be visibly wrong rather than quietly wrong.
//
// RFC 4180 quoting, CRLF line endings — the same convention as
// js/recording/recording-core.js, so exports from the two systems open
// identically in Excel and in pandas.

/**
 * Column order.
 *
 * The first twelve are exactly the columns named in the project brief, in
 * that order, so a file from this tool drops into any consumer written
 * against the brief. The rest are appended, never interleaved: traceability
 * fields (which step, which visit, which line of which log) that make a row
 * re-locatable in the original recording.
 */
export const EXPERIMENT_CSV_COLUMNS = [
  "timestamp",
  "experiment_id",
  "reference_height_mm",
  "latitude",
  "longitude",
  "altitude_m",
  "fix",
  "satellites",
  "hdop",
  "vdop",
  "pdop",
  "nmea",
  // --- traceability, beyond the brief's minimum ---
  "sample_index",
  "gnss_time",
  "geoid_separation_m",
  "qzss_visible",
  "step_index",
  "visit_index",
  "direction",
  "stage",
  "source_line"
];

/** One CSV row (as an object) from one labelled experiment sample. */
export function sampleToRow(sample, { experimentId, stage }) {
  return {
    timestamp: Number.isFinite(sample.timestampUtcMs)
      ? new Date(sample.timestampUtcMs).toISOString()
      : "",
    experiment_id: experimentId ?? "",
    reference_height_mm: numberCell(sample.referenceHeightMm),
    latitude: numberCell(sample.latitude, 8),
    longitude: numberCell(sample.longitude, 8),
    altitude_m: numberCell(sample.altitudeM, 3),
    fix: numberCell(sample.fix),
    satellites: numberCell(sample.satellites),
    hdop: numberCell(sample.hdop),
    vdop: numberCell(sample.vdop),
    pdop: numberCell(sample.pdop),
    nmea: sample.nmea ?? "",
    sample_index: numberCell(sample.sampleIndex),
    gnss_time: sample.gnssTimeOfDay ?? "",
    geoid_separation_m: numberCell(sample.geoidSeparationM, 3),
    qzss_visible: numberCell(sample.qzssVisible),
    step_index: numberCell(sample.stepIndex),
    visit_index: numberCell(sample.visitIndex),
    direction: sample.direction ?? "",
    stage: stage ?? "",
    source_line: numberCell(sample.sourceLine)
  };
}

/** Serializes labelled samples to the experiment CSV. */
export function experimentToCsv(samples, meta = {}) {
  const rows = samples.map((sample) => sampleToRow(sample, meta));
  const lines = [EXPERIMENT_CSV_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(EXPERIMENT_CSV_COLUMNS.map((column) => csvEscape(row[column])).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * Reads an experiment CSV back into samples.
 *
 * Column ORDER is not assumed — the header is read and columns are matched by
 * name, so a file that carries extra columns, or the brief's twelve only,
 * both load. A file missing a column the analysis needs is reported as an
 * error rather than filled in.
 */
export function parseExperimentCsv(text) {
  const errors = [];
  const table = parseCsv(String(text ?? ""));
  if (table.length === 0) {
    return { samples: [], errors: ["CSVが空です / empty CSV"], header: [] };
  }

  const header = table[0].map((name) => name.trim());
  const required = ["timestamp", "reference_height_mm", "altitude_m"];
  for (const column of required) {
    if (!header.includes(column)) {
      errors.push(`CSV: 必須列 "${column}" がありません / required column missing`);
    }
  }
  if (errors.length > 0) {
    return { samples: [], errors, header };
  }

  const index = Object.fromEntries(header.map((name, position) => [name, position]));
  const samples = [];

  for (let rowIndex = 1; rowIndex < table.length; rowIndex += 1) {
    const row = table[rowIndex];
    if (row.length === 1 && row[0].trim() === "") {
      continue;
    }
    const cell = (name) => (index[name] === undefined ? "" : (row[index[name]] ?? ""));
    const altitudeM = numberOrNull(cell("altitude_m"));
    const timestampUtcMs = cell("timestamp") ? Date.parse(cell("timestamp")) : NaN;

    samples.push({
      id: null,
      sessionId: cell("experiment_id") || null,
      sampleIndex: numberOrNull(cell("sample_index")),
      sourceLine: numberOrNull(cell("source_line")),
      nmea: cell("nmea"),
      timestampUtcMs: Number.isFinite(timestampUtcMs) ? timestampUtcMs : null,
      gnssTimeOfDay: cell("gnss_time"),
      loggerTimestamp: null,
      latitude: numberOrNull(cell("latitude")),
      longitude: numberOrNull(cell("longitude")),
      altitudeM,
      altitudeMm: altitudeM === null ? null : altitudeM * 1000,
      geoidSeparationM: numberOrNull(cell("geoid_separation_m")),
      fix: numberOrNull(cell("fix")),
      fixValid: numberOrNull(cell("fix")) !== null && numberOrNull(cell("fix")) > 0,
      satellites: numberOrNull(cell("satellites")),
      hdop: numberOrNull(cell("hdop")),
      vdop: numberOrNull(cell("vdop")),
      pdop: numberOrNull(cell("pdop")),
      qzssVisible: numberOrNull(cell("qzss_visible")),
      qzssUsedInFix: null,
      referenceHeightMm: numberOrNull(cell("reference_height_mm")),
      stepIndex: numberOrNull(cell("step_index")),
      visitIndex: numberOrNull(cell("visit_index")),
      direction: cell("direction") || null
    });
  }

  return { samples, errors, header };
}

/**
 * Reconstructs level marks from an already-labelled CSV.
 *
 * Used when the operator captured the run with the live runner (which wrote
 * the labels) and later re-analyses the CSV alone. The reconstructed marks
 * carry `settleSeconds: 0` because the settle window was ALREADY applied when
 * the CSV was written — re-applying it would silently discard a second
 * settling period that never existed.
 */
export function marksFromLabelledSamples(samples) {
  const byStep = new Map();
  for (const sample of samples) {
    if (sample.referenceHeightMm === null || !Number.isFinite(sample.timestampUtcMs)) {
      continue;
    }
    const key = sample.stepIndex === null ? `h${sample.referenceHeightMm}` : `s${sample.stepIndex}`;
    if (!byStep.has(key)) {
      byStep.set(key, {
        stepIndex: sample.stepIndex ?? byStep.size,
        referenceHeightMm: sample.referenceHeightMm,
        visitIndex: sample.visitIndex ?? 0,
        direction: sample.direction,
        startMs: sample.timestampUtcMs,
        endMs: sample.timestampUtcMs + 1,
        settleSeconds: 0,
        note: "reconstructed from labelled CSV"
      });
    }
    const mark = byStep.get(key);
    mark.startMs = Math.min(mark.startMs, sample.timestampUtcMs);
    // +1 ms so the last sample of a step falls inside its own half-open range.
    mark.endMs = Math.max(mark.endMs, sample.timestampUtcMs + 1);
  }
  return [...byStep.values()].sort((a, b) => a.startMs - b.startMs);
}

// ---------------------------------------------------------------------------
// CSV primitives (RFC 4180)
// ---------------------------------------------------------------------------

export function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Minimal RFC 4180 reader: handles quoted fields, embedded commas and CRLF. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') {
      inQuotes = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\r") {
      // Consumed with the \n that follows; a lone \r also ends the row.
      if (text[index + 1] === "\n") {
        index += 1;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function numberCell(value, decimals = null) {
  const number = numberOrNull(value);
  if (number === null) {
    return "";
  }
  return decimals === null ? String(number) : number.toFixed(decimals);
}

function numberOrNull(value) {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) {
    return null;
  }
  if (typeof value !== "number" && typeof value !== "string") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
