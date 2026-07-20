import test from "node:test";
import assert from "node:assert/strict";
import { FieldReportController } from "../../js/reports/field-report-controller.js";

// FieldReportController.buildReportFor()/listReportableFields() are pure
// data lookups (no DOM access) — safe to unit test without calling mount(),
// which is the only place this controller touches document.

function controllerWithData({ fields = [], boundaryTracks = [], surveySessions = [], waterControlPoints = [], fieldObservations = [] }) {
  return new FieldReportController({
    getFieldAnnotationController: () => ({ fields, boundaryTracks, surveySessions, waterControlPoints, fieldObservations })
  });
}

const field = {
  id: "paddy-001", name: "圃場1", coordinates: [[35, 135], [35, 135.0004], [35.0004, 135.0004], [35.0004, 135]],
  sourceSessionId: "session-1",
  properties: { areaM2: 500, closureGapM: 1, closedManually: false, createdAt: "2026-07-20T01:00:00.000Z", updatedAt: "2026-07-20T01:00:00.000Z" }
};
const session = {
  id: "session-1", fieldId: "paddy-001", name: "圃場1 測量", sourceFileName: "walk.txt",
  rawPoints: [{ lat: 35, lon: 135, fixQuality: 1, augmented: false }, { lat: 35, lon: 135.0001, fixQuality: 2, augmented: true }],
  rawNmeaStored: true, rawNmeaStorageReason: null, rawNmeaLineCount: 10, measurementType: "field_polygon"
};

test("listReportableFields() delegates to the shared field-report resolution without touching this.currentReport or the DOM", () => {
  const controller = controllerWithData({ fields: [field], surveySessions: [session] });
  const entries = controller.listReportableFields();
  assert.deepEqual(entries.map((entry) => entry.fieldId), ["paddy-001"]);
  assert.equal(entries[0].fieldName, "圃場1");
  assert.equal(controller.currentReport, null, "listReportableFields must not mutate controller state");
});

test("buildReportFor(fieldId) returns a full report without setting this.currentReport (pure lookup for other panels like 判断デモ)", () => {
  const controller = controllerWithData({ fields: [field], surveySessions: [session] });
  const report = controller.buildReportFor("paddy-001");
  assert.equal(report.fieldId, "paddy-001");
  assert.equal(report.fieldName, "圃場1");
  assert.equal(report.surveyLog.found, true);
  assert.equal(report.surveyLog.sourceFileName, "walk.txt");
  assert.ok(["使用可能", "要確認", "再測量推奨", "証拠不足"].includes(report.reliabilityCheck.label));
  assert.equal(controller.currentReport, null, "buildReportFor must not mutate controller state — generate() is the only method that does");
});

test("listReportableFields() reflects an empty registry when no fields exist", () => {
  const controller = controllerWithData({});
  assert.deepEqual(controller.listReportableFields(), []);
});
