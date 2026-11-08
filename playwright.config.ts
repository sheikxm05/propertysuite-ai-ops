/**
 * Playwright configuration — lane w0-l6. Configuration only.
 *
 * The specs under tests/e2e and the page objects under tests/_harness/e2e belong to
 * lane w2-l1 and do not exist yet; this file exists now so that lane inherits a
 * settled runner instead of negotiating one at the end of the project.
 *
 * Deliberate choices:
 *   - No `webServer` auto-start by default. The ten-step scenario in docs/test-plan.md
 *     runs against the local Supabase stack with seeded data; silently booting `next
 *     dev` against whatever database happens to be configured is how an e2e suite ends
 *     up asserting against the wrong tenant's data. Opt in with PS_E2E_WEB_SERVER=1.
 *   - One browser project. The suite proves authorization boundaries, not rendering
 *     parity, and step 10 ("the other organization cannot access any of these records")
 *     behaves identically in every engine.
 *   - Storage state is never reused across role projects. Each role signs in for real,
 *     for the same reason the RLS suite uses real JWTs.
 */

import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.APP_BASE_URL ?? 'http://localhost:3000';
const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './tests/e2e',
  // w2-l1 writes page objects under tests/_harness/e2e; they are helpers, not specs.
  testMatch: /.*\.e2e\.(spec|test)\.ts$/,
  outputDir: 'test-results/e2e',
  snapshotDir: 'tests/e2e/__snapshots__',

  fullyParallel: false, // Shared seeded database; see the RLS suite for the same reason.
  workers: 1,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },

  reporter: isCI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }], ['junit', { outputFile: 'test-results/e2e-junit.xml' }]]
    : [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],

  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    // Dubai: every date, currency and expiry assertion in the suite depends on these.
    locale: 'en-AE',
    timezoneId: 'Asia/Dubai',
    extraHTTPHeaders: { 'x-playwright-run': '1' },
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  ...(process.env.PS_E2E_WEB_SERVER === '1'
    ? {
        webServer: {
          command: 'npm run dev',
          url: baseURL,
          reuseExistingServer: !isCI,
          timeout: 120_000,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      }
    : {}),
});
