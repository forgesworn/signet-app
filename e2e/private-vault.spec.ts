import { vaultIdentityFromMnemonic, zeroise } from 'signet-protocol';
import { bytesToHex } from '@noble/hashes/utils.js';
import { test, expect, type BrowserContext } from '@playwright/test';
import { restoreIdentityAndUnlock, navigateViaHarness } from './fixtures';
test.use({ actionTimeout: 15000 });

type Event = { id: string; pubkey: string; kind: number; tags: string[][]; created_at: number; content: string };

/** In-memory relays only: no test identity or private backup reaches a real relay. */
async function installRelays(context: BrowserContext, events: Map<string, Event>) {
  await context.routeWebSocket('**', socket => {
    if (new URL(socket.url()).port === '5174') {
      socket.connectToServer(); return;
    }
    socket.onMessage(raw => {
      let message: unknown[];
      try { message = JSON.parse(String(raw)); } catch { return; }
      if (message[0] === 'EVENT') {
        const event = message[1] as Event;
        if (event.kind >= 30000 && event.kind < 40000) {
          const d = event.tags.find(t => t[0] === 'd')?.[1];
          for (const [id, old] of events) {
            if (old.pubkey === event.pubkey && old.kind === event.kind
              && old.tags.find(t => t[0] === 'd')?.[1] === d && old.created_at <= event.created_at) events.delete(id);
          }
        }
        events.set(event.id, event);
        socket.send(JSON.stringify(['OK', event.id, true, '']));
      }
      if (message[0] === 'REQ') {
        const found = new Map<string, Event>();
        for (const filter of message.slice(2) as Record<string, unknown>[]) {
          const matches = [...events.values()].filter(event => Object.entries(filter).every(([key, value]) => {
            if (key === 'ids') return (value as string[]).includes(event.id);
            if (key === 'authors') return (value as string[]).includes(event.pubkey);
            if (key === 'kinds') return (value as number[]).includes(event.kind);
            if (key === 'since') return event.created_at >= Number(value);
            if (key === 'until') return event.created_at <= Number(value);
            if (key.startsWith('#')) return event.tags.some(t => t[0] === key.slice(1) && (value as string[]).includes(t[1]));
            return true;
          })).sort((a, b) => b.created_at - a.created_at).slice(0, Number(filter.limit ?? 1000));
          for (const event of matches) found.set(event.id, event);
        }
        for (const event of found.values()) socket.send(JSON.stringify(['EVENT', message[1], event]));
        socket.send(JSON.stringify(['EOSE', message[1]]));
      }
    });
  });
}

test('rotates a private backup and restores human/bot contacts and family contact policy on a fresh browser', async ({ page, context, browser }) => {
  test.setTimeout(180000);
  const events = new Map<string, Event>();
  await installRelays(context, events);
  await restoreIdentityAndUnlock(page);
  await navigateViaHarness(page, 'settings');
  await expect(page.getByText('5 private datasets verified')).toBeVisible({ timeout: 60000 });
  const before = new Set(events.keys());
  await navigateViaHarness(page, 'contact-new');
  await page.getByLabel('Name').fill('Vault recovery contact');
  await page.getByRole('button', { name: 'Save contact' }).click();
  await expect(page.getByText('Vault recovery contact')).toBeVisible();
  // Wait for the mutation's queued backup to finish, rather than accepting
  // the previous cycle's status before its debounce has run.
  await expect.poll(() => [...events.keys()].some(id => !before.has(id)), { timeout: 15000 }).toBe(true);
  await navigateViaHarness(page, 'settings');
  await expect(page.getByText('5 private datasets verified')).toBeVisible({ timeout: 60000 });
  await navigateViaHarness(page, 'bots');
  await page.getByLabel('Bot name').fill('Recovery Helper');
  await page.getByRole('button', { name: 'Create bot', exact: true }).click();
  for (const digit of '123456') await page.getByRole('button', { name: digit, exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Recovery Helper · Bot', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'View bot contacts' }).click();
  const beforeBotContact = new Set(events.keys());
  await page.getByRole('button', { name: 'New contact', exact: true }).first().click();
  await page.getByLabel('Name', { exact: true }).fill('Recovered bot friend');
  await page.getByRole('button', { name: 'Save contact' }).click();
  await expect(page.getByRole('button', { name: /Open Recovered bot friend/ })).toBeVisible();
  // The BIP-39 payload of fixtures.ts's frozen 19-word recovery envelope.
  const vault = vaultIdentityFromMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', 'contacts:bots');
  const botAuthor = bytesToHex(vault.publicKey); zeroise(vault);
  await expect.poll(() => [...events.values()].some(event => event.pubkey === botAuthor && !beforeBotContact.has(event.id)), { timeout: 30000 }).toBe(true);
  await navigateViaHarness(page, 'settings');
  await expect(page.getByText('5 private datasets verified')).toBeVisible({ timeout: 60000 });
  await navigateViaHarness(page, 'add-dependant');
  const activate = page.getByRole('button', { name: 'Activate my real identity' });
  if (await activate.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
    await activate.click();
    await page.locator('#legal-name').fill('Recovery Guardian');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByPlaceholder('Recovery Guardian').fill('Recovery Guardian');
    await page.getByRole('button', { name: 'Activate my real identity' }).click();
    const written = page.getByRole('checkbox', { name: /written these down/ });
    if (await written.waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false)) {
      await written.click();
      await page.getByRole('button', { name: 'Done', exact: true }).click();
    }
  }
  await page.getByLabel(/Their name/i).fill('Recovery Robin');
  await page.getByRole('button', { name: 'Create identity', exact: true }).click();
  await expect(page.getByText(/Recovery Robin's identity is ready/)).toBeVisible({ timeout: 60000 });
  await page.getByRole('button', { name: /Done for now/ }).click();
  await navigateViaHarness(page, 'family-list');
  await page.getByRole('button', { name: /Recovery Robin/ }).click();
  await page.getByRole('button', { name: 'Approved contacts', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Approved contacts', exact: true })).toHaveClass(/btn-tile-selected/);
  await page.getByRole('button', { name: 'Kith', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Kith', exact: true })).toHaveClass(/btn-primary/);
  await page.getByRole('button', { name: 'Switch back to your own identity' }).click();
  await expect(page.locator('.carousel-viewport')).toBeVisible();
  await navigateViaHarness(page, 'settings');
  await expect(page.getByText('6 private datasets verified')).toBeVisible({ timeout: 60000 });
  await page.locator('.sync-backup-banner summary').filter({ hasText: '6 private datasets verified' }).click();
  const ownerBackup = page.locator('[data-vault-purpose="signet:vault:contacts:owner"]');
  await ownerBackup.getByRole('button', { name: 'Change backup key for contacts:owner', exact: true }).click();
  // Rotation requires fresh presence even though the app is already unlocked.
  for (const digit of '123456') await page.getByRole('button', { name: digit, exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Backup key changed and verified.' })).toBeVisible({ timeout: 60000 });
  await expect(ownerBackup).toContainText('key version 1', { timeout: 60000 });
  const second = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: new URL(page.url()).origin, viewport: { width: 390, height: 844 } });
  try {
    await installRelays(second, events);
    const restored = await second.newPage();
    await restoreIdentityAndUnlock(restored);
    await navigateViaHarness(restored, 'settings');
    await expect(restored.getByText('6 private datasets verified')).toBeVisible({ timeout: 60000 });
    await restored.locator('.sync-backup-banner summary').filter({ hasText: '6 private datasets verified' }).click();
    await expect(restored.locator('[data-vault-purpose="signet:vault:contacts:owner"]')).toContainText('key version 1');
    await navigateViaHarness(restored, 'contacts');
    await expect(restored.getByText('Vault recovery contact')).toBeVisible({ timeout: 15000 });
    await expect(restored.getByText('Recovered bot friend', { exact: true })).toHaveCount(0);
    await navigateViaHarness(restored, 'bots');
    await expect(restored.getByRole('heading', { name: 'Recovery Helper · Bot', exact: true })).toBeVisible();
    await restored.getByRole('button', { name: 'View bot contacts' }).click();
    await expect(restored.getByRole('button', { name: /Open Recovered bot friend/ })).toBeVisible();
    await expect(restored.getByText('Vault recovery contact', { exact: true })).toHaveCount(0);
    await navigateViaHarness(restored, 'family-list');
    await restored.getByRole('button', { name: /Recovery Robin/ }).click();
    await expect(restored.getByRole('button', { name: 'Approved contacts', exact: true })).toHaveClass(/btn-tile-selected/, { timeout: 60000 });
    await expect(restored.getByRole('button', { name: 'Kith', exact: true })).toHaveClass(/btn-primary/, { timeout: 60000 });
  } finally { await second.close(); }
});
