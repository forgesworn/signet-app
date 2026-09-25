import { test, expect } from '@playwright/test';
import { nip19 } from 'nostr-tools';
import { schnorr } from '@noble/curves/secp256k1.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { confirmRealNameIfPrompted, unlockWithPin } from './fixtures';
import { TestBunker } from './helpers/test-bunker';

test('external signer reconnects after an outage and keeps the same signing identity', async ({ page }) => {
  test.setTimeout(150_000);
  const signer = new TestBunker();
  await signer.route(page);
  await page.route('https://example.com/callback**', route => route.fulfill({ body: 'Signed in' }));
  await page.goto('/');
  await page.getByRole('button', { name: 'I already have a Signet' }).click();
  await page.getByRole('button', { name: 'Connect a remote signer' }).click();
  await page.getByPlaceholder('bunker://...').fill(signer.uri);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByPlaceholder('Your name', { exact: true }).fill('Remote owner');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('button', { name: 'Set up now' }).click();
  await page.getByRole('button', { name: /6-digit PIN/ }).click();
  for (const digit of '123456123456') await page.getByRole('button', { name: digit, exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByText('Remote owner', { exact: true }).first()).toBeVisible();

  signer.setOnline(false);
  await page.goto(`/?auth=1&challenge=${'6'.repeat(64)}&origin=https://example.com&callback=https://example.com/callback&t=${Math.floor(Date.now() / 1000)}&name=ReconnectTest`);
  await unlockWithPin(page);
  await expect(page.getByText('Signer unavailable', { exact: false })).toBeVisible({ timeout: 45_000 });
  signer.setOnline(true);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByText('Signer unavailable', { exact: false })).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText('Connecting to signer...', { exact: true })).toBeHidden({ timeout: 15_000 });

  await page.getByRole('button', { name: /Remote owner/ }).click();
  await confirmRealNameIfPrompted(page);
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.waitForURL(/example\.com\/callback/);
  const result = new URL(page.url()).searchParams;
  expect(result.get('npub')).toBe(nip19.npubEncode(signer.pubkey));
  expect(result.get('pubkey')).toBe(signer.pubkey);
  expect(schnorr.verify(hexToBytes(result.get('signature')!), hexToBytes(result.get('eventId')!), hexToBytes(signer.pubkey))).toBe(true);
  expect(signer.methods.filter(method => method === 'connect').length).toBeGreaterThan(1);
  signer.setOnline(false);
});
