import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/results',
  timeout: 60_000,
  retries: 0,
  projects: [
    {
      name: 'mobile-chromium',
      use: {
        browserName: 'chromium',
        launchOptions: {
          args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
          ],
        },
      },
    },
    {
      name: 'mobile-webkit-qr',
      testMatch: /verification\.spec\.ts/,
      use: {
        browserName: 'webkit',
      },
    },
  ],
  use: {
    // Local dev serves https when cert/ holds mkcert certs (WebAuthn needs it);
    // CI has no certs and serves http. Override with E2E_BASE_URL to match
    // whichever dev server is actually running.
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5174',
    ignoreHTTPSErrors: true,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // Default to a mobile viewport — the app's mobile-first UI (carousel, narrow
    // layouts) is what the existing specs were written against. Desktop-layout
    // specs can override this per-test via test.use({ viewport: ... }).
    viewport: { width: 390, height: 844 },
  },
  webServer: {
    command: 'npm run dev -- --port 5174',
    port: 5174,
    reuseExistingServer: true,
  },
});
