import { test, expect } from '@playwright/test';
import { fromMnemonic } from 'nsec-tree';
import { wrapNsec, unwrapNsec } from 'nsec-tree/wrapped';
import { getPublicKey } from 'nostr-tools/pure';
import { npubEncode } from 'nostr-tools/nip19';
import { readFile } from 'node:fs/promises';
import { restoreIdentityAndUnlock, navigateViaHarness, unlockWithPin } from './fixtures';

// Public BIP-39 test vector and disposable imported key. Never an owner key.
const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const raw = new Uint8Array(32).fill(0x22);
const npub = npubEncode(getPublicKey(raw));

test('restore an encrypted account, confirm its npub, export and check the saved file', async ({page}, info) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const root = fromMnemonic(mnemonic);
  try {
    const record = await wrapNsec(root, raw);
    await restoreIdentityAndUnlock(page, {name: 'Owner'});
    await navigateViaHarness(page, 'settings-personas');
    await page.getByLabel('Encrypted backup file', {exact: true}).setInputFiles({
      name: 'account.nstw', mimeType: 'text/plain', buffer: Buffer.from(record),
    });
    await page.getByLabel('Restored account name').fill('Existing account');
    const check = page.getByRole('button', {name: 'Check backup file', exact: true});
    await expect(check).toBeEnabled();
    await check.click();
    await unlockWithPin(page);
    await expect(page.getByText(npub, {exact: true})).toBeVisible();
    await page.screenshot({path: info.outputPath('confirm-imported-account.png'), fullPage: true});
    await page.getByRole('button', {name: 'Restore this account', exact: true}).click();
    await unlockWithPin(page);
    await expect(page.getByRole('status').filter({hasText: 'Restored Existing account'})).toBeVisible({timeout: 30_000});
    const address = page.locator('.slot-npub-row').filter({has: page.getByTitle(npub)});
    await address.locator('..').getByRole('button', {name: 'Manage identity', exact: true}).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', {name: 'Download encrypted backup', exact: true}).click();
    await unlockWithPin(page);
    const downloaded = await downloadPromise;
    expect(downloaded.suggestedFilename()).toBe('imported-account.nstw');
    const file = await downloaded.path();
    const restored = await unwrapNsec(root, await readFile(file!, 'utf8'), npub);
    try { expect(restored.privateKey).toEqual(raw); } finally { restored.privateKey.fill(0); }
    await page.getByLabel('Check saved backup file', {exact: true}).setInputFiles(file!);
    await unlockWithPin(page);
    await expect(page.getByRole('status').filter({hasText: `File checked for ${npub}`})).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({path: info.outputPath('checked-encrypted-backup.png'), fullPage: true});
  } finally { root.destroy(); }
});
