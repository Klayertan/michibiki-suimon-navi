import { migrateCalibration, validateCalibration } from "./gamepad-calibration.js";
export class CalibrationRepository {
 constructor(indexedDB=globalThis.indexedDB){this.indexedDB=indexedDB;}
 open(){return new Promise((resolve,reject)=>{const r=this.indexedDB.open("suisuinavi-gamepad",1);r.onupgradeneeded=()=>r.result.createObjectStore("calibrations",{keyPath:"controllerId"});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
 async save(record){const checked=validateCalibration(record);if(!checked.valid)throw new Error(checked.errors.join(", "));record={...record,updatedAt:new Date().toISOString(),validationState:"valid"};const db=await this.open();await new Promise((res,rej)=>{const r=db.transaction("calibrations","readwrite").objectStore("calibrations").put(record);r.onsuccess=res;r.onerror=()=>rej(r.error)});db.close();return record;}
 async load(id){const db=await this.open();const value=await new Promise((res,rej)=>{const r=db.transaction("calibrations").objectStore("calibrations").get(id);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});db.close();const migrated=migrateCalibration(value);return migrated&&validateCalibration(migrated).valid?migrated:null;}
 async delete(id){const db=await this.open();await new Promise((res,rej)=>{const r=db.transaction("calibrations","readwrite").objectStore("calibrations").delete(id);r.onsuccess=res;r.onerror=()=>rej(r.error)});db.close();}
}
