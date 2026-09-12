import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const branded = process.env.TERMINAL_BRANDED_BROWSERS === "1";
// Peers share this test machine. Avoid relying on the runner's multicast/mDNS
// discovery to deliver host ICE candidates between different browser engines.
// This affects tests only; the library keeps browser privacy defaults.
const localPeers = { launchOptions: { args: ["--disable-features=WebRtcHideLocalIpsWithMdns"] } };
export default defineConfig({
  testDir: "./test/browser",
  testMatch: "**/*.spec.ts",
  outputDir: "./test-results",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 3,
  timeout: 30_000,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:5203",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    reducedMotion: "reduce",
  },
  webServer: {
    command: "node scripts/serve.mjs", cwd: root,
    url: "http://127.0.0.1:5203/test/browser/harness.html",
    reuseExistingServer: false,
    timeout: 15_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], ...localPeers } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "android-chromium", use: { ...devices["Pixel 7"], ...localPeers } },
    { name: "ios-webkit", use: { ...devices["iPhone 13"] } },
    ...(branded ? [
      { name: "chrome", use: { ...devices["Desktop Chrome"], channel: "chrome" } },
      { name: "edge", use: { ...devices["Desktop Edge"], channel: "msedge" } },
    ] : []),
  ],
});
