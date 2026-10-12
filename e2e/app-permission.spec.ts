import { test, expect, type Page } from '@playwright/test';
import { generateSecretKey, getPublicKey, verifyEvent, type Event } from 'nostr-tools/pure';
import * as nip44 from 'nostr-tools/nip44';
import { createIdentityAndUnlock, unlockWithPin } from './fixtures';
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
