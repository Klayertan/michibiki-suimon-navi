import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGrowthStageRecord,
  GROWTH_STAGES,
  growthStageOptions,
  growthStageRule,
  hasNumericTarget,
  isDrainageStage,
  isGrowthStageId,
  normalizeGrowthStageId,
  normalizeGrowthStageRecord,
  UNKNOWN_STAGE_ID
} from "../../js/water/growth-stage-model.js";
import { resolveSources, verificationLabel, WATER_MANAGEMENT_SOURCES } from "../../js/water/water-management-sources.js";

// The stage set the feature is specified against. Asserted rather than
// assumed: dropping one silently would quietly narrow the model.
const REQUIRED_STAGE_IDS = [
  "pre_transplant",
  "after_transplanting",
  "establishment",
  "tillering",
  "midseason_drainage",
  "panicle_initiation",
  "booting",
  "heading_flowering",
  "ripening",
  "final_drainage",
  "unknown"
];

test("every conceptual growth stage is present, in cultivation-calendar order", () => {
  assert.deepEqual(GROWTH_STAGES.map((stage) => stage.id), REQUIRED_STAGE_IDS);
});

test("no rule anywhere in the model depends on field area", () => {
  // The whole scientific point of the model: the target is a function of stage
  // and management conditions, never of size.
  const serialized = JSON.stringify(GROWTH_STAGES);
  assert.ok(!/area/i.test(serialized), "a stage rule must not reference area");
});

test("every stage carries a management mode, a note, and provenance for its numbers", () => {
  for (const stage of GROWTH_STAGES) {
    assert.ok(stage.labelJa && stage.labelEn, `${stage.id} needs bilingual labels`);
    assert.ok(stage.mode, `${stage.id} needs a management mode`);
    assert.ok(stage.noteJa && stage.noteEn, `${stage.id} needs bilingual notes`);
    if (hasNumericTarget(stage.id)) {
      assert.ok(stage.sourceIds.length > 0, `${stage.id} states a numeric range and must cite sources`);
      assert.equal(resolveSources(stage.sourceIds).length, stage.sourceIds.length, `${stage.id} cites an unknown source id`);
      assert.equal(stage.confidence, "reference");
      assert.ok(stage.targetMinMm < stage.targetMaxMm, `${stage.id} range must be ordered`);
      assert.ok(stage.targetMinMm > 0, `${stage.id} range must be a real depth`);
    } else {
      assert.equal(stage.targetMinMm, null, `${stage.id} must use null, not 0, for "no numeric target"`);
      assert.equal(stage.targetMaxMm, null);
      assert.ok(["management-state", "unknown"].includes(stage.confidence));
    }
  }
});

test("the drainage stages are exactly 中干し and 落水期", () => {
  const drainage = GROWTH_STAGES.filter((stage) => isDrainageStage(stage.id)).map((stage) => stage.id);
  assert.deepEqual(drainage, ["midseason_drainage", "final_drainage"]);
  for (const id of drainage) {
    assert.equal(hasNumericTarget(id), false, `${id} must never carry a numeric fill target`);
  }
});

test("unknown / missing / mistyped stage ids resolve to the explicit unknown stage", () => {
  assert.equal(normalizeGrowthStageId("tillering"), "tillering");
  for (const value of [undefined, null, "", "Tillering", "分げつ期", 3, {}, []]) {
    assert.equal(normalizeGrowthStageId(value), UNKNOWN_STAGE_ID);
  }
  assert.equal(isGrowthStageId("tillering"), true);
  assert.equal(isGrowthStageId("harvest"), false);
});

test("growthStageRule always returns a usable rule", () => {
  const rule = growthStageRule("nonsense");
  assert.equal(rule.id, UNKNOWN_STAGE_ID);
  assert.equal(rule.targetMinMm, null);
});

test("selector options expose the mode label alongside each stage", () => {
  const options = growthStageOptions();
  assert.equal(options.length, GROWTH_STAGES.length);
  const tillering = options.find((option) => option.value === "tillering");
  assert.equal(tillering.labelJa, "分げつ期");
  assert.equal(tillering.modeLabelJa, "浅水管理");
});

test("conditional managements are declared, not silently applied", () => {
  const tillering = growthStageRule("tillering");
  assert.equal(tillering.mode, "shallow", "the base management stays shallow");
  assert.equal(tillering.conditional.length, 1);
  assert.equal(tillering.conditional[0].mode, "deep");
  assert.match(tillering.conditional[0].conditionJa, /低温/);
  assert.ok(resolveSources(tillering.conditional[0].sourceIds).length > 0);
});

// ---------------------------------------------------------------------------
// Per-field stage record (persistence shape)
// ---------------------------------------------------------------------------

test("a stage record records how the stage was decided, and future derivation inputs", () => {
  const record = buildGrowthStageRecord({
    stage: "tillering",
    transplantedOn: "2026-05-20",
    variety: "コシヒカリ",
    updatedAt: 1755000000000
  });
  assert.deepEqual(record, {
    stage: "tillering",
    source: "manual",
    transplantedOn: "2026-05-20",
    variety: "コシヒカリ",
    updatedAt: 1755000000000
  });
});

test("a stage record never invents a stage", () => {
  assert.equal(buildGrowthStageRecord({ stage: "nope" }).stage, UNKNOWN_STAGE_ID);
  assert.equal(buildGrowthStageRecord({}).stage, UNKNOWN_STAGE_ID);
});

test("a bare stage-id string in storage is accepted; junk normalizes to null", () => {
  assert.equal(normalizeGrowthStageRecord("tillering").stage, "tillering");
  assert.equal(normalizeGrowthStageRecord("tillering").source, "manual");
  for (const raw of [null, undefined, 5, true]) {
    assert.equal(normalizeGrowthStageRecord(raw), null);
  }
  assert.equal(normalizeGrowthStageRecord({ stage: "garbage" }).stage, UNKNOWN_STAGE_ID);
});

// ---------------------------------------------------------------------------
// Source registry
// ---------------------------------------------------------------------------

test("every registry source states organization, what it supports, its caveat and how it was checked", () => {
  for (const [id, source] of Object.entries(WATER_MANAGEMENT_SOURCES)) {
    assert.equal(source.id, id);
    assert.ok(source.organization, `${id} needs an organization`);
    assert.ok(source.titleJa && source.titleEn, `${id} needs bilingual titles`);
    assert.ok(source.supportsJa && source.supportsEn, `${id} must say what it supports`);
    assert.ok(source.caveatJa && source.caveatEn, `${id} must state its caveat`);
    assert.match(source.url, /^https?:\/\//, `${id} needs a citable URL`);
    // Provenance is not just a link: a reviewer must be able to tell a page we
    // actually fetched and read from one that merely resolves.
    assert.ok(["primary", "link-only"].includes(source.verification?.level), `${id} needs a verification level`);
    assert.match(source.verification.checkedOn, /^\d{4}-\d{2}-\d{2}$/, `${id} needs a check date`);
    assert.ok(verificationLabel(source), `${id} needs a displayable verification label`);
  }
});

test("the peer-reviewed water-requirement record carries full bibliographic detail", () => {
  const record = WATER_MANAGEMENT_SOURCES.naroWaterRequirement;
  assert.equal(record.titleJa, "低平地水田における減水深の空間的ばらつき");
  assert.equal(record.doi, "10.24514/00001146");
  assert.equal(record.issn, "2432-7883");
  assert.equal(record.journal.startsWith("農研機構研究報告 農村工学研究部門"), true);
  assert.equal(record.volume, "3");
  assert.equal(record.pages, "1-12");
  assert.equal(record.publishedOn, "2019-03-30");
  assert.equal(record.authors.length, 2);
});

test("a source whose contents could not be read is not used for any number", () => {
  // maffCultivation is an image-only PDF: reachable, but unverifiable here.
  assert.equal(WATER_MANAGEMENT_SOURCES.maffCultivation.verification.level, "link-only");
  const numericStages = GROWTH_STAGES.filter((stage) => hasNumericTarget(stage.id));
  for (const stage of numericStages) {
    assert.ok(
      !stage.sourceIds.includes("maffCultivation"),
      `${stage.id} states a numeric range, so it must not rest on an unverified source`
    );
    assert.ok(
      resolveSources(stage.sourceIds).some((source) => source.verification.level === "primary"),
      `${stage.id} needs at least one fully-checked source`
    );
  }
});

test("the four reference works named in the brief are all encoded", () => {
  for (const id of ["naroSmartWater", "naroTillering", "maffCultivation", "naroWaterRequirement"]) {
    assert.ok(WATER_MANAGEMENT_SOURCES[id], `${id} must be in the registry`);
  }
});

test("unknown source ids are dropped rather than rendered as blanks", () => {
  assert.deepEqual(resolveSources(["naroTillering", "notARealSource"]).map((s) => s.id), ["naroTillering"]);
  assert.deepEqual(resolveSources(undefined), []);
});
