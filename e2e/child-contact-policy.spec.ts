import { test, expect } from '@playwright/test';
import jsQR from 'jsqr';
import { createIdentityAndUnlock, navigateViaHarness } from './fixtures';
import { privateRelays } from './helpers/private-relays';
test.use({ actionTimeout: 15000 });
test('delivers current contact policy to a genuinely paired child without identity keys', async ({ page, context, browser }) => {
  test.setTimeout(240000);
  const network = privateRelays(); await network.install(context);
  await createIdentityAndUnlock(page, { name: 'Guardian' });
  await page.evaluate(() => (window as any).__TEST__.setRelayUrl('wss://family-invite.test'));
  await navigateViaHarness(page, 'add-dependant');
  await page.getByRole('button', { name: 'Activate my real identity' }).click();
  await page.locator('#legal-name').fill('Guardian Person');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByPlaceholder('Guardian Person').fill('Guardian Person');
  await page.getByRole('button', { name: 'Activate my real identity' }).click();
  await page.getByRole('checkbox').click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByLabel(/Their name/i).fill('Robin');
  await page.getByRole('button', { name: 'Create identity', exact: true }).click();
  await expect(page.getByText(/Robin's identity is ready/)).toBeVisible({ timeout: 60000 });
  await page.getByRole('button', { name: /Done for now/ }).click();
  await navigateViaHarness(page, 'family-list');
  await page.getByRole('button', { name: /Robin/ }).click();
  await page.getByRole('button', { name: 'Approved contacts', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Approved contacts', exact: true })).toHaveClass(/btn-tile-selected/);

  const depId = await page.evaluate(async () => {
    const db = await import('/src/lib/db.ts');
    const records = await (await db.getDb()).getAll('identity');
    const dependant = records.find(record => record.guardianPubkey);
    return dependant.id.replace(/^dependant:/, '');
  });
  await page.evaluate(async id => await (window as any).__TEST__.setDependantStage(id, 'request-approve'), depId);
  await navigateViaHarness(page, 'pair-dependant-device');
  await page.getByRole('button', { name: 'Open Security settings' }).click();
  await page.getByRole('button', { name: 'Turn the Bunker on', exact: true }).click();
  await navigateViaHarness(page, 'pair-dependant-device');
  await expect(page.locator('canvas')).toBeVisible({ timeout: 30000 });
  let uri = '';
  await expect.poll(async () => {
    const pixels = await page.locator('canvas').evaluate((canvas: HTMLCanvasElement) => ({
      width: canvas.width, height: canvas.height, data: Array.from(canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data),
    }));
    uri = jsQR(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height)?.data ?? '';
    return uri.startsWith('bunker://');
  }).toBe(true);
  const second = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: new URL(page.url()).origin, viewport: { width: 390, height: 844 } });
  try {
    await network.install(second); const child = await second.newPage();
    await child.goto('/');
    await child.getByRole('button', { name: 'I already have a Signet' }).click();
    await child.getByRole('button', { name: 'I have a pairing code from my guardian' }).click();
    await child.getByRole('button', { name: 'Paste pairing code' }).click();
    await child.getByPlaceholder('bunker://...').fill(uri);
    await child.getByRole('button', { name: 'Continue', exact: true }).click();
    await child.getByRole('button', { name: "That's me", exact: true }).click();
    await child.getByRole('button', { name: 'Set up now' }).click();
    await child.getByRole('button', { name: /6-digit PIN/ }).click();
    for (const digit of '123456123456') await child.getByRole('button', { name: digit, exact: true }).click();
    await child.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect.poll(() => [...network.events.values()].some(event => event.tags.some(tag => tag[0] === 'd' && tag[1] === 'signet:child-contact-policy:v1')), { timeout: 30000 }).toBe(true);
    await navigateViaHarness(child, 'contacts');
    await expect(child.getByText('New contacts need your guardian’s approval.', { exact: true })).toBeVisible({ timeout: 30000 });
    await navigateViaHarness(page, 'family-list');
    await page.getByRole('button', { name: /Robin/ }).click();
    await page.getByRole('button', { name: 'Close circle only', exact: true }).click();
    await expect(child.getByText('Your guardian allows contacts in your close circle.', { exact: true })).toBeVisible({ timeout: 30000 });
    expect(await child.getByRole('button', { name: 'Invites and requests' }).count()).toBe(0);
  } finally { await second.close().catch(() => {}); }
});
