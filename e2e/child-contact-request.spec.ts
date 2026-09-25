import { test, expect } from '@playwright/test';
import jsQR from 'jsqr';
import { createIdentityAndUnlock, navigateViaHarness, unlockWithPin } from './fixtures';
import { privateRelays } from './helpers/private-relays';
import { androidAcceptance } from './helpers/android-acceptance';
test.use({ actionTimeout: 15000 });

/**
 * D6 (child submission) + D4 (history). Three real identities over one
 * mocked relay: a Friend who owns a reusable contact invite, a Guardian
 * managing a paired dependant (Robin), and Robin's own paired-child device.
 * The paired-child install never connects an invite directly — it asks the
 * guardian, who approves or denies from the same "Requests from paired
 * children" card D1–D5 already ship.
 */
test('child asks to connect; the guardian approves one and denies another', async ({ page, context, browser }) => {
  test.setTimeout(360000);
  const network = privateRelays();
  await network.install(context);

  // --- Guardian: activates real identity, adds Robin, opens contact policy, pairs a child device. ---
  await createIdentityAndUnlock(page, { name: 'Guardian' });
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
    const dependant = records.find((record: any) => record.guardianPubkey);
    return dependant.id.replace(/^dependant:/, '');
  });
  await page.evaluate(async id => await (window as any).__TEST__.setDependantStage(id, 'request-approve'), depId);
  await navigateViaHarness(page, 'family-list');
  await page.getByRole('button', { name: /Robin/ }).click();
  // Open — anyone may ask; the request still waits for a guardian decision.
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open', exact: true })).toHaveClass(/btn-tile-selected/);

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

  // --- Friend: owns the invite Robin wants to use. ---
  const friendContext = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: new URL(page.url()).origin, viewport: { width: 390, height: 844 } });
  await network.install(friendContext);
  const friend = await friendContext.newPage();
  await createIdentityAndUnlock(friend, { name: 'Friend' });
  // Invite creation requires a wss:// relay (the dev default is ws://, filtered
  // out) — the mock intercepts any hostname, so any wss:// string works.
  await friend.evaluate(() => (window as any).__TEST__.setRelayUrl('wss://friend-invite.test'));
  await friend.keyboard.press('ArrowRight');
  await friend.getByRole('button', { name: 'Create reusable contact invite', exact: true }).click();
  await expect(friend.getByRole('option', { name: 'My contact card', exact: true })).toHaveCount(1);
  await friend.getByRole('button', { name: 'Manage invites', exact: true }).click();
  await expect(friend.getByText('My contact card', { exact: true })).toBeVisible();
  await friend.evaluate(() => { Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true,
    value: async (text: string) => { (window as any).__copiedInvite = text; } }); });
  await friend.getByRole('button', { name: 'Copy invite link' }).click();
  const link = await friend.evaluate(() => (window as any).__copiedInvite as string);
  const invite = await friend.evaluate(async (rawLink: string) => {
    const { parseContactInviteLink } = await import('/src/lib/contact-invite-link.ts');
    return parseContactInviteLink(rawLink);
  }, link);
  expect(invite).toBeTruthy();

  const android = process.env.SIGNET_ANDROID_DEVICE ? await androidAcceptance(process.env.SIGNET_ANDROID_DEVICE) : undefined;
  const childContext = android?.context ?? await browser.newContext({ ignoreHTTPSErrors: true, baseURL: new URL(page.url()).origin, viewport: { width: 390, height: 844 } });
  try {
    await network.install(childContext);
    const child = android?.page ?? await childContext.newPage();
    child.on('pageerror', error => console.error('Child page error:', error.message));
    const unlockChild = async () => {
      await unlockWithPin(child, '123456');
      await expect(child.getByRole('button', { name: '1', exact: true })).toHaveCount(0, { timeout: 30000 });
    };
    const navigateChild = async (destination: 'contacts') => {
      if (!android) {
        await child.waitForFunction(() => !!(window as any).__TEST__?.setPage);
        await navigateViaHarness(child, destination);
      } else {
        await expect(child.getByRole('button', { name: 'Contacts', exact: true })
          .or(child.getByRole('button', { name: '1', exact: true })).first()).toBeVisible({ timeout: 30000 });
        if (await child.getByRole('button', { name: '1', exact: true }).isVisible()) await unlockChild();
        await child.getByRole('button', { name: 'Contacts', exact: true }).click();
      }
      const unlock = child.getByRole('button', { name: 'Unlock contacts', exact: true });
      if (await unlock.isVisible().catch(() => false) && !await child.getByRole('button', { name: '1', exact: true }).isVisible().catch(() => false)) await unlock.click();
      if (await child.getByRole('button', { name: '1', exact: true }).isVisible().catch(() => false)) await unlockChild();
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

    const ask = async () => {
      await navigateChild('contacts');
      await child.evaluate(inv => (window as any).__TEST__.setPendingContactInvite(JSON.stringify(inv)), invite);
      const askButton = child.getByRole('button', { name: /^Ask .* to connect$/ });
      await expect(askButton).toBeVisible({ timeout: 15000 });
      await askButton.click();
      await expect(child.getByText('Request sent', { exact: true })).toBeVisible({ timeout: 30000 });
      await child.getByRole('button', { name: 'Done', exact: true }).click();
    };

    // --- Scenario 1: child asks, guardian approves, the friend accepts, child sees "Added". ---
    await ask();
    await navigateViaHarness(page, 'contacts');
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: 'Approve', exact: true }).click();

    await expect(friend.getByText('Unopened contact request', { exact: true })).toBeVisible({ timeout: 30000 });
    await friend.getByRole('button', { name: 'Open request list' }).click();
    await friend.getByRole('button', { name: 'Accept request' }).click();

    await navigateChild('contacts');
    const requests = child.getByRole('region', { name: 'Your contact requests' });
    await expect.poll(async () => requests.getByText(/— Added$/).count(), { timeout: 60000 }).toBe(1);
    await expect(requests.getByText(/— Declined$/)).toHaveCount(0);

    // --- Scenario 2: a second ask, denied — the first result is untouched. ---
    await ask();
    await navigateViaHarness(page, 'contacts');
    await expect(page.getByRole('button', { name: 'Deny', exact: true })).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: 'Deny', exact: true }).click();

    await navigateChild('contacts');
    await expect.poll(async () => requests.getByText(/— Declined$/).count(), { timeout: 30000 }).toBe(1);
    await expect(requests.getByText(/— Added$/)).toHaveCount(1);
  } catch (error) {
    console.log('Child acceptance failed:', String(error));
    const child = childContext.pages()[0];
    if (child) {
      console.log('Child controls at failure:', await child.locator('h1,h2,button,[role=alert]').allTextContents());
      try { await test.info().attach('child-failure', { body: await child.screenshot({ timeout: 5000 }), contentType: 'image/png' }); } catch { /* Preserve the original failure on native screenshot timeouts. */ }
    }
    throw error;
  } finally {
    if (android) await android.close(); else await childContext.close().catch(() => {});
    await friendContext.close().catch(() => {});
  }
});
