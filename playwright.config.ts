import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3219);

// The spine test runs the whole demo in a real browser against the scripted
// model, so it needs no key and gives the same result every time. Point
// E2E_BASE_URL at a Vercel preview to run it there instead of a local server.
export default defineConfig({
  testDir: "e2e",
  timeout: Number(process.env.E2E_TEST_MS ?? 60_000),
  // Real-model turns take ~10 s; E2E_EXPECT_MS raises the wait for runs against a deployment.
  expect: { timeout: Number(process.env.E2E_EXPECT_MS ?? 15_000) },
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    viewport: { width: 1280, height: 900 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `npx next start --port ${PORT}`,
        port: PORT,
        reuseExistingServer: !process.env.CI,
        env: { AGENT_MODEL: "mock", TOOL_APPROVAL_SECRET: "e2e-approval-secret-0000000000000000" },
      },
});
