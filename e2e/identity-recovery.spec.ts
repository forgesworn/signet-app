import { test, expect } from '@playwright/test';
import { getPublicKey, nip19, nip44 } from 'nostr-tools';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { zeroise } from 'signet-protocol';
import { vaultIdentityFromMnemonic } from 'signet-protocol/experimental';
import { restoreIdentityAndUnlock, unlockWithPin } from './fixtures';
import { RoutedRelay } from './helpers/routed-relay';
import { openVaultPayload } from '../src/lib/vault-envelope';

// The BIP-39 payload of the fixture's test-vector recovery words.
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/**
 * Every plaintext sealed to the owner's `profiles` private-vault key. Once
 * that vault is canonical the legacy `signet:personas` rail stops writing
 * (`legacyVaultWriteAllowed`), so the persona backup lives here: the vault
 * snapshot carries the personas wire (`profilesVaultAdapter`).
 */
async function profilesVaultPlaintexts(events: { kind: number; content: string }[]): Promise<string[]> {
  const vault = vaultIdentityFromMnemonic(TEST_MNEMONIC, 'profiles', 0);
  const secret = vault.privateKey.slice();
  const vaultPubkey = bytesToHex(vault.publicKey);
  zeroise(vault);
  try {
    const backend = { nip44Decrypt: async (sender: string, ciphertext: string) =>
      nip44.decrypt(ciphertext, nip44.getConversationKey(secret, sender)) };
    const opened = await Promise.all(events.filter(event => event.kind === 30078)
      .map(event => openVaultPayload(event.content, backend, vaultPubkey, { legacyFallback: false })));
    return opened.filter((plaintext): plaintext is string => plaintext !== null);
  } finally {
    secret.fill(0);
  }
}

test('recovery words restore the same derived persona; imported keys need a separate backup', async ({ browser, page, context }) => {
  // Keep real timers and relay I/O. Bound non-cryptographic jitter near its
  // minimum; fake time can expire relay connections before Node routes them.
  // crypto.getRandomValues (keys/nonces) remains untouched. The full jitter
  // range is covered by personas-sync unit tests.
  test.setTimeout(120_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(() => {
    const originalRandom = Math.random;
    Math.random = () => originalRandom() / 1000;
  });
  // localhost uses the development relay; 127.0.0.1 uses the public fallback.
  const relay = new RoutedRelay(/^(?:wss:\/\/|ws:\/\/localhost:7777(?:\/|$))/);
  await relay.route(page);
  // Both contexts restore the deterministic test-vector words, so the second
  // context provably rebuilds the SAME identity the first one backed up.
  await restoreIdentityAndUnlock(page, { name: 'Original owner' });
  const origin = new URL(page.url()).origin;
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: /^Personas / }).click();
  await page.getByRole('button', { name: '+ Add persona', exact: true }).click();
  await page.getByPlaceholder('Persona name', { exact: true }).fill('Recoverable persona');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const derivedRow = page.locator('.row').filter({ has: page.getByText('Recoverable persona', { exact: true }) }).locator('..');
  const npub = await derivedRow.locator('.slot-npub-row [title]').getAttribute('title');
  expect(npub).toMatch(/^npub1/);

  const separateKey = new Uint8Array(32).fill(71);
  await page.getByRole('button', { name: 'Import an existing Nostr account' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByPlaceholder('nsec1...').fill(nip19.nsecEncode(separateKey));
  await dialog.getByPlaceholder('What should we call this persona?').fill('Imported separately');
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTitle(nip19.npubEncode(getPublicKey(separateKey)))).toBeVisible();
  try {
    // The backup must carry the persona just added, not merely exist: the
    // vault already published a snapshot at unlock, before the persona.
    await expect.poll(async () => (await profilesVaultPlaintexts(relay.storedEvents))
      .some(plaintext => plaintext.includes('Recoverable persona')),
    { timeout: 45_000 }).toBe(true);
  } catch (error) {
    const state = await page.evaluate(() => ({
      visibility: document.visibilityState,
      locked: (window as any).__TEST__?.isLocked?.(),
      pathname: location.pathname,
    }));
    throw new Error(`Persona backup missing: ${JSON.stringify({ ...state, publishedKinds: relay.storedEvents.map(event => event.kind) })}`, { cause: error });
  }

  await page.context().close();

  // Fresh browser storage: restoration uses only the written recovery words
  // and the encrypted relay inventory, never the original IndexedDB.
  const restoredContext = await browser.newContext({ baseURL: origin, viewport: { width: 390, height: 844 } });
  const restored = await restoredContext.newPage();
  try {
    await relay.route(restored);
    await restored.route('https://example.com/callback**', route => route.fulfill({ body: 'Signed in' }));
    await restoreIdentityAndUnlock(restored, { name: 'Restored owner' });
    await restored.getByRole('button', { name: 'Settings', exact: true }).click();
    await restored.getByRole('button', { name: /^Personas / }).click();
    // The persona arrives over the personas sync rail after unlock; give the
    // fetch time on a loaded CI runner.
    await expect(restored.getByText('Recoverable persona', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(restored.getByTitle(npub!)).toBeVisible();
    await expect(restored.getByText('Imported separately')).toBeHidden();
    await expect(restored.getByTitle(nip19.npubEncode(getPublicKey(separateKey)))).toBeHidden();

    await restored.goto(`/?auth=1&challenge=${'8'.repeat(64)}&origin=https://example.com&callback=https://example.com/callback&t=${Math.floor(Date.now() / 1000)}&name=RecoveryTest`);
    await unlockWithPin(restored);
    await restored.getByRole('button', { name: /Recoverable persona/ }).click();
    await restored.getByRole('button', { name: 'Approve', exact: true }).click();
    await restored.waitForURL(/example\.com\/callback/);
    const result = new URL(restored.url()).searchParams;
    expect(result.get('npub')).toBe(npub);
    const recoveredPubkey = nip19.decode(npub!).data as string;
    expect(result.get('pubkey')).toBe(recoveredPubkey);
    expect(schnorr.verify(hexToBytes(result.get('signature')!), hexToBytes(result.get('eventId')!), hexToBytes(recoveredPubkey))).toBe(true);
  } finally {
    await restoredContext.close();
    relay.close();
  }
});
