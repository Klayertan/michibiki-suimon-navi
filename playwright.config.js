import { defineConfig } from "@playwright/test";

// By default the suite runs against the plain node dev server. Set
// SUISUI_BASE_URL to point it at an already-running server instead -- notably
// the Cloudflare preview (`npm run cf:dev`, http://localhost:8788), which is
// how the same tests verify that production hosting serves the app the same
// way the development server does.
const externalBaseURL = process.env.SUISUI_BASE_URL;

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 30_000,
  use: {
    baseURL: externalBaseURL ?? "http://127.0.0.1:4173",
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure"
  },
  webServer: externalBaseURL
    ? undefined
    : {
        command: "node scripts/dev-server.mjs",
        url: "http://127.0.0.1:4173",
        reuseExistingServer: true
      }
});
