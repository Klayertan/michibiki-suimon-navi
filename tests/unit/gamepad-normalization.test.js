import test from "node:test";
import assert from "node:assert/strict";
import { clamp, scaleAxis, compensateCenter, invertAxis, axialDeadzone, radialDeadzone, applyExpo, normalizeTrigger, isNeutral, detectDrift, detectNoise, gatePreview, normalizeMode2Axes } from "../../js/gamepad/gamepad-normalization.js";
import { defaultCalibration } from "../../js/gamepad/gamepad-calibration.js";

test("clamp and asymmetric calibration",()=>{assert.equal(clamp(2),1);assert.equal(clamp(-2),-1);assert.ok(Math.abs(scaleAxis(.6,-1,.2,1)-.5)<1e-12);assert.ok(Math.abs(scaleAxis(-.4,-1,.2,1)+.5)<1e-12)});
test("centre offset and inversion",()=>{assert.ok(Math.abs(compensateCenter(.3,.1)-.2)<1e-12);assert.equal(invertAxis(.4,true),-.4)});
test("axial deadzone rescales",()=>{assert.equal(axialDeadzone(.05,.1),0);assert.ok(axialDeadzone(.55,.1)>.49)});
test("radial deadzone retains direction",()=>{assert.deepEqual(radialDeadzone(.05,.05,.1),{x:0,y:0});const r=radialDeadzone(.5,.5,.1);assert.ok(Math.abs(r.x-r.y)<1e-9)});
test("expo and trigger normalization",()=>{assert.equal(applyExpo(0),0);assert.equal(normalizeTrigger(-1,-1,1),0);assert.equal(normalizeTrigger(1,-1,1),1)});
test("neutral drift and noise detection",()=>{assert.equal(isNeutral([.01,0],[.01]),true);assert.equal(detectDrift([.1,.11,.09]),true);assert.equal(detectNoise([-.1,.1,-.1,.1]),true)});
test("Mode 2 normalization applies semantic assignments and raw-axis inversion",()=>{
  const calibration=defaultCalibration({id:"mapped",axesCount:4});
  calibration.axisAssignments=[2,3,0,1];
  calibration.axisInversions=[false,false,false,true];
  calibration.deadzones=[0,0,0,0];
  calibration.expoValues=[0,0,0,0];
  const axes=normalizeMode2Axes({axes:[.3,-.4,.5,-.6]},calibration);
  assert.deepEqual(axes,{yaw:.5,throttle:-.6,roll:.3,pitch:.4});
});
test("dead-man release immediately zeroes every preview",()=>{const r=gatePreview({yaw:.5,vertical:-.5},{deadman:false,connected:true,focused:true,visible:true,stale:false,calibrated:true});assert.deepEqual(r.values,{yaw:0,vertical:0});assert.equal(r.reason,"deadman-released")});
for(const [name,state,reason] of [["disconnect",{connected:false},"controller-disconnected"],["focus loss",{focused:false},"focus-lost"],["visibility loss",{visible:false},"tab-hidden"],["stale input",{stale:true},"stale-input"],["incomplete calibration",{calibrated:false},"calibration-incomplete"]]) test(`${name} resets output`,()=>{const base={deadman:true,connected:true,focused:true,visible:true,stale:false,calibrated:true,...state};const r=gatePreview({roll:1},base);assert.equal(r.values.roll,0);assert.equal(r.reason,reason)});
