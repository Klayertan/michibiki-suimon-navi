import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// This app is a new, separate frontend living beside the existing static
// `index.html` app at the repository root (see docs/UI_REDESIGN.md /
// docs/FRONTEND_ARCHITECTURE.md for why). Two things below exist only because
// of that placement:
//
// - `resolve.alias['@legacy']` and `server.fs.allow` let this project import
//   already-working, framework-independent modules straight from the
//   repository's `js/` tree (e.g. `js/drone/drone-api-client.js`) instead of
//   duplicating them. Stage 1 only imports drone-api-client.js this way.
// - `server.proxy['/api']` forwards this dev server's `/api/*` calls
//   (HTTP *and* the telemetry WebSocket, `ws: true`) to the existing FastAPI
//   backend on 127.0.0.1:8787. The frontend therefore never hard-codes the
//   backend origin and never needs a dev-only CORS allowance: from the
//   browser's point of view every request stays same-origin.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@legacy': fileURLToPath(new URL('../js', import.meta.url)),
    },
  },
  server: {
    fs: {
      allow: [fileURLToPath(new URL('..', import.meta.url))],
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    exclude: ['tests/browser/**', 'node_modules/**', 'dist/**'],
    css: true,
    // Spinning up 8+ jsdom environments concurrently is flaky on this
    // machine (environment setup alone can exceed the 5s default test
    // timeout under contention) even though every test passes reliably in
    // isolation. Sequential files trade a few seconds of wall time for a
    // suite that isn't randomly red.
    fileParallelism: false,
  },
})
