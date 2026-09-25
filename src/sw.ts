/// <reference lib="webworker" />

import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare const self: ServiceWorkerGlobalScope;

// Plugin injects the precache manifest here:
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// SPA navigation fallback -- navigation requests serve cached index.html.
// Needed for direct hits (mysignet.app), offline refresh, and
// Sign in with Signet redirects (mysignet.app/?auth=1&challenge=...).
// Denylist: real static pages (/get, /about) and APK downloads must reach the
// network, or users with a registered SW get the app shell instead (mirrors
// the Caddy SPA-fallback exclusions server-side).
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), {
  denylist: [/^\/get(\/|\?|$)/, /^\/about(\/|\?|$)/, /\.apk(\?|$)/],
}));

// Update flow -- app sends SKIP_WAITING when safe to reload.
// Defence-in-depth: only act on same-origin messages (security audit
// 2026-06-15). postMessage to a SW is same-origin by browser design, but an
// explicit origin check forecloses acting on anything cross-origin. An empty
// origin (some same-origin contexts) is permitted.
self.addEventListener('message', (event) => {
  if (event.origin && event.origin !== self.location.origin) return;
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Take control immediately on activate
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
