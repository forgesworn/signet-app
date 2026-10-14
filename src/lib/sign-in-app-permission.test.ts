import { describe, expect, it } from 'vitest';
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { encodeAppPermission, parseSignInAppPermission, permissionTemplate, type SignInAppPermission } from './sign-in-app-permission';
import { buildAuthCallbackUrl, parseSignInRequest } from './url-auth';

const now = Math.floor(Date.now() / 1000);
const key = getPublicKey(new Uint8Array(32).fill(1));
const request: SignInAppPermission = { v: 1, permission: 'online-play', appId: 'twang-thang', installKey: key, validFrom: now, validUntil: now + 86400, reason: 'Show players that it is me.' };
const encode = (x: unknown) => Buffer.from(JSON.stringify(x)).toString('base64url');

describe('combined online-play sign-in parameters', () => {
  it('round trips and binds the statement to the selected persona', () => {
    expect(parseSignInAppPermission(encodeAppPermission(request))).toEqual(request);
    const persona = getPublicKey(new Uint8Array(32).fill(2));
    expect(permissionTemplate(request, persona)).toMatchObject({ pubkey: persona, kind: 30420, tags: [['d', 'twang-thang'], ['p', key], ['valid_from', String(now)], ['valid_until', String(now + 86400)], ['v', '1'], ['role', 'player'], ['expiration', String(now + 86400)]] });
  });
  it.each([
    { v: 2 }, { permission: 'post' }, { installKey: 'f'.repeat(64) }, { appId: '../other' },
    { validFrom: String(now) }, { validUntil: now + 91 * 86400 }, { validUntil: now - 1 },
    { validFrom: now - 301 }, { validFrom: now - 200, validUntil: now - 1 }, { reason: '' }, { reason: 'x'.repeat(201) }, { role: 'admin' },
  ])('refuses invalid or wider statement parameters: %j', change => {
    expect(parseSignInAppPermission(encode({ ...request, ...change }), now)).toBeNull();
  });
  it('refuses malformed/oversized values and duplicate permission parameters', () => {
    for (const raw of ['%', 'x'.repeat(4097), encode(null), encode([])]) expect(parseSignInAppPermission(raw, now)).toBeNull();
    const params = new URLSearchParams({ auth: '1', challenge: 'a'.repeat(64), origin: 'https://twang.example', name: 'Twang Thang', callback: 'https://twang.example/back', t: String(now) });
    params.set('app_permission', encode(request));
    expect(parseSignInRequest(params.toString())?.appPermission).toEqual(request);
    params.append('app_permission', encode(request));
    expect(parseSignInRequest(params.toString())).toBeNull();
  });
});

it('redirect answers carry a verifiable statement separately from the ordinary sign-in proof', () => {
  const secret = new Uint8Array(32).fill(2);
  const event = finalizeEvent({ ...permissionTemplate(request, getPublicKey(secret)), created_at: now }, secret);
  const result = { v: 1 as const, permission: 'online-play' as const, status: 'approved' as const, event };
  const url = new URL(buildAuthCallbackUrl('https://twang.example/back', event.pubkey, 'npub-proof', 'auth-signature', 'auth-event-id', { createdAt: now, appPermission: result }));
  const decoded = JSON.parse(Buffer.from(url.searchParams.get('app_permission')!, 'base64url').toString('utf8'));
  expect(decoded).toEqual(JSON.parse(JSON.stringify(result)));
  expect(verifyEvent(decoded.event)).toBe(true);
  expect(url.searchParams.get('signature')).toBe('auth-signature');
  expect(url.searchParams.get('eventId')).toBe('auth-event-id');
  const legacy = new URL(buildAuthCallbackUrl('https://twang.example/back', event.pubkey, 'npub', 'sig', 'id'));
  expect(legacy.searchParams.has('app_permission')).toBe(false);
});
