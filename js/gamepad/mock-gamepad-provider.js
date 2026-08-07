import { GamepadProvider } from "./gamepad-provider.js";
export class MockGamepadProvider extends GamepadProvider {
 constructor(){super("mock");this.connected=false;this.axes=[0,0,0,0];this.buttons=Array.from({length:18},()=>({pressed:false,touched:false,value:0}));this.drift=0;this.noise=0;this.stale=false;}
 connect(){this.connected=true;this.emit("connection",this.sample());}
 disconnect(){this.connected=false;this.reset();this.emit("connection",null);}
 reset(){this.axes.fill(0);this.buttons=this.buttons.map(()=>({pressed:false,touched:false,value:0}));this.emit("sample",this.sample());}
 setAxis(i,v){this.axes[i]=Math.max(-1,Math.min(1,Number(v)));this.emit("sample",this.sample());}
 setButton(i,value){this.buttons[i]={pressed:Number(value)>.5,touched:Number(value)>0,value:Number(value)};this.emit("sample",this.sample());}
 sample(){if(!this.connected)return null;return {provider:"mock",id:"Simulated DualSense Controller",mapping:"standard",axes:this.axes.map(v=>Math.max(-1,Math.min(1,v+this.drift+(Math.random()*2-1)*this.noise))),buttons:this.buttons.map(b=>({...b})),timestamp:this.stale?0:performance.now()};}
}
