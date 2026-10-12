import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { createHash } from "node:crypto";

function wsFrame(text) {
  const payload = Buffer.from(text);
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  return Buffer.concat([Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]), payload]);
}

function sentence(body) {
  let checksum = 0;
  for (const char of body) checksum ^= char.charCodeAt(0);
  return `$${body}*${checksum.toString(16).padStart(2, "0").toUpperCase()}\r\n`;
}

test("local WebSocket bridge streams QZ1 GGA/RMC and harmless proprietary lines", async ({ page }) => {
  const connections = [];
  const server = createServer();
  server.on("upgrade", (request, socket) => {
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    connections.push(socket);
    socket.write(wsFrame('{"type":"status","state":"connected","deviceName":"QZ1 test"}'));
    socket.write(wsFrame(sentence("GNGGA,123519,4807.038,N,01131.000,E,2,12,0.8,545.4,M,46.9,M,,")));
    socket.write(wsFrame(sentence("GNRMC,123519,A,4807.038,N,01131.000,E,0.0,0.0,230394,,,A")));
    socket.write(wsFrame("$L1BAT,3.8\r\n$L1MAG,12.5\r\n"));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    await page.goto("/");
    const received = await page.evaluate(async (url) => {
      const { LocalBridgeWebSocketTransport } = await import("/js/recording/local-bridge-websocket.js");
      return await new Promise((resolve) => {
        const lines = [];
        const states = [];
        const transport = new LocalBridgeWebSocketTransport({ url, onLine: (line) => { lines.push(line); if (lines.length === 4) { transport.disconnect(); resolve({ lines, states }); } }, onStateChange: (state) => states.push(state), reconnectMinMs: 20 });
        transport.connect();
      });
    }, `ws://127.0.0.1:${port}`);
    expect(received.lines[0]).toMatch(/^\$GNGGA,.*\*../);
    expect(received.lines[1]).toMatch(/^\$GNRMC,.*\*../);
    expect(received.lines.slice(2)).toEqual(["$L1BAT,3.8", "$L1MAG,12.5"]);
    expect(received.states).toContain("qz1-connected");
    const checksums = await page.evaluate(async (lines) => {
      const { isChecksumValidNmea } = await import("/js/recording/qz1le-ble-explorer.js");
      return lines.slice(0, 2).map(isChecksumValidNmea);
    }, received.lines);
    expect(checksums).toEqual([true, true]);
  } finally {
    for (const socket of connections) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});
