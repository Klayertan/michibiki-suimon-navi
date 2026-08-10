import test from "node:test";import assert from "node:assert/strict";
import { defaultCalibration,validateCalibration,migrateCalibration,observeAxis } from "../../js/gamepad/gamepad-calibration.js";
import { MockGamepadProvider } from "../../js/gamepad/mock-gamepad-provider.js";
test("malformed calibration is rejected",()=>assert.equal(validateCalibration({schemaVersion:1}).valid,false));
test("defaults are controller-specific and structurally valid",()=>{const a=defaultCalibration({id:"A"}),b=defaultCalibration({id:"B"});assert.equal(validateCalibration(a).valid,true);assert.notEqual(a.controllerId,b.controllerId)});
test("old/unknown schema is rejected by migration",()=>assert.equal(migrateCalibration({schemaVersion:99}),null));
test("schema-v1 calibration migration hydrates semantic axis assignments",()=>{
  const migrated=migrateCalibration({...defaultCalibration({id:"legacy"}),axisAssignments:undefined});
  assert.deepEqual(migrated.axisAssignments,[0,1,2,3]);
});
test("duplicate/out-of-range assignments and invalid dead-man indexes are rejected",()=>{
  const duplicate={...defaultCalibration({id:"duplicate"}),axisAssignments:[0,0,2,3]};
  assert.match(validateCalibration(duplicate).errors.join(";"),/duplicate axis assignments/);
  const badButton={...defaultCalibration({id:"button"}),deadmanButtonIndex:99};
  assert.match(validateCalibration(badButton).errors.join(";"),/invalid dead-man button/);
});
test("axis observation tracks range",()=>assert.deepEqual(observeAxis(observeAxis(null,.4),-.7),{min:-.7,max:.4,center:.4}));
test("simulator connect, input, reset and disconnect",()=>{const p=new MockGamepadProvider();p.connect();p.setAxis(0,.6);p.setButton(4,1);assert.equal(p.sample().axes[0],.6);assert.equal(p.sample().buttons[4].pressed,true);p.reset();assert.equal(p.sample().axes[0],0);p.disconnect();assert.equal(p.sample(),null)});
test("simulator drift and noise controls affect shared samples",()=>{const p=new MockGamepadProvider();p.connect();p.drift=.1;p.noise=0;assert.equal(p.sample().axes[0],.1)});
