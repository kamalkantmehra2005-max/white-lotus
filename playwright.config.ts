import { defineConfig, devices } from "@playwright/test";

/**
 * UI tests. Expects the app at BASE_URL (default http://localhost:3000) wired to the mock AI server:
 *   node scripts/mock-ai-server.mjs &  npm run build && npm start
 * PW_CHROMIUM lets you point at a preinstalled Chromium instead of downloading one.
 */
const launchOptions = process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {};

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  workers: 2,
  use: { baseURL: process.env.BASE_URL ?? "http://localhost:3000", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], launchOptions } },
    { name: "mobile", use: { ...devices["Pixel 7"], launchOptions } },
    // iPhone viewport/touch emulation on Chromium. This is NOT Safari/WebKit — real iPhone Safari must be tested on a device.
    { name: "iphone-viewport", use: { ...devices["iPhone 14"], browserName: "chromium", launchOptions } },
  ],
});
