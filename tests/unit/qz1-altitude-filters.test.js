import test from "node:test";
import assert from "node:assert/strict";
import {
  FILTER_KINDS,
  PRESET_FILTER_CHAINS,
  applyFilterChain,
  filterAltitudes,
  normalizeFilterChain
} from "../../js/qz1-water-level/altitude-filters.js";

/** SYNTHETIC samples: hand-built numbers, not observations. */
function sample(altitudeMm, extra = {}) {
  return { altitudeMm, fix: 1, satellites: 9, hdop: 0.9, vdop: 1.4, pdop: 1.8, ...extra };
}

test("an empty chain is the identity, and that is the honest default", () => {
  const samples = [sample(10), sample(20), sample(30)];
  const result = applyFilterChain(samples, []);
  assert.deepEqual(result.samples.map((entry) => entry.altitudeMm), [10, 20, 30]);
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.stages, []);
});

test("no filtering happens unless a chain is asked for", () => {
  const { chain } = normalizeFilterChain(undefined);
  assert.deepEqual(chain, [], "undefined must not silently become a default quality gate");
});

test("presets resolve by name and are copied, not shared", () => {
  const { chain } = normalizeFilterChain("standard-quality-gate");
  assert.equal(chain.length, PRESET_FILTER_CHAINS["standard-quality-gate"].length);
  chain[0].kind = "mutated";
  assert.equal(PRESET_FILTER_CHAINS["standard-quality-gate"][0].kind, "require-altitude",
    "mutating a resolved chain must not corrupt the preset");
});

test("an unknown filter kind is an error, never a silent skip", () => {
  const { chain, errors } = normalizeFilterChain([{ kind: "wishful-thinking" }]);
  assert.equal(chain, null);
  assert.equal(errors.length, 1);
  assert.ok(!FILTER_KINDS.includes("wishful-thinking"));
});

test("a filter stage missing its parameter is an error", () => {
  for (const broken of [
    [{ kind: "fix-quality" }],
    [{ kind: "fix-quality", allowed: [1, null] }],
    [{ kind: "min-satellites" }],
    [{ kind: "min-satellites", minimum: null }],
    [{ kind: "max-hdop", maximum: "low" }],
    [{ kind: "max-hdop", maximum: null }],
    [{ kind: "moving-mean", windowSamples: 0 }],
    [{ kind: "moving-mean", windowSamples: null }],
    [{ kind: "moving-median", windowSamples: 2.5 }],
    [{ kind: "mad-outlier", threshold: -1 }]
  ]) {
    assert.equal(normalizeFilterChain(broken).chain, null, `${JSON.stringify(broken)} must not normalize`);
  }
});

test("quality gates remove exactly what they say and report the count", () => {
  const samples = [
    sample(10, { fix: 1 }),
    sample(20, { fix: 0 }),
    sample(30, { fix: 4 })
  ];
  const result = applyFilterChain(samples, [{ kind: "fix-quality", allowed: [1, 2, 4, 5] }]);
  assert.deepEqual(result.samples.map((entry) => entry.altitudeMm), [10, 30]);
  assert.equal(result.stages[0].removed, 1);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].kind, "fix-quality");
  assert.ok(result.rejected[0].reason.includes("fix"));
});

test("a DOP gate keeps samples whose DOP the receiver never sent", () => {
  // Otherwise a GGA-only receiver would produce an empty dataset and the
  // report would read "no usable data" instead of "no VDOP available".
  const samples = [sample(10, { vdop: null }), sample(20, { vdop: 9 }), sample(30, { vdop: 1.2 })];
  const result = applyFilterChain(samples, [{ kind: "max-vdop", maximum: 3 }]);
  assert.deepEqual(result.samples.map((entry) => entry.altitudeMm), [10, 30]);
});

test("require-altitude drops samples with no altitude at all", () => {
  const result = applyFilterChain([sample(10), sample(null), sample(30)], [{ kind: "require-altitude" }]);
  assert.deepEqual(result.samples.map((entry) => entry.altitudeMm), [10, 30]);
});

test("MAD outlier rejection survives a spike that would defeat a sigma gate", () => {
  // One 40 m spike inflates the SD enough to protect itself; MAD does not
  // move. This is the case the real dorm-walk log actually contains.
  const values = [100, 102, 98, 101, 99, 103, 97, 40000];
  const samples = values.map((value) => sample(value));
  const mad = applyFilterChain(samples, [{ kind: "mad-outlier", threshold: 3 }]);
  assert.ok(!mad.samples.some((entry) => entry.altitudeMm === 40000), "MAD removes the spike");

  const sigma = applyFilterChain(samples, [{ kind: "sigma-outlier", threshold: 3 }]);
  assert.ok(sigma.samples.some((entry) => entry.altitudeMm === 40000),
    "a 3σ gate does NOT remove it — the spike defines the σ");
});

test("outlier rejection with no spread removes nothing, rather than removing arbitrarily", () => {
  const result = applyFilterChain([sample(50), sample(50), sample(50), sample(50)], [{ kind: "mad-outlier", threshold: 3 }]);
  assert.equal(result.samples.length, 4);
});

test("smoothing keeps the original value under rawAltitudeMm", () => {
  const samples = [sample(0), sample(10), sample(20), sample(30), sample(40)];
  const result = applyFilterChain(samples, [{ kind: "moving-mean", windowSamples: 3 }]);
  assert.equal(result.samples[2].rawAltitudeMm, 20, "the observed value is never destroyed");
  assert.equal(result.samples[2].altitudeMm, 20, "centred mean of 10,20,30");
  assert.equal(result.samples[2].smoothedFrom, 3);
});

test("the smoothing window is centred, so a step is not delayed", () => {
  // A trailing window would put the transition half a window late and make
  // every step look shallower than it is.
  const samples = [0, 0, 0, 100, 100, 100].map((value) => sample(value));
  const result = applyFilterChain(samples, [{ kind: "moving-mean", windowSamples: 3 }]);
  assert.equal(result.samples[2].altitudeMm, 100 / 3, "the rise starts at the sample before the step");
  assert.equal(result.samples[3].altitudeMm, 200 / 3);
});

test("window edges report how many samples really contributed", () => {
  const samples = [sample(10), sample(20), sample(30)];
  const result = applyFilterChain(samples, [{ kind: "moving-median", windowSamples: 5 }]);
  assert.equal(result.samples[0].smoothedFrom, 3, "an edge value is not padded to a full window");
});

test("a smoothing stage is reported as transformed even though it removes nothing", () => {
  const result = applyFilterChain([sample(10), sample(20)], [{ kind: "moving-mean", windowSamples: 3 }]);
  assert.equal(result.stages[0].removed, 0);
  assert.equal(result.stages[0].transformed, true, "'removed: 0' must not read as 'did nothing'");
});

test("stage order is preserved exactly as declared", () => {
  const chain = [
    { kind: "require-altitude" },
    { kind: "min-satellites", minimum: 5 },
    { kind: "moving-mean", windowSamples: 3 }
  ];
  const result = applyFilterChain([sample(10)], chain);
  assert.deepEqual(result.stages.map((stage) => stage.kind),
    ["require-altitude", "min-satellites", "moving-mean"]);
});

test("every rejected sample is traceable to the stage that rejected it", () => {
  const samples = [sample(10, { fix: 0 }), sample(20, { satellites: 2 }), sample(30)];
  const result = applyFilterChain(samples, [
    { kind: "fix-quality", allowed: [1, 2, 4, 5] },
    { kind: "min-satellites", minimum: 5 }
  ]);
  assert.equal(result.rejected.length, 2);
  assert.equal(result.rejected[0].stageIndex, 0);
  assert.equal(result.rejected[1].stageIndex, 1);
  assert.equal(result.rejected[0].sample.altitudeMm, 10, "the rejected sample itself is kept");
});

test("filterAltitudes returns the raw set untouched alongside the filtered one", () => {
  const samples = [sample(10, { fix: 0 }), sample(20)];
  const { raw, filtered, report } = filterAltitudes(samples, "valid-fix-only");
  assert.equal(raw.length, 2, "raw is never mutated or shortened");
  assert.equal(filtered.length, 1);
  assert.equal(report.rejectedCount, 1);
  assert.ok(report.chain.length > 0, "the chain used is returned with the result");
});
