import { test, expect, type Page } from '@playwright/test';
import { generateSecretKey, getPublicKey, verifyEvent, type Event } from 'nostr-tools/pure';
import * as nip44 from 'nostr-tools/nip44';
import { createIdentityAndUnlock, unlockWithPin, navigateViaHarness } from './fixtures';
import { privateRelays } from './helpers/private-relays';
test.use({ actionTimeout: 15000 });

/**
 * `?action=app-permission` for an ADULT, end to end against a fake app. The
 * app opens the link on the phone, My Signet asks, and the answer comes back
 * as a stored gift wrap on the app's own relay. The fake app opens that wrap
 * the way a real one must: wrap -> seal (author = the persona) -> rumor
 * (kind 29999), and checks the signed event is exactly the template it sent.
 */
const RELAY = 'wss://app-permission.test';
const ORIGIN = 'https://twang.example';

function appRequest(persona: string) {
  const sessionSk = generateSecretKey();
  const sessionPubkey = getPublicKey(sessionSk);
  const installKey = getPublicKey(generateSecretKey());
  const now = Math.floor(Date.now() / 1000);
  const template = {
    kind: 30420, pubkey: persona, content: '',
    tags: [
      ['d', 'twang-thang'], ['p', installKey], ['valid_from', String(now)], ['valid_until', String(now + 90 * 86400)],
      ['v', '1'], ['role', 'player'], ['expiration', String(now + 90 * 86400)],
    ],
  };
  const challenge = Buffer.from(generateSecretKey()).toString('hex');
  const query = new URLSearchParams({
    action: 'app-permission', permission: 'online-play', origin: ORIGIN, name: 'Twang Thang',
    reason: 'Twang Thang shows the other players in a game that it is really you.',
    template: Buffer.from(JSON.stringify(template), 'utf8').toString('base64url'),
    relay: RELAY, sessionPubkey, challenge, t: String(now), callback: `${ORIGIN}/back`,
  });
  return { sessionSk, sessionPubkey, template, challenge, url: `/?${query}` };
}

/** What the app does with a wrap addressed to its session key. */
function openAnswer(wrap: Event, sessionSk: Uint8Array) {
  const seal = JSON.parse(nip44.decrypt(wrap.content, nip44.getConversationKey(sessionSk, wrap.pubkey))) as Event;
  const rumor = JSON.parse(nip44.decrypt(seal.content, nip44.getConversationKey(sessionSk, seal.pubkey))) as Event;
  return { wrap, seal, rumor, content: JSON.parse(rumor.content) as Record<string, unknown> };
}

async function waitForAnswer(network: ReturnType<typeof privateRelays>, sessionPubkey: string, sessionSk: Uint8Array) {
  let found: Event | undefined;
  await expect.poll(() => {
    found = [...network.events.values()].find(e => e.kind === 1059 && e.tags.some(t => t[0] === 'p' && t[1] === sessionPubkey)) as Event | undefined;
    return !!found;
  }, { timeout: 30000 }).toBe(true);
  return openAnswer(found!, sessionSk);
}

/** Create an identity, then follow the app's link on a locked app, as a real launch would. */
async function openLinkOnLockedApp(page: Page, network: ReturnType<typeof privateRelays>) {
  await createIdentityAndUnlock(page, { name: 'Sky' });
  const persona = await page.evaluate(() => (window as any).__TEST__.getActivePubkey() as string);
  const request = appRequest(persona);
  await page.goto(request.url);
  await unlockWithPin(page);
  await expect(page.getByTestId('app-permission-reason')).toBeVisible({ timeout: 60000 });
  return { persona, ...request, network };
}

test('adult allows: the app gets its exact template signed by the persona, sealed by the persona', async ({ page, context }) => {
  test.setTimeout(240000);
  const network = privateRelays();
  await network.install(context);
  const r = await openLinkOnLockedApp(page, network);

  // The page is My Signet's wording around the app's own name and reason.
  await expect(page.getByRole('heading', { name: /Twang Thang asks to show other players it is Sky/ })).toBeVisible();
  await expect(page.getByText('The app says:')).toBeVisible();
  await expect(page.getByTestId('app-permission-reason')).toHaveText('Twang Thang shows the other players in a game that it is really you.');
  await expect(page.getByTestId('app-permission-allows')).toContainText('It cannot post, message anyone or act as Sky anywhere else');
  await expect(page.getByText('From twang.example')).toBeVisible();
  // The link is gone from the address bar: a refresh must not ask again.
  expect(new URL(page.url()).search).toBe('');

  await page.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Permission given' })).toBeVisible({ timeout: 60000 });

  const a = await waitForAnswer(network, r.sessionPubkey, r.sessionSk);
  expect(a.rumor.kind).toBe(29999);
  expect(a.rumor.pubkey).toBe(r.persona);
  expect(a.seal.kind).toBe(13);
  expect(a.seal.pubkey).toBe(r.persona);
  expect(verifyEvent(a.seal)).toBe(true);
  expect(a.rumor.tags).toEqual([['session', r.challenge], ['status', 'approved']]);
  expect(a.content).toMatchObject({ type: 'signet-app-permission-response', permission: 'online-play', challenge: r.challenge });
  const event = a.content.event as Event;
  expect(verifyEvent(event)).toBe(true);
  expect({ kind: event.kind, pubkey: event.pubkey, content: event.content, tags: event.tags }).toEqual(r.template);
  expect(event.pubkey).toBe(r.persona);
  expect(Math.abs(event.created_at - Math.floor(Date.now() / 1000))).toBeLessThan(300);
});

test('adult cancels: the app is told it was declined, by a key that is not the persona, and nothing is signed', async ({ page, context }) => {
  test.setTimeout(240000);
  const network = privateRelays();
  await network.install(context);
  const r = await openLinkOnLockedApp(page, network);

  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Declined' })).toBeVisible({ timeout: 30000 });

  const a = await waitForAnswer(network, r.sessionPubkey, r.sessionSk);
  expect(a.rumor.kind).toBe(29999);
  expect(a.rumor.tags).toEqual([['session', r.challenge], ['status', 'rejected']]);
  expect(a.content).toEqual({ type: 'signet-app-permission-response', permission: 'online-play', challenge: r.challenge, denied: true });
  // a throwaway key, so the app cannot tie a refusal to anyone
  expect(a.rumor.pubkey).not.toBe(r.persona);
  expect(a.seal.pubkey).toBe(a.rumor.pubkey);
  expect(a.content.event).toBeUndefined();
  // no 30420 left the phone
  expect([...network.events.values()].some(e => e.kind === 30420)).toBe(false);
});

/** Mock only the Android plugin boundary; App's URL listener, request state,
 * unlock effects, navigation, signing and delivery all run normally. */
async function installAndroidBoundary(page: Page) {
  await page.route('**/src/lib/native.ts*', route => route.fulfill({
    contentType: 'application/javascript',
    body: `export const isNativeApp = () => true;
      export const SignetNative = new Proxy({}, { get: (_, method) => {
        if (method === 'addListener') return async () => ({ remove: async () => {} });
        const replies = { lifecycleState: { state: 'foreground' }, nip55Pending: { requests: [] },
          isBiometricAvailable: { available: false }, isBatteryExempt: { exempt: true },
          nfcStatus: { supported: false, enabled: false }, nearbyStatus: { supported: false, enabled: false, permitted: false } };
        return async () => replies[method] ?? {};
      }});`,
  }));
  await page.route('**/node_modules/.vite/deps/@capacitor_app.js*', route => route.fulfill({
    contentType: 'application/javascript',
    body: `export const App = {
      async addListener(name, listener) {
        const handle = event => listener(event.detail);
        window.addEventListener('__android_' + name, handle);
        return { remove: async () => window.removeEventListener('__android_' + name, handle) };
      },
      async getLaunchUrl() { return { url: sessionStorage.getItem('__android_launch_url') ?? undefined }; },
      async getInfo() { return { version: '0.20.0', build: '2000' }; }
    };`,
  }));
}

async function openAndroidLink(page: Page, url: string) {
  await page.evaluate(url => {
    window.dispatchEvent(new CustomEvent('__android_appUrlOpen', { detail: { url: new URL(url, 'https://mysignet.app').href } }));
  }, url);
}

async function signInToAcknowledgement(page: Page) {
  const query = new URLSearchParams({
    auth: '1', challenge: Buffer.from(generateSecretKey()).toString('hex'), origin: ORIGIN,
    callback: `${ORIGIN}/back`, name: 'Twang Thang', t: String(Math.floor(Date.now() / 1000)),
    relay: RELAY, sessionPubkey: getPublicKey(generateSecretKey()),
  });
  await openAndroidLink(page, `/?${query}`);
  await expect(page.getByText('Login Request', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Signed in', exact: true })).toBeVisible();
  await expect(page.getByText(/Return to the app or page where you started/)).toBeVisible();
}

test.describe('Android app-permission links while My Signet is running', () => {
  test.use({ viewport: { width: 800, height: 1280 } });
  let network: ReturnType<typeof privateRelays>;
  test.beforeEach(async ({ page, context }) => {
    network = privateRelays();
    await network.install(context);
    await installAndroidBoundary(page);
    await createIdentityAndUnlock(page, { name: 'Sky' });
  });

  for (const online of [true, false]) {
    test(`combined sign-in returns ${online ? 'the approved statement' : 'sign-in only'} without a bunker`, async ({ page }) => {
      const persona = await page.evaluate(() => (window as any).__TEST__.getActivePubkey());
      const request = appRequest(persona);
      const params = new URLSearchParams(new URL(request.url, 'https://mysignet.app').search);
      const tag = (name: string) => request.template.tags.find(t => t[0] === name)![1];
      const permission = { v: 1, permission: 'online-play', appId: tag('d'), installKey: tag('p'), validFrom: Number(tag('valid_from')), validUntil: Number(tag('valid_until')), reason: params.get('reason') };
      params.set('auth', '1');
      for (const key of ['action', 'permission', 'reason', 'template']) params.delete(key);
      params.set('app_permission', Buffer.from(JSON.stringify(permission)).toString('base64url'));
      if (online) {
        await signInToAcknowledgement(page);
        await page.evaluate(() => (window as any).__TEST__.lock(false));
      }
      await openAndroidLink(page, '/?' + params);
      if (online) await unlockWithPin(page);
      await expect(page.getByTestId('sign-in-online-play')).toContainText('It cannot post, message anyone');
      if (!online) await page.getByRole('checkbox', { name: 'Enable online play for this app' }).uncheck();
      await page.getByRole('button', { name: online ? 'Sign in and enable online play' : 'Sign in only', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Signed in', exact: true })).toBeVisible();
      const answer = await waitForAnswer(network, request.sessionPubkey, request.sessionSk);
      expect(answer.content.type).toBe('signet-auth-response');
      expect(answer.content.requestId).toBe(request.challenge);
      expect(verifyEvent(answer.content.authEvent as Event)).toBe(true);
      expect(answer.content.bunkerUri).toBeUndefined();
      const result = answer.content.appPermission as any;
      expect(result).toMatchObject({ v: 1, permission: 'online-play', status: online ? 'approved' : 'declined' });
      if (online) {
        expect(verifyEvent(result.event)).toBe(true);
        expect(result.event).toMatchObject(request.template);
      } else expect(result.event).toBeUndefined();
      expect(JSON.stringify(answer.content)).not.toMatch(/autonomyStage|dateOfBirth|byGuardian|dependantId/);
    });
  }

  test('a new link replaces a completed sign-in and permission result, and answers only after Allow', async ({ page }) => {
    const persona = await page.evaluate(() => (window as any).__TEST__.getActivePubkey());
    await signInToAcknowledgement(page);
    const request = appRequest(persona);
    await openAndroidLink(page, request.url);
    await expect(page.getByTestId('app-permission-reason')).toBeVisible();
    expect(await page.evaluate(() => history.state.page)).toBe('approve-app-permission');
    expect([...network.events.values()].some(e => e.kind === 30420)).toBe(false);
    await openAndroidLink(page, appRequest(persona).url);
    await expect(page.getByText("Another app's request is already open.")).toBeVisible();
    await page.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Permission given' })).toBeVisible();
    const answer = await waitForAnswer(network, request.sessionPubkey, request.sessionSk);
    expect(answer.content.challenge).toBe(request.challenge);
    expect(verifyEvent(answer.content.event as Event)).toBe(true);
    await openAndroidLink(page, appRequest(persona).url);
    await expect(page.getByTestId('app-permission-reason')).toBeVisible();
    expect(await page.evaluate(() => history.state.page)).toBe('approve-app-permission');
  });

  test('a link on a locked acknowledgement offers unlock and then opens its review', async ({ page }) => {
    const persona = await page.evaluate(() => (window as any).__TEST__.getActivePubkey());
    await signInToAcknowledgement(page);
    // Background/inactivity locks drop the key without opening a prompt.
    await page.evaluate(() => (window as any).__TEST__.lock(false));
    await expect(page.getByRole('heading', { name: 'Signed in', exact: true })).toBeVisible();
    await openAndroidLink(page, appRequest(persona).url);
    await expect(page.getByRole('heading', { name: 'Review app permissions' })).toBeVisible();
    expect(await page.evaluate(() => history.state.page)).toBe('relay-auth-ack');
    await unlockWithPin(page);
    await expect(page.getByTestId('app-permission-reason')).toBeVisible();
    expect(await page.evaluate(() => history.state.page)).toBe('approve-app-permission');
  });

  test('a cold launch survives PIN entry and duplicate native delivery', async ({ page }) => {
    const persona = await page.evaluate(() => (window as any).__TEST__.getActivePubkey());
    const request = appRequest(persona);
    await page.evaluate(url => sessionStorage.setItem('__android_launch_url', new URL(url, 'https://mysignet.app').href), request.url);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Review app permissions' })).toBeVisible();
    await openAndroidLink(page, request.url);
    await unlockWithPin(page);
    await expect(page.getByTestId('app-permission-reason')).toBeVisible();
    expect(await page.evaluate(() => history.state.page)).toBe('approve-app-permission');
  });

  test('a request arriving during an existing unlock is retained after PIN entry', async ({ page }) => {
    const persona = await page.evaluate(() => (window as any).__TEST__.getActivePubkey());
    await page.reload();
    await page.getByText('Sky', { exact: true }).waitFor();
    await navigateViaHarness(page, 'manage-carousel');
    await expect(page.locator('.auth-screen')).toBeVisible();
    await openAndroidLink(page, appRequest(persona).url);
    await unlockWithPin(page);
    await expect(page.getByTestId('app-permission-reason')).toBeVisible();
    expect(await page.evaluate(() => history.state.page)).toBe('approve-app-permission');
  });

  test('cancelling unlock sends no answer and the same native link can be opened again', async ({ page }) => {
    const persona = await page.evaluate(() => (window as any).__TEST__.getActivePubkey());
    const request = appRequest(persona);
    await page.reload();
    await page.getByText('Sky', { exact: true }).waitFor();
    await openAndroidLink(page, request.url);
    await expect(page.getByRole('heading', { name: 'Review app permissions' })).toBeVisible();
    await page.locator('.auth-screen').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('.auth-screen')).toHaveCount(0);
    expect([...network.events.values()].some(e => e.tags.some(tag => tag[0] === 'p' && tag[1] === request.sessionPubkey))).toBe(false);
    await openAndroidLink(page, request.url);
    await expect(page.getByRole('heading', { name: 'Review app permissions' })).toBeVisible();
    await unlockWithPin(page);
    await expect(page.getByTestId('app-permission-reason')).toBeVisible();
    expect(await page.evaluate(() => history.state.page)).toBe('approve-app-permission');
  });
});
