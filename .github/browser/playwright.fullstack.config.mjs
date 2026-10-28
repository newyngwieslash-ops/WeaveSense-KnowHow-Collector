import { defineConfig } from '@playwright/test';

const phase = process.env.VIDEO_FULLSTACK_PHASE || 'initial';
if (!['initial', 'restart'].includes(phase)) throw new Error('Invalid full-stack phase');

// This suite has no webServer and no network stubs. The isolated Compose stack
// must already be healthy, bootstrapped and explicitly enabled for its workspace.
export default defineConfig({
  testDir: '.',
  testMatch: 'video-fullstack.spec.mjs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300000,
  expect: { timeout: 30000 },
  outputDir: `test-results/fullstack-${phase}`,
  reporter: [['list'], ['json', { outputFile: `test-results/fullstack-${phase}-results.json` }]],
  use: {
    browserName: 'chromium',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined },
    baseURL: process.env.VIDEO_FULLSTACK_BASE_URL || 'http://127.0.0.1:4180',
    viewport: { width: 1440, height: 1000 },
    actionTimeout: 30000,
    navigationTimeout: 30000,
    // Traces/HAR can contain login passwords, Cookie headers and service data.
    // Capture only deliberate, authenticated screenshots and sanitized JSON.
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});
