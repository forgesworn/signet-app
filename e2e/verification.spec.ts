import { test, expect, type Page } from '@playwright/test';
import { getPublicKey } from 'nostr-tools/pure';
import { createIdentityAndUnlock, restoreIdentityAndUnlock, clearDatabase, navigateViaHarness, confirmRealNameIfPrompted } from './fixtures';

const clientPubkey = (byte: number) => getPublicKey(new Uint8Array(32).fill(byte));

/**
 * Get Verified attaches a legal name, so it sits behind the `RequireRealIdentity`
 * activation gate for a dormant identity (spec §7.3). Tests that need to reach
 * the real Get Verified screen override the shared dormant-identity beforeEach
 * with a restored, NP-primary identity (NP starts active on that door) —
 * mirrors `unlockWithActiveNp` in home.spec.ts.
 */
async function unlockWithActiveNp(page: Page) {
  await clearDatabase(page);
  await restoreIdentityAndUnlock(page, { keypair: 'natural-person' });
  await page.locator('.carousel-viewport').waitFor({ state: 'visible', timeout: 60_000 });
}

async function routeNostrConnectRelay(page: Page): Promise<{ eventReceived: Promise<unknown> }> {
  let resolveEvent: (event: unknown) => void;
  const eventReceived = new Promise<unknown>(resolve => { resolveEvent = resolve; });

  await page.routeWebSocket('wss://**', ws => {
    ws.onMessage(message => {
      try {
        const data = JSON.parse(String(message));
        if (Array.isArray(data) && data[0] === 'EVENT') {
          ws.send(JSON.stringify(['OK', (data[1] as any).id, true, '']));
          resolveEvent(data[1]);
        }
      } catch {
        // Ignore non-Nostr frames.
      }
    });
  });

  return { eventReceived };
}

async function expectConnectPublish(eventReceived: Promise<unknown>, clientPubkey: string) {
  const published = await eventReceived;
  expect((published as any).kind).toBe(24133);
  expect((published as any).id).toHaveLength(64);
  expect(typeof (published as any).sig).toBe('string');
  expect((published as any).sig.length).toBeGreaterThan(0);

  const tags: string[][] = (published as any).tags ?? [];
  expect(tags.some(t => t[0] === 'p' && t[1] === clientPubkey)).toBe(true);
}

test.describe('Verification', () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
    await createIdentityAndUnlock(page);
  });

  test('web verify page loads with scan options', async ({ page }) => {
    await navigateViaHarness(page, 'web-verify');
    await expect(page.getByRole('button', { name: 'Scan QR code' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Choose from photos' })).toBeVisible();
  });

  test('paste-link input is visible without first failing camera scan', async ({ page }) => {
    await navigateViaHarness(page, 'web-verify');
    await expect(page.getByTestId('paste-link-input')).toBeVisible();
  });

  test('mobile scan screen keeps the paste fallback immediately reachable', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await navigateViaHarness(page, 'web-verify');

    const input = page.getByTestId('paste-link-input');
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute('placeholder', /nostrconnect:\/\//);

    const box = await input.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(320);
  });

  test('invalid paste payload shows error', async ({ page }) => {
    await navigateViaHarness(page, 'web-verify');

    await page.getByTestId('paste-link-input').fill('garbage payload');
    await page.getByRole('button', { name: 'Submit' }).click();

    await expect(page.getByText(/isn't recognised/)).toBeVisible();
  });

  test('valid verify request shows approval screen', async ({ page }) => {
    await navigateViaHarness(page, 'web-verify');

    const requestId = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
    const payload = JSON.stringify({
      type: 'signet-verify-request',
      requestId,
      requiredAgeRange: '18+',
      origin: 'https://example.com',
      relayUrl: 'wss://relay.trotters.cc',
      timestamp: Math.floor(Date.now() / 1000),
    });

    await page.getByTestId('paste-link-input').fill(payload);
    await page.getByRole('button', { name: 'Submit' }).click();

    await expect(page.getByText('Age Verification Request')).toBeVisible({ timeout: 5_000 });
  });

  test('deny verification returns to home', async ({ page }) => {
    await navigateViaHarness(page, 'web-verify');

    const payload = JSON.stringify({
      type: 'signet-verify-request',
      requestId: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
      requiredAgeRange: '18+',
      origin: 'https://example.com',
      relayUrl: 'wss://relay.trotters.cc',
      timestamp: Math.floor(Date.now() / 1000),
    });

    await page.getByTestId('paste-link-input').fill(payload);
    await page.getByRole('button', { name: 'Submit' }).click();

    await expect(page.getByText('Age Verification Request')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('You need to get verified first')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve' })).not.toBeVisible();

    await page.getByRole('button', { name: 'Cancel' }).click();

    await expect(page.getByText('Test User')).toBeVisible();
  });

  test('verification request without credential shows get-verified prompt', async ({ page }) => {
    await unlockWithActiveNp(page);
    await navigateViaHarness(page, 'web-verify');

    const payload = JSON.stringify({
      type: 'signet-verify-request',
      requestId: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
      requiredAgeRange: '18+',
      origin: 'https://example.com',
      relayUrl: 'wss://relay.trotters.cc',
      timestamp: Math.floor(Date.now() / 1000),
    });

    await page.getByTestId('paste-link-input').fill(payload);
    await page.getByRole('button', { name: 'Submit' }).click();

    await expect(page.getByText('Age Verification Request')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('You need to get verified first')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Get Verified' })).toBeVisible();

    await page.getByRole('button', { name: 'Get Verified' }).click();

    await expect(page.getByText('How verification works')).toBeVisible();
  });

  test('get verified page shows steps', async ({ page }) => {
    await unlockWithActiveNp(page);
    await navigateViaHarness(page, 'get-verified');
    await expect(page.getByText('How verification works')).toBeVisible();
    await expect(page.getByText('Visit a verifier')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enter my details' })).toBeVisible();
  });

  test('expired verify request rejected', async ({ page }) => {
    await navigateViaHarness(page, 'web-verify');

    const payload = JSON.stringify({
      type: 'signet-verify-request',
      requestId: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
      requiredAgeRange: '18+',
      origin: 'https://example.com',
      relayUrl: 'wss://relay.trotters.cc',
      timestamp: Math.floor(Date.now() / 1000) - 600,
    });

    await page.getByTestId('paste-link-input').fill(payload);
    await page.getByRole('button', { name: 'Submit' }).click();

    // Expired timestamp should be rejected
    await expect(page.getByText(/expired|isn't recognised/)).toBeVisible({ timeout: 5_000 });
  });
});

test.describe('WebVerify NostrConnect relay publish', () => {
  async function approvePastedConnect(page: Page, payload: string) {
    await clearDatabase(page);
    await createIdentityAndUnlock(page);
    await navigateViaHarness(page, 'web-verify');
    await page.getByTestId('paste-link-input').fill(payload);
    await page.getByRole('button', { name: 'Submit' }).click();

    await expect(page.getByText('Connection Request')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('strong').filter({ hasText: /^Canary$/ })).toBeVisible();
    await expect(page.getByText('wss://relay.example.com')).toBeVisible();
    await confirmRealNameIfPrompted(page);
    await page.getByRole('button', { name: 'Approve' }).click();
  }

  test('raw nostrconnect paste approves through the NIP-46 relay path', async ({ page }) => {
    const { eventReceived } = await routeNostrConnectRelay(page);
    const pubkey = clientPubkey(7);
    const uri = `nostrconnect://${pubkey}?relay=wss://relay.example.com&secret=pair-secret&name=Canary&url=${encodeURIComponent('https://canary.trotters.cc')}`;

    await approvePastedConnect(page, uri);
    await expectConnectPublish(eventReceived, pubkey);
  });

  test('wrapped mysignet nostrconnect paste approves through the NIP-46 relay path', async ({ page }) => {
    const { eventReceived } = await routeNostrConnectRelay(page);
    const pubkey = clientPubkey(8);
    const uri = `nostrconnect://${pubkey}?relay=wss://relay.example.com&secret=pair-secret&name=Canary&url=${encodeURIComponent('https://canary.trotters.cc')}`;
    const wrapped = `https://mysignet.app/?nostrconnect=${encodeURIComponent(uri)}`;

    await approvePastedConnect(page, wrapped);
    await expectConnectPublish(eventReceived, pubkey);
  });
});
