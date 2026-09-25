import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(viteConfig, defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/e2e/**'],
    setupFiles: ['fake-indexeddb/auto', './src/test-setup.ts'],
    // Real 600k-iteration PBKDF2 runs in the hook tests; the 5 s default left
    // no room above Testing Library's own async budget (see src/test-setup.ts),
    // so a waitFor that ran long was reported as a test timeout instead.
    testTimeout: 15_000,
  },
}));
