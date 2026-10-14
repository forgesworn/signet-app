import { defineConfig } from '@playwright/test';
import path from 'node:path';

// Opt-in integration against an actual sibling KithMoot checkout. All keys,
// approval screens and relay traffic belong to disposable local browsers.
const kithmoot = process.env.KITHMOOT_REPO_PATH;
if (!kithmoot) throw new Error('Set KITHMOOT_REPO_PATH to the KithMoot checkout to test.');
process.env.KITHMOOT_BASE_URL = 'https://localhost:4474/j/';

export default defineConfig({
  testDir: './e2e', testMatch: ['kithmoot-signet.spec.ts', 'relay-health.spec.ts'],
  workers: 1, timeout: 180_000, retries: 0, reporter: 'list',
  outputDir: './e2e/results-kithmoot',
  use: { browserName: 'chromium', baseURL: 'http://localhost:5474', ignoreHTTPSErrors: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } } : {}),
    viewport: { width: 1280, height: 900 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: [
    { command: 'npm run dev -- --port 5474 --strictPort', url: 'http://localhost:5474', reuseExistingServer: false },
    { command: 'RELAY_PORT=4577 node test/ws-relay.mjs', cwd: path.resolve(kithmoot), url: 'http://localhost:4577', reuseExistingServer: false },
    { command: 'VITE_DESKTOP=true npm run build && VITE_DESKTOP=true E2E_RELAY_PORT=4577 npx vite preview --config app/vite.config.ts --port 4474 --strictPort',
      cwd: path.resolve(kithmoot), url: process.env.KITHMOOT_BASE_URL, ignoreHTTPSErrors: true, reuseExistingServer: false, timeout: 180_000 },
  ],
});
