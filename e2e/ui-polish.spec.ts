import { test, expect } from '@playwright/test';
import { createIdentityAndUnlock, restoreIdentityAndUnlock, navigateViaHarness } from './fixtures';
import { privateRelays } from './helpers/private-relays';

test.use({ isMobile: true, hasTouch: true });

for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 768, height: 1024 }]) {
  test(`persona card fits and vertical touch changes identities at ${viewport.width}px`, async ({ page, context }) => {
    await page.setViewportSize(viewport);
    await privateRelays().install(context);
    await restoreIdentityAndUnlock(page, { name: 'Polish Test', keypair: 'natural-person' });
    const wallet = page.locator('.carousel-viewport');
    const body = page.locator('.carousel-screen:not([data-testid]) .card-inner');
    const cdp = await context.newCDPSession(page);
    const checkFit = async () => {
      const geometry = await body.evaluate(el => {
        const bounds = el.getBoundingClientRect();
        return {
          height: el.clientHeight, content: el.scrollHeight,
          controlsFit: [...el.children].every(child => child.getBoundingClientRect().bottom <= bounds.bottom - parseFloat(getComputedStyle(el).paddingBottom) + 1),
        };
      });
      expect(geometry.content).toBeLessThanOrEqual(geometry.height + 1);
      expect(geometry.controlsFit).toBe(true);
      await expect(body.getByRole('button', { name: 'Scan a QR code' })).toBeVisible();
      await expect(body.getByRole('button', { name: 'Show my QR code' })).toBeVisible();
    };
    const swipe = async (dy: number) => {
      const avatar = await body.locator('.card-photo').boundingBox();
      const x = avatar!.x + avatar!.width / 2;
      const y = avatar!.y + avatar!.height / 2;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let step = 1; step <= 8; step++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + dy * step / 8 }] });
        await page.waitForTimeout(16);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    await expect(body.locator('.card-type')).toHaveText('Persona');
    await checkFit();
    await swipe(-90);
    await expect(wallet).toHaveAttribute('data-carousel-cell', '1:0');
    await expect(body.locator('.card-type')).toHaveText('Natural Person');
    await checkFit();
    await swipe(90);
    await expect(wallet).toHaveAttribute('data-carousel-cell', '0:0');
    await expect(body.locator('.card-type')).toHaveText('Persona');
    await checkFit();
  });
}

for (const viewport of [{ width: 320, height: 568 }, { width: 768, height: 1024 }]) {
  test.describe(`${viewport.width}px portrait layout`, () => {
    test.use({ viewport });
    test.beforeEach(async ({ page, context }) => {
      await privateRelays().install(context);
      await createIdentityAndUnlock(page, { name: 'Polish Test' });
    });

    test('every wallet card has the same frame and retains its prepared DOM after sliding', async ({ page }) => {
      const wallet = page.locator('.carousel-viewport');
      const current = page.locator('.carousel-screen:not([data-testid])');
      const first = await current.locator('.id-card').boundingBox();
      expect(first).toBeTruthy();
      for (let col = 1; col < 5; col++) {
        await page.keyboard.press('ArrowRight');
        // Capture the incoming node before the animation promotes it.
        await page.evaluate(() => {
          (window as any).preparedScreen = document.querySelector('[data-testid="carousel-incoming-screen"]');
        });
        await expect(wallet).toHaveAttribute('data-carousel-cell', `0:${col}`);
        await expect(page.getByTestId('carousel-incoming-screen')).toHaveCount(0);
        expect(await current.evaluate(el => el === (window as any).preparedScreen)).toBe(true);
        const frame = await current.locator(':is(.qr-view,.contacts-card,.settings-view,.camera-view):visible').boundingBox();
        expect(frame).toBeTruthy();
        expect(Math.abs(frame!.width - first!.width)).toBeLessThanOrEqual(1);
        expect(Math.abs(frame!.height - first!.height)).toBeLessThanOrEqual(1);
      }
    });

    test('landscape fallback keeps the form mounted and restores it in portrait', async ({ page }) => {
      await navigateViaHarness(page, 'contact-new');
      const input = page.locator('#new-contact-name');
      await input.fill('Keep this draft');
      await page.evaluate(() => {
        (window as any).draftInput = document.querySelector('#new-contact-name');
        Object.defineProperty(screen.orientation, 'type', { configurable: true, value: 'landscape-primary' });
      });
      await page.setViewportSize({ width: viewport.height, height: viewport.width });
      await expect(page.getByRole('dialog', { name: 'Turn your device upright' })).toBeVisible();
      await expect(input).toHaveValue('Keep this draft');
      expect(await input.evaluate(el => el === (window as any).draftInput)).toBe(true);
      await page.evaluate(() => Object.defineProperty(screen.orientation, 'type', { configurable: true, value: 'portrait-primary' }));
      await page.setViewportSize(viewport);
      await expect(page.getByRole('dialog', { name: 'Turn your device upright' })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'New contact' })).toBeVisible();
      await expect(input).toHaveValue('Keep this draft');
    });
  });
}

test('reduced motion changes cards without a slide', async ({ page, context }) => {
  await privateRelays().install(context);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await createIdentityAndUnlock(page);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.carousel-viewport')).toHaveAttribute('data-carousel-cell', '0:1');
  await expect(page.getByTestId('carousel-incoming-screen')).toHaveCount(0);
});

for (const viewport of [{ width: 320, height: 568 }, { width: 411, height: 840 }, { width: 768, height: 1024 }]) {
  test(`family signer message and footer fit inside the card at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    // Mount the real child card with its additional signer notice. The usual
    // onboarding fixture creates an owner, which does not have this content.
    await page.evaluate(async () => {
      const { createElement } = (await import('/node_modules/.vite/deps/react.js')).default;
      const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
      const { IdentityCard } = await import('/src/components/IdentityCard.tsx');
      const host = document.createElement('div');
      host.className = 'carousel-viewport';
      host.dataset.theme = 'dark';
      host.style.zIndex = '10000';
      document.body.appendChild(host);
      const key = 'b'.repeat(64);
      createRoot(host).render(createElement('div', { className: 'carousel-screen' }, createElement(IdentityCard, {
        row: { type: 'persona', identity: {} },
        resolved: { displayName: 'Family Persona', displayNameIsSet: true, publicKey: key, type: 'Persona', isDependant: false },
        badge: null, childMode: false, childDormant: true, childSignerKind: 'heartwood', onHandshake: () => {},
      })));
    });
    const card = page.locator('.id-card');
    await expect(card.getByText('Your family Heartwood signs for you.')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Handshake' })).toBeVisible();
    await expect(card.getByText('Ask your guardian', { exact: true })).toBeVisible();
    const fit = await card.evaluate(el => {
      const body = el.querySelector('.card-inner')!;
      const bounds = body.getBoundingClientRect();
      const contentBottom = bounds.bottom - parseFloat(getComputedStyle(body).paddingBottom);
      const footer = el.querySelector('.card-footer')!.getBoundingClientRect();
      return {
        fits: [...body.children].every(child => child.getBoundingClientRect().bottom <= contentBottom + 1),
        clearance: el.getBoundingClientRect().bottom - footer.bottom,
        overflow: [...body.children].filter(child => child.getBoundingClientRect().bottom > contentBottom + 1).map(child => ({ class: child.className, extra: child.getBoundingClientRect().bottom - contentBottom })),
      };
    });
    expect(fit.fits, JSON.stringify(fit)).toBe(true);
    expect(fit.clearance).toBeGreaterThanOrEqual(9);
  });
}
