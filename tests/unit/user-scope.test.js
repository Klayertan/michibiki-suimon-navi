import test from "node:test";
import assert from "node:assert/strict";
import {
  SCOPED_STORAGE_KEYS,
  ScopedStorage,
  clearScope,
  isScopedKey,
  readScoped,
  scopeHasFields,
  scopeKeyFor,
  writeScoped
} from "../../js/cloud/user-scope.js";

/** A Storage-shaped fake; the real one is not available under node:test. */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    keys: () => [...map.keys()]
  };
}

const FIELD_KEY = "suimonNaviFieldAnnotationsV2";

function storeWith(...fieldIds) {
  return JSON.stringify({ schemaVersion: 3, fields: fieldIds.map((id) => ({ id })) });
}

test("guest scope reads and writes the ORIGINAL keys, byte for byte", () => {
  // The single most important property here: an install that never signs in
  // must behave exactly as it did before per-user namespacing existed.
  const backing = fakeStorage();
  const scoped = new ScopedStorage(backing);
  scoped.setItem(FIELD_KEY, storeWith("paddy-001"));
  assert.deepEqual(backing.keys(), [FIELD_KEY]);
  assert.equal(scoped.getItem(FIELD_KEY), storeWith("paddy-001"));
});

test("a signed-in scope writes a namespaced key and leaves the guest key alone", () => {
  const backing = fakeStorage({ [FIELD_KEY]: storeWith("guest-field") });
  const scoped = new ScopedStorage(backing);
  scoped.setUserId("user-a");
  scoped.setItem(FIELD_KEY, storeWith("paddy-001"));

  assert.equal(backing.getItem(FIELD_KEY), storeWith("guest-field"));
  assert.equal(backing.getItem(`${FIELD_KEY}::u:user-a`), storeWith("paddy-001"));
});

test("switching users cannot surface the previous user's data", () => {
  // Brief §23: a shared phone. This is the leak the whole module exists for.
  const backing = fakeStorage();
  const scoped = new ScopedStorage(backing);

  scoped.setUserId("user-a");
  scoped.setItem(FIELD_KEY, storeWith("A1", "A2"));

  scoped.setUserId("user-b");
  assert.equal(scoped.getItem(FIELD_KEY), null, "user B must start empty, not inherit A's paddies");
  scoped.setItem(FIELD_KEY, storeWith("B1"));
  assert.equal(scoped.getItem(FIELD_KEY), storeWith("B1"));

  scoped.setUserId("user-a");
  assert.equal(scoped.getItem(FIELD_KEY), storeWith("A1", "A2"), "A's data is still intact");
});

test("logging out returns to guest without touching either cache", () => {
  const backing = fakeStorage({ [FIELD_KEY]: storeWith("guest-field") });
  const scoped = new ScopedStorage(backing);
  scoped.setUserId("user-a");
  scoped.setItem(FIELD_KEY, storeWith("A1"));

  scoped.setUserId(null);
  assert.equal(scoped.getItem(FIELD_KEY), storeWith("guest-field"));
  // Brief §22: logout must never delete a farmer's data.
  assert.equal(backing.getItem(`${FIELD_KEY}::u:user-a`), storeWith("A1"));
});

test("setUserId reports whether the scope actually moved", () => {
  const scoped = new ScopedStorage(fakeStorage());
  assert.equal(scoped.setUserId("user-a"), true);
  assert.equal(scoped.setUserId("user-a"), false, "a repeat must not trigger a needless rehydrate");
  assert.equal(scoped.setUserId(null), true);
  assert.equal(scoped.setUserId(null), false);
});

test("only the listed keys are namespaced; everything else stays global", () => {
  const backing = fakeStorage();
  const scoped = new ScopedStorage(backing);
  scoped.setUserId("user-a");
  scoped.setItem("suimonNaviFieldMode", "1"); // a UI preference, not user data
  assert.equal(backing.getItem("suimonNaviFieldMode"), "1");
  assert.equal(backing.getItem("suimonNaviFieldMode::u:user-a"), null);
});

test("every user-data key is covered", () => {
  // A key added to the app but forgotten here is a cross-user leak, so the
  // list is asserted rather than assumed.
  assert.deepEqual(SCOPED_STORAGE_KEYS, [
    "suimonNaviFieldAnnotationsV2",
    "suimonNaviTargetWaterLevelV1",
    "suimonNaviFieldGrowthStageV1",
    "suimonNaviCloudSyncV1"
  ]);
});

test("scopeKeyFor and isScopedKey agree, and guest keys are not 'scoped'", () => {
  assert.equal(scopeKeyFor(FIELD_KEY, "abc"), `${FIELD_KEY}::u:abc`);
  assert.equal(scopeKeyFor(FIELD_KEY, null), FIELD_KEY);
  assert.equal(scopeKeyFor(FIELD_KEY, "  "), FIELD_KEY);
  assert.equal(isScopedKey(`${FIELD_KEY}::u:abc`), true);
  assert.equal(isScopedKey(FIELD_KEY), false);
});

test("readScoped/writeScoped reach a specific scope regardless of the current one", () => {
  const backing = fakeStorage();
  writeScoped(backing, FIELD_KEY, "user-a", storeWith("A1"));
  const scoped = new ScopedStorage(backing);
  scoped.setUserId("user-b");
  assert.equal(readScoped(backing, FIELD_KEY, "user-a"), storeWith("A1"));
  assert.equal(scoped.getItem(FIELD_KEY), null);
});

test("clearScope removes one user's data and only that user's", () => {
  const backing = fakeStorage({ [FIELD_KEY]: storeWith("guest") });
  writeScoped(backing, FIELD_KEY, "user-a", storeWith("A1"));
  writeScoped(backing, FIELD_KEY, "user-b", storeWith("B1"));

  assert.equal(clearScope(backing, "user-a"), 1);
  assert.equal(readScoped(backing, FIELD_KEY, "user-a"), null);
  assert.equal(readScoped(backing, FIELD_KEY, "user-b"), storeWith("B1"));
  assert.equal(backing.getItem(FIELD_KEY), storeWith("guest"));
});

test("scopeHasFields detects an empty or corrupt scope without throwing", () => {
  const backing = fakeStorage();
  assert.equal(scopeHasFields(backing, "user-a"), false);
  writeScoped(backing, FIELD_KEY, "user-a", JSON.stringify({ fields: [] }));
  assert.equal(scopeHasFields(backing, "user-a"), false);
  writeScoped(backing, FIELD_KEY, "user-a", "{not json");
  assert.equal(scopeHasFields(backing, "user-a"), false);
  writeScoped(backing, FIELD_KEY, "user-a", storeWith("paddy-001"));
  assert.equal(scopeHasFields(backing, "user-a"), true);
});

test("a missing backing storage degrades to no-ops instead of throwing", () => {
  const scoped = new ScopedStorage(null);
  assert.equal(scoped.getItem(FIELD_KEY), null);
  assert.doesNotThrow(() => scoped.setItem(FIELD_KEY, "x"));
  assert.doesNotThrow(() => scoped.removeItem(FIELD_KEY));
  assert.equal(clearScope(null, "user-a"), 0);
});
