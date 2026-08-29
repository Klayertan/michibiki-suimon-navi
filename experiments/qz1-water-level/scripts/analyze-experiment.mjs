#!/usr/bin/env node
// Offline analysis of a QZ1 vertical-displacement experiment.
//
// Acquisition and analysis are deliberately separate programs. This one never
// touches a serial port, never asks the receiver anything, and cannot alter a
// recording — it reads a log that already exists and produces a verdict from
// it. That separation is what makes a run re-analysable: the same log can be
// pushed through a different filter chain a year later and the original
// numbers are still there to compare against.
//
// Two input modes:
//
//   1. A raw NMEA log plus a marks file (which levels were held when).
//      The log goes through the project's EXISTING parser
//      (js/gnss/nmea-parser.js) — there is no second NMEA implementation.
//
//        node experiments/qz1-water-level/scripts/analyze-experiment.mjs \
//          --nmea run.nmea --marks run.marks.json --config run.config.json
//
//   2. An experiment CSV written earlier by this project, whose rows already
//      carry their reference height.
//
//        node experiments/qz1-water-level/scripts/analyze-experiment.mjs \
//          --csv run.csv --config run.config.json
//
// Options:
//   --filter <name|json>  filter chain: a preset name (none, valid-fix-only,
//                         standard-quality-gate, quality-gate-then-median-15)
//                         or an inline JSON array. Default: none — the raw,
//                         unprocessed result, which is the honest default.
//   --html <path>         write a standalone HTML report with the plots
//   --csv-out <path>      write the labelled experiment CSV
//   --json-out <path>     write the full analysis as JSON
//   --capture-date <YYYY-MM-DD>
//                         for logs whose sentences carry no date

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// fileURLToPath, not `.pathname`: a repository checked out under a path with
// spaces or non-ASCII characters would otherwise resolve to a percent-encoded
// string and every import below would fail with a confusing ENOENT.
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const load = (relative) => import(pathToFileURL(resolve(ROOT, relative)).href);

const { parseNmeaSession } = await load("js/gnss/nmea-parser.js");
const { observationsToSamples } = await load("js/qz1-water-level/experiment-samples.js");
const { normalizeExperimentConfig } = await load("js/qz1-water-level/experiment-config.js");
const { analyzeExperiment } = await load("js/qz1-water-level/displacement-analysis.js");
const { renderTextReport, renderHtmlReport } = await load("js/qz1-water-level/experiment-report.js");
const { experimentToCsv, parseExperimentCsv, marksFromLabelledSamples } = await load("js/qz1-water-level/experiment-csv.js");

const args = parseArgs(process.argv.slice(2));

if (!args.config) {
  fail("--config <experiment config json> is required. See experiments/qz1-water-level/configs/.");
}
if (!args.nmea && !args.csv) {
  fail("Provide either --nmea <log> --marks <marks.json>, or --csv <experiment.csv>.");
}

const { config, errors: configErrors } = normalizeExperimentConfig(readJson(args.config));
if (!config) {
  fail(`Invalid experiment config:\n  - ${configErrors.join("\n  - ")}`);
}

let samples;
let marks;

if (args.nmea) {
  if (!args.marks) {
    fail("--nmea requires --marks (the file recording which reference height was held when).");
  }
  const text = readFileSync(resolve(args.nmea), "utf8");
  const parsed = parseNmeaSession(text, {
    receiver: { id: "qz1", role: "qz1" },
    sessionId: config.experimentId,
    sourceName: args.nmea,
    sourceType: "file",
    captureDate: args["capture-date"] ?? null
  });
  for (const warning of parsed.session.warnings) {
    process.stderr.write(`parser warning: ${warning}\n`);
  }
  samples = observationsToSamples(parsed.observations);
  const marksFile = readJson(args.marks);
  marks = Array.isArray(marksFile) ? marksFile : marksFile.marks;
  if (marksFile?.synthetic) {
    process.stderr.write(
      "\n*** SYNTHETIC INPUT ***\n"
      + "This marks file is flagged synthetic. The report below exercises the analysis\n"
      + "code; it is not evidence about any receiver's real behaviour.\n\n"
    );
  }
} else {
  const parsed = parseExperimentCsv(readFileSync(resolve(args.csv), "utf8"));
  if (parsed.errors.length > 0) {
    fail(`Cannot read CSV:\n  - ${parsed.errors.join("\n  - ")}`);
  }
  samples = parsed.samples;
  marks = args.marks ? (readJson(args.marks).marks ?? readJson(args.marks)) : marksFromLabelledSamples(samples);
}

const analysis = analyzeExperiment({
  samples,
  marks,
  config,
  filterChain: parseFilterOption(args.filter)
});

if (!analysis.ok) {
  fail(`Analysis failed:\n  - ${analysis.errors.join("\n  - ")}`);
}

process.stdout.write(`${renderTextReport(analysis)}\n`);

if (args["csv-out"]) {
  const labelled = relabelSamples(samples, marks);
  writeFileSync(resolve(args["csv-out"]), experimentToCsv(labelled, {
    experimentId: config.experimentId,
    stage: config.stage
  }), "utf8");
  process.stderr.write(`\nwrote ${args["csv-out"]}\n`);
}
if (args.html) {
  writeFileSync(resolve(args.html), renderHtmlReport(analysis), "utf8");
  process.stderr.write(`wrote ${args.html}\n`);
}
if (args["json-out"]) {
  writeFileSync(resolve(args["json-out"]), `${JSON.stringify(analysis, replacer, 2)}\n`, "utf8");
  process.stderr.write(`wrote ${args["json-out"]}\n`);
}

// Exit code carries the headline: 0 when at least one step size was resolved,
// 2 when none was. 2 is NOT an error — a run where nothing is resolvable is a
// valid negative result, and the distinct code just lets a script tell the
// two outcomes apart without parsing the report.
const anyPass = Object.values(analysis.verdicts).includes("PASS");
process.exit(anyPass ? 0 : 2);

// ---------------------------------------------------------------------------

/** Re-applies the marks to raw samples so the exported CSV carries labels. */
function relabelSamples(allSamples, allMarks) {
  return allSamples.map((sample) => {
    const mark = allMarks.find((candidate) =>
      Number.isFinite(sample.timestampUtcMs)
      && sample.timestampUtcMs >= candidate.startMs
      && (candidate.endMs === null || candidate.endMs === undefined || sample.timestampUtcMs < candidate.endMs));
    return mark
      ? {
        ...sample,
        referenceHeightMm: mark.referenceHeightMm,
        stepIndex: mark.stepIndex,
        visitIndex: mark.visitIndex,
        direction: mark.direction
      }
      : sample;
  });
}

function parseFilterOption(value) {
  if (value === undefined || value === true) {
    return [];
  }
  const text = String(value).trim();
  if (text.startsWith("[")) {
    try {
      return JSON.parse(text);
    } catch (error) {
      fail(`--filter is not valid JSON: ${error.message}`);
    }
  }
  return text;
}

/** Drops the bulky per-sample arrays from the JSON dump; the CSV holds those. */
function replacer(key, value) {
  return key === "filteredSamples" || key === "filteredAltitudesMm" || key === "rawAltitudesMm"
    ? undefined
    : value;
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}
