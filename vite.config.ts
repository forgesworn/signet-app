import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'));
let gitSha = 'unknown';
try {
  gitSha = execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim();
} catch {
  // not a git checkout (e.g. tarball install) — leave as 'unknown'
}
const buildTime = new Date().toISOString();

/** Shim node:crypto → Web Crypto for browser bundles (used by @forgesworn/shamir-words) */
function nodeCryptoShim(): Plugin {
  return {
    name: 'node-crypto-shim',
    resolveId(id) {
      if (id === 'node:crypto') return '\0node-crypto-shim';
    },
    load(id) {
      if (id === '\0node-crypto-shim') {
        return `export function randomFillSync(buf) { crypto.getRandomValues(buf); return buf; }`;
      }
    },
  };
}

const certDir = path.resolve(__dirname, 'cert');
const hasCerts = fs.existsSync(path.join(certDir, 'signet.pem'));

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(buildTime),
    __GIT_SHA__: JSON.stringify(gitSha),
  },
  plugins: [nodeCryptoShim(), react(), VitePWA({
    strategies: 'injectManifest',
    srcDir: 'src',
    filename: 'sw.ts',
    injectRegister: false,
    manifest: {
      name: 'MySignet',
      short_name: 'MySignet',
      description: 'Identity verification for the real world',
      theme_color: '#0E2A47',
      background_color: '#FAF7ED',
      display: 'standalone',
      orientation: 'portrait',
      scope: '/',
      start_url: '/',
      launch_handler: {
        client_mode: 'navigate-existing',
      },
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    injectManifest: {
      globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
    },
    devOptions: {
      enabled: false,
    },
  })],
  resolve: {
    alias: {
      'node:crypto': path.resolve(__dirname, 'src/lib/node-crypto-shim.ts'),
    },
  },
  optimizeDeps: {
    entries: ['index.html'],
    // These subpath deps are pulled in transitively — notably `nsec-tree/persona`
    // and `nsec-tree/encoding` reach us only through the (symlinked) signet-protocol
    // build, which Vite's startup dep scan does not crawl. Left undeclared, Vite
    // discovers them at runtime during onboarding and triggers a dep
    // re-optimization + full page reload. When that reload lands mid-derivation it
    // tears down nsec-tree's module state, so `derivePersona` throws
    // "TreeRoot has been destroyed" and onboarding wedges — flaky under concurrent
    // e2e cold starts (the CI browser-regression failures). Pre-bundling them up
    // front means no runtime discovery and no mid-run reload.
    include: [
      'nsec-tree',
      'nsec-tree/persona',
      'nsec-tree/encoding',
      'spoken-token',
      'spoken-token/wordlist',
      'spoken-token/encoding',
    ],
  },
  server: {
    port: 5174,
    host: '0.0.0.0',
    ...(hasCerts
      ? {
          https: {
            cert: fs.readFileSync(path.join(certDir, 'signet.pem')),
            key: fs.readFileSync(path.join(certDir, 'signet-key.pem')),
          },
        }
      : {}),
  },
});
