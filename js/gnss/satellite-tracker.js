// Live satellite state from the NMEA stream: GSV (satellites in view with
// elevation / azimuth / C/N0), GSA (which PRNs the receiver used) and RMC
// (course over ground / speed). Pure and DOM-free, one sentence at a time, so
// it can sit beside the existing GGA-only live pipeline without touching it.
//
// Not a second fix parser: GGA stays the source of position / fix quality.

import { validateNmeaChecksum } from "./nmea-parser.js";

const TALKER_CONSTELLATION = Object.freeze({
  GP: "GPS",
  GL: "GLONASS",
  GA: "Galileo",
  GB: "BeiDou",
  BD: "BeiDou",
  GQ: "QZSS"
});

export const CONSTELLATION_ORDER = ["QZSS", "GPS", "GLONASS", "Galileo", "BeiDou", "その他"];

// QZSS PRNs are 193-202 in NMEA; some receivers report them under a GPS (GP)
// talker, so the PRN wins over the talker.
export function constellationFor(talker, prn) {
  const number = Number(prn);
  if (number >= 193 && number <= 202) return "QZSS";
  return TALKER_CONSTELLATION[talker] || "その他";
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export class SatelliteTracker {
  constructor({ requireChecksum = false, staleAfterMs = 6000, usedTtlMs = 3000 } = {}) {
    this.requireChecksum = requireChecksum;
    this.staleAfterMs = staleAfterMs;
    this.usedTtlMs = usedTtlMs;
    this.reset();
  }

  reset() {
    this.satellites = new Map(); // `${talker}:${prn}` -> satellite (committed cycles)
    this.pending = new Map(); // talker -> Map(prn -> satellite) for a GSV cycle in progress
    this.usedPrns = new Map(); // prn -> when a GSA last listed it
    this.course = null;
    this.speedKnots = null;
    this.lastGsvMs = null;
  }

  /** @returns {boolean} true when the line changed tracker state. */
  ingest(rawLine, nowMs = Date.now()) {
    const line = String(rawLine || "").trim();
    const match = /^\$([A-Z]{2})([A-Z]{3}),/.exec(line);
    if (!match) return false;
    if (this.requireChecksum && line.includes("*") && validateNmeaChecksum(line) === false) return false;
    const [, talker, type] = match;
    const fields = line.split("*")[0].split(",");

    if (type === "GSV") return this.ingestGsv(talker, fields, nowMs);
    if (type === "GSA") return this.ingestGsa(fields, nowMs);
    if (type === "RMC") return this.ingestRmc(fields);
    return false;
  }

  ingestGsv(talker, fields, nowMs) {
    const total = numberOrNull(fields[1]);
    const index = numberOrNull(fields[2]);
    if (total === null || index === null) return false;

    if (index === 1) this.pending.set(talker, new Map());
    const cycle = this.pending.get(talker);
    if (!cycle) return false; // joined mid-cycle: wait for message 1

    // Each entry is PRN, elevation, azimuth, C/N0; the final C/N0 may be
    // empty or cut off, so only PRN/elevation/azimuth have to be present.
    for (let i = 4; i + 2 < fields.length; i += 4) {
      const prn = fields[i];
      if (!prn) continue;
      cycle.set(prn, {
        talker,
        prn,
        constellation: constellationFor(talker, prn),
        elevation: numberOrNull(fields[i + 1]),
        azimuth: numberOrNull(fields[i + 2]),
        // Empty C/N0 means the satellite is in view but not tracked.
        snr: numberOrNull(fields[i + 3])
      });
    }

    if (index === total) {
      // Replace this talker's satellites wholesale: a satellite that dropped
      // out of the cycle must disappear instead of lingering forever.
      for (const key of [...this.satellites.keys()]) {
        if (key.startsWith(`${talker}:`)) this.satellites.delete(key);
      }
      for (const [prn, satellite] of cycle) this.satellites.set(`${talker}:${prn}`, satellite);
      this.pending.delete(talker);
      this.lastGsvMs = nowMs;
    }
    return true;
  }

  ingestGsa(fields, nowMs) {
    // Fields 3-14 are the PRNs used in the solution. Several GSA lines arrive
    // per epoch (one per constellation) and receivers order GGA / GSA / GSV /
    // RMC differently, so "used" is not tied to an epoch boundary: a PRN
    // counts as used while a GSA listed it within the last `usedTtlMs`.
    for (const prn of fields.slice(3, 15).filter(Boolean)) this.usedPrns.set(prn, nowMs);
    return true;
  }

  ingestRmc(fields) {
    this.speedKnots = numberOrNull(fields[7]);
    this.course = numberOrNull(fields[8]);
    return true;
  }

  /** Satellites grouped for display, sorted by constellation then PRN. */
  snapshot(nowMs = Date.now()) {
    const stale = this.lastGsvMs === null || nowMs - this.lastGsvMs > this.staleAfterMs;
    const isUsed = (prn) => {
      const listedAt = this.usedPrns.get(prn);
      return listedAt !== undefined && nowMs - listedAt <= this.usedTtlMs;
    };
    const satellites = [...this.satellites.values()].map((satellite) => ({
      ...satellite,
      used: isUsed(satellite.prn),
      tracked: Number.isFinite(satellite.snr)
    }));
    satellites.sort((a, b) => {
      const byConstellation = CONSTELLATION_ORDER.indexOf(a.constellation) - CONSTELLATION_ORDER.indexOf(b.constellation);
      return byConstellation || Number(a.prn) - Number(b.prn);
    });
    const tracked = satellites.filter((satellite) => satellite.tracked);
    return {
      stale,
      satellites,
      inView: satellites.length,
      tracked: tracked.length,
      used: satellites.filter((satellite) => satellite.used).length,
      qzssInView: satellites.filter((satellite) => satellite.constellation === "QZSS").length,
      qzssTracked: tracked.filter((satellite) => satellite.constellation === "QZSS").length,
      course: this.course,
      speedKnots: this.speedKnots
    };
  }
}

/** Sky-plot position in a unit circle: centre = zenith, edge = horizon, north up. */
export function skyPlotPosition({ elevation, azimuth }, radius = 1) {
  if (!Number.isFinite(elevation) || !Number.isFinite(azimuth)) return null;
  const clamped = Math.min(90, Math.max(0, elevation));
  const distance = ((90 - clamped) / 90) * radius;
  const radians = (azimuth * Math.PI) / 180;
  return { x: distance * Math.sin(radians), y: -distance * Math.cos(radians) };
}

/** Bar color for C/N0 (dB-Hz): the usual rule-of-thumb bands, not an accuracy claim. */
export function snrColor(snr) {
  if (!Number.isFinite(snr)) return "#94a3b8";
  if (snr >= 35) return "#15803d";
  if (snr >= 25) return "#d97706";
  return "#b91c1c";
}
