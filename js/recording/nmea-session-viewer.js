// Pure helpers behind the "recorded NMEA" window (view / download / apply to
// map / delete). No DOM, no IndexedDB: the controller feeds in stored raw-line
// records and renders what comes back.

import { classifyFix } from "../gnss/gnss-quality.js";
import { verifyNmeaChecksum } from "./recording-core.js";

const SENTENCE_PATTERN = /^\$([A-Z0-9]{2})([A-Z0-9]{3}),/;
const GGA_PATTERN = /^\$[A-Z0-9]{2}GGA,/;

export const SESSION_STATUS_LABELS = Object.freeze({
  recording: "記録中",
  paused: "一時停止中",
  stopped: "終了"
});

/** Stored raw-line records -> the lines in recorded order. */
export function nmeaLinesFromRecords(records) {
  return [...(records || [])]
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    .map((record) => String(record.line ?? ""))
    .filter((line) => line.length > 0);
}

/**
 * The file text for a session. CRLF-terminated like the .nmea export, so
 * "view", "download" and "apply to map" all see byte-identical content.
 */
export function buildNmeaText(records) {
  const lines = nmeaLinesFromRecords(records);
  return lines.length > 0 ? `${lines.join("\r\n")}\r\n` : "";
}

function formatUtcTime(value) {
  const match = /^(\d{2})(\d{2})(\d{2})/.exec(String(value || ""));
  return match ? `${match[1]}:${match[2]}:${match[3]}` : null;
}

/**
 * Counts for the summary block. Works on whatever lines were recorded: a
 * session with no GGA is still summarised (sentence types, size), it simply
 * reports zero fixes.
 */
export function summarizeNmea(lines) {
  const sentenceTypes = {};
  const quality = { good: 0, fair: 0, poor: 0 };
  let ggaTotal = 0;
  let noFix = 0;
  let validFixes = 0;
  let checksumInvalid = 0;
  let bytes = 0;
  let firstUtc = null;
  let lastUtc = null;

  for (const line of lines) {
    bytes += line.length + 2;
    const sentence = SENTENCE_PATTERN.exec(line);
    if (sentence) {
      sentenceTypes[sentence[2]] = (sentenceTypes[sentence[2]] || 0) + 1;
    }
    if (verifyNmeaChecksum(line) === false) {
      checksumInvalid += 1;
    }
    if (!GGA_PATTERN.test(line)) {
      continue;
    }
    ggaTotal += 1;
    const fields = line.split("*")[0].split(",");
    const fixQuality = Number.parseInt(fields[6], 10);
    if (!Number.isFinite(fixQuality) || fixQuality === 0) {
      noFix += 1;
      continue;
    }
    validFixes += 1;
    const level = classifyFix({
      fixQuality,
      satellites: Number.parseInt(fields[7], 10),
      hdop: Number.parseFloat(fields[8])
    }).level;
    if (level in quality) {
      quality[level] += 1;
    }
    const time = formatUtcTime(fields[1]);
    if (time) {
      firstUtc ??= time;
      lastUtc = time;
    }
  }

  return {
    totalLines: lines.length,
    bytes,
    sentenceTypes: Object.entries(sentenceTypes).sort((a, b) => b[1] - a[1]),
    ggaTotal,
    validFixes,
    noFix,
    quality,
    checksumInvalid,
    firstUtc,
    lastUtc
  };
}

/** Head and tail of a long log, so a 50,000-line session never floods the DOM. */
export function previewLines(lines, { head = 40, tail = 20 } = {}) {
  if (lines.length <= head + tail) {
    return { head: lines, tail: [], hidden: 0 };
  }
  return { head: lines.slice(0, head), tail: lines.slice(lines.length - tail), hidden: lines.length - head - tail };
}

export function previewToText(preview) {
  const parts = [...preview.head];
  if (preview.hidden > 0) {
    parts.push(`… ${preview.hidden.toLocaleString("ja-JP")} 行を省略 …`);
  }
  parts.push(...preview.tail);
  return parts.join("\n");
}

/** One <option> label per saved session, newest first when sorted with compareSessionsNewestFirst. */
export function describeSession(session, lineCount) {
  const started = session?.startedAt ? new Date(session.startedAt) : null;
  const when = started && !Number.isNaN(started.getTime())
    ? started.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "日時不明";
  const status = SESSION_STATUS_LABELS[session?.status] || "不明";
  const field = session?.fieldName ? ` ${session.fieldName}` : "";
  const count = Number.isFinite(lineCount) ? ` ${lineCount.toLocaleString("ja-JP")}行` : "";
  return `${when}${field}${count}（${status}）`;
}

export function compareSessionsNewestFirst(a, b) {
  return String(b?.startedAt || "").localeCompare(String(a?.startedAt || ""));
}

/** A session that is still being written must not be deleted from under the recorder. */
export function canDeleteSession(session, activeSessionId, recordingState) {
  if (!session) {
    return { allowed: false, reason: "セッションが見つかりません。" };
  }
  const live = session.sessionId === activeSessionId && (recordingState === "recording" || recordingState === "paused");
  if (live) {
    return { allowed: false, reason: "記録中のセッションは削除できません。先に「記録終了」を押してください。" };
  }
  return { allowed: true, reason: null };
}

export function mapApplySourceLabel(session) {
  return `記録 ${session?.sessionId ?? ""}`.trim();
}
