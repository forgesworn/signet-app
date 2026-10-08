import { test, expect, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { createIdentityAndUnlock } from './fixtures';
import { privateRelays } from './helpers/private-relays';
import QRCode from 'qrcode';
import jsQR from 'jsqr';

async function camera(context: Parameters<ReturnType<typeof privateRelays>['install']>[0]) {
  await context.addInitScript(() => {
    const sockets = new Set<WebSocket>();
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        sockets.add(this);
        this.addEventListener('close', () => sockets.delete(this));
      }
    };
    (window as any).__closeHandshakeRelay = () => {
      let closed = 0;
      for (const socket of sockets) if (socket.url.includes('handshake.test') && socket.readyState === WebSocket.OPEN) {
        socket.close(); closed++;
      }
      return closed;
    };
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
async function readAllQRs(page: Page) {
  const first = await readQR(page);
  const payload = jsQR(new Uint8ClampedArray(first.pixels), first.width, first.height)?.data;
  expect(payload).toBeTruthy();
  const count = payload!.startsWith('SGF1:') ? Number(/^:\d+:(\d+):/.exec(payload!.slice(53))![1]) : 1;
  // Capture inside the browser so synchronous Node decoding cannot skip a
  // 500 ms frame when both phones are sampled concurrently. Decode the actual
  // rendered pixels after collection; no React internals or regenerated codes.
  const images = await page.locator('.handshake-screen > canvas').evaluate(async (canvas: HTMLCanvasElement, count) => {
    const images = new Map<string, { width: number; height: number; pixels: number[] }>();
    const started = performance.now();
    while (images.size < count) {
      const key = canvas.toDataURL();
      if (!images.has(key)) images.set(key, { width: canvas.width, height: canvas.height,
        pixels: Array.from(canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data) });
      if (performance.now() - started > 5000) throw new Error(`QR carousel presented ${images.size}/${count} raster frames`);
      if (images.size < count) await new Promise(resolve => setTimeout(resolve, 50));
    }
    return [...images.values()];
  }, count);
  const decoded = images.map(qr => jsQR(new Uint8ClampedArray(qr.pixels), qr.width, qr.height)?.data);
  expect(decoded.every(Boolean)).toBe(true);
  expect(new Set(decoded).size).toBe(count);
  return images;
}
async function showFrames(page: Page, qrs: Awaited<ReturnType<typeof readAllQRs>>, second = false) {
  const extra = QRCode.create('UNRELATED', { errorCorrectionLevel: 'M' });
  await page.evaluate(({ qrs, extra }) => {
    const frame = (window as any).__cameraFrame as HTMLCanvasElement;
    const ctx = frame.getContext('2d')!;
    clearInterval((window as any).__cameraPlayback);
    const draw = (qr: typeof qrs[number]) => {
    ctx.fillStyle = '#ddd'; ctx.fillRect(0, 0, frame.width, frame.height);
    ctx.putImageData(new ImageData(new Uint8ClampedArray(qr.pixels), qr.width, qr.height), (frame.width - qr.width) / 2, (frame.height - qr.height) / 2);
    if (extra) {
      // A second code in the strip outside the displayed central square.
      ctx.fillStyle = '#fff'; ctx.fillRect(2, 2, (extra.size + 8) * 2, (extra.size + 8) * 2);
      ctx.fillStyle = '#000';
      for (let y = 0; y < extra.size; y++) for (let x = 0; x < extra.size; x++)
        if (extra.data[y * extra.size + x]) ctx.fillRect(10 + x * 2, 10 + y * 2, 2, 2);
    }
    };
    let index = 0; draw(qrs[index]);
    if (qrs.length > 1) (window as any).__cameraPlayback = setInterval(() => { index = (index + 1) % qrs.length; draw(qrs[index]); }, 500);
  }, { qrs, extra: second ? { size: extra.modules.size, data: Array.from(extra.modules.data) } : null });
}
test('two real QR camera reads recover closed relays, auto-seal one signed exchange and preserve Ken', async ({ page, context, browser }) => {
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
    const [qrA, qrB] = await Promise.all([readAllQRs(page), readAllQRs(other)]);
    expect(qrA.length).toBeGreaterThan(1); expect(qrB.length).toBeGreaterThan(1);
    await showFrames(page, qrB, true);
    await page.waitForTimeout(qrB.length * 500 + 500);
    await expect(page.locator('.handshake-status')).toHaveText('Reading');
    // The mailbox list stays unchanged when a connection dies. Recovery must
    // restore the live subscriptions without another tap or a polling cycle.
    for (const phone of [page, other]) {
      expect(await phone.evaluate(() => (window as any).__closeHandshakeRelay())).toBeGreaterThan(0);
    }
    await showFrames(page, qrB); await showFrames(other, qrA);
    for (const phone of [page, other]) {
      await expect(phone.getByText('Sealed', { exact: true })).toBeVisible({ timeout: 60000 });
      await expect(phone.getByRole('img', { name: 'Handshake sigil' })).toBeVisible();
      await expect(phone.getByText('You say:', { exact: false })).toHaveCount(0);
    }
    const paths = await Promise.all([page, other].map(phone => phone.locator('.jigsaw-sigil path').evaluateAll(elements => elements.map(e => e.getAttribute('d')))));
    expect(paths[0]).toEqual(paths[1]);
    await other.getByRole('button', { name: 'Open contact', exact: true }).click();
    await expect(other.getByText('Ken', { exact: true }).first()).toBeVisible();
    await expect(other.locator('.handshake-status')).toContainText('Met in person');
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
