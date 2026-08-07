export class GamepadProvider extends EventTarget { constructor(type){ super(); this.type=type; } emit(type,detail){ this.dispatchEvent(new CustomEvent(type,{detail})); } start(){} stop(){} sample(){return null;} }
export const likelyDualSense = id => /DualSense|Wireless Controller|Sony Interactive Entertainment/i.test(id || "");
