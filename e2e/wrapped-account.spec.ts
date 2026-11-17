import { test, expect } from '@playwright/test';
import { fromMnemonic } from 'nsec-tree';
import { fromNsec } from 'nsec-tree/core';
import { wrapNsec, unwrapNsec } from 'nsec-tree/wrapped';
import { getPublicKey } from 'nostr-tools/pure';
import { npubEncode } from 'nostr-tools/nip19';
import { readFile } from 'node:fs/promises';
import { restoreIdentityAndUnlock, navigateViaHarness, unlockWithPin } from './fixtures';
import {createAccountCollection, inspectAccountCollection} from '../src/lib/wrapped-account-collection';
import {derivePersona} from 'nsec-tree';
import {bytesToHex} from '@noble/hashes/utils.js';

// Public BIP-39 test vector and disposable imported key. Never an owner key.
const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const raw = new Uint8Array(32).fill(0x22);
const npub = npubEncode(getPublicKey(raw));

test('ten-account collection survives a fresh browser and supports selected restore and exact saved-file checking', async ({page, browser}, info) => {
  test.setTimeout(300_000);
  const root = fromMnemonic(mnemonic);
  const np = derivePersona(root, 'natural-person');
  const owner = {mnemonic, naturalPerson: {publicKey: bytesToHex(np.identity.publicKey)}};
  np.identity.privateKey.fill(0); root.destroy();
  const slots = Array.from({length: 10}, (_, i) => {
    const key = new Uint8Array(32).fill(i + 1);
    return {displayName: `Recovered ${i + 1}`, privateKey: bytesToHex(key), publicKey: getPublicKey(key), imported: true};
  });
  const source = await createAccountCollection(owner, slots);
  await restoreIdentityAndUnlock(page, {name: 'Collection owner'});
  await navigateViaHarness(page, 'settings-personas');
  await page.getByLabel('Account collection file', {exact: true}).setInputFiles({name: 'accounts.nstc', mimeType: 'application/octet-stream', buffer: Buffer.from(source)});
  await page.getByRole('button', {name: 'Open collection', exact: true}).click();
  await unlockWithPin(page);
  for (const slot of slots) await expect(page.getByText(npubEncode(slot.publicKey), {exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Restore 10 selected accounts', exact: true}).click();
  await unlockWithPin(page);
  await expect(page.getByRole('status').filter({hasText: 'Restored 10 accounts'})).toBeVisible({timeout: 90_000});
  await page.getByRole('button', {name: 'Select all imported accounts', exact: true}).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', {name: 'Download account collection', exact: true}).click();
  await unlockWithPin(page);
  const downloaded = await downloading;
  expect(downloaded.suggestedFilename()).toBe('signet-accounts.nstc');
  const bytes = await readFile((await downloaded.path())!);
  const checked = await inspectAccountCollection(owner, bytes);
  expect(checked.accounts.map(a => a.npub)).toEqual(slots.map(s => npubEncode(s.publicKey)));
  await page.getByLabel('Account collection file', {exact: true}).setInputFiles({name: 'saved.nstc', mimeType: 'application/octet-stream', buffer: bytes});
  await page.getByRole('button', {name: 'Open collection', exact: true}).click(); await unlockWithPin(page);
  await expect(page.getByRole('status').filter({hasText: 'Saved collection checked: 10 accounts'})).toBeVisible();
  await page.screenshot({path: info.outputPath('ten-account-collection-checked.png'), fullPage: true});

  // A separate browser storage partition has none of the first install's account data.
  const fresh = await browser.newContext({viewport: {width: 390, height: 844}, ignoreHTTPSErrors: true});
  try {
    const recovery = await fresh.newPage();
    await restoreIdentityAndUnlock(recovery, {name: 'Fresh owner'});
    await navigateViaHarness(recovery, 'settings-personas');
    await recovery.getByLabel('Account collection file', {exact: true}).setInputFiles({name: 'recovered-encrypted.fswnenc', mimeType: 'application/octet-stream', buffer: bytes});
    await recovery.getByRole('button', {name: 'Open collection', exact: true}).click(); await unlockWithPin(recovery);
    for (let i = 1; i < 10; i++) await recovery.getByLabel(`Restore Recovered ${i + 1}`, {exact: true}).uncheck();
    await recovery.getByRole('button', {name: 'Restore 1 selected account', exact: true}).click(); await unlockWithPin(recovery);
    await expect(recovery.getByRole('status').filter({hasText: 'Restored 1 account'})).toBeVisible({timeout: 30_000});
    const row = recovery.locator('.slot-npub-row').filter({has: recovery.getByTitle(npubEncode(slots[0].publicKey))});
    await expect(row).toBeVisible();
    expect(await recovery.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await fresh.close(); }
});

test('restore an encrypted account, confirm its npub, export and check the saved file', async ({page}, info) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const root = fromMnemonic(mnemonic);
  try {
    const record = await wrapNsec(root, raw);
    await restoreIdentityAndUnlock(page, {name: 'Owner'});
    await navigateViaHarness(page, 'settings-personas');
    const wrongRoot = fromNsec(new Uint8Array(32).fill(0x33));
    let foreignRecord: string;
    try { foreignRecord = await wrapNsec(wrongRoot, raw); }
    finally { wrongRoot.destroy(); }
    const damaged = Buffer.from(record.slice(6), 'base64url');
    damaged[55] ^= 1;
    for (const rejectedRecord of [foreignRecord, 'nstw1:' + damaged.toString('base64url')]) {
      await page.getByLabel('Encrypted backup file', {exact: true}).setInputFiles({
        name: 'rejected.nstw', mimeType: 'text/plain', buffer: Buffer.from(rejectedRecord),
      });
      await page.getByRole('button', {name: 'Check backup file', exact: true}).click();
      await unlockWithPin(page);
      await expect(page.getByRole('alert')).toHaveText(/could not be opened/);
      await expect(page.getByRole('button', {name: 'Restore this account', exact: true})).toHaveCount(0);
    }
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
