import { expect, test } from '@playwright/test';
import { createIdentityAndUnlock } from './fixtures';

test('relay settings show successful reads, refused reads and failed connections', async ({ page }) => {
  test.setTimeout(120_000);
  await page.routeWebSocket(/^(?:wss:\/\/|ws:\/\/localhost:7777(?:\/|$))/, socket => {
    if (socket.url().includes('nos.lol')) { socket.close({ code: 1008, reason: 'Test unavailable' }); return; }
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
});
