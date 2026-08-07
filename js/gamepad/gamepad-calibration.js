export const CALIBRATION_SCHEMA_VERSION = 1;
export function defaultCalibration(meta = {}) {
  const n = meta.axesCount ?? 4;
  return { schemaVersion: 1, controllerId: meta.id || "", mapping: meta.mapping || "", axesCount:n, buttonsCount:meta.buttonsCount ?? 18, createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(), axisCenters:Array(n).fill(0), axisMinimums:Array(n).fill(-1), axisMaximums:Array(n).fill(1), axisInversions:Array(n).fill(false), deadzones:Array(n).fill(.08), expoValues:Array(n).fill(.25), triggerRanges:{ l2:{rest:0,full:1}, r2:{rest:0,full:1} }, deadmanButtonIndex:4, warnings:[], validationState:"incomplete" };
}
export function validateCalibration(value) {
  if (!value || value.schemaVersion !== 1 || typeof value.controllerId !== "string" || !Number.isInteger(value.axesCount) || value.axesCount < 1) return { valid:false, errors:["malformed calibration data"] };
  const arrays=["axisCenters","axisMinimums","axisMaximums","axisInversions","deadzones","expoValues"];
  const errors=arrays.filter(k => !Array.isArray(value[k]) || value[k].length !== value.axesCount).map(k=>`invalid ${k}`);
  for(let i=0;i<value.axesCount;i++) if ((value.axisMaximums?.[i] - value.axisMinimums?.[i]) < .5) errors.push(`axis ${i}: insufficient range`);
  if (new Set(value.axisAssignments || [0,1,2,3]).size < (value.axisAssignments || [0,1,2,3]).length) errors.push("duplicate axis assignments");
  return { valid:errors.length===0, errors };
}
export function observeAxis(stats, value) { return { min:Math.min(stats?.min ?? value,value), max:Math.max(stats?.max ?? value,value), center:stats?.center ?? value }; }
export function migrateCalibration(value) { return value?.schemaVersion === 1 ? value : null; }
