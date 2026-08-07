import { GamepadProvider } from "./gamepad-provider.js";
export class BrowserGamepadProvider extends GamepadProvider {
  constructor({win=window,nav=navigator,doc=document}={}){ super("browser"); this.win=win;this.nav=nav;this.doc=doc;this.index=null;this.frame=null;this.onConnect=e=>{this.index=e.gamepad.index;this.emit("connection",this.sample())};this.onDisconnect=e=>{if(e.gamepad.index===this.index){this.index=null;this.emit("connection",null)}};this.poll=this.poll.bind(this); }
  start(){this.win.addEventListener("gamepadconnected",this.onConnect);this.win.addEventListener("gamepaddisconnected",this.onDisconnect);this.poll();}
  stop(){this.win.removeEventListener("gamepadconnected",this.onConnect);this.win.removeEventListener("gamepaddisconnected",this.onDisconnect);this.win.cancelAnimationFrame(this.frame);}
  sample(){const pads=Array.from(this.nav.getGamepads?.()||[]).filter(Boolean);const g=this.index==null?pads[0]:pads.find(p=>p.index===this.index);if(!g)return null;this.index=g.index;return {provider:"browser",id:g.id,mapping:g.mapping,axes:[...g.axes],buttons:[...g.buttons].map(b=>({pressed:b.pressed,touched:b.touched,value:b.value})),timestamp:g.timestamp||performance.now()};}
  poll(){const sample=this.sample();if(sample)this.emit("sample",sample);this.frame=this.win.requestAnimationFrame(this.poll);}
}
