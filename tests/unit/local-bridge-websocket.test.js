import test from "node:test";
import assert from "node:assert/strict";
import { LocalBridgeWebSocketTransport } from "../../js/recording/local-bridge-websocket.js";

class FakeWebSocket {
  static instances = [];
  constructor(url) { this.url = url; this.readyState = 0; FakeWebSocket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  message(data) { this.onmessage?.({ data }); }
  close() { this.readyState = 3; this.onclose?.(); }
}

test("bridge websocket sends status states and complete NMEA lines to the shared callback", () => {
  FakeWebSocket.instances = [];
  const lines = [];
  const states = [];
  const transport = new LocalBridgeWebSocketTransport({ WebSocketImpl: FakeWebSocket, onLine: (line) => lines.push(line), onStateChange: (state) => states.push(state) });
  transport.connect();
  const socket = FakeWebSocket.instances[0];
  assert.equal(socket.url, "ws://127.0.0.1:8765");
  socket.open();
  socket.message('{"type":"status","state":"connected","deviceName":"QZ1"}');
  socket.message("$GNGGA,foo*");
  socket.message("00\r\n$GNRMC,bar*00\r\n$L1BAT,1\r\n$L1MAG,2\r\n");
  assert.deepEqual(states, ["connecting", "bridge-connected", "qz1-connected"]);
  assert.deepEqual(lines, ["$GNGGA,foo*00", "$GNRMC,bar*00", "$L1BAT,1", "$L1MAG,2"]);
});

test("bridge reconnection uses bounded exponential backoff and can be cancelled", () => {
  FakeWebSocket.instances = [];
  const timers = [];
  const cleared = [];
  const transport = new LocalBridgeWebSocketTransport({
    WebSocketImpl: FakeWebSocket,
    setTimeoutImpl(callback, delay) { timers.push({ callback, delay }); return timers.length; },
    clearTimeoutImpl(id) { cleared.push(id); }
  });
  transport.connect();
  FakeWebSocket.instances[0].close();
  assert.equal(timers[0].delay, 500);
  timers[0].callback();
  FakeWebSocket.instances[1].close();
  assert.equal(timers[1].delay, 1000);
  transport.disconnect();
  assert.deepEqual(cleared, [2]);
});
