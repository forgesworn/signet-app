import { defineConfig } from '@playwright/test';
import path from 'node:path';

const signetBaseURL = process.env.SIGNET_BASE_URL ?? 'http://127.0.0.1:5174';
const canaryBaseURL = process.env.CANARY_BASE_URL ?? 'http://127.0.0.1:5173';
const canaryRepoPath = process.env.CANARY_REPO_PATH ?? path.resolve(process.cwd(), '../canary-kit');
const skipWebServer = process.env.PLAYWRIGHT_SKIP_WEBSERVER === '1';

process.env.SIGNET_CROSS_APP_E2E = '1';

export default defineConfig({
  testDir: './e2e',
  testMatch: /cross-app-nostrconnect\.spec\.ts/,
  outputDir: './e2e/results-cross-app',
  timeout: 120_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-cross-app' }]],
  webServer: skipWebServer ? undefined : [
    {
      command: 'npm run dev -- --host 127.0.0.1 --port 5174',
      url: signetBaseURL,
      reuseExistingServer: true,
      cwd: process.cwd(),
    },
    {
      command: 'npm run dev -- --host 127.0.0.1 --port 5173',
      url: canaryBaseURL,
      reuseExistingServer: true,
      cwd: canaryRepoPath,
    },
  ],
  use: {
    baseURL: signetBaseURL,
    bypassCSP: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 390, height: 844 },
  },
});
