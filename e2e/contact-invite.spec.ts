import { test, expect } from '@playwright/test';
import { createIdentityAndUnlock, navigateViaHarness } from './fixtures';
import { privateRelays } from './helpers/private-relays';
test.use({ actionTimeout: 15000 });

test('two identities complete an invite exchange and explicitly compare fixed words', async ({ page, context, browser }) => {
  test.setTimeout(180000);
  const network = privateRelays();
  await network.install(context);
  await createIdentityAndUnlock(page, { name: 'Invite recipient' });
  await page.evaluate(() => (window as any).__TEST__.setRelayUrl('wss://invite.test'));
  await expect(page.locator('.carousel-viewport')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await page.getByRole('button', { name: 'Create reusable contact invite', exact: true }).click();
  await expect(page.getByRole('option', { name: 'My contact card', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Manage invites', exact: true }).click();
  await expect(page.getByText('My contact card', { exact: true })).toBeVisible();
  // Capture the link through the actual copy action, without requiring clipboard permissions.
  await page.evaluate(() => { Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true,
    value: async (text: string) => { (window as any).__copiedInvite = text; } }); });
  await page.getByRole('button', { name: 'Copy invite link' }).click();
  const link = await page.evaluate(() => (window as any).__copiedInvite as string);
  const senderContext = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: new URL(page.url()).origin, viewport: { width: 390, height: 844 } });
  try {
    await network.install(senderContext);
    const sender = await senderContext.newPage();
    await createIdentityAndUnlock(sender, { name: 'Invite sender' });
    await navigateViaHarness(sender, 'contact-invites');
    await sender.getByLabel('Invite link', { exact: true }).fill(link);
    await sender.getByRole('button', { name: 'Send contact request' }).click();
    await expect(page.getByText('Unopened contact request', { exact: true })).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: 'Open request list' }).click();
    await page.getByRole('button', { name: 'Accept request' }).click();
    await expect(sender.getByText('You say:', { exact: false })).toBeVisible({ timeout: 60000 });
    await expect(page.getByText('You say:', { exact: false })).toBeVisible({ timeout: 60000 });
    const recipientWords = await page.getByText('You say:', { exact: false }).locator('strong').innerText();
    const senderExpected = await sender.getByText('They say:', { exact: false }).locator('strong').innerText();
    expect(recipientWords).toBe(senderExpected);
    await sender.getByLabel('Words they told you').fill(recipientWords);
    await sender.getByRole('button', { name: 'Confirm their words' }).click();
    await expect(sender.getByText(/Words checked/)).toBeVisible();
    await expect(page.getByText(/Connected — words not checked/)).toBeVisible();
    await sender.getByRole('button', { name: 'Open contact', exact: true }).click();
    await expect(sender.getByText('Kith', { exact: true }).first()).toBeVisible();
    await expect(sender.getByText(/^Words ·/)).toBeVisible({ timeout: 30000 });
    await sender.getByLabel('Check method').selectOption('in-person');
    await sender.getByLabel('Private source', { exact: true }).selectOption('printed-card');
    await sender.getByLabel('Private evidence or link').fill('Private card comparison');
    await sender.getByRole('button', { name: 'Record check', exact: true }).click();
    await expect(sender.getByText('Private card comparison', { exact: true })).toBeVisible();
    await expect(sender.getByText(/^In person ·/)).toBeVisible();
    await expect(sender.getByText(/^Contact link ·/)).toBeVisible();
    await page.getByRole('button', { name: 'Open contact', exact: true }).click();
    await expect(page.getByText('Via your invite: My contact card', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Edit how added' }).click();
    await page.getByLabel('Private invite name', { exact: true }).fill('Conference 2026');
    await page.getByRole('button', { name: 'Save history record' }).click();
    await expect(page.getByText('Via your invite: Conference 2026', { exact: true })).toBeVisible();
    await navigateViaHarness(page, 'contacts');
    await page.getByLabel('Private invite', { exact: true }).selectOption('Conference 2026');
    await expect(page.getByRole('button', { name: /^Open / })).toHaveCount(1);

  } finally { await senderContext.close().catch(() => {}); }
});
