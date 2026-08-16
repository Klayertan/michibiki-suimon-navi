// Deciding whether a user-picked file is a usable NMEA log: pure logic
// (no DOM, no File API).
//
// Why this exists
// ---------------
// The NMEA pickers used to carry `accept=".nmea,.txt,.log,text/plain"`.
// iOS Safari hands that list to the native Files picker, which filters by
// UTType — and a custom `.nmea` file has no platform-recognised UTType, so
// iPhone users saw their own recordings greyed out while the identical file
// opened fine on macOS. The pickers therefore no longer carry `accept` at
// all (NOT `accept="*/*"`, which is the same filtering machinery with a
// wildcard); the file is allowed through the picker and judged here instead.
//
// Consequences for what this module may look at:
//
//   * MIME type is NEVER consulted. iOS reports "" or
//     "application/octet-stream" for a `.nmea` file — both are normal, and
//     rejecting on either is exactly the bug being fixed.
//   * The extension is informational only. `.nmea` / `.txt` / `.log` are the
//     names we expect, but a file that is named anything else and *contains*
//     NMEA is still a valid recording, and a `.nmea` file full of noise is
//     still not one.
//
// So content is the only thing that decides. This module answers the cheap
// half of that question — "does this text contain NMEA sentences at all?" —
// so an obviously-wrong file is rejected before any parser state is touched.
// The authoritative half ("are there usable fixes in it?") stays with the
// existing NMEA parser; see index.html's handleNmeaFileSelected().

/** Shown to the farmer for anything that is not a usable NMEA recording. */
export const NMEA_INTAKE_REJECTED_MESSAGE =
  "NMEAデータを確認できませんでした。QZ1から保存したNMEAログを選んでください。";

/** Names we expect. Informational: never used to reject. */
export const NMEA_FILE_EXTENSIONS = [".nmea", ".txt", ".log"];

// A sentence is "$" + a 2-character talker id + a 3-character sentence id +
// ",". Deliberately wider than the GGA-only pattern the parser keeps: a log
// that is all RMC/GSV still *is* an NMEA log, and telling the farmer "this
// is not NMEA" about it would be wrong. Whether it yields fixes is the
// parser's call, not ours.
const NMEA_SENTENCE_PATTERN = /\$[A-Z]{2}[A-Z0-9]{3},/;

// Logger apps prefix lines with timestamps and QZ1 sessions can be long, so
// the scan is not anchored to the first line. It is capped because a binary
// file the user picked by mistake can be arbitrarily large and a real log
// carries sentences from its very first bytes.
const SCAN_LIMIT_CHARS = 65536;

/** True when `text` contains at least one recognisable NMEA sentence. */
export function hasNmeaSentences(text) {
  if (typeof text !== "string" || text.length === 0) {
    return false;
  }
  return NMEA_SENTENCE_PATTERN.test(text.slice(0, SCAN_LIMIT_CHARS));
}

/** True when the name ends in one of the extensions we expect. Advisory. */
export function hasExpectedNmeaExtension(fileName) {
  const name = String(fileName || "").toLowerCase();
  return NMEA_FILE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

/**
 * Judges a picked file from its name and its text.
 *
 * `type` is accepted so call sites can pass the whole File-ish object
 * unchanged, and is then ignored on purpose — see the header.
 *
 * @returns {{accepted: boolean, expectedExtension: boolean, message: string|null}}
 */
export function describeNmeaCandidate({ name = "", text = "" } = {}) {
  const accepted = hasNmeaSentences(text);
  return {
    accepted,
    expectedExtension: hasExpectedNmeaExtension(name),
    message: accepted ? null : NMEA_INTAKE_REJECTED_MESSAGE
  };
}
