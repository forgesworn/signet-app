import { test, expect } from '@playwright/test';
import { confirmRealNameIfPrompted, createIdentityAndUnlock, clearDatabase, navigateViaHarness } from './fixtures';

test.describe('Pages via test harness', () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
    await createIdentityAndUnlock(page);
  });

  test('my documents shows empty state', async ({ page }) => {
    await navigateViaHarness(page, 'my-documents');
    await expect(page.getByText('No documents yet')).toBeVisible();
  });

  test('family list shows empty state', async ({ page }) => {
    await navigateViaHarness(page, 'family-list');
    await expect(page.getByText('No dependants yet')).toBeVisible();
  });

  test('verify someone shows verifier QR step', async ({ page }) => {
    await navigateViaHarness(page, 'verify-someone');
    await expect(page.getByRole('heading', { name: 'Your verifier code' })).toBeVisible();
    await expect(page.getByRole('button', { name: /scanned it/ })).toBeVisible();
  });

  test('credential detail renders mock credential', async ({ page }) => {
    // Inject a mock credential via the test harness
    await page.evaluate(() => {
      (window as any).__TEST__.setSelectedCredential({
        id: 'test-credential-001',
        documentId: 'doc-001',
        keypairType: 'natural-person',
        event: '{}',
        verifierPubkey: 'a'.repeat(64),
        verifiedAt: 1700000000,
        verifierStatus: 'confirmed',
      });
    });
    await navigateViaHarness(page, 'credential-detail');

    await expect(page.getByText('Credential Details')).toBeVisible();
    await expect(page.getByText('Verified')).toBeVisible();
    await expect(page.getByText('Natural Person')).toBeVisible();
    await expect(page.getByText('Credential ID')).toBeVisible();
    await expect(page.getByText('test-credential-001')).toBeVisible();
  });

  test('credential detail shows pending status', async ({ page }) => {
    await page.evaluate(() => {
      (window as any).__TEST__.setSelectedCredential({
        id: 'test-credential-002',
        documentId: 'doc-002',
        keypairType: 'persona',
        event: '{}',
        verifierPubkey: 'b'.repeat(64),
        verifiedAt: 1700000000,
        verifierStatus: 'pending',
      });
    });
    await navigateViaHarness(page, 'credential-detail');

    await expect(page.getByText('Pending verification')).toBeVisible();
    await expect(page.getByText('Persona')).toBeVisible();
    await expect(page.getByText(/waiting for the verifier/)).toBeVisible();
  });

  test('photo capture shows consent step', async ({ page }) => {
    await navigateViaHarness(page, 'photo-capture');
    await expect(page.getByRole('heading', { name: 'Photo for venue entry' })).toBeVisible();
    await expect(page.getByText(/encrypted on your device before uploading to Blossom/)).toBeVisible();
    await expect(page.getByRole('button', { name: /I understand/ })).toBeVisible();
  });

  test('photo capture consent leads to camera step', async ({ page }) => {
    await navigateViaHarness(page, 'photo-capture');
    await page.getByRole('button', { name: /I understand/ }).click();
    await expect(page.getByRole('heading', { name: 'Take a selfie' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Capture' })).toBeVisible();
  });

  test('photo capture full upload flow', async ({ page }) => {
    await navigateViaHarness(page, 'photo-capture');

    // Mock fetch at JS level — intercept Blossom upload, echo back the hash from auth event
    await page.evaluate(() => {
      const origFetch = window.fetch;
      window.fetch = async function(input: any, init: any) {
        const url = typeof input === 'string' ? input : input?.url;
        if (url && url.includes('/upload')) {
          const auth = init?.headers?.['Authorization'] || init?.headers?.authorization || '';
          const b64 = auth.replace('Nostr ', '');
          const json = atob(b64);
          const event = JSON.parse(json);
          const xTag = event.tags.find((t: any) => t[0] === 'x');
          return new Response(JSON.stringify({ sha256: xTag[1] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return origFetch.call(window, input, init);
      } as typeof fetch;
    });

    // Consent step
    await page.getByRole('button', { name: /I understand/ }).click();

    // Camera step — wait for fake camera to produce frames
    await page.waitForFunction(() => {
      const video = document.querySelector('video');
      return video && video.readyState >= 2;
    }, { timeout: 10_000 });
    await page.getByRole('button', { name: 'Capture' }).click();

    // Preview step
    await expect(page.getByRole('heading', { name: 'Review photo' })).toBeVisible();
    await page.getByRole('button', { name: 'Upload to Blossom' }).click();

    // Done step
    await expect(page.getByText('Photo uploaded')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Back to venue entry' })).toBeVisible();
  });

  test('approve connect shows request and handles deny', async ({ page }) => {
    await page.evaluate(() => {
      (window as any).__TEST__.setPendingConnectRequest({
        clientPubkey: 'aa'.repeat(32),
        relayUrl: 'wss://relay.example.com',
        appName: 'Test App',
        appUrl: 'https://testapp.example.com',
      });
    });
    await navigateViaHarness(page, 'approve-connect');

    // Verify UI content
    await expect(page.getByRole('heading', { name: 'Connection Request' })).toBeVisible();
    await expect(page.getByText('Test App wants to connect to your Signet.')).toBeVisible();
    await expect(page.getByText('Connect as')).toBeVisible();
    await expect(page.getByText('Connection details')).toBeVisible();
    await expect(page.getByText('wss://relay.example.com')).toBeVisible();
    await expect(page.getByText('https://testapp.example.com')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Deny' })).toBeVisible();

    // Deny returns to home
    await page.getByRole('button', { name: 'Deny' }).click();
    await expect(page.getByText('Test User')).toBeVisible();
  });

  test('approve connect shows error state on failed relay', async ({ page }) => {
    await page.evaluate(() => {
      (window as any).__TEST__.setPendingConnectRequest({
        clientPubkey: 'cc'.repeat(32),
        relayUrl: 'wss://relay.example.com',
        appName: 'Failing Test',
      });
    });
    await navigateViaHarness(page, 'approve-connect');

    await confirmRealNameIfPrompted(page);
    await page.getByRole('button', { name: 'Approve' }).click();
    // Relay connection fails — error state with retry button
    await expect(page.getByText(/Could not complete NostrConnect pairing|Failed to connect/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});
