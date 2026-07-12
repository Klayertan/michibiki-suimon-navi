import test from "node:test";
import assert from "node:assert/strict";
import { GnssStore } from "../../js/gnss/gnss-store.js";

test("legacy survey points load without inventing receiver or NMEA provenance", () => {
  const store = new GnssStore();
  const session = store.addLegacyPoints([{
    lat: 35,
    lon: 135,
    fixQuality: 2,
    satelliteCount: 8,
    hdop: 1.2,
    timestamp: "2026-07-12T00:00:00Z",
    feature: "corner"
  }], { sourceName: "old-survey.json" });
  const observation = store.getObservations(session.id)[0];
  assert.equal(session.receiverId, "legacy-unknown");
  assert.equal(observation.receiverId, "legacy-unknown");
  assert.equal(observation.augmentation.status, "unknown");
  assert.deepEqual(observation.rawRefs, []);
  assert.ok(session.warnings[0].includes("旧形式"));
});

test("receiver-aware sessions survive a v2 export/import round trip", () => {
  const original = new GnssStore();
  const session = original.addLegacyPoints([{ lat: 35, lon: 135, fixQuality: 1 }]);
  const restored = new GnssStore();
  restored.hydrate(original.serialize());
  assert.equal(restored.getSession(session.id).id, session.id);
  assert.deepEqual(restored.getObservations(session.id), original.getObservations(session.id));
});
