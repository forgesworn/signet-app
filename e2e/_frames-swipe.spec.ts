/**
 * NOT A TEST — throwaway frame capture for the carousel swipe jitter report.
 * Run: FRAMES=1 npx playwright test e2e/_frames-swipe.spec.ts --project=mobile-chromium --workers=1
 */
import { test, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { createIdentityAndUnlock, clearDatabase } from './fixtures';

test.skip(process.env.FRAMES !== '1', 'frame capture harness');
test.use({ baseURL: 'https://localhost:5174', ignoreHTTPSErrors: true });

const OUT = process.env.FRAMES_DIR ?? 'e2e/results/frames';

async function drag(page: Page, fromX: number, toX: number, y: number) {
  await page.mouse.move(fromX, y);
  await page.mouse.down();
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(fromX + ((toX - fromX) * i) / steps, y);
  }
  await page.mouse.up();
}

test('frames: card → qr → camera → settings', async ({ page }) => {
  test.setTimeout(180_000);
  await clearDatabase(page);
  await createIdentityAndUnlock(page, { name: 'Alex Rivera' });
  await page.waitForTimeout(800);
  await mkdir(OUT, { recursive: true });

  const cdp = await page.context().newCDPSession(page);
  let n = 0;
  const t0 = Date.now();
  const log: string[] = [];
  cdp.on('Page.screencastFrame', async (ev) => {
    const i = n++;
    const name = `${String(i).padStart(3, '0')}-${Date.now() - t0}ms.png`;
    log.push(name);
    await writeFile(`${OUT}/${name}`, Buffer.from(ev.data, 'base64'));
    await cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: 390, maxHeight: 844 });

  // card → qr (swipe left = next column)
  await drag(page, 300, 60, 400);
  await page.waitForTimeout(700);
  // qr → camera? columns: card, qr, settings, camera. Swipe right from card goes to camera.
  await drag(page, 300, 60, 400);
  await page.waitForTimeout(700);
  await drag(page, 300, 60, 400);
  await page.waitForTimeout(700);
  // back around to card, then card → camera via swipe right
  await drag(page, 300, 60, 400);
  await page.waitForTimeout(700);
  await drag(page, 60, 300, 400);
  await page.waitForTimeout(700);

  await cdp.send('Page.stopScreencast');
  await writeFile(`${OUT}/index.txt`, log.join('\n'));
});
