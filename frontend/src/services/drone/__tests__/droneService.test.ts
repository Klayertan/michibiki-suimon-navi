import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDroneService } from '../droneService'

describe('createDroneService', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('exposes only read-only operations -- no connect/disconnect/mode/flight command', () => {
    const service = createDroneService('http://127.0.0.1:8787')
    // Locks the Stage 1 non-goal ("Do NOT add flight commands") as a test: if
    // someone adds setMode/connect/arm/etc. to this adapter without updating
    // this test, that is a deliberate, reviewable change, not an accident.
    expect(Object.keys(service).sort()).toEqual(['getHealth', 'getStatus', 'subscribeTelemetry'])
  })

  it('getHealth() calls GET /api/health on the given base URL and returns the parsed body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok', version: '1.2.3', mode: 'mock', linkRunning: false }),
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const service = createDroneService('http://127.0.0.1:8787')
    const health = await service.getHealth()

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8787/api/health',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(health).toEqual({ status: 'ok', version: '1.2.3', mode: 'mock', linkRunning: false })
  })

  it('getStatus() rejects with a readable error when the backend is unreachable', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch

    const service = createDroneService('http://127.0.0.1:8787')
    await expect(service.getStatus()).rejects.toMatchObject({ reason: 'backend_unreachable' })
  })
})

describe('createDroneService default base URL', () => {
  let originalWebSocket: typeof WebSocket | undefined

  beforeEach(() => {
    originalWebSocket = globalThis.WebSocket
  })

  afterEach(() => {
    if (originalWebSocket) globalThis.WebSocket = originalWebSocket
  })

  it('defaults to window.location.origin so it works unmodified behind the Vite dev proxy and the desktop build', () => {
    let capturedUrl = ''
    class FakeWebSocket {
      constructor(url: string) {
        capturedUrl = url
      }
      close() {}
    }
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket

    const service = createDroneService()
    const subscription = service.subscribeTelemetry({})

    // jsdom's default origin is http://localhost:3000; the important thing is
    // the client turns it into ws:// and keeps the page's own host, rather
    // than the hard-coded 127.0.0.1:8787 default that belongs only to the
    // legacy browser app (js/drone/drone-api-client.js).
    expect(capturedUrl).toBe(`ws://${window.location.host}/api/drone/telemetry/ws`)
    subscription.close()
  })
})
