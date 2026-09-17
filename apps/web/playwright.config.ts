import { defineConfig, devices } from "playwright/test";

/**
 * End-to-end against a running local stack: scripts/localnet.sh up, then
 * scripts/dev.sh up. Opt in with RUN_WEB_E2E=1, because these tests move real
 * transactions on the local chains.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: { baseURL: process.env.WEB_URL ?? "http://localhost:8721", ...devices["Desktop Chrome"] }
});
