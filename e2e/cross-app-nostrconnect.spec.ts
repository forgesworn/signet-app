import { test, expect, type Page } from '@playwright/test';
import { NostrConnect } from 'nostr-tools/kinds';
import { RoutedRelay, hasFilterValue } from './helpers/routed-relay';
import { clearDatabase, confirmRealNameIfPrompted, createIdentityAndUnlock, unlockWithPin } from './fixtures';

const CANARY_BASE_URL = process.env.CANARY_BASE_URL ?? 'http://127.0.0.1:5173';
const RELAY_URL = 'wss://relay.example.com';

test.skip(process.env.SIGNET_CROSS_APP_E2E !== '1', 'Run cross-app NostrConnect via npm run test:e2e:cross-app.');

test('Canary pairs with the real Signet NostrConnect signer and restores NIP-44 after reload', async ({ browser, page }) => {
  const relay = new RoutedRelay();
  await relay.route(page);
  await clearDatabase(page);
  await createIdentityAndUnlock(page, { name: 'Cross App Signer' });

  const canaryContext = await browser.newContext();
  const canaryPage = await canaryContext.newPage();
  await relay.route(canaryPage);
  await canaryPage.addInitScript((relayUrl) => {
    if (!sessionStorage.getItem('canary-cross-app-nostrconnect-seeded')) {
      localStorage.clear();
      sessionStorage.setItem('canary-cross-app-nostrconnect-seeded', '1');
    }
    (window as Window & { __CANARY_SIGNET_TEST_RELAYS__?: string[] }).__CANARY_SIGNET_TEST_RELAYS__ = [relayUrl];
  }, RELAY_URL);

  try {
    await canaryPage.goto(CANARY_BASE_URL);
    await canaryPage.locator('#login-signet').click();
    await expect(canaryPage.locator('#signet-login-dialog')).toBeVisible();

    await canaryPage.locator('#signet-login-dialog button[data-choice="nostrconnect"]').click();
    await expect(canaryPage.locator('#signet-login-nc-status')).toContainText(/NostrConnect URI ready|Connecting to NostrConnect relay|Connected to relay|Waiting for signer/);

    const uriInput = canaryPage.locator('#signet-login-nc-uri');
    await expect(uriInput).toBeVisible();
    const uri = await uriInput.inputValue();
    expect(uri).toContain(`relay=${encodeURIComponent(RELAY_URL)}`);
    const clientPubkey = new URL(uri).hostname.toLowerCase();

    await relay.waitForSubscription(filter =>
      hasFilterValue(filter, 'kinds', NostrConnect) &&
      hasFilterValue(filter, '#p', clientPubkey) &&
      filter.limit !== 0,
    );

    await page.goto(`/?nostrconnect=${encodeURIComponent(uri)}`);
    await unlockWithPin(page);
    await expect(page.getByRole('heading', { name: 'Connection Request' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('CANARY', { exact: false }).first()).toBeVisible();
    await expect(page.getByText(RELAY_URL, { exact: false })).toBeVisible();

    await confirmRealNameIfPrompted(page);
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByText('Connected!')).toBeVisible({ timeout: 20_000 });

    await expect(canaryPage.locator('#signet-login-dialog')).toBeHidden({ timeout: 20_000 });
    await expect(canaryPage.locator('#sidebar')).toBeVisible({ timeout: 20_000 });

    await canaryPage.waitForFunction(() => {
      const raw = localStorage.getItem('canary:identity');
      if (!raw) return false;
      const identity = JSON.parse(raw) as { pubkey?: string } | null;
      return /^[0-9a-f]{64}$/.test(identity?.pubkey ?? '');
    });
    const identity = await canaryPage.evaluate(() => JSON.parse(localStorage.getItem('canary:identity') ?? 'null') as {
      pubkey?: string;
      signerMethod?: string;
      signerType?: string;
    } | null);
    expect(identity).toMatchObject({
      signerMethod: 'bunker',
      signerType: 'nip07',
    });
    expect(identity?.pubkey).toMatch(/^[0-9a-f]{64}$/);

    await canaryPage.reload();
    await canaryPage.waitForFunction(() => !!(window as Window & {
      Signet?: { restoreSession?: unknown };
    }).Signet?.restoreSession);

    const restoredRoundTrip = await canaryPage.evaluate(async () => {
      const signet = (window as Window & {
        Signet?: {
          restoreSession: () => Promise<{
            pubkey: string;
            signer: {
              nip44?: {
                encrypt: (peer: string, plaintext: string) => Promise<string>;
                decrypt: (peer: string, ciphertext: string) => Promise<string>;
              };
            };
          } | null>;
        };
      }).Signet;
      const session = await signet?.restoreSession();
      if (!session?.signer.nip44) return null;
      const ciphertext = await session.signer.nip44.encrypt(session.pubkey, 'cross-app-vault-secret');
      return session.signer.nip44.decrypt(session.pubkey, ciphertext);
    });
    expect(restoredRoundTrip).toBe('cross-app-vault-secret');
    expect(relay.storedEvents.some(event => event.kind === NostrConnect)).toBe(true);
  } finally {
    await canaryContext.close();
    relay.close();
  }
});
