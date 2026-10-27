import { expect, test } from '@playwright/test';
import { createIdentityAndUnlock, unlockWithPin } from './fixtures';

test('relay settings show successful reads, refused reads and failed connections', async ({ page }) => {
  test.setTimeout(120_000);
  await page.routeWebSocket(/^(?:wss:\/\/|ws:\/\/localhost:7777(?:\/|$))/, socket => {
    if (socket.url().includes('relay.ditto.pub')) { socket.close({ code: 1008, reason: 'Test unavailable' }); return; }
    socket.onMessage(raw => {
      const frame = JSON.parse(String(raw));
      if (frame[0] !== 'REQ') return;
      socket.send(JSON.stringify(socket.url().includes('damus')
        ? ['CLOSED', frame[1], 'auth-required: sign in to read']
        : ['EOSE', frame[1]]));
    });
  });
  await createIdentityAndUnlock(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Enable Power Mode' }).click();
  await page.getByRole('button', { name: /^Advanced / }).click();
  const relays = page.locator('.card.section').filter({ has: page.getByText('Relays', { exact: true }) });
  await expect(relays.getByText(/Connection and read check passed/).first()).toBeVisible();
  await expect(relays.getByText(/Unavailable/)).toBeVisible();
  await expect(relays.getByText('auth-required: sign in to read', { exact: true })).toBeVisible();
  await expect(relays.getByText(/A sign-in started by another app replies on the relay that app requested/)).toBeVisible();
  await relays.getByRole('button', { name: 'Check relays' }).click();
  await expect(relays.getByText(/Connection and read check passed/).first()).toBeVisible();
  await expect(relays.getByText('App connection: Connected', { exact: true }).first()).toBeVisible();
  const first = relays.getByRole('group', { name: /^Relay / }).first();
  const second = relays.getByRole('group', { name: /^Relay / }).nth(1);
  const original = await first.getAttribute('aria-label');
  const promoted = await second.getAttribute('aria-label');
  await second.getByRole('button', { name: / up$/ }).click();
  await expect(first).toHaveAttribute('aria-label', promoted!);
  await expect(first.getByRole('button', { name: / up$/ })).toBeDisabled();
  await expect(first.getByText('PREFERRED PRIMARY')).toBeVisible();
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    expect(await relays.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await page.reload();
  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  const pin = page.getByRole('button', { name: '1', exact: true });
  // An immediate reload can legitimately restore the recent unlock grace.
  await expect(settings.or(pin)).toBeVisible({ timeout: 20_000 });
  if (await pin.isVisible()) await unlockWithPin(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Enable Power Mode' }).click();
  await page.getByRole('button', { name: /^Advanced / }).click();
  await expect(relays.getByRole('group', { name: /^Relay / }).first()).toHaveAttribute('aria-label', promoted!);
  await expect(relays.getByRole('group', { name: /^Relay / }).nth(1)).toHaveAttribute('aria-label', original!);
});
