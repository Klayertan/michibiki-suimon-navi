// The blue "you are here" marker: dot + translucent facing cone, like the one
// in Google Maps. Markup only; Leaflet wiring is in index.html.

export const LOCATION_MARKER_SIZE = 56;

/**
 * @param {{ heading?: number|null }} options heading in degrees clockwise from north; null hides the cone.
 */
export function locationMarkerHtml({ heading = null } = {}) {
  const hasHeading = Number.isFinite(heading);
  const rotation = hasHeading ? heading : 0;
  // The cone points straight up (north) and is rotated about the marker centre.
  return `<div class="loc-marker${hasHeading ? "" : " loc-marker--no-heading"}">`
    + `<svg class="loc-cone" viewBox="0 0 56 56" aria-hidden="true" style="transform:rotate(${rotation.toFixed(1)}deg)">`
    + `<defs><linearGradient id="locConeFade" x1="0" y1="1" x2="0" y2="0">`
    + `<stop offset="0" stop-color="#1d4ed8" stop-opacity="0.55"/><stop offset="1" stop-color="#1d4ed8" stop-opacity="0"/>`
    + `</linearGradient></defs>`
    + `<path d="M28 28 L10 2 A34 34 0 0 1 46 2 Z" fill="url(#locConeFade)"/>`
    + `</svg><span class="loc-dot"></span></div>`;
}

/** Updates an already-rendered marker element in place (cheap enough for compass events). */
export function setLocationMarkerHeading(element, heading) {
  const marker = element?.querySelector?.(".loc-marker");
  const cone = element?.querySelector?.(".loc-cone");
  if (!marker || !cone) return false;
  const hasHeading = Number.isFinite(heading);
  marker.classList.toggle("loc-marker--no-heading", !hasHeading);
  if (hasHeading) cone.style.transform = `rotate(${heading.toFixed(1)}deg)`;
  return true;
}
