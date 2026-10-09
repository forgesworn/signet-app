import { test, expect } from '@playwright/test';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { createIdentityAndUnlock } from './fixtures';
import { RoutedRelay } from './helpers/routed-relay';

for (const viewport of [{ width: 1358, height: 636 }, { width: 390, height: 844 }]) {
  test(`nsec import actions remain reachable at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    test.setTimeout(120_000);
    const relay = new RoutedRelay(/^(?:wss:\/\/|ws:\/\/localhost:7777(?:\/|$))/);
    await relay.route(page);
    await createIdentityAndUnlock(page, { name: 'Import owner' });
    await page.setViewportSize(viewport);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: /^Personas / }).click();
    await page.getByRole('button', { name: 'Import an existing Nostr account' }).click();
    const dialog = page.getByRole('dialog', { name: 'Import an existing Nostr account' });
    const submit = dialog.getByRole('button', { name: 'Import', exact: true });
    // The desktop phone frame clips fixed descendants. A window-vh limit
    // allows this dialog's actions to fall outside that shorter frame.
    await expect(submit).toBeInViewport();
    await expect(submit).toBeDisabled();

    const secret = generateSecretKey();
    const npub = nip19.npubEncode(getPublicKey(secret));
    await dialog.getByPlaceholder('nsec1...').fill(nip19.nsecEncode(secret));
    await dialog.getByPlaceholder('What should we call this persona?').fill('Imported account');
    await dialog.getByRole('checkbox').check();
    await expect(submit).toBeInViewport();
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTitle(npub)).toBeVisible();

    await page.reload();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: /^Personas / }).click();
    await expect(page.getByTitle(npub)).toBeVisible();
    relay.close();
  });
}
