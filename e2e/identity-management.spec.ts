import { test, expect } from '@playwright/test';
import { nip19, getPublicKey, finalizeEvent } from 'nostr-tools';
import { schnorr } from '@noble/curves/secp256k1.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { createIdentityAndUnlock, unlockWithPin } from './fixtures';

// Disposable test material, never an operator identity.
const testKey = new Uint8Array(32).fill(37);
const importedPubkey = getPublicKey(testKey);
const importedNpub = nip19.npubEncode(importedPubkey);

for (const signer of ['local', 'extension'] as const) {
test(`import, recognise, open, reload and sign with the same Nostr identity (${signer})`, async ({ page, context }, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.route('https://example.com/callback**', route => route.fulfill({ body: 'Signed in' }));
  if (signer === 'extension') {
    const extensionKey = new Uint8Array(32).fill(42);
    await page.exposeFunction('testExtensionPubkey', () => getPublicKey(extensionKey));
    await page.exposeFunction('testExtensionSign', (event: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(event, extensionKey));
    await page.addInitScript(() => {
      const w = window as any;
      w.nostr = { getPublicKey: () => w.testExtensionPubkey(), signEvent: (event: unknown) => w.testExtensionSign(event) };
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'I already have a Signet' }).click();
    await page.getByRole('button', { name: /Import a Nostr key/ }).click();
    await page.getByRole('button', { name: 'Connect Nostr extension' }).click();
    await page.getByPlaceholder('Your name or nickname').fill('Owner');
    await page.getByRole('button', { name: 'Connect Extension' }).click();
    await page.getByRole('button', { name: 'Set up now' }).click();
    await page.getByRole('button', { name: /6-digit PIN/ }).click();
    for (const digit of '123456123456') await page.getByRole('button', { name: digit, exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByText('Owner', { exact: true }).first()).toBeVisible();
  } else {
    await createIdentityAndUnlock(page, { name: 'Owner' });
  }
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: /^Personas / }).click();
  await page.getByRole('button', { name: 'Import an existing Nostr account' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import an existing Nostr account' });
  await dialog.getByPlaceholder('nsec1...').fill(nip19.nsecEncode(testKey));
  await dialog.getByPlaceholder('What should we call this persona?').fill('Daily Nostr');
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog).toBeHidden();

  await page.screenshot({ path: testInfo.outputPath('identities.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const address = page.locator('.slot-npub-row').filter({ has: page.getByTitle(importedNpub) });
  await address.getByRole('button', { name: 'Copy npub' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(importedNpub);
  const identityActions = address.locator('..');
  await identityActions.getByRole('button', { name: 'Manage identity' }).click();
  await expect(page.getByText(/Your recovery words won't bring it back/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy hex' })).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('manage-imported-identity.png'), fullPage: true });
  await page.getByRole('button', { name: 'Hide this persona', exact: true }).click();
  await page.getByRole('button', { name: 'Hide', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Show this persona again' })).toBeVisible();
  await page.getByRole('button', { name: 'Go back', exact: true }).first().click();
  await expect(identityActions.getByRole('button', { name: 'Open identity' })).toBeHidden();
  await identityActions.getByRole('button', { name: 'Manage identity' }).click();
  await page.getByRole('button', { name: 'Show this persona again' }).click();
  await expect(page.getByRole('button', { name: 'Hide this persona', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Go back', exact: true }).first().click();
  await identityActions.getByRole('button', { name: 'Open identity' }).click();
  await expect(page.locator('.carousel-viewport').getByText('Daily Nostr', { exact: true }).first()).toBeVisible();

  // A real reload must preserve the imported key in encrypted storage.
  const challenge = '9'.repeat(64);
  await page.goto(`/?auth=1&challenge=${challenge}&origin=https://example.com&callback=https://example.com/callback&t=${Math.floor(Date.now() / 1000)}&name=IdentityTest`);
  await unlockWithPin(page);
  await page.getByRole('button', { name: /Daily Nostr/ }).click();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.waitForURL(/example\.com\/callback/);
  const result = new URL(page.url()).searchParams;
  expect(result.get('pubkey')).toBe(importedPubkey);
  expect(result.get('npub')).toBe(importedNpub);
  expect(schnorr.verify(hexToBytes(result.get('signature')!), hexToBytes(result.get('eventId')!), hexToBytes(importedPubkey))).toBe(true);
});
}
