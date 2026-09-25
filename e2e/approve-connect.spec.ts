/**
 * Playwright tests for the ApproveConnect approve path.
 *
 * The deny path and relay-error state are already covered in harness-pages.spec.ts.
 * This file covers the approve path only: event published to relay, UI state
 * transitions, and retry after relay error.
 */

import { test, expect } from '@playwright/test';
import { getPublicKey } from 'nostr-tools/pure';
import { createIdentityAndUnlock, clearDatabase, confirmRealNameIfPrompted } from './fixtures';

// A connect request shape that matches NostrConnectRequest.
// clientPubkey must be 64 hex chars; relayUrl must be wss://.
const clientPubkey = (byte: number) => getPublicKey(new Uint8Array(32).fill(byte));
const CONNECT_REQUEST = {
  clientPubkey: clientPubkey(1),
  relayUrl: 'wss://relay.example.com',
  relayUrls: ['wss://relay.example.com'],
  appName: 'Approve Test App',
  appUrl: 'https://approvetest.example.com',
};

// ── Approve path ────────────────────────────────────────────────────────────

test.describe('ApproveConnect: approve path', () => {
  // routeWebSocket must be registered before any page navigation so the init
  // script patches window.WebSocket before it is first used.
  test('approve publishes a kind-24133 event to the relay', async ({ page }) => {
    let resolveEvent: (event: unknown) => void;
    const eventReceived = new Promise<unknown>(resolve => { resolveEvent = resolve; });

    await page.routeWebSocket('wss://**', ws => {
      ws.onMessage(message => {
        try {
          const data = JSON.parse(String(message));
          if (Array.isArray(data) && data[0] === 'EVENT') {
            // Acknowledge publish so RelayClient resolves with ok:true
            ws.send(JSON.stringify(['OK', (data[1] as any).id, true, '']));
            resolveEvent(data[1]);
          }
        } catch { /* ignore non-JSON frames */ }
      });
    });

    await clearDatabase(page);
    await createIdentityAndUnlock(page);

    // Inject the pending connect request via the test harness, then navigate.
    // Both calls must be batched in the same evaluate so React 18 batching
    // applies them in a single render — avoids an intermediate render where
    // page='approve-connect' but pendingConnectRequest=null.
    await page.evaluate((req) => {
      (window as any).__TEST__.setPendingConnectRequest(req);
      (window as any).__TEST__.setPage('approve-connect');
    }, CONNECT_REQUEST);

    await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible({ timeout: 5_000 });
    // requireNpConfirmation (default-on) gates the real-name Approve.
    await confirmRealNameIfPrompted(page);
    await page.getByRole('button', { name: 'Approve' }).click();

    // Wait for the published event
    const published = await eventReceived;

    // NIP-46 connect responses are kind 24133
    expect((published as any).kind).toBe(24133);

    // The event must target the client pubkey via a 'p' tag
    const tags: string[][] = (published as any).tags ?? [];
    expect(tags.some(t => t[0] === 'p' && t[1] === CONNECT_REQUEST.clientPubkey)).toBe(true);

    // The event must have a valid id, pubkey, and sig (non-empty strings)
    expect(typeof (published as any).id).toBe('string');
    expect((published as any).id).toHaveLength(64);
    expect(typeof (published as any).sig).toBe('string');
    expect((published as any).sig.length).toBeGreaterThan(0);
  });

  test('approve shows "Connected! Returning..." then transitions to home', async ({ page }) => {
    await page.routeWebSocket('wss://**', ws => {
      ws.onMessage(message => {
        try {
          const data = JSON.parse(String(message));
          if (Array.isArray(data) && data[0] === 'EVENT') {
            ws.send(JSON.stringify(['OK', (data[1] as any).id, true, '']));
          }
        } catch { /* ignore */ }
      });
    });

    await clearDatabase(page);
    await createIdentityAndUnlock(page);

    await page.evaluate((req) => {
      (window as any).__TEST__.setPendingConnectRequest(req);
      (window as any).__TEST__.setPage('approve-connect');
    }, CONNECT_REQUEST);

    await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible({ timeout: 5_000 });
    // requireNpConfirmation (default-on) gates the real-name Approve.
    await confirmRealNameIfPrompted(page);
    await page.getByRole('button', { name: 'Approve' }).click();

    // After the 1.5 s delay, handleConnectDone fires → home page
    await expect(page.getByText('Test User')).toBeVisible({ timeout: 15_000 });
  });

  test('falls back to the next advertised relay when the first relay cannot be opened', async ({ page }) => {
    let resolveEvent: (event: unknown) => void;
    const eventReceived = new Promise<unknown>(resolve => { resolveEvent = resolve; });

    await page.routeWebSocket('wss://dead.example.com', async ws => {
      await ws.close({ code: 1011, reason: 'relay unavailable' });
    });
    await page.routeWebSocket('wss://relay.example.com', ws => {
      ws.onMessage(message => {
        try {
          const data = JSON.parse(String(message));
          if (Array.isArray(data) && data[0] === 'EVENT') {
            ws.send(JSON.stringify(['OK', (data[1] as any).id, true, '']));
            resolveEvent(data[1]);
          }
        } catch { /* ignore */ }
      });
    });

    await clearDatabase(page);
    await createIdentityAndUnlock(page);

    const fallbackClientPubkey = clientPubkey(4);
    await page.evaluate((req) => {
      (window as any).__TEST__.setPendingConnectRequest(req);
      (window as any).__TEST__.setPage('approve-connect');
    }, {
      ...CONNECT_REQUEST,
      clientPubkey: fallbackClientPubkey,
      relayUrl: 'wss://dead.example.com',
      relayUrls: ['wss://dead.example.com', 'wss://relay.example.com'],
    });

    await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible({ timeout: 5_000 });
    await confirmRealNameIfPrompted(page);
    await page.getByRole('button', { name: 'Approve' }).click();

    const published = await eventReceived;
    const tags: string[][] = (published as any).tags ?? [];
    expect(tags.some(t => t[0] === 'p' && t[1] === fallbackClientPubkey)).toBe(true);
    await expect(page.getByText('Test User')).toBeVisible({ timeout: 15_000 });
  });

  test('shows relay-by-relay diagnostics when every advertised relay fails', async ({ page }) => {
    await page.routeWebSocket('wss://dead-one.example.com', async ws => {
      await ws.close({ code: 1011, reason: 'relay unavailable' });
    });
    await page.routeWebSocket('wss://dead-two.example.com', async ws => {
      await ws.close({ code: 1011, reason: 'relay unavailable' });
    });

    await clearDatabase(page);
    await createIdentityAndUnlock(page);

    await page.evaluate((req) => {
      (window as any).__TEST__.setPendingConnectRequest(req);
      (window as any).__TEST__.setPage('approve-connect');
    }, {
      ...CONNECT_REQUEST,
      clientPubkey: clientPubkey(5),
      relayUrl: 'wss://dead-one.example.com',
      relayUrls: ['wss://dead-one.example.com', 'wss://dead-two.example.com'],
    });

    await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible({ timeout: 5_000 });
    await confirmRealNameIfPrompted(page);
    await page.getByRole('button', { name: 'Approve' }).click();

    const errorMessage = page.getByText('Could not complete NostrConnect pairing', { exact: false });
    await expect(errorMessage).toBeVisible({ timeout: 20_000 });
    await expect(errorMessage).toContainText('wss://dead-one.example.com');
    await expect(errorMessage).toContainText('wss://dead-two.example.com');
    await expect(errorMessage).toContainText('phase');
  });
});

// ── Retry path ───────────────────────────────────────────────────────────────

test.describe('ApproveConnect: retry after relay error', () => {
  test('error state shows retry button after relay refuses the event', async ({ page }) => {
    // Relay refuses with ok:false so the component lands in 'error' state.
    await page.routeWebSocket('wss://**', ws => {
      ws.onMessage(message => {
        try {
          const data = JSON.parse(String(message));
          if (Array.isArray(data) && data[0] === 'EVENT') {
            ws.send(JSON.stringify(['OK', (data[1] as any).id, false, 'error: rejected']));
          }
        } catch { /* ignore */ }
      });
    });

    await clearDatabase(page);
    await createIdentityAndUnlock(page);

    await page.evaluate((req) => {
      (window as any).__TEST__.setPendingConnectRequest(req);
      (window as any).__TEST__.setPage('approve-connect');
    }, { ...CONNECT_REQUEST, clientPubkey: clientPubkey(2) });

    await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible({ timeout: 5_000 });
    // requireNpConfirmation (default-on) gates the real-name Approve.
    await confirmRealNameIfPrompted(page);
    await page.getByRole('button', { name: 'Approve' }).click();

    // Relay returned ok:false → error state
    await expect(page.getByText('Failed to send connect response via wss://relay.example.com')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();

    // Approve is replaced by Try again; Deny remains available.
    await expect(page.getByRole('button', { name: 'Approve' })).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Deny' })).toBeVisible();
  });

  test('retry re-sends the event and succeeds on second attempt', async ({ page }) => {
    // First EVENT → ok:false; second EVENT → ok:true.
    let retryEventReceived: (event: unknown) => void;
    const retryEvent = new Promise<unknown>(resolve => { retryEventReceived = resolve; });
    let callCount = 0;

    await page.routeWebSocket('wss://**', ws => {
      ws.onMessage(message => {
        try {
          const data = JSON.parse(String(message));
          if (Array.isArray(data) && data[0] === 'EVENT') {
            callCount += 1;
            if (callCount === 1) {
              // First attempt: relay rejects — component must land in 'error' state.
              ws.send(JSON.stringify(['OK', (data[1] as any).id, false, 'error: rejected']));
            } else {
              // Retry attempt: relay accepts — component must succeed.
              ws.send(JSON.stringify(['OK', (data[1] as any).id, true, '']));
              retryEventReceived(data[1]);
            }
          }
        } catch { /* ignore non-JSON frames */ }
      });
    });

    await clearDatabase(page);
    await createIdentityAndUnlock(page);

    const retryClientPubkey = clientPubkey(3);
    await page.evaluate((req) => {
      (window as any).__TEST__.setPendingConnectRequest(req);
      (window as any).__TEST__.setPage('approve-connect');
    }, { ...CONNECT_REQUEST, clientPubkey: retryClientPubkey });

    await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible({ timeout: 5_000 });
    // requireNpConfirmation (default-on) gates the real-name Approve.
    await confirmRealNameIfPrompted(page);
    await page.getByRole('button', { name: 'Approve' }).click();

    // Wait for error state then click Retry
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Try again' }).click();

    // Assert the retry event was published to the relay
    const published = await retryEvent;
    expect((published as any).kind).toBe(24133);
    const tags: string[][] = (published as any).tags ?? [];
    expect(tags.some(t => t[0] === 'p' && t[1] === retryClientPubkey)).toBe(true);

    // Success state shown, then component navigates back to home
    await expect(page.getByText('Test User')).toBeVisible({ timeout: 10_000 });
  });
});
