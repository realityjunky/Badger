import { defineConfig, devices } from "@playwright/test";

const PORT = 4319;

/**
 * The journeys run against the real service seam: local single-user mode,
 * PGlite, and the built dashboard served by the server.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env["CI"] === undefined ? 0 : 1,
  reporter:
    process.env["CI"] === undefined
      ? [["list"]]
      : [["github"], ["html", { open: "never" }]],
  expect: {
    // Font rasterisation differs slightly between machines; the layout must
    // still match.
    toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: "disabled" },
  },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop-1280",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 720 },
      },
    },
    {
      name: "desktop-2560",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 2560, height: 1440 },
      },
    },
  ],
  webServer: {
    command: "node e2e/serve.mjs",
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: process.env["CI"] === undefined,
    timeout: 60_000,
  },
});
