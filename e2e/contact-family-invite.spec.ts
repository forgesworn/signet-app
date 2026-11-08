import { test, expect } from '@playwright/test';
import { createIdentityAndUnlock, navigateViaHarness, addDependantViaUi } from './fixtures';
import { privateRelays } from './helpers/private-relays';
test.use({ actionTimeout: 15000 });
test('guardian reviews a dependant invite and completes it using the dependant identity', async ({ page, context, browser }) => {
  test.setTimeout(240000);
  const network = privateRelays(); await network.install(context);
  await createIdentityAndUnlock(page, { name: 'Guardian' });
  await page.evaluate(() => (window as any).__TEST__.setRelayUrl('wss://family-invite.test'));
  await addDependantViaUi(page, 'Robin');
  await navigateViaHarness(page, 'family-list');
  await page.getByRole('button', { name: /Robin/ }).click();
  await page.getByRole('button', { name: 'Approved contacts', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Approved contacts', exact: true })).toHaveClass(/btn-tile-selected/);
  await navigateViaHarness(page, 'contacts');
  await page.getByRole('button', { name: 'Invites and requests' }).click();
  await expect(page.getByRole('heading', { name: /Invites for Robin/ })).toBeVisible();
  await page.getByRole('button', { name: 'Create invite', exact: true }).click();
  await page.evaluate(() => { Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true,
    value: async (text: string) => { (window as any).__copiedInvite = text; } }); });
  await page.getByRole('button', { name: 'Copy invite link' }).click();
  const link = await page.evaluate(() => (window as any).__copiedInvite as string);
  const second = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: new URL(page.url()).origin, viewport: { width: 390, height: 844 } });
  try {
    await network.install(second); const sender = await second.newPage();
    await createIdentityAndUnlock(sender, { name: 'Friend' });
    await navigateViaHarness(sender, 'contact-invites');
    await sender.getByLabel('Invite link', { exact: true }).fill(link);
    await sender.getByRole('button', { name: 'Send contact request', exact: true }).click();
    await expect(page.getByText('Unopened contact request', { exact: true })).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: 'Open request list' }).click();
    await expect(page.getByText(/^Request from /)).toBeVisible();
    await expect(page.getByText(/Connected — words not checked/)).toHaveCount(0);
    await page.getByRole('button', { name: 'Approve and accept request', exact: true }).click();
    await expect(page.getByText(/Connected — words not checked/)).toBeVisible({ timeout: 60000 });
    await expect(sender.getByText(/Connected — words not checked/)).toBeVisible({ timeout: 60000 });
    expect(await page.getByText('You say:', { exact: false }).locator('strong').innerText())
      .toBe(await sender.getByText('They say:', { exact: false }).locator('strong').innerText());
    await page.getByRole('button', { name: 'Open contact', exact: true }).click();
    await expect(page.getByText('Via your invite: My contact card', { exact: true })).toBeVisible({ timeout: 30000 });
  } finally { await second.close().catch(() => {}); }
});
