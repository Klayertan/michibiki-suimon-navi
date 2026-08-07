import { BrowserGamepadProvider } from "./browser-gamepad-provider.js";
import { MockGamepadProvider } from "./mock-gamepad-provider.js";
import { KeyboardProvider } from "./keyboard-provider.js";
import { defaultCalibration, observeAxis, validateCalibration } from "./gamepad-calibration.js";
import { CalibrationRepository } from "./gamepad-storage.js";
import { scaleAxis, axialDeadzone, applyExpo, radialDeadzone, gatePreview, isNeutral } from "./gamepad-normalization.js";
import { likelyDualSense } from "./gamepad-provider.js";

const buttonNames={4:"L1",5:"R1",6:"L2",7:"R2",12:"↑",13:"↓",14:"←",15:"→",0:"Cross",1:"Circle",2:"Square",3:"Triangle",8:"Create",9:"Options"};

/** Selectable input sources. Exactly one may be active at a time; switching
 *  zeroes every output before the new source is read. */
export const INPUT_SOURCES = Object.freeze({
  none: "なし / None",
  keyboard: "キーボード / Keyboard",
  browser: "ゲームパッド / Browser gamepad",
  mock: "シミュレーション / Simulated gamepad"
});

/**
 * Display state for the input source, used by render() and unit-tested
 * directly. Split out of the template because the disconnected case has
 * specific required wording: a source that is not present must never report
 * "Neutral: active" — absence of input is not evidence of a centred stick.
 */
export function inputStatusModel({ source, sample, gated, stale }) {
  if (source === "none" || !sample) {
    return {
      controller: source === "none" ? "未選択 / No source selected" : "未検出 / Not detected",
      neutral: "利用不可 / unavailable",
      inputActive: "いいえ / no",
      deadman: "無効 / inactive — source unavailable",
      available: false
    };
  }
  return {
    controller: sample.id,
    neutral: isNeutral(sample.axes, []) ? "中立 / neutral" : "非中立 / active",
    inputActive: gated?.active ? "はい / yes" : "いいえ / no",
    deadman: gated?.active ? "有効 / active" : `無効 / ${gated?.reason ?? "inactive"}`,
    available: true,
    stale: Boolean(stale)
  };
}

export class GamepadController {
 constructor(){this.browser=new BrowserGamepadProvider();this.mock=new MockGamepadProvider();this.keyboard=new KeyboardProvider();this.source="browser";this.provider=this.browser;this.repo=new CalibrationRepository();this.sample=null;this.calibration=null;this.stats=[];this.step=0;this.connectedAt=null;this.lastMeaningful=null;this.focused=document.hasFocus();this.visible=!document.hidden;this.desktop=window.SUISUI_DESKTOP||null;}
 async mount(){this.panel=document.querySelector("#gamepadPanel");this.root=document.querySelector("#gamepadRoot");if(!this.root)return;this.panel.hidden=false;this.renderShell();this.bindProvider(this.browser);this.bindProvider(this.mock);this.bindProvider(this.keyboard);this.keyboard.addEventListener("capture",()=>this.render());this.keyboard.addEventListener("panic",()=>this.render());this.browser.start();window.addEventListener("focus",()=>{this.focused=true;this.render()});window.addEventListener("blur",()=>{this.focused=false;this.zeroInput();this.render()});document.addEventListener("visibilitychange",()=>{this.visible=!document.hidden;if(document.hidden)this.zeroInput();this.render()});window.addEventListener("pagehide",()=>this.zeroInput());
  // The native desktop shell calls this when the OS window loses focus; the
  // page itself never sees that, so held keys would otherwise keep counting.
  window.suisuiDesktopBlur=()=>{this.focused=false;this.zeroInput();this.render();};
  this.bind();this.render();}
 bindProvider(p){p.addEventListener("sample",e=>this.accept(e.detail));p.addEventListener("connection",e=>{if(!e.detail){this.sample=null;this.calibration=null;this.render();}else{this.connectedAt=Date.now();this.accept(e.detail);}});}
 /** Release every held control immediately, whatever the source. */
 zeroInput(){this.keyboard.reset();if(this.provider===this.mock)this.mock.reset();}
 /** Switch input source by name. Zeroes all output before switching. */
 selectSource(name){if(!(name in INPUT_SOURCES)||name===this.source)return;this.zeroInput();this.keyboard.stopCapture();if(this.provider&&this.provider!==this.browser)this.provider.stop?.();this.source=name;this.sample=null;this.calibration=null;this.stats=[];
  this.provider=name==="keyboard"?this.keyboard:name==="mock"?this.mock:name==="browser"?this.browser:null;
  if(name==="keyboard")this.keyboard.start();
  this.render();}
 switchProvider(p){if(this.provider===p)return;this.provider=p;this.sample=null;this.calibration=null;this.render();}
 async accept(sample){if(!sample)return;this.sample=sample;sample.axes.forEach((v,i)=>this.stats[i]=observeAxis(this.stats[i],v));if(sample.axes.some(v=>Math.abs(v)>.08)||sample.buttons.some(b=>b.pressed))this.lastMeaningful=Date.now();if(!this.calibration||this.calibration.controllerId!==sample.id){this.calibration=defaultCalibration({id:sample.id,mapping:sample.mapping,axesCount:sample.axes.length,buttonsCount:sample.buttons.length});this.render();const saved=await this.repo.load(sample.id);if(saved&&this.sample?.id===sample.id)this.calibration=saved;}this.render();}
 renderShell(){this.root.innerHTML=`<div class="gamepad-safety" role="note">No aircraft commands are being transmitted.<br>機体への操作コマンドは送信されていません。</div><div id="gpLive" role="status" aria-live="polite" class="sr-only"></div><div id="gpContent"></div>`;}
 render(){const s=this.sample;const stale=Boolean(s&&s.provider!=="keyboard"&&(performance.now()-s.timestamp>500));const c=this.calibration;
  // The keyboard is a synthetic, exactly-known source: it has no analogue
  // centre to measure, so requiring a calibration pass would block it forever.
  const calibrated=this.source==="keyboard"?true:c?.validationState==="valid";
  let values={yaw:0,vertical:0,roll:0,pitch:0};
  if(s&&this.source==="keyboard"){const [yaw,vertical,roll,pitch]=s.axes;values={yaw,vertical,roll,pitch};}
  else if(s&&c){const a=s.axes.map((v,i)=>applyExpo(axialDeadzone(scaleAxis(v,c.axisMinimums[i],c.axisCenters[i],c.axisMaximums[i]),c.deadzones[i]),c.expoValues[i]));const l=radialDeadzone(a[0],a[1]),r=radialDeadzone(a[2],a[3]);values={yaw:l.x,vertical:l.y,roll:r.x,pitch:r.y};}
  const deadman=Boolean(s?.buttons[c?.deadmanButtonIndex??4]?.pressed);
  const connected=Boolean(s)&&this.source!=="none"&&(this.source!=="keyboard"||this.keyboard.capturing);
  const gated=gatePreview(values,{deadman,connected,focused:this.focused,visible:this.visible,stale,calibrated});
  const info=inputStatusModel({source:this.source,sample:connected?s:null,gated,stale});
  const status=info.available?`${{keyboard:"キーボード / Keyboard",mock:"シミュレーション / Simulated Gamepad",browser:"Browser"}[this.source]||this.source} — ${s.id}`:info.controller;
  const mockEnabled=this.desktop?true:new URLSearchParams(location.search).get("gamepadMock")==="1";
  document.querySelector("#gpContent").innerHTML=`
${this.desktop?`<p class="gp-desktop-badge">デスクトップ版 / Desktop — ${this.desktop.modeLabel||this.desktop.mode} mode${this.desktop.development?" [DEV]":""}</p>`:""}
<div class="input-row"><label for="gpSource">入力ソース / Input source</label><select id="gpSource">${Object.entries(INPUT_SOURCES).map(([k,v])=>`<option value="${k}" ${this.source===k?"selected":""}>${v}</option>`).join("")}</select></div>
${this.source==="keyboard"?`<div class="gp-keyboard"><button id="gpKeyCapture" type="button" class="panel-button ${this.keyboard.capturing?"danger":"primary"}">${this.keyboard.capturing?"キャプチャ停止 / Stop capture":"キーボードをキャプチャ / Capture keyboard"}</button><p class="meta">W/S=pitch, A/D=roll, ←/→=yaw, ↑/↓=vertical, 左Shift長押し=Dead-man, Esc=即時中立・キャプチャ解除。プレビューのみ / preview only.</p></div>`:""}
<div class="gp-status"><strong>${status}</strong>${s&&info.available&&likelyDualSense(s.id)?'<span class="gp-badge">DualSense候補 / hint</span>':''}${this.source==="mock"&&info.available?'<span class="gp-sim">SIMULATION</span>':''}</div>
<dl class="gp-meta"><div><dt>Controller</dt><dd id="gpController">${info.controller}</dd></div><div><dt>Provider</dt><dd>${info.available?s.provider:"—"}</dd></div><div><dt>Mapping</dt><dd>${info.available?s.mapping:"—"}</dd></div><div><dt>Axes / Buttons</dt><dd>${info.available?`${s.axes.length} / ${s.buttons.length}`:"—"}</dd></div><div><dt>Calibration</dt><dd>${this.source==="keyboard"?"不要 / not required":calibrated?"保存済み / valid":"未完了 / incomplete"}</dd></div><div><dt>最終入力</dt><dd>${this.lastMeaningful?new Date(this.lastMeaningful).toLocaleTimeString():"—"}</dd></div><div><dt>Neutral</dt><dd id="gpNeutral">${info.neutral}</dd></div><div><dt>Input active</dt><dd id="gpInputActive">${info.inputActive}</dd></div><div><dt>Dead-man</dt><dd id="gpDeadmanState">${info.deadman}</dd></div><div><dt>Focus / Visible</dt><dd>${this.focused&&this.visible?"有効":"無効"}</dd></div><div><dt>Stale</dt><dd>${info.available?(stale?"はい / stale":"いいえ"):"—"}</dd></div></dl>
<section><h3>プレビューのみ — 機体には送信されません</h3><div class="gp-preview">${Object.entries(values).map(([k,v])=>`<div><span>${k==="vertical"?"Vertical input preview":k}</span><meter min="-1" max="1" value="${gated.values[k]}"></meter><output>${v.toFixed(3)} → ${gated.values[k].toFixed(3)}</output></div>`).join("")}</div><p class="gp-gate ${gated.active?'active':''}">Dead-man: ${gated.active?"有効 / active":`無効 / ${gated.reason}`}</p></section>
<details><summary>生入力モニター / Raw input</summary><div class="gp-table-wrap"><table><thead><tr><th>Axis</th><th>Raw</th><th>Min</th><th>Centre</th><th>Max</th><th>Normalized</th></tr></thead><tbody>${(s?.axes||[]).map((v,i)=>`<tr><td>${i}</td><td>${v.toFixed(3)}</td><td>${(this.stats[i]?.min??v).toFixed(3)}</td><td>${(c?.axisCenters[i]??0).toFixed(3)}</td><td>${(this.stats[i]?.max??v).toFixed(3)}</td><td>${(values[["yaw","vertical","roll","pitch"][i]]??0).toFixed(3)}</td></tr>`).join("")}</tbody></table></div><div class="gp-buttons">${(s?.buttons||[]).map((b,i)=>`<span>${buttonNames[i]||i}: ${b.pressed?"pressed":"released"}${b.touched?" / touched":""} (${b.value.toFixed(2)})</span>`).join("")}</div></details>
<section><h3>校正 / Calibration</h3><p>Step ${this.step+1}/8: ${["触れずに中央・ノイズを測定","左スティックを全域へ","右スティックを全域へ","L2を全押し・解放","R2を全押し・解放","Dead-manを数回押す","範囲・反転・警告を確認","保存"][this.step]}</p><label>Dead-man button <select id="gpDeadman">${[4,5].map(i=>`<option value="${i}" ${c?.deadmanButtonIndex===i?'selected':''}>${buttonNames[i]}</option>`).join("")}</select></label><div class="gp-actions"><button id="gpCalNext" type="button" ${!s?'disabled':''}>次へ / Next</button><button id="gpCalSave" type="button" ${this.step<7||!s?'disabled':''}>保存 / Save</button><button id="gpCalDelete" type="button" ${!s?'disabled':''}>削除 / Delete</button></div><p id="gpCalMessage"></p></section>
<aside class="gp-warning"><strong>工学上の注意:</strong> DualSenseの左スティックは中央復帰式で、従来RCのスロットルとして自動的に扱えません。将来候補: ALT_HOLD/GUIDEDの昇降率、全下げゼロ、QGroundControl式、速度制限付き垂直速度。Phase 1では選択・実装しません。</aside>
${mockEnabled?`<details id="gpSimulator" ${this.source==="mock"?"open":""}><summary><span class="gp-sim">SIMULATION</span> シミュレーション / Simulated Gamepad</summary><div class="gp-actions"><button id="gpMockConnect">接続</button><button id="gpMockDisconnect">突然切断</button><button id="gpMockReset">中立へリセット</button></div>${["Left X","Left Y","Right X","Right Y"].map((n,i)=>`<label>${n}<input data-axis="${i}" type="range" min="-1" max="1" step=".01" value="${this.mock.axes[i]}"></label>`).join("")}<label>L2<input data-button="6" type="range" min="0" max="1" step=".01"></label><label>R2<input data-button="7" type="range" min="0" max="1" step=".01"></label><label>Drift<input id="gpDrift" type="range" min="0" max=".2" step=".005" value="${this.mock.drift}"></label><label>Noise<input id="gpNoise" type="range" min="0" max=".1" step=".005" value="${this.mock.noise}"></label><div class="gp-buttons">${[4,5,12,13,14,15,0,1,2,3,8,9].map(i=>`<button data-toggle="${i}">${buttonNames[i]}</button>`).join("")}</div><label><input id="gpStale" type="checkbox"> Sample staleness</label><button id="gpBlur">Focus-loss simulation</button></details>`:"<p class='meta'>Simulator disabled. Add <code>?gamepadMock=1</code> in development.</p>"}`;document.querySelector("#gpLive").textContent=`${status}; dead-man ${gated.reason||"active"}`;this.bindDynamic();}
 bind(){this.panel.addEventListener("toggle",()=>{if(!this.panel.open&&this.provider===this.mock)this.mock.reset()});}
 bindDynamic(){const q=s=>document.querySelector(s);
  q("#gpSource")?.addEventListener("change",e=>this.selectSource(e.target.value));
  q("#gpKeyCapture")?.addEventListener("click",()=>{if(this.keyboard.capturing)this.keyboard.stopCapture();else this.keyboard.startCapture();this.render();});
  q("#gpCalNext")?.addEventListener("click",()=>{this.step=Math.min(7,this.step+1);this.render()});q("#gpDeadman")?.addEventListener("change",e=>{this.calibration.deadmanButtonIndex=+e.target.value});q("#gpCalSave")?.addEventListener("click",async()=>{this.calibration.axisMinimums=this.stats.map(x=>x.min);this.calibration.axisMaximums=this.stats.map(x=>x.max);this.calibration.validationState="valid";const v=validateCalibration(this.calibration);if(!v.valid){q("#gpCalMessage").textContent=v.errors.join("; ");return;}await this.repo.save(this.calibration);this.render()});q("#gpCalDelete")?.addEventListener("click",async()=>{await this.repo.delete(this.sample.id);this.calibration=defaultCalibration({id:this.sample.id,axesCount:this.sample.axes.length,buttonsCount:this.sample.buttons.length});this.step=0;this.render()});q("#gpMockConnect")?.addEventListener("click",()=>{this.switchProvider(this.mock);this.mock.connect()});q("#gpMockDisconnect")?.addEventListener("click",()=>this.mock.disconnect());q("#gpMockReset")?.addEventListener("click",()=>this.mock.reset());document.querySelectorAll("[data-axis]").forEach(e=>e.addEventListener("input",x=>this.mock.setAxis(+e.dataset.axis,+x.target.value)));document.querySelectorAll("[data-button]").forEach(e=>e.addEventListener("input",x=>this.mock.setButton(+e.dataset.button,+x.target.value)));document.querySelectorAll("[data-toggle]").forEach(e=>e.addEventListener("pointerdown",()=>this.mock.setButton(+e.dataset.toggle,1)));document.querySelectorAll("[data-toggle]").forEach(e=>e.addEventListener("pointerup",()=>this.mock.setButton(+e.dataset.toggle,0)));q("#gpDrift")?.addEventListener("input",e=>this.mock.drift=+e.target.value);q("#gpNoise")?.addEventListener("input",e=>this.mock.noise=+e.target.value);q("#gpStale")?.addEventListener("change",e=>{this.mock.stale=e.target.checked;this.accept(this.mock.sample())});q("#gpBlur")?.addEventListener("click",()=>{this.focused=false;this.render()});}
}
