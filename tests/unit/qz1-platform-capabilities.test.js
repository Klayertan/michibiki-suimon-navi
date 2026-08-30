// Platform capability detection and the transport abstraction.
//
// The point of these tests: the application must behave sensibly on a browser
// that has none of the hardware APIs, and it must say WHY rather than
// pretending the sensor is broken. Every environment here is a plain object —
// no browser, no user-agent sniffing under test, because the code under test
// does not sniff either.

import test from "node:test";
import assert from "node:assert/strict";
import {
  TRANSPORT_KINDS,
  UNAVAILABLE_REASONS,
  availableTransports,
  capabilityFor,
  detectCapabilities,
  hasAnyTransport,
  looksLikeIosWebkit,
  probeStorage,
  refineBluetoothAvailability
} from "../../js/qz1-water-level/platform-capabilities.js";
import {
  TRANSPORT_PREFERENCE_AUTO,
  describeTransports,
  hasUsablePosition,
  measurementFromLivePoint,
  measurementFromObservation,
  normalizeMeasurement,
  normalizeTransportPreference,
  resolveTransport
} from "../../js/qz1-water-level/sensor-transport.js";

/** A Chromium-like desktop: both hardware APIs, HTTPS. */
function desktopChromium({ cloudConfigured = true } = {}) {
  return detectCapabilities({
    navigatorRef: { serial: {}, bluetooth: {}, userAgent: "Mozilla/5.0 Chrome/120" },
    windowRef: { isSecureContext: true, FileReader: function FileReader() {} },
    storage: workingStorage(),
    cloudConfigured
  });
}

/** iOS Safari: no serial, no bluetooth, everything else fine. */
function iosSafari({ cloudConfigured = true } = {}) {
  return detectCapabilities({
    navigatorRef: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari" },
    windowRef: { isSecureContext: true, FileReader: function FileReader() {} },
    storage: workingStorage(),
    cloudConfigured
  });
}

function workingStorage() {
  const map = new Map();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key)
  };
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

test("desktop Chromium reports serial and bluetooth available", () => {
  const capabilities = desktopChromium();
  assert.equal(capabilities.serial.available, true);
  assert.equal(capabilities.bluetooth.available, true);
  assert.equal(capabilities.fileImport.available, true);
  assert.equal(capabilities.cloud.available, true);
  // availableTransports reports BROWSER capability. What this build can
  // actually drive is narrower — see describeTransports/resolveTransport.
  assert.deepEqual(availableTransports(capabilities),
    [TRANSPORT_KINDS.SERIAL, TRANSPORT_KINDS.BLUETOOTH, TRANSPORT_KINDS.FILE_IMPORT, TRANSPORT_KINDS.CLOUD]);
});

test("iOS Safari loses the direct routes but keeps the application usable", () => {
  // The headline requirement: no direct connection, but file import and cloud
  // remain, so the sensor is not reported as broken.
  const capabilities = iosSafari();
  assert.equal(capabilities.serial.available, false);
  assert.equal(capabilities.serial.reason, UNAVAILABLE_REASONS.API_MISSING);
  assert.equal(capabilities.bluetooth.available, false);
  assert.equal(capabilities.fileImport.available, true);
  assert.equal(hasAnyTransport(capabilities), true, "the app still has a way to get data");
  assert.deepEqual(availableTransports(capabilities), [TRANSPORT_KINDS.FILE_IMPORT, TRANSPORT_KINDS.CLOUD]);
});

test("an insecure context is reported as such, not as an unsupported browser", () => {
  // A fixable problem must not be described as an unfixable one.
  const capabilities = detectCapabilities({
    navigatorRef: { serial: {}, bluetooth: {} },
    windowRef: { isSecureContext: false, FileReader: function FileReader() {} },
    storage: workingStorage(),
    cloudConfigured: false
  });
  assert.equal(capabilities.serial.available, false);
  assert.equal(capabilities.serial.reason, UNAVAILABLE_REASONS.INSECURE_CONTEXT);
  assert.equal(capabilities.bluetooth.reason, UNAVAILABLE_REASONS.INSECURE_CONTEXT);
});

test("a missing navigator does not throw — the app must still boot", () => {
  const capabilities = detectCapabilities({ navigatorRef: null, windowRef: null, storage: null });
  assert.equal(capabilities.serial.available, false);
  assert.equal(capabilities.bluetooth.available, false);
  assert.equal(capabilities.fileImport.available, false);
  assert.equal(hasAnyTransport(capabilities), false);
});

test("cloud is 'not configured' rather than 'unsupported' when nothing is set up", () => {
  const capabilities = desktopChromium({ cloudConfigured: false });
  assert.equal(capabilities.cloud.available, false);
  assert.equal(capabilities.cloud.reason, UNAVAILABLE_REASONS.NOT_CONFIGURED);
});

test("storage that throws on write is detected, and does not throw here", () => {
  // Safari private browsing historically exposed localStorage and threw on
  // setItem. Losing persistence must degrade the app, not break it.
  const hostile = {
    getItem: () => null,
    setItem: () => { throw new Error("QuotaExceededError"); },
    removeItem: () => {}
  };
  assert.equal(probeStorage(hostile).available, false);
  assert.equal(probeStorage(null).available, false);
  assert.equal(probeStorage(workingStorage()).available, true);
});

test("the probe key never survives the probe", () => {
  const storage = workingStorage();
  probeStorage(storage);
  assert.equal(storage.getItem("__suisui_probe__"), null);
});

test("a switched-off Bluetooth radio downgrades the capability", async () => {
  const capabilities = desktopChromium();
  const refined = await refineBluetoothAvailability(capabilities, {
    navigatorRef: { bluetooth: { getAvailability: async () => false } }
  });
  assert.equal(refined.bluetooth.available, false);
  assert.equal(refined.bluetooth.reason, UNAVAILABLE_REASONS.HARDWARE_UNAVAILABLE);
});

test("a browser that refuses to answer about the radio is not treated as a 'no'", async () => {
  const capabilities = desktopChromium();
  const refined = await refineBluetoothAvailability(capabilities, {
    navigatorRef: { bluetooth: { getAvailability: async () => { throw new Error("nope"); } } }
  });
  assert.equal(refined.bluetooth.available, true);
});

test("the iOS hint explains a negative result and never produces one", () => {
  // Availability comes from the feature test alone. The hint only phrases it.
  assert.equal(iosSafari().iosLikeBluetoothBlock, true);
  assert.equal(desktopChromium().iosLikeBluetoothBlock, false,
    "a browser that HAS the API is never flagged, whatever its user agent");

  // An iPad reporting a desktop Mac UA is still iOS.
  assert.equal(looksLikeIosWebkit({ userAgent: "Macintosh", maxTouchPoints: 5 }), true);
  assert.equal(looksLikeIosWebkit({ userAgent: "Macintosh", maxTouchPoints: 0 }), false,
    "a real Mac must not be told to give up on Chrome");
  assert.equal(looksLikeIosWebkit(null), false);
});

// ---------------------------------------------------------------------------
// Transport resolution
// ---------------------------------------------------------------------------

test("unavailable transports are described, not hidden", () => {
  // A farmer who sees nothing cannot tell a missing feature from a broken app.
  const described = describeTransports(iosSafari());
  assert.equal(described.length, 4, "every route is listed");
  const serial = described.find((entry) => entry.kind === TRANSPORT_KINDS.SERIAL);
  assert.equal(serial.available, false);
  assert.ok(serial.reasonTextJa.length > 0, "and carries a reason a person can read");
  assert.ok(serial.reasonTextEn.length > 0);
});

test("auto resolves to the best route the platform actually offers", () => {
  assert.equal(resolveTransport(TRANSPORT_PREFERENCE_AUTO, desktopChromium()).resolved, TRANSPORT_KINDS.SERIAL);
  // On iOS the same sensor record resolves to file import — the only route
  // this build both supports and can drive there. Cloud is modelled but has
  // no ingestion code yet, so it is not offered as if it worked.
  assert.equal(resolveTransport(TRANSPORT_PREFERENCE_AUTO, iosSafari()).resolved, TRANSPORT_KINDS.FILE_IMPORT);
});

test("a preference this platform cannot honour falls back and says so", () => {
  // The same sensor record has to work on the laptop it was configured on and
  // on the phone carried to the paddy.
  const result = resolveTransport(TRANSPORT_KINDS.SERIAL, iosSafari());
  assert.equal(result.resolved, TRANSPORT_KINDS.FILE_IMPORT);
  assert.equal(result.fellBack, true, "the UI must be able to say the preference was not honoured");
  assert.equal(result.requested, TRANSPORT_KINDS.SERIAL);
});

test("a route the browser supports but this build cannot drive is not offered", () => {
  // Web Bluetooth exists in desktop Chromium, but SuisuiNavi has no GATT
  // client. Offering it would be the dead button this layer exists to prevent,
  // and blaming the browser for it would be a lie.
  const described = describeTransports(desktopChromium());
  const bluetooth = described.find((entry) => entry.kind === TRANSPORT_KINDS.BLUETOOTH);
  assert.equal(bluetooth.browserSupported, true, "the browser can");
  assert.equal(bluetooth.implemented, false, "this build cannot");
  assert.equal(bluetooth.available, false);
  assert.ok(bluetooth.reasonTextJa.includes("未実装"), "and the reason names the app, not the browser");

  assert.ok(!resolveTransport(TRANSPORT_PREFERENCE_AUTO, desktopChromium()).usable
    .includes(TRANSPORT_KINDS.BLUETOOTH));
});

test("a platform with no transport at all resolves to nothing rather than guessing", () => {
  const nothing = detectCapabilities({ navigatorRef: null, windowRef: null });
  const result = resolveTransport(TRANSPORT_PREFERENCE_AUTO, nothing);
  assert.equal(result.resolved, null);
  assert.deepEqual(result.usable, []);
});

test("an unknown stored preference degrades to auto instead of breaking", () => {
  assert.equal(normalizeTransportPreference("carrier-pigeon"), TRANSPORT_PREFERENCE_AUTO);
  assert.equal(normalizeTransportPreference(null), TRANSPORT_PREFERENCE_AUTO);
  assert.equal(normalizeTransportPreference(TRANSPORT_KINDS.SERIAL), TRANSPORT_KINDS.SERIAL);
});

test("capabilityFor covers every transport kind and refuses unknown ones", () => {
  const capabilities = desktopChromium();
  for (const kind of Object.values(TRANSPORT_KINDS)) {
    assert.notEqual(capabilityFor(capabilities, kind), null, `${kind} must map to a capability`);
  }
  assert.equal(capabilityFor(capabilities, "nonsense"), null);
});

// ---------------------------------------------------------------------------
// Normalized measurement — the shared format
// ---------------------------------------------------------------------------

test("missing GNSS values stay missing and never become a position at 0N 0E", () => {
  // The bug class this project has already hit twice. Number(null) === 0 and
  // Number("") === 0, and 0 is a valid latitude, longitude and altitude.
  const measurement = normalizeMeasurement({
    latitude: null, longitude: "", altitudeM: undefined,
    fixQuality: null, satellites: "", hdop: undefined, vdop: null, pdop: ""
  });
  for (const field of ["latitude", "longitude", "altitudeM", "fixQuality", "satellites", "hdop", "vdop", "pdop"]) {
    assert.equal(measurement[field], null, `${field} must stay null`);
  }
  assert.equal(hasUsablePosition(measurement), false);
});

test("a zero the receiver really reported survives", () => {
  const measurement = normalizeMeasurement({
    latitude: 0, longitude: 0, altitudeM: 0, fixQuality: 0, satellites: 0, hdop: 0
  });
  assert.equal(measurement.latitude, 0);
  assert.equal(measurement.altitudeM, 0);
  assert.equal(measurement.satellites, 0);
  assert.equal(hasUsablePosition(measurement), true, "0,0 is a real place, however unlikely");
});

test("non-numeric junk is rejected rather than coerced", () => {
  const measurement = normalizeMeasurement({ latitude: {}, longitude: [], altitudeM: "abc", satellites: true });
  assert.equal(measurement.latitude, null);
  assert.equal(measurement.longitude, null);
  assert.equal(measurement.altitudeM, null);
  assert.equal(measurement.satellites, null);
});

test("the live point and a parsed observation produce the same shape", () => {
  // One format downstream, whatever the acquisition route.
  const live = measurementFromLivePoint(
    { lat: 34.7, lon: 135.5, altitude: 50.1, fixQuality: 1, satellites: 9, hdop: 0.9, timestamp: "020000.00" },
    { sensorId: "QZ1-FLOAT-001", receivedAtMs: 1000 }
  );
  const offline = measurementFromObservation(
    { lat: 34.7, lon: 135.5, altitudeMsl: 50.1, fixQuality: 1, satellites: 9, hdop: 0.9, vdop: 1.5, pdop: 1.8, timestampUtcMs: 1000, timeOfDay: "020000.00" },
    { sensorId: "QZ1-FLOAT-001" }
  );
  assert.deepEqual(Object.keys(live).sort(), Object.keys(offline).sort());
  assert.equal(live.latitude, offline.latitude);
  assert.equal(live.altitudeM, offline.altitudeM);
  // The routes differ in what the hardware actually provided, not in shape.
  assert.equal(live.vdop, null, "the live GGA-only path genuinely has no VDOP");
  assert.equal(offline.vdop, 1.5);
  assert.equal(live.source, TRANSPORT_KINDS.SERIAL);
  assert.equal(offline.source, TRANSPORT_KINDS.FILE_IMPORT);
});

test("a null point yields no measurement rather than an empty one", () => {
  assert.equal(measurementFromLivePoint(null), null);
  assert.equal(measurementFromObservation(null), null);
});
