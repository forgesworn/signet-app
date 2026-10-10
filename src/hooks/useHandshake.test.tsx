// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { beginContactExchange, confirmContactRevealSent, createContactAcceptance, createContactRequest, receiveContactAcceptance } from '@forgesworn/signet-contacts';
import type { ContactInvite } from '@forgesworn/signet-contacts';
import type { NostrEvent } from 'signet-protocol';
import { useHandshake, type HandshakeHost } from './useHandshake';
import type { ContactInviteService } from '../lib/contact-invite-service';
import type { ContactInviteVault, StoredContactExchange, StoredContactInvite } from '../lib/contact-invite-store';
import { contactExchangeKey } from '../lib/contact-exchange-key';
import { ContactCardPhotoError } from '../lib/contact-card-share';
import { bindingTemplate, openReveal, readSessionQR, sealReveal, sessionQR, verifyRevealBinding, type HandshakeSession } from '../lib/handshake-reveal';
import { HandshakeNearby } from '../lib/handshake-nearby';

const haptics = vi.hoisted(() => ({ play: vi.fn(), cancel: vi.fn() }));
vi.mock('../lib/handshake-haptics', () => ({ handshakeHaptic: haptics.play, cancelHandshakeHaptics: haptics.cancel }));
// The hook makes its own session; each test chooses it, so dial order is known.
const sessions = vi.hoisted(() => ({ next: undefined as HandshakeSession | undefined }));
vi.mock('../lib/handshake-reveal', async importOriginal => {
  const real = await importOriginal<typeof import('../lib/handshake-reveal')>();
  return { ...real, createHandshakeSession: () => sessions.next ?? real.createHandshakeSession() };
});
const freshSession = (): HandshakeSession => { const secret = generateSecretKey(); return { secret, publicKey: getPublicKey(secret) }; };
beforeEach(() => { sessions.next = undefined; });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

/** `recipient`: this phone holds the higher persona. `ownLowerSession`: this
 * phone's session key sorts first, so it is the one that dials. */
function setup(opts: { recipient?: boolean; ownLowerSession?: boolean } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const keys = [generateSecretKey(), generateSecretKey()].sort((x, y) => getPublicKey(x) < getPublicKey(y) ? -1 : 1);
  const [ownSk, peerSk] = opts.recipient ? [keys[1], keys[0]] : [keys[0], keys[1]];
  const ownPub = getPublicKey(ownSk), peerPub = getPublicKey(peerSk);
  let own: HandshakeSession, peerSession: HandshakeSession;
  do { own = freshSession(); peerSession = freshSession(); }
  while ((own.publicKey < peerSession.publicKey) !== (opts.ownLowerSession ?? true));
  sessions.next = own;
  const relays = ['wss://relay.example/'];
  const ownInvite: StoredContactInvite = { id: 'a'.repeat(32), identityPubkey: ownPub, name: 'Handshake', mode: 'single-use', enabled: true,
    createdAt: now, updatedAt: now, invite: { v: 1, recipient: ownPub, secret: '3'.repeat(64), expiresAt: now + 120, relays } };
  const peerInvite: ContactInvite = { v: 1, recipient: peerPub, secret: '4'.repeat(64), expiresAt: now + 120, relays };
  const [low, high] = ownPub < peerPub ? [ownPub, peerPub] : [peerPub, ownPub];
  const request = createContactRequest({ id: 'b'.repeat(32), from: low, to: high, nonce: '5'.repeat(64), now,
    reply: { secret: '6'.repeat(64), relays }, expiresAt: now + 120 });
  const acceptance = createContactAcceptance(request, '7'.repeat(64), now, { name: 'Other person' });
  const complete: StoredContactExchange = { ...confirmContactRevealSent(receiveContactAcceptance(beginContactExchange(request, '5'.repeat(64)), acceptance, now)),
    handshake: { startedAt: now } };
  const vault: ContactInviteVault = { v: 1, directoryId: 'owner', invites: [ownInvite], arrivals: [], exchanges: [], outbox: [] };
  const service = {
    create: vi.fn(async () => ownInvite), read: vi.fn(async () => vault), openInbox: vi.fn(async () => {}),
    request: vi.fn(async () => { vault.exchanges = [complete]; return contactExchangeKey(request); }),
    acceptHandshake: vi.fn(async () => { vault.exchanges = [{ ...complete, role: 'recipient' }]; }),
    accept: vi.fn(async () => { vault.exchanges = [{ ...complete, role: 'recipient' }]; }),
    flush: vi.fn(async () => {}), setEnabled: vi.fn(async () => {}), cancel: vi.fn(async () => {}),
    confirmHandshake: vi.fn(async () => 'c'.repeat(32)),
    signRevealBinding: vi.fn(async (_persona: string, template: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(template, ownSk) as NostrEvent),
  };
  let watcher: ((event: NostrEvent) => void) | undefined;
  const revealRelays = {
    watch: vi.fn((_relays: string[], _session: string, onEvent: (event: NostrEvent) => void) => { watcher = onEvent; return () => { watcher = undefined; }; }),
    publish: vi.fn(async (_event: NostrEvent, _relays: string[]) => true),
  };
  const host: HandshakeHost = { persona: ownPub, version: 0, relays, service: () => service as unknown as ContactInviteService,
    card: async () => undefined, nearby: null, revealRelays };
  const peerCode = sessionQR({ publicKey: peerSession.publicKey, expiresAt: now + 120, relays })!;
  /** The peer's sealed reveal, signed for its session and `forSession` (this phone's, if it scanned us). */
  const peerReveal = (forSession = own.publicKey) => sealReveal({ v: 2, to: own.publicKey, invite: peerInvite,
    binding: finalizeEvent(bindingTemplate(peerSession, forSession, peerInvite, now), peerSk) as NostrEvent }, own.publicKey, now);
  const deliver = (event: NostrEvent) => act(() => watcher!(event));
  return { host, service, vault, revealRelays, own, peerSession, peerInvite, peerCode, peerReveal, deliver, now, ownInvite, request, complete, ownPub };
}
const ready = async (hook: { result: { current: ReturnType<typeof useHandshake> } }) =>
  waitFor(() => expect(hook.result.current.view.code).toBeTruthy());

it('shows only its session, and sends a reveal bound to both sessions once the camera reads the peer', async () => {
  const s = setup();
  const hook = renderHook(() => useHandshake(s.host));
  await ready(hook);
  expect(readSessionQR(hook.result.current.view.code!, s.now)).toEqual({ kind: 'session', card: { publicKey: s.own.publicKey, expiresAt: s.now + 120, relays: s.ownInvite.invite.relays } });
  expect(hook.result.current.view.code).not.toContain(s.ownPub.slice(0, 10));
  act(() => hook.result.current.scan(s.peerCode));
  await waitFor(() => expect(s.revealRelays.publish).toHaveBeenCalledTimes(1));
  const [sent, relays] = s.revealRelays.publish.mock.calls[0];
  expect(relays).toEqual(['wss://relay.example/']);
  const body = openReveal(sent, s.peerSession, s.now)!;
  expect(body.invite).toEqual(s.ownInvite.invite);
  expect(verifyRevealBinding(body, s.own.publicKey, s.peerSession)).toBe(true);
  expect(haptics.play).toHaveBeenCalledWith('tick');
  expect(haptics.play).not.toHaveBeenCalledWith('double');
});

it('confirms both scans only on a reveal bound to this session, then the lower persona sends and seals mutual', async () => {
  const s = setup();
  const hook = renderHook(() => useHandshake(s.host));
  await ready(hook);
  act(() => hook.result.current.scan(s.peerCode));
  await waitFor(() => expect(s.revealRelays.publish).toHaveBeenCalled());
  expect(s.service.request).not.toHaveBeenCalled();
  s.deliver(s.peerReveal());
  await waitFor(() => expect(hook.result.current.view.phase).toBe('sealed'));
  expect(hook.result.current.view.partner).toBe(s.peerInvite.recipient);
  expect(haptics.play).toHaveBeenCalledWith('double');
  expect((s.service.request.mock.calls[0] as unknown[])[1]).toEqual(s.peerInvite);
  const evidence = (s.service.confirmHandshake.mock.calls[0] as unknown[])[2] as unknown as Record<string, unknown>;
  expect(evidence).toMatchObject({ inviteId: s.ownInvite.id, cameraPeerSession: s.peerSession.publicKey });
  expect(evidence.ownSession).toBe(s.own);
});

it('a reveal not signed for this session proves nothing: no confirmation, no automatic exchange', async () => {
  const s = setup();
  const hook = renderHook(() => useHandshake(s.host));
  await ready(hook);
  act(() => hook.result.current.scan(s.peerCode));
  s.deliver(s.peerReveal(freshSession().publicKey));
  await new Promise(r => setTimeout(r, 100));
  expect(hook.result.current.view.scansConfirmed).not.toBe(true);
  expect(haptics.play).not.toHaveBeenCalledWith('double');
  expect(s.service.request).not.toHaveBeenCalled();
});

it('keeps a reveal that came before the scan, and acts on it once the camera confirms the session', async () => {
  const s = setup();
  const hook = renderHook(() => useHandshake(s.host));
  await ready(hook);
  s.deliver(s.peerReveal());
  await waitFor(() => expect(hook.result.current.view.phase).toBe('waiting'));
  expect(s.service.request).not.toHaveBeenCalled();
  act(() => hook.result.current.scan(s.peerCode));
  await waitFor(() => expect(hook.result.current.view.phase).toBe('sealed'));
});

it('auto-accepts as the higher persona only on a verified reveal', async () => {
  const s = setup({ recipient: true });
  s.vault.arrivals = [{ id: 'c'.repeat(64), inviteId: s.ownInvite.id, identityPubkey: s.ownPub, receivedAt: s.now, channel: 'invite', request: s.request }];
  const hook = renderHook(() => useHandshake(s.host));
  await ready(hook);
  act(() => hook.result.current.scan(s.peerCode));
  // The peer's request already names our invite, so it has our reveal.
  await new Promise(r => setTimeout(r, 100));
  expect(s.service.acceptHandshake).not.toHaveBeenCalled();
  s.deliver(s.peerReveal());
  await waitFor(() => expect(s.service.acceptHandshake).toHaveBeenCalledTimes(1));
  expect(s.service.acceptHandshake.mock.calls[0]).toEqual(expect.arrayContaining([{ invite: s.peerInvite }]));
  expect(s.service.request).not.toHaveBeenCalled();
});

it('refuses a handshake code from an older build', async () => {
  const s = setup();
  const hook = renderHook(() => useHandshake(s.host));
  await ready(hook);
  act(() => hook.result.current.scan('SGH1:ABCDEF'));
  await waitFor(() => expect(hook.result.current.view.outdated).toBe(true));
  expect(hook.result.current.view.scanned).not.toBe(true);
  expect(s.revealRelays.publish).not.toHaveBeenCalled();
});

it('one-way: without its own scan, the seam check uses the revealed invite and never claims mutual', async () => {
  const s = setup({ recipient: true });
  const hook = renderHook(() => useHandshake(s.host));
  await ready(hook);
  s.deliver(s.peerReveal());
  await waitFor(() => expect(hook.result.current.view.phase).toBe('waiting'));
  act(() => hook.result.current.oneWay());
  await waitFor(() => expect(hook.result.current.view.phase).toBe('checking'));
  expect((s.service.request.mock.calls[0] as unknown[])[1]).toEqual(s.peerInvite);
  act(() => hook.result.current.confirm());
  await waitFor(() => expect(hook.result.current.view.phase).toBe('sealed'));
  expect((s.service.confirmHandshake.mock.calls[0] as unknown[])[2]).toBeUndefined();
});

it('sends nothing when the picture cannot be prepared, and goes on without it only when asked', async () => {
  const s = setup();
  const card = vi.fn(async (opts?: { withoutPhoto?: boolean }) => {
    if (!opts?.withoutPhoto) throw new ContactCardPhotoError();
    return { name: 'Me' };
  });
  s.service.request.mockImplementation(async (...args: unknown[]) => {
    await (args[4] as () => Promise<unknown>)();
    s.vault.exchanges = [s.complete];
    return contactExchangeKey(s.request);
  });
  const hook = renderHook(() => useHandshake({ ...s.host, card }));
  await ready(hook);
  act(() => hook.result.current.scan(s.peerCode));
  s.deliver(s.peerReveal());
  await waitFor(() => expect(hook.result.current.view.photoFailed).toBe(true));
  expect(hook.result.current.view.phase).not.toBe('failed');
  expect(s.vault.exchanges).toHaveLength(0);
  act(() => hook.result.current.withoutPhoto());
  await waitFor(() => expect(s.vault.exchanges).toHaveLength(1));
  expect(card).toHaveBeenLastCalledWith({ withoutPhoto: true });
});

it('stays sealed when saving the contact wakes a pass that was waiting behind the seal', async () => {
  const s = setup({ recipient: true });
  const hook = renderHook(({ version }) => useHandshake({ ...s.host, version }), { initialProps: { version: 0 } });
  s.service.confirmHandshake.mockImplementation(async () => { hook.rerender({ version: 1 }); await new Promise(r => setTimeout(r, 20)); return 'c'.repeat(32); });
  await ready(hook);
  s.deliver(s.peerReveal());
  act(() => hook.result.current.oneWay());
  await waitFor(() => expect(hook.result.current.view.phase).toBe('checking'));
  act(() => hook.result.current.confirm());
  await waitFor(() => expect(hook.result.current.view.phase).toBe('sealed'));
  await act(() => new Promise(r => setTimeout(r, 300)));
  expect(hook.result.current.view.phase).toBe('sealed');
  expect(s.service.confirmHandshake).toHaveBeenCalledTimes(1);
});

function fakeNearby() {
  return {
    status: vi.fn(async () => ({ supported: true, enabled: true, permitted: true })),
    permission: vi.fn(async () => ({ granted: true })), enable: vi.fn(async () => ({ enabled: true })),
    advertise: vi.fn(async () => ({ psm: 0x80 })), connect: vi.fn(() => new Promise<{ link: string }>(() => {})),
    send: vi.fn(async () => {}), trust: vi.fn(async () => {}), close: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    quiet: vi.fn(async () => {}), listen: vi.fn(async () => () => {}),
  };
}
it('advertises its session, dials the scanned session as the lower one and stops the radio on leaving', async () => {
  const s = setup({ ownLowerSession: true }), nearby = fakeNearby();
  const hook = renderHook(() => useHandshake({ ...s.host, nearby }));
  await waitFor(() => expect(nearby.advertise).toHaveBeenCalledTimes(1));
  act(() => hook.result.current.scan(s.peerCode));
  await waitFor(() => expect(nearby.connect).toHaveBeenCalledTimes(1));
  expect(nearby.quiet).toHaveBeenCalled();
  hook.unmount();
  await waitFor(() => expect(nearby.stop).toHaveBeenCalled());
});
it('as the higher session, waits for the other phone to dial, and dials itself only if it never does', async () => {
  const s = setup({ ownLowerSession: false }), nearby = fakeNearby();
  const hook = renderHook(() => useHandshake({ ...s.host, nearby }));
  await waitFor(() => expect(nearby.advertise).toHaveBeenCalledTimes(1));
  act(() => hook.result.current.scan(s.peerCode));
  await new Promise(r => setTimeout(r, 200));
  expect(nearby.connect).not.toHaveBeenCalled();
  await waitFor(() => expect(nearby.connect).toHaveBeenCalledTimes(1), { timeout: 4000 });
}, 10000);
it('keeps Bluetooth off while the app is hidden and restarts it on return, dialling again', async () => {
  let visibility: DocumentVisibilityState = 'visible';
  const spy = vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  const turn = (value: DocumentVisibilityState) => { visibility = value; document.dispatchEvent(new Event('visibilitychange')); };
  try {
    const s = setup({ ownLowerSession: true }), nearby = fakeNearby();
    const hook = renderHook(() => useHandshake({ ...s.host, nearby }));
    await waitFor(() => expect(nearby.advertise).toHaveBeenCalledTimes(1));
    act(() => hook.result.current.scan(s.peerCode));
    await waitFor(() => expect(nearby.connect).toHaveBeenCalledTimes(1));
    act(() => turn('hidden'));
    await waitFor(() => expect(nearby.stop).toHaveBeenCalledTimes(1));
    act(() => turn('hidden'));
    expect(nearby.advertise).toHaveBeenCalledTimes(1);
    act(() => turn('visible'));
    await waitFor(() => expect(nearby.advertise).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(nearby.connect).toHaveBeenCalledTimes(2));
    hook.unmount();
    await waitFor(() => expect(nearby.stop).toHaveBeenCalledTimes(2));
    act(() => turn('visible'));
    expect(nearby.advertise).toHaveBeenCalledTimes(2);
  } finally { spy.mockRestore(); }
});
it('stops Bluetooth when the shell reports the app went to the background, even if the page still looks visible', async () => {
  const s = setup(), nearby = fakeNearby();
  let report: ((state: 'background' | 'foreground') => void) | undefined;
  const lifecycle = vi.fn(async (handler: (state: 'background' | 'foreground') => void) => { report = handler; return () => { report = undefined; }; });
  const hook = renderHook(() => useHandshake({ ...s.host, nearby: { ...nearby, lifecycle } }));
  await waitFor(() => expect(nearby.advertise).toHaveBeenCalledTimes(1));
  act(() => report!('background'));
  await waitFor(() => expect(nearby.stop).toHaveBeenCalledTimes(1));
  act(() => report!('foreground'));
  await waitFor(() => expect(nearby.advertise).toHaveBeenCalledTimes(2));
  hook.unmount();
  expect(report).toBeUndefined();
});
it('turns Bluetooth off once only the seam check is left', async () => {
  const s = setup({ recipient: true }), nearby = fakeNearby();
  const hook = renderHook(() => useHandshake({ ...s.host, nearby }));
  await waitFor(() => expect(nearby.advertise).toHaveBeenCalledTimes(1));
  s.deliver(s.peerReveal());
  await waitFor(() => expect(hook.result.current.view.phase).toBe('waiting'));
  expect(nearby.stop).not.toHaveBeenCalled();
  act(() => hook.result.current.oneWay());
  await waitFor(() => expect(hook.result.current.view.phase).toBe('checking'));
  await waitFor(() => expect(nearby.stop).toHaveBeenCalledTimes(1));
});
it('one-way: the link that carried the chosen reveal speaks for its persona, so the request can go back over it', async () => {
  const bind = vi.spyOn(HandshakeNearby.prototype, 'bind');
  try {
    const s = setup({ recipient: true }), nearby = fakeNearby();
    const hook = renderHook(() => useHandshake({ ...s.host, nearby }));
    await waitFor(() => expect(nearby.advertise).toHaveBeenCalledTimes(1));
    const reveal = s.peerReveal();
    s.deliver(reveal);
    await waitFor(() => expect(hook.result.current.view.phase).toBe('waiting'));
    expect(bind).not.toHaveBeenCalledWith(reveal.id, s.peerInvite.recipient);
    act(() => hook.result.current.oneWay());
    await waitFor(() => expect(bind).toHaveBeenCalledWith(reveal.id, s.peerInvite.recipient));
  } finally { bind.mockRestore(); }
});
it('sends its reveal again, freshly sealed, until the peer acts on it (review M1)', async () => {
  // Real time still flows (crypto, waitFor); the 5 s resend interval is jumped
  // rather than waited out, so a loaded machine cannot make it race the clock.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const s = setup();
    const hook = renderHook(() => useHandshake(s.host));
    await ready(hook);
    act(() => hook.result.current.scan(s.peerCode));
    await waitFor(() => expect(s.revealRelays.publish).toHaveBeenCalledTimes(1), { timeout: 10000 });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    await waitFor(() => expect(s.revealRelays.publish).toHaveBeenCalledTimes(2), { timeout: 10000 });
    const [first, second] = s.revealRelays.publish.mock.calls.map(c => c[0]);
    expect(second.id).not.toBe(first.id);
    expect(openReveal(second, s.peerSession, s.now)!.binding.id).toBe(openReveal(first, s.peerSession, s.now)!.binding.id);
    s.deliver(s.peerReveal());
    await waitFor(() => expect(hook.result.current.view.phase).toBe('sealed'), { timeout: 10000 });
    const sent = s.revealRelays.publish.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5500); });
    expect(s.revealRelays.publish.mock.calls.length).toBe(sent);
  } finally { vi.useRealTimers(); }
}, 40000);
it('one-way refuses to guess when more than one persona answered before any scan (review M2)', async () => {
  const s = setup({ recipient: true });
  const hook = renderHook(() => useHandshake(s.host));
  await ready(hook);
  s.deliver(s.peerReveal());
  const other = generateSecretKey(), otherInvite = { ...s.peerInvite, recipient: getPublicKey(other) };
  s.deliver(sealReveal({ v: 2, to: s.own.publicKey, invite: otherInvite,
    binding: finalizeEvent(bindingTemplate(freshSession(), s.own.publicKey, otherInvite, s.now), other) as NostrEvent }, s.own.publicKey, s.now));
  await waitFor(() => expect(hook.result.current.view.phase).toBe('waiting'));
  act(() => hook.result.current.oneWay());
  await waitFor(() => expect(hook.result.current.view.ambiguous).toBe(true));
  await new Promise(r => setTimeout(r, 100));
  expect(s.service.request).not.toHaveBeenCalled();
});
it('fails closed if two personas both prove the session this camera read', async () => {
  const s = setup();
  const hook = renderHook(() => useHandshake(s.host));
  await ready(hook);
  s.deliver(s.peerReveal());
  const other = generateSecretKey(), otherInvite = { ...s.peerInvite, recipient: getPublicKey(other) };
  // Only the holder of the peer's session secret could make this second proof.
  s.deliver(sealReveal({ v: 2, to: s.own.publicKey, invite: otherInvite,
    binding: finalizeEvent(bindingTemplate(s.peerSession, s.own.publicKey, otherInvite, s.now), other) as NostrEvent }, s.own.publicKey, s.now));
  act(() => hook.result.current.scan(s.peerCode));
  await waitFor(() => expect(hook.result.current.view.phase).toBe('failed'));
  expect(s.service.request).not.toHaveBeenCalled();
  expect(s.service.confirmHandshake).not.toHaveBeenCalled();
});
it('junk reveals cannot crowd out the genuine one, and replays cost nothing (review N1)', async () => {
  const s = setup();
  const hook = renderHook(() => useHandshake(s.host));
  await ready(hook);
  act(() => hook.result.current.scan(s.peerCode));
  // A photo holder floods sealed junk to this session.
  const junk = sealReveal({ v: 2, to: s.own.publicKey, invite: s.peerInvite,
    binding: finalizeEvent(bindingTemplate(freshSession(), s.own.publicKey, s.peerInvite, s.now), generateSecretKey()) as NostrEvent }, s.own.publicKey, s.now);
  for (let i = 0; i < 80; i++) s.deliver({ ...junk, id: i.toString(16).padStart(64, '0') });
  for (let i = 0; i < 80; i++) s.deliver(junk);
  s.deliver(s.peerReveal());
  await waitFor(() => expect(hook.result.current.view.phase).toBe('sealed'));
});
it('a second persona answering after the one-way tap, before anything is sent, stops the guess (review M2)', async () => {
  const s = setup({ recipient: true });
  s.service.request.mockImplementation(() => new Promise(() => {}));
  const hook = renderHook(() => useHandshake(s.host));
  await ready(hook);
  act(() => hook.result.current.oneWay());
  const other = generateSecretKey(), otherInvite = { ...s.peerInvite, recipient: getPublicKey(other) };
  // Both arrive in one go, before any pass could send.
  act(() => {
    s.deliver(s.peerReveal());
    s.deliver(sealReveal({ v: 2, to: s.own.publicKey, invite: otherInvite,
      binding: finalizeEvent(bindingTemplate(freshSession(), s.own.publicKey, otherInvite, s.now), other) as NostrEvent }, s.own.publicKey, s.now));
  });
  await waitFor(() => expect(hook.result.current.view.ambiguous).toBe(true));
});
it('an NFC tap reads the other session like a camera, and the contact is recorded as tapped', async () => {
  const s = setup();
  let tapped: ((code: string) => void) | undefined;
  const stop = vi.fn();
  const nfc = { status: vi.fn(async () => ({ supported: true, enabled: true })),
    start: vi.fn(async (_code: string, onPeer: (code: string) => void) => { tapped = onPeer; return stop; }) };
  const hook = renderHook(() => useHandshake({ ...s.host, nfc }));
  await waitFor(() => expect(hook.result.current.view.tapAvailable).toBe(true));
  expect(nfc.start.mock.calls[0][0]).toBe(hook.result.current.view.code);
  act(() => tapped!(s.peerCode));
  await waitFor(() => expect(s.revealRelays.publish).toHaveBeenCalled());
  expect(haptics.play).toHaveBeenCalledWith('tick');
  expect(hook.result.current.view.via).toBe('tap');
  s.deliver(s.peerReveal());
  await waitFor(() => expect(hook.result.current.view.phase).toBe('sealed'));
  expect(((s.service.confirmHandshake.mock.calls[0] as unknown[])[2] as { via: string }).via).toBe('tap');
  expect(stop).toHaveBeenCalled();
});
it('a tap after the camera already read the peer changes nothing, and NFC stops on leaving', async () => {
  const s = setup();
  let tapped: ((code: string) => void) | undefined;
  const stop = vi.fn();
  const nfc = { status: vi.fn(async () => ({ supported: true, enabled: true })),
    start: vi.fn(async (_code: string, onPeer: (code: string) => void) => { tapped = onPeer; return stop; }) };
  const hook = renderHook(() => useHandshake({ ...s.host, nfc }));
  await waitFor(() => expect(hook.result.current.view.tapAvailable).toBe(true));
  act(() => hook.result.current.scan(s.peerCode));
  act(() => tapped!(s.peerCode));
  s.deliver(s.peerReveal());
  await waitFor(() => expect(hook.result.current.view.phase).toBe('sealed'));
  expect(((s.service.confirmHandshake.mock.calls[0] as unknown[])[2] as { via: string }).via).toBe('camera');
  hook.unmount();
  expect(stop).toHaveBeenCalled();
});
it('a different session arriving after the peer was read fails the screen closed, by tap or camera (NFC review M1)', async () => {
  for (const second of ['tap', 'camera'] as const) {
    const s = setup();
    let tapped: ((code: string) => void) | undefined;
    const stop = vi.fn();
    const nfc = { status: vi.fn(async () => ({ supported: true, enabled: true })),
      start: vi.fn(async (_code: string, onPeer: (code: string) => void) => { tapped = onPeer; return stop; }) };
    const hook = renderHook(() => useHandshake({ ...s.host, nfc }));
    await waitFor(() => expect(hook.result.current.view.tapAvailable).toBe(true));
    act(() => hook.result.current.scan(s.peerCode));
    await waitFor(() => expect(s.revealRelays.publish).toHaveBeenCalled());
    // Another phone or card, brushed past while the screen was open.
    const stranger = sessionQR({ publicKey: freshSession().publicKey, expiresAt: s.now + 120, relays: ['wss://elsewhere.example/'] })!;
    act(() => { if (second === 'tap') tapped!(stranger); else hook.result.current.scan(stranger); });
    await waitFor(() => expect(hook.result.current.view.phase).toBe('failed'));
    expect(stop).toHaveBeenCalled();
    // The genuine reveal after that cannot seal, and nothing went to the stranger.
    s.deliver(s.peerReveal());
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    expect(hook.result.current.view.phase).toBe('failed');
    expect(s.service.confirmHandshake).not.toHaveBeenCalled();
    expect(s.revealRelays.publish.mock.calls.every(call => !call[1].includes('wss://elsewhere.example/'))).toBe(true);
    hook.unmount(); cleanup(); vi.clearAllMocks();
  }
});
