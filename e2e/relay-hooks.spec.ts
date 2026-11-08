import { test, expect, type Page } from '@playwright/test';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { activateRealIdentity, confirmRealNameIfPrompted, createIdentityAndUnlock, clearDatabase, navigateViaHarness } from './fixtures';

const TEST_PUBKEY = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const GIFT_WRAP_KIND = 1059;

async function setRelayUrl(page: Page, url: string) {
  await page.evaluate((u) => (window as any).__TEST__.setRelayUrl(u), url);
  await page.waitForFunction((u) => (window as any).__TEST__?.getRelayUrl?.() === u, url);
}

// --- Credential status via relay ---

// Properly signed test event so RelayClient's verifyEvents:true accepts it
const TEST_VERIFIER_SK = generateSecretKey();
const VERIFIER_PUBKEY = getPublicKey(TEST_VERIFIER_SK);
const RELAY_CREDENTIAL_EVENT = finalizeEvent({
  kind: 31000,
  created_at: 1700000000,
  tags: [['d', TEST_PUBKEY], ['t', 'credential']],
  content: '',
}, TEST_VERIFIER_SK);
const CREDENTIAL_ID = RELAY_CREDENTIAL_EVENT.id;

test.describe('Credential status via relay', () => {
  test('stays pending when relay has no matching event', async ({ page }) => {
    await clearDatabase(page);
    await createIdentityAndUnlock(page);

    await page.evaluate((id) => {
      (window as any).__TEST__.setSelectedCredential({
        id,
        documentId: 'doc-001',
        keypairType: 'natural-person',
        event: '{}',
        verifierPubkey: 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3',
        verifiedAt: 1700000000,
        verifierStatus: 'pending',
      });
    }, CREDENTIAL_ID);

    await navigateViaHarness(page, 'credential-detail');
    await expect(page.getByText('⏳ Pending')).toBeVisible();
  });

  test('updates to confirmed when relay returns matching event', async ({ page }) => {
    // routeWebSocket MUST be registered before any page navigation.
    // The mock patches window.WebSocket via an init script that runs on page load —
    // it does NOT patch the currently-loaded page. Registering before clearDatabase
    // ensures the init script runs during the page.goto() inside clearDatabase.
    await page.routeWebSocket('wss://**', ws => {
      ws.onMessage(message => {
        try {
          const data = JSON.parse(String(message));
          if (Array.isArray(data) && data[0] === 'REQ') {
            const subId = data[1];
            ws.send(JSON.stringify(['EVENT', subId, RELAY_CREDENTIAL_EVENT]));
            // Delay EOSE so verifyEvent (async Schnorr check) completes before fetch resolves
            setTimeout(() => ws.send(JSON.stringify(['EOSE', subId])), 100);
          }
        } catch {}
      });
    });

    await clearDatabase(page);
    await createIdentityAndUnlock(page);

    await setRelayUrl(page, 'wss://relay.trotters.cc');

    await page.evaluate(({ id, pubkey }) => {
      (window as any).__TEST__.setSelectedCredential({
        id,
        documentId: 'doc-001',
        keypairType: 'natural-person',
        event: '{}',
        verifierPubkey: pubkey,
        verifiedAt: 1700000000,
        verifierStatus: 'pending',
      });
    }, { id: CREDENTIAL_ID, pubkey: VERIFIER_PUBKEY });

    await navigateViaHarness(page, 'credential-detail');
    await expect(page.getByText('✓ Verified')).toBeVisible({ timeout: 15_000 });
  });
});

// --- Credential publish ---

const VALID_EVENT_JSON = JSON.stringify({
  id: CREDENTIAL_ID,
  kind: 31000,
  pubkey: VERIFIER_PUBKEY,
  created_at: 1700000000,
  tags: [],
  content: '',
  sig: 'a'.repeat(128),
});

test.describe('Publish credential to relay', () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
    await createIdentityAndUnlock(page);
    // Get verified is a real-name feature: a dormant real identity meets the
    // activation gate instead of the education screen.
    await navigateViaHarness(page, 'get-verified');
    await activateRealIdentity(page);
  });

  test('publish button hidden when no relay configured', async ({ page }) => {
    await navigateViaHarness(page, 'get-verified');
    // Wait for component to render and register the injector via onRegisterSavedInjector effect
    await expect(page.getByRole('heading', { name: 'How verification works' })).toBeVisible();
    await page.evaluate((evJson) => {
      (window as any).__TEST__.injectGetVerifiedSaved([evJson]);
    }, VALID_EVENT_JSON);

    await expect(page.getByRole('button', { name: /Publish to Nostr relay/ })).not.toBeVisible();
  });

  test('publish button appears and sends event when relay configured', async ({ page }) => {
    await page.routeWebSocket('wss://**', ws => {
      ws.onMessage(message => {
        try {
          const data = JSON.parse(String(message));
          if (Array.isArray(data) && data[0] === 'EVENT') {
            ws.send(JSON.stringify(['OK', (data[1] as any).id, true, '']));
          }
          if (Array.isArray(data) && data[0] === 'REQ') {
            ws.send(JSON.stringify(['EOSE', data[1]]));
          }
        } catch {}
      });
    });

    await setRelayUrl(page, 'wss://relay.trotters.cc');
    await navigateViaHarness(page, 'get-verified');
    // Wait for component to render and register the injector via onRegisterSavedInjector effect
    await expect(page.getByRole('heading', { name: 'How verification works' })).toBeVisible();
    await page.evaluate((evJson) => {
      (window as any).__TEST__.injectGetVerifiedSaved([evJson]);
    }, VALID_EVENT_JSON);

    await expect(page.getByRole('button', { name: /Publish to Nostr relay/ })).toBeVisible({ timeout: 5_000 });
    await page.getByRole('button', { name: /Publish to Nostr relay/ }).click();
    await expect(page.getByText('Published')).toBeVisible({ timeout: 15_000 });
  });
});

// --- Relay-publish functions ---

test.describe('Relay publish: verify rejection', () => {
  test('rejection event is published when verify request is denied', async ({ page }) => {
    let resolveEvent: (event: unknown) => void;
    const eventReceived = new Promise(resolve => { resolveEvent = resolve; });

    // Register WS mock before navigation; capture the first EVENT message
    await page.routeWebSocket('wss://**', ws => {
      ws.onMessage(message => {
        try {
          const data = JSON.parse(String(message));
          if (Array.isArray(data) && data[0] === 'EVENT') {
            // Only the gift wrap is the response: the app also publishes its own
            // kind-30078 sync records to a configured relay.
            if ((data[1] as any).kind === GIFT_WRAP_KIND) resolveEvent(data[1]);
            ws.send(JSON.stringify(['OK', (data[1] as any).id, true, '']));
          }
          if (Array.isArray(data) && data[0] === 'REQ') {
            ws.send(JSON.stringify(['EOSE', data[1]]));
          }
        } catch {}
      });
    });

    await clearDatabase(page);
    await createIdentityAndUnlock(page);

    // Both state setters must be called in the same page.evaluate so React 18's
    // automatic batching applies them in a single render.
    // If called in separate evaluate calls, there is an intermediate render where
    // page='approve-verification' but pendingVerifyRequest=null, which falls through to Home.
    const now = Math.floor(Date.now() / 1000);
    await page.evaluate(({ ts, sessionPubkey }) => {
      (window as any).__TEST__.setPendingVerifyRequest({
        type: 'signet-verify-request',
        requestId: 'req-reject-001',
        requiredAgeRange: '18+',
        relayUrl: 'wss://relay.trotters.cc',
        sessionPubkey,
        timestamp: ts,
      });
      (window as any).__TEST__.setPage('approve-verification');
    }, { ts: now, sessionPubkey: TEST_PUBKEY });

    // No credential → "Cancel" button on the "get verified first" screen
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible({ timeout: 5_000 });
    await page.getByRole('button', { name: 'Cancel' }).click();

    // Verify the rejection event arrived at the relay
    const published = await eventReceived;
    expect((published as any).kind).toBe(GIFT_WRAP_KIND);
    const tags: string[][] = (published as any).tags ?? [];
    expect(tags.some(t => t[0] === 'p' && t[1] === TEST_PUBKEY)).toBe(true);
  });
});

test.describe('Relay publish: verify approval', () => {
  test('response event is published when verify request is approved', async ({ page }) => {
    let resolveEvent: (event: unknown) => void;
    const eventReceived = new Promise(resolve => { resolveEvent = resolve; });

    await page.routeWebSocket('wss://**', ws => {
      ws.onMessage(message => {
        try {
          const data = JSON.parse(String(message));
          if (Array.isArray(data) && data[0] === 'EVENT') {
            // Only the gift wrap is the response: the app also publishes its own
            // kind-30078 sync records to a configured relay.
            if ((data[1] as any).kind === GIFT_WRAP_KIND) resolveEvent(data[1]);
            ws.send(JSON.stringify(['OK', (data[1] as any).id, true, '']));
          }
          if (Array.isArray(data) && data[0] === 'REQ') {
            ws.send(JSON.stringify(['EOSE', data[1]]));
          }
        } catch {}
      });
    });

    await clearDatabase(page);
    await createIdentityAndUnlock(page);

    // Inject a stored credential so the Approve button is shown
    const cred = {
      id: CREDENTIAL_ID,
      documentId: 'doc-001',
      keypairType: 'natural-person',
        event: JSON.stringify({ id: CREDENTIAL_ID, kind: 31000, pubkey: VERIFIER_PUBKEY, tags: [['age-range', '18+']], content: '', sig: 'a'.repeat(128), created_at: 1700000000 }),
        verifierPubkey: VERIFIER_PUBKEY,
        verifiedAt: 1700000000,
        verifierStatus: 'confirmed',
      };
    await page.evaluate((c) => (window as any).__TEST__.addCredential(c), cred);

    const now = Math.floor(Date.now() / 1000);
    await page.evaluate(({ ts, sessionPubkey }) => {
      (window as any).__TEST__.setPendingVerifyRequest({
        type: 'signet-verify-request',
        requestId: 'req-approve-001',
        requiredAgeRange: '18+',
        relayUrl: 'wss://relay.trotters.cc',
        sessionPubkey,
        timestamp: ts,
      });
    }, { ts: now, sessionPubkey: TEST_PUBKEY });

    await navigateViaHarness(page, 'approve-verification');

    // Credential present → Approve button is shown
    await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible({ timeout: 5_000 });
    await page.getByRole('button', { name: 'Approve' }).click();

    // Response event should be published to the relay
    const published = await eventReceived;
    expect((published as any).kind).toBe(GIFT_WRAP_KIND);
    const tags: string[][] = (published as any).tags ?? [];
    expect(tags.some(t => t[0] === 'p' && t[1] === TEST_PUBKEY)).toBe(true);
  });
});

test.describe('Relay publish: auth response', () => {
  test('auth response is published when auth request with relayUrl is approved', async ({ page }) => {
    let resolveEvent: (event: unknown) => void;
    const eventReceived = new Promise(resolve => { resolveEvent = resolve; });

    await page.routeWebSocket('wss://**', ws => {
      ws.onMessage(message => {
        try {
          const data = JSON.parse(String(message));
          if (Array.isArray(data) && data[0] === 'EVENT') {
            // Only the gift wrap is the response: the app also publishes its own
            // kind-30078 sync records to a configured relay.
            if ((data[1] as any).kind === GIFT_WRAP_KIND) resolveEvent(data[1]);
            ws.send(JSON.stringify(['OK', (data[1] as any).id, true, '']));
          }
          if (Array.isArray(data) && data[0] === 'REQ') {
            ws.send(JSON.stringify(['EOSE', data[1]]));
          }
        } catch {}
      });
    });

    await clearDatabase(page);
    await createIdentityAndUnlock(page);

    // Inject a login request that carries a relay URL but no callbackUrl,
    // so approval publishes to the relay rather than redirecting the page.
    // Both state setters must be called in the same page.evaluate so React 18's
    // automatic batching applies them in a single render (avoids intermediate
    // render where page='approve-auth' but pendingAuthRequest=null).
    const now = Math.floor(Date.now() / 1000);
    await page.evaluate(({ ts, sessionPubkey }) => {
      (window as any).__TEST__.setPendingAuthRequest({
        type: 'signet-login-request',
        requestId: 'auth-relay-001',
        challenge: 'a'.repeat(64),
        origin: 'https://example.com',
        relay: 'wss://relay.trotters.cc',
        sessionPubkey,
        timestamp: ts,
      });
      (window as any).__TEST__.setPage('approve-auth');
    }, { ts: now, sessionPubkey: TEST_PUBKEY });

    await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible({ timeout: 5_000 });
    await confirmRealNameIfPrompted(page);
    await page.getByRole('button', { name: 'Approve' }).click();

    const published = await eventReceived;
    expect((published as any).kind).toBe(GIFT_WRAP_KIND);
    const tags: string[][] = (published as any).tags ?? [];
    expect(tags.some(t => t[0] === 'p' && t[1] === TEST_PUBKEY)).toBe(true);
  });
});

// --- useNostrEvents: re-fetch on relay connect ---
//
// Architecture note: useNostrEvents subscribes to the RelayClient instance that
// exists when the component mounts. setRelayUrl() replaces that singleton with a
// new client, so subscriptions made before the URL change point at the old client.
// The correct test scenario is therefore: set the relay URL FIRST (which creates
// the new client and starts connecting), THEN navigate to credential-detail so
// useNostrEvents subscribes to the correct client. The hook then fetches when
// the relay transitions to 'connected' via onStateChanged.

test.describe('useNostrEvents relay connect', () => {
  test('credential-detail updates to confirmed when relay connects after component mounts', async ({ page }) => {
    // Register WS mock BEFORE navigation so it intercepts the relay connection
    await page.routeWebSocket('wss://**', ws => {
      ws.onMessage(message => {
        try {
          const data = JSON.parse(String(message));
          if (Array.isArray(data) && data[0] === 'REQ') {
            const subId = data[1];
            ws.send(JSON.stringify(['EVENT', subId, RELAY_CREDENTIAL_EVENT]));
            setTimeout(() => ws.send(JSON.stringify(['EOSE', subId])), 100);
          }
        } catch {}
      });
    });

    await clearDatabase(page);
    await createIdentityAndUnlock(page);

    // Set relay URL FIRST so the relay client is created before useNostrEvents mounts.
    // The client may still be connecting asynchronously at this point.
    await setRelayUrl(page, 'wss://relay.trotters.cc');

    // Inject credential and navigate — useNostrEvents subscribes to the already-
    // existing relay client. If the relay is already connected, fetchAll runs
    // immediately; if not yet connected, onStateChanged fires and triggers fetchAll.
    await page.evaluate(({ id, pubkey }) => {
      (window as any).__TEST__.setSelectedCredential({
        id,
        documentId: 'doc-001',
        keypairType: 'natural-person',
        event: '{}',
        verifierPubkey: pubkey,
        verifiedAt: 1700000000,
        verifierStatus: 'pending',
      });
    }, { id: CREDENTIAL_ID, pubkey: VERIFIER_PUBKEY });

    await navigateViaHarness(page, 'credential-detail');

    // Hook finds the matching event and updates status to confirmed
    await expect(page.getByText('✓ Verified')).toBeVisible({ timeout: 15_000 });
  });
});
