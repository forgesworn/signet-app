import { test, expect, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { createIdentityAndUnlock } from './fixtures';
import { privateRelays } from './helpers/private-relays';

async function camera(context: Parameters<ReturnType<typeof privateRelays>['install']>[0]) {
  await context.addInitScript(() => {
    (window as any).__handshakeErrors = [];
    window.addEventListener('signet-handshake-error', event => (window as any).__handshakeErrors.push((event as CustomEvent).detail));
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
      (window as any).__cameraFrame = canvas;
      return canvas.captureStream(10);
    } });
  });
}
async function readQR(page: Page) {
  return page.locator('.handshake-screen > canvas').evaluate((canvas: HTMLCanvasElement) => ({
    width: canvas.width, height: canvas.height,
    pixels: Array.from(canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data),
  }));
}
async function showFrame(page: Page, qr: Awaited<ReturnType<typeof readQR>>) {
  await page.evaluate(qr => {
    const frame = (window as any).__cameraFrame as HTMLCanvasElement;
    const ctx = frame.getContext('2d')!;
    ctx.fillStyle = '#ddd'; ctx.fillRect(0, 0, frame.width, frame.height);
    ctx.putImageData(new ImageData(new Uint8ClampedArray(qr.pixels), qr.width, qr.height), (frame.width - qr.width) / 2, (frame.height - qr.height) / 2);
  }, qr);
}
test('two real QR camera reads auto-seal one signed exchange, preserve Ken and keep identity text off screen', async ({ page, context, browser }) => {
  test.setTimeout(180000);
  const relays = privateRelays(); await relays.install(context); await camera(context);
  const otherContext = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: new URL(test.info().project.use.baseURL!).origin, viewport: { width: 390, height: 844 } });
  try {
    await relays.install(otherContext); await camera(otherContext);
    const other = await otherContext.newPage();
    await createIdentityAndUnlock(page, { name: 'First private persona' });
    await createIdentityAndUnlock(other, { name: 'Second private persona' });
    for (const phone of [page, other]) {
      await phone.evaluate(() => (window as any).__TEST__.setRelayUrl('wss://handshake.test'));
      await phone.getByRole('button', { name: 'Handshake', exact: true }).click();
      await expect(phone.locator('.handshake-screen > canvas')).toBeVisible();
      await expect(phone.locator('.handshake-camera video')).toBeVisible();
    }
    await expect(page.getByText('First private persona', { exact: true })).toHaveCount(0);
    await expect(other.getByText('Second private persona', { exact: true })).toHaveCount(0);
    const [qrA, qrB] = await Promise.all([readQR(page), readQR(other)]);
    await showFrame(page, qrB); await showFrame(other, qrA);
    for (const phone of [page, other]) {
      await expect(phone.getByText('Sealed', { exact: true })).toBeVisible({ timeout: 60000 });
      await expect(phone.getByRole('img', { name: 'Handshake sigil' })).toBeVisible();
      await expect(phone.getByText('You say:', { exact: false })).toHaveCount(0);
    }
    const paths = await Promise.all([page, other].map(phone => phone.locator('.jigsaw-sigil path').evaluateAll(elements => elements.map(e => e.getAttribute('d')))));
    expect(paths[0]).toEqual(paths[1]);
    await page.screenshot({ path: 'e2e/results/handshake-sealed.png' });
    await page.getByRole('button', { name: 'Go back' }).click();
    await page.evaluate(() => (window as any).__TEST__.setPage('contacts'));
    await expect(page.getByRole('button', { name: /^Open Second private persona/ })).toBeVisible();
    await page.getByRole('button', { name: /^Open Second private persona/ }).click();
    await expect(page.getByText('Ken', { exact: true }).first()).toBeVisible();
    await expect(page.locator('.handshake-status')).toContainText('Met in person');
    await expect(page.getByText(/^Confirmed in person/)).toBeVisible();
    expect((await page.evaluate(() => (window as any).__TEST__.getContactInviteProgress())).exchanges[0].handshake.strength).toBe('mutual');
  } catch (error) {
    const diagnostics = await Promise.all([page, ...otherContext.pages()].map(async phone => ({
      status: await phone.locator('.handshake-status').textContent().catch(() => ''),
      errors: await phone.evaluate(() => (window as any).__handshakeErrors),
      state: await phone.evaluate(() => (window as any).__TEST__.getContactInviteProgress()),
    })));
    const diagnosticPath = test.info().outputPath('handshake-diagnostics.json');
    await writeFile(diagnosticPath, JSON.stringify({ phones: diagnostics, relayed: [...relays.events.values()].map(e => ({ id: e.id, kind: e.kind, tags: e.tags })) }));
    await test.info().attach('handshake-diagnostics', { path: diagnosticPath, contentType: 'application/json' });
    throw error;
  } finally { await otherContext.close(); }
});
