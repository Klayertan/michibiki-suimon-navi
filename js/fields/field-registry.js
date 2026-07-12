import { makeId } from "../gnss/gnss-store.js";

export class FieldRegistry extends EventTarget {
  constructor() {
    super();
    this.fields = new Map();
    this.activeFieldId = null;
  }

  createFromObservationRange({ name, sessionId, observations, startObservationId, endObservationId, direction = "forward" }) {
    const valid = observations.filter((observation) => observation.fixValid && Number.isFinite(observation.lat) && Number.isFinite(observation.lon));
    const startIndex = valid.findIndex((observation) => observation.id === startObservationId);
    const endIndex = valid.findIndex((observation) => observation.id === endObservationId);
    if (startIndex < 0 || endIndex < 0) throw new Error("開始点または終了点が見つかりません。");

    let selected;
    if (direction === "reverse") {
      const from = Math.max(startIndex, endIndex);
      const to = Math.min(startIndex, endIndex);
      selected = valid.slice(to, from + 1).reverse();
    } else {
      const from = Math.min(startIndex, endIndex);
      const to = Math.max(startIndex, endIndex);
      selected = valid.slice(from, to + 1);
    }
    if (selected.length < 3) throw new Error("圃場境界には3点以上が必要です。");

    const coordinates = selected.map((observation) => [observation.lat, observation.lon]);
    const validation = validateBoundary(coordinates);
    const field = {
      id: makeId("field"),
      name: String(name || `圃場 ${this.fields.size + 1}`),
      boundary: {
        coordinates,
        sourceType: "observation-range",
        sessionId,
        startObservationId,
        endObservationId,
        orderedObservationIds: selected.map((observation) => observation.id),
        selectedVertexIds: selected.map((observation) => observation.id),
        direction
      },
      channel: [],
      gate: null,
      validation,
      updatedAt: new Date().toISOString()
    };
    this.fields.set(field.id, field);
    this.activeFieldId = field.id;
    this.emitChange();
    return field;
  }

  addCoordinateField({ id, name, coordinates, sourceType = "legacy" }) {
    const field = {
      id: id || makeId("field"),
      name: name || "圃場",
      boundary: { coordinates: coordinates || [], sourceType, sessionId: null, orderedObservationIds: [], selectedVertexIds: [] },
      channel: [],
      gate: null,
      validation: validateBoundary(coordinates || []),
      updatedAt: new Date().toISOString()
    };
    this.fields.set(field.id, field);
    if (!this.activeFieldId) this.activeFieldId = field.id;
    this.emitChange();
    return field;
  }

  setActive(fieldId) {
    if (!this.fields.has(fieldId)) return false;
    this.activeFieldId = fieldId;
    this.emitChange();
    return true;
  }

  getActive() {
    return this.activeFieldId ? this.fields.get(this.activeFieldId) || null : null;
  }

  serialize() {
    return { activeFieldId: this.activeFieldId, fields: [...this.fields.values()] };
  }

  hydrate(data) {
    this.fields.clear();
    (data.fields || []).forEach((field) => this.fields.set(field.id, field));
    this.activeFieldId = this.fields.has(data.activeFieldId) ? data.activeFieldId : this.fields.keys().next().value || null;
    this.emitChange();
  }

  emitChange() {
    this.dispatchEvent(new Event("change"));
  }
}

export function validateBoundary(coordinates) {
  const warnings = [];
  if (!Array.isArray(coordinates) || coordinates.length < 3) return { valid: false, warnings: ["3点以上が必要です。"] };
  const gap = distanceMeters(coordinates[0], coordinates[coordinates.length - 1]);
  if (gap > 10) warnings.push(`開始点と終了点が${gap.toFixed(1)}m離れています。閉じ方を確認してください。`);
  if (hasSelfIntersection(coordinates)) warnings.push("境界線が自己交差しています。点の範囲・順序を確認してください。");
  return { valid: warnings.length === 0, warnings, closureGapM: gap };
}

function hasSelfIntersection(points) {
  const projected = project(points);
  for (let i = 0; i < projected.length; i += 1) {
    const a = projected[i];
    const b = projected[(i + 1) % projected.length];
    for (let j = i + 1; j < projected.length; j += 1) {
      if (Math.abs(i - j) <= 1 || (i === 0 && j === projected.length - 1)) continue;
      const c = projected[j];
      const d = projected[(j + 1) % projected.length];
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

function project(points) {
  const origin = points[0];
  const metersLon = 111320 * Math.cos(origin[0] * Math.PI / 180);
  return points.map(([lat, lon]) => ({ x: (lon - origin[1]) * metersLon, y: (lat - origin[0]) * 111320 }));
}

function segmentsIntersect(a, b, c, d) {
  const orient = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return orient(a, b, c) !== orient(a, b, d) && orient(c, d, a) !== orient(c, d, b);
}

function distanceMeters(a, b) {
  const lat = (a[0] + b[0]) / 2 * Math.PI / 180;
  const dx = (b[1] - a[1]) * 111320 * Math.cos(lat);
  const dy = (b[0] - a[0]) * 111320;
  return Math.hypot(dx, dy);
}
