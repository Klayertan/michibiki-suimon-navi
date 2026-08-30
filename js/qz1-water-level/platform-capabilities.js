// What this browser can actually do, asked of the browser rather than guessed
// from its name.
//
// WHY THIS MODULE EXISTS
// ----------------------
// SuisuiNavi is meant to be usable on an iPhone in a paddy, a Windows laptop
// in an office and a Mac at a desk. "Universal" cannot mean "every hardware
// transport works everywhere", because it demonstrably does not: Web Serial
// and Web Bluetooth are Chromium features, and Safari — the only browser
// engine iOS allows — ships neither. A single "接続" button that throws
// `navigator.serial is undefined` on an iPhone is worse than no button.
//
// So the application asks what is available and offers what is. The sensor
// domain downstream is identical on every platform; only the way measurements
// ARRIVE differs. See docs/qz1-floating-water-level/PLATFORM_SUPPORT.md.
//
// NO BROWSER SNIFFING
// -------------------
// Nothing here branches on `navigator.userAgent`. User-agent strings lie by
// design (every browser claims to be several others), they change without
// warning, and a feature test stays correct when Safari eventually ships an
// API that it does not ship today. `detectCapabilities()` therefore only
// ever asks "does this object exist", "is this a secure context", "does this
// store accept a write".
//
// The one place a platform hint IS collected is `iosLikeBluetoothBlock`, and
// it is used ONLY to explain a negative result the feature test already
// produced — never to decide one. On iOS every browser is Safari's engine
// underneath, so "install Chrome" is bad advice there and good advice on
// Windows; that difference cannot be feature-detected and is the sole reason
// the hint exists.

/** Every acquisition route the sensor domain understands. */
export const TRANSPORT_KINDS = {
  /** Web Serial: USB cable, or a Bluetooth SPP virtual COM port. */
  SERIAL: "serial",
  /** Web Bluetooth GATT. Not the same thing as the SPP port above. */
  BLUETOOTH: "bluetooth",
  /** A recorded NMEA log the farmer picks with a file input. */
  FILE_IMPORT: "file-import",
  /** Measurements pushed in by a gateway through the network. */
  CLOUD: "cloud"
};

/** Why a transport is not offered. Drives the wording the farmer sees. */
export const UNAVAILABLE_REASONS = {
  /** The API object is simply not in this browser. */
  API_MISSING: "api-missing",
  /** The API exists but needs HTTPS (or localhost) and this page is not. */
  INSECURE_CONTEXT: "insecure-context",
  /** The API exists and the context is secure, but the radio is off. */
  HARDWARE_UNAVAILABLE: "hardware-unavailable",
  /** Nothing is configured to send us data yet. */
  NOT_CONFIGURED: "not-configured",
  /**
   * The browser could do this, but SuisuiNavi has no code behind it yet.
   * Kept distinct from API_MISSING so the UI never blames the browser for a
   * gap in this application.
   */
  NOT_IMPLEMENTED: "not-implemented"
};

/**
 * Reads the environment.
 *
 * Synchronous and side-effect-free apart from one probe write to storage,
 * which is immediately removed. Everything is injectable so the whole matrix
 * can be unit tested without a browser.
 *
 * `bluetooth` here means "the API exists". Whether a radio is switched on is
 * asynchronous (`navigator.bluetooth.getAvailability()`); call
 * `refineBluetoothAvailability()` for that when it matters. Reporting the
 * synchronous answer first means the UI can render immediately rather than
 * waiting on a permission-adjacent call at boot.
 */
export function detectCapabilities({
  navigatorRef = typeof navigator === "undefined" ? null : navigator,
  windowRef = typeof window === "undefined" ? null : window,
  storage = null,
  cloudConfigured = null
} = {}) {
  const secureContext = windowRef ? windowRef.isSecureContext === true : false;

  // Both APIs are gated on a secure context by specification. Distinguishing
  // "your browser cannot" from "this page is not on HTTPS" matters: the
  // second is fixable by the person reading the message.
  const serialApi = Boolean(navigatorRef && "serial" in navigatorRef);
  const bluetoothApi = Boolean(navigatorRef && "bluetooth" in navigatorRef);

  const serial = describeApiCapability(serialApi, secureContext);
  const bluetooth = describeApiCapability(bluetoothApi, secureContext);

  // File import is the floor this application stands on. `FileReader` and
  // `<input type=file>` are universal across every browser SuisuiNavi
  // targets, which is exactly why the iOS story is "import the log" rather
  // than "you cannot use this feature".
  const fileImport = {
    available: Boolean(windowRef && typeof windowRef.FileReader === "function"),
    reason: windowRef && typeof windowRef.FileReader === "function" ? null : UNAVAILABLE_REASONS.API_MISSING
  };

  const cloud = cloudConfigured === null
    ? { available: false, reason: UNAVAILABLE_REASONS.NOT_CONFIGURED }
    : { available: Boolean(cloudConfigured), reason: cloudConfigured ? null : UNAVAILABLE_REASONS.NOT_CONFIGURED };

  return {
    secureContext,
    serial,
    bluetooth,
    fileImport,
    cloud,
    persistentStorage: probeStorage(storage),
    // Explanation only. Never used to decide availability — see the header.
    iosLikeBluetoothBlock: looksLikeIosWebkit(navigatorRef) && !bluetoothApi
  };
}

function describeApiCapability(apiPresent, secureContext) {
  if (!apiPresent) {
    return { available: false, reason: UNAVAILABLE_REASONS.API_MISSING };
  }
  if (!secureContext) {
    return { available: false, reason: UNAVAILABLE_REASONS.INSECURE_CONTEXT };
  }
  return { available: true, reason: null };
}

/**
 * Confirms a `Storage`-shaped object actually accepts a write.
 *
 * `"localStorage" in window` is not the question. Safari in Private Browsing
 * historically exposed the object and threw on `setItem`, and every browser
 * throws once the quota is full. The probe key is removed immediately; a
 * failure here is reported, not thrown, because losing persistence must
 * degrade the app rather than break it.
 */
export function probeStorage(storage) {
  if (!storage || typeof storage.setItem !== "function") {
    return { available: false, reason: UNAVAILABLE_REASONS.API_MISSING };
  }
  const probeKey = "__suisui_probe__";
  try {
    storage.setItem(probeKey, "1");
    storage.removeItem(probeKey);
    return { available: true, reason: null };
  } catch {
    return { available: false, reason: UNAVAILABLE_REASONS.HARDWARE_UNAVAILABLE };
  }
}

/**
 * Asks whether a Bluetooth radio is actually usable. Async by specification.
 *
 * Returns the capability unchanged when the API is absent — there is nothing
 * to refine — so a caller can apply this unconditionally.
 */
export async function refineBluetoothAvailability(capabilities, {
  navigatorRef = typeof navigator === "undefined" ? null : navigator
} = {}) {
  if (!capabilities?.bluetooth?.available || !navigatorRef?.bluetooth?.getAvailability) {
    return capabilities;
  }
  try {
    const radioPresent = await navigatorRef.bluetooth.getAvailability();
    if (radioPresent) {
      return capabilities;
    }
    return {
      ...capabilities,
      bluetooth: { available: false, reason: UNAVAILABLE_REASONS.HARDWARE_UNAVAILABLE }
    };
  } catch {
    // A browser that refuses to answer is not a browser that said "no".
    return capabilities;
  }
}

/**
 * True for an engine that is WebKit-on-iOS.
 *
 * Used only to phrase an explanation (see the header). Deliberately narrow:
 * it must not match desktop Safari, where the advice "use Chrome instead" is
 * actually correct.
 */
export function looksLikeIosWebkit(navigatorRef) {
  const ua = String(navigatorRef?.userAgent ?? "");
  if (!ua) {
    return false;
  }
  const iPhoneOrIPad = /iPhone|iPad|iPod/.test(ua);
  // iPadOS 13+ reports a desktop Mac UA; touch points separate it from a Mac.
  const iPadMasqueradingAsMac = /Macintosh/.test(ua) && Number(navigatorRef?.maxTouchPoints ?? 0) > 1;
  return iPhoneOrIPad || iPadMasqueradingAsMac;
}

/** Transports usable right now, in the order the UI should offer them. */
export function availableTransports(capabilities) {
  const order = [TRANSPORT_KINDS.SERIAL, TRANSPORT_KINDS.BLUETOOTH, TRANSPORT_KINDS.FILE_IMPORT, TRANSPORT_KINDS.CLOUD];
  return order.filter((kind) => capabilityFor(capabilities, kind)?.available === true);
}

/** The capability entry backing one transport kind. */
export function capabilityFor(capabilities, kind) {
  switch (kind) {
    case TRANSPORT_KINDS.SERIAL: return capabilities?.serial ?? null;
    case TRANSPORT_KINDS.BLUETOOTH: return capabilities?.bluetooth ?? null;
    case TRANSPORT_KINDS.FILE_IMPORT: return capabilities?.fileImport ?? null;
    case TRANSPORT_KINDS.CLOUD: return capabilities?.cloud ?? null;
    default: return null;
  }
}

/**
 * True when SOME route exists to get measurements in.
 *
 * The honest headline for the iPhone case: direct connection is unavailable,
 * the application is not.
 */
export function hasAnyTransport(capabilities) {
  return availableTransports(capabilities).length > 0;
}
