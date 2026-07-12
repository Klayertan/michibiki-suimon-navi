import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:4173",
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure"
  },
  webServer: {
    command: "node scripts/dev-server.mjs",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: true
  }
});
