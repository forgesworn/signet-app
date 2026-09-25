import { test, expect } from '@playwright/test';
import jsQR from 'jsqr';
import { nip19 } from 'nostr-tools';
import { createIdentityAndUnlock, navigateViaHarness, unlockWithPin } from './fixtures';
import { privateRelays } from './helpers/private-relays';
import { androidAcceptance } from './helpers/android-acceptance';
test.use({ actionTimeout: 15000 });
test('delivers a scoped read-only directory to a paired child, withdraws blocked contacts and preserves local records', async ({ page, context, browser }) => {
  test.setTimeout(360000);
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
  const depId = await page.evaluate(async () => {
    const db = await import('/src/lib/db.ts');
    const records = await (await db.getDb()).getAll('identity');
    const dependant = records.find(record => record.guardianPubkey);
    return dependant.id.replace(/^dependant:/, '');
  });
  await page.evaluate(async id => await (window as any).__TEST__.setDependantStage(id, 'request-approve'), depId);
  await navigateViaHarness(page, 'family-list');
  await page.getByRole('button', { name: /Robin/ }).click();
  await page.getByRole('button', { name: 'Approved contacts', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Approved contacts', exact: true })).toHaveClass(/btn-tile-selected/);

  await navigateViaHarness(page, 'ken-add');
  await page.getByRole('button', { name: 'Paste an npub' }).click();
  await page.getByPlaceholder('npub1…').fill(nip19.npubEncode('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'));
  await page.getByPlaceholder('Display name (optional)').fill('Shared Friend');
  await page.getByRole('button', { name: 'Pin key' }).click();
  await expect(page.getByRole('heading', { name: 'Shared Friend added' })).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: 'Done', exact: true }).click();

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
  const android = process.env.SIGNET_ANDROID_DEVICE ? await androidAcceptance(process.env.SIGNET_ANDROID_DEVICE) : undefined;
  const second = android?.context ?? await browser.newContext({ ignoreHTTPSErrors: true, baseURL: new URL(page.url()).origin, viewport: { width: 390, height: 844 } });
  try {
    await network.install(second); const child = android?.page ?? await second.newPage();
    child.on('pageerror', error => console.error('Child page error:', error.message));
    const unlockChild = async () => {
      await unlockWithPin(child, '123456');
      await expect(child.getByRole('button', { name: '1', exact: true })).toHaveCount(0, { timeout: 30000 });
    };
    const navigateChild = async (destination: 'contacts' | 'contact-new') => {
      if (!android) {
        await child.waitForFunction(() => !!(window as any).__TEST__?.setPage);
        await navigateViaHarness(child, 'contacts');
      }
      else {
        await expect(child.getByRole('button', { name: 'Contacts', exact: true })
          .or(child.getByRole('button', { name: '1', exact: true })).first()).toBeVisible({ timeout: 30000 });
        if (await child.getByRole('button', { name: '1', exact: true }).isVisible()) await unlockChild();
        await child.getByRole('button', { name: 'Contacts', exact: true }).click();
      }
      const unlock = child.getByRole('button', { name: 'Unlock contacts', exact: true });
      if (await unlock.isVisible() && !await child.getByRole('button', { name: '1', exact: true }).isVisible()) await unlock.click();
      await expect(child.getByRole('heading', { name: 'Contacts from your guardian', exact: true })
        .or(child.getByRole('button', { name: '1', exact: true })).first()).toBeVisible({ timeout: 30000 });
      if (await child.getByRole('button', { name: '1', exact: true }).isVisible()) await unlockChild();
      if (destination === 'contact-new') await child.getByRole('button', { name: 'New contact', exact: true }).first().click();
    };
    await child.goto(android ? 'https://localhost/' : '/');
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
    await navigateChild('contacts');
    await expect(child.getByText('New contacts need your guardian’s approval.', { exact: true })).toBeVisible({ timeout: 30000 });
    await expect.poll(() => [...network.events.values()].filter(event => event.tags.some(tag => tag[1] === 'signet:child-contact-directory:v1')).length, { timeout: 30000 }).toBeGreaterThan(0);
    const directory = child.getByRole('region', { name: 'Contacts from your guardian' });
    await expect(directory.getByText('Shared Friend', { exact: true })).toBeVisible({ timeout: 30000 });
    expect(await directory.getByRole('button').count()).toBe(0);
    await navigateChild('contact-new');
    await child.getByLabel('Name', { exact: true }).fill('Child Local Friend');
    await child.getByRole('button', { name: 'Save contact', exact: true }).click();
    await navigateChild('contacts');
    await expect(child.getByText('Child Local Friend', { exact: true })).toBeVisible();
    await child.reload();
    await navigateChild('contacts');
    await expect(directory.getByText('Shared Friend', { exact: true })).toBeVisible({ timeout: 30000 });
    await expect(child.getByText('Child Local Friend', { exact: true })).toBeVisible();
    if (android) await child.reload();
    else await child.evaluate(() => (window as any).__TEST__.lock());
    await expect(child.getByText('Shared Friend', { exact: true })).toHaveCount(0);
    if (!android) await unlockChild();
    await navigateChild('contacts');
    await expect(directory.getByText('Shared Friend', { exact: true })).toBeVisible({ timeout: 30000 });
    await navigateViaHarness(page, 'contacts');
    await page.getByRole('button', { name: 'Open Shared Friend' }).click();
    await page.getByRole('button', { name: 'Block', exact: true }).click();
    await page.getByRole('button', { name: 'Block Shared Friend', exact: true }).click();
    await expect(directory.getByText('Shared Friend', { exact: true })).toHaveCount(0, { timeout: 30000 });
    await expect(child.getByText('Child Local Friend', { exact: true })).toBeVisible();
    expect(await child.getByRole('button', { name: 'Invites and requests' }).count()).toBe(0);
  } catch (error) {
    console.log('Child acceptance failed:', String(error));
    const child = android?.page ?? second.pages()[0];
    if (child) {
      console.log('Child controls at failure:', await child.locator('h1,h2,button,[role=alert]').allTextContents());
      try { await test.info().attach('child-failure', { body: await child.screenshot({ timeout: 5000 }), contentType: 'image/png' }); } catch { /* Preserve the original failure on native screenshot timeouts. */ }
    }
    throw error;
  } finally { if (android) await android.close(); else await second.close().catch(() => {}); }
});
