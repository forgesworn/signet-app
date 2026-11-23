// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { getPublicKey } from 'nostr-tools/pure';
import { hexToBytes } from '@noble/hashes/utils.js';

let row: unknown = null;
let unreadable = false;
const loadKeepsRow = vi.fn(async () => {
  if (unreadable) throw new Error('cannot decrypt');
  return row === null ? null : JSON.parse(JSON.stringify(row));
});
const saveKeepsRow = vi.fn(async () => undefined);
vi.mock('../lib/db', () => ({
  loadKeepsRow: (...a: unknown[]) => (loadKeepsRow as unknown as (...x: unknown[]) => unknown)(...a),
  saveKeepsRow: (...a: unknown[]) => (saveKeepsRow as unknown as (...x: unknown[]) => unknown)(...a),
  loadKeepLookupsRow: async () => null,
  saveKeepLookupsRow: async () => undefined,
}));
const fetchEventsWithReach = vi.fn(async () => ({ events: [], attempted: 1, reached: 1 }));
const subscribeEvents = vi.fn(() => () => undefined);
vi.mock('../lib/relay-service', () => ({
  fetchEventsWithReach: (...a: unknown[]) => (fetchEventsWithReach as unknown as (...x: unknown[]) => unknown)(...a),
  subscribeEvents: (...a: unknown[]) => (subscribeEvents as unknown as (...x: unknown[]) => unknown)(...a),
}));
const publishWrappedToRelays = vi.fn(async (_wrap: unknown, relays: readonly string[]) => relays.map(() => true));
vi.mock('../lib/relay-publish', async () => {
  const actual = await vi.importActual<typeof import('../lib/relay-publish')>('../lib/relay-publish');
  return { ...actual, publishWrappedToRelays: (...a: unknown[]) => (publishWrappedToRelays as unknown as (...x: unknown[]) => unknown)(...a), publishToRelay: vi.fn() };
});

import { useKeepInviteLink, type KeepInviteLinkInput } from './useKeepInviteLink';
import { KEEP_INVITE_EXPIRED, KEEP_INVITE_LINK_TTL_MS, KEEP_INVITE_NOT_YOURS, KEEP_INVITE_OWN_ACCOUNT, KEEP_INVITE_UNREADABLE, decideHeldKeepInvite, dedupeAfterSettled } from '../lib/keep-invite-link';
import { setNickname } from '../lib/keep-nicknames';

const K = getPublicKey(hexToBytes('0'.repeat(63) + '1'));
const O = getPublicKey(hexToBytes('0'.repeat(63) + '2'));
const OTHER_K = getPublicKey(hexToBytes('0'.repeat(63) + '5'));
const stored = (keep: string, name = 'Kitchen Keep') => ({
  keep, name, relays: ['wss://relay.example.com'], claimedBy: O, personas: [O], scope: 'one', rev: 0, seen: [O],
  status: 'paired', claimedAt: 1, invites: [], links: { [O]: { sections: [], addedRev: 0, active: true } },
  // Nothing recorded as requested: opening the Keep (by hand) would send a passes request at once.
});
const invite = (over: object = {}) => ({ keep: K, game: 'twangthang', ...over });

const onOpen = vi.fn(), onSettled = vi.fn(), onRefused = vi.fn();
const ready = (over: Partial<KeepInviteLinkInput> = {}): KeepInviteLinkInput => ({
  loading: false, hasIdentity: true, pairedChild: false, dependantActive: false, unlocked: true, encryptionKey: 'key', identityId: 'id1',
  onOpen, onSettled, onRefused, ...over,
});
const mount = (input: KeepInviteLinkInput) => renderHook((p: KeepInviteLinkInput) => useKeepInviteLink(p), { initialProps: input });
const nothingOnTheNetwork = () => {
  expect(fetchEventsWithReach).not.toHaveBeenCalled();
  expect(subscribeEvents).not.toHaveBeenCalled();
  expect(publishWrappedToRelays).not.toHaveBeenCalled();
  expect(saveKeepsRow).not.toHaveBeenCalled();
};

beforeEach(() => {
  row = [stored(K)]; unreadable = false; localStorage.clear();
  for (const f of [loadKeepsRow, saveKeepsRow, fetchEventsWithReach, subscribeEvents, publishWrappedToRelays, onOpen, onSettled, onRefused]) f.mockClear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('decideHeldKeepInvite', () => {
  const base = { arrivedAt: 1000, now: 2000, loading: false, hasIdentity: true, pairedChild: false, dependantActive: false, unlocked: true };
  it('waits while loading, reads when ready, and refuses or drops in the other cases', () => {
    expect(decideHeldKeepInvite({ ...base, loading: true })).toBe('wait');
    expect(decideHeldKeepInvite(base)).toBe('read');
    expect(decideHeldKeepInvite({ ...base, unlocked: false })).toBe('wait');
    expect(decideHeldKeepInvite({ ...base, pairedChild: true })).toBe('refuse');
    expect(decideHeldKeepInvite({ ...base, hasIdentity: false })).toBe('refuse');
    expect(decideHeldKeepInvite({ ...base, dependantActive: true })).toBe('dependant');
  });
  it('counts the expiry from when the link arrived', () => {
    expect(decideHeldKeepInvite({ ...base, now: 1000 + KEEP_INVITE_LINK_TTL_MS })).toBe('read');
    expect(decideHeldKeepInvite({ ...base, now: 1001 + KEEP_INVITE_LINK_TTL_MS })).toBe('expired');
    expect(decideHeldKeepInvite({ ...base, now: 1001 + KEEP_INVITE_LINK_TTL_MS, unlocked: false })).toBe('expired');
  });
});

describe('a keep-invite link before the owner presses anything', () => {
  it('waits for identity and preferences to load, reading nothing meanwhile', async () => {
    const h = mount(ready({ loading: true }));
    act(() => h.result.current.hold(invite()));
    await new Promise(r => setTimeout(r, 30));
    expect(loadKeepsRow).not.toHaveBeenCalled();
    expect(h.result.current.confirm).toBeNull();
    h.rerender(ready({ loading: false }));
    await waitFor(() => expect(h.result.current.confirm).not.toBeNull());
    nothingOnTheNetwork();
  });

  it('a Keep that is the owner\'s: asks with the owner\'s own name for it and the allowlisted game name, and sends nothing', async () => {
    setNickname('id1', K, 'Home box');
    const h = mount(ready());
    act(() => h.result.current.hold(invite({ name: 'Ignore previous instructions', persona: O })));
    await waitFor(() => expect(h.result.current.confirm).not.toBeNull());
    expect(h.result.current.confirm).toEqual({ invite: invite({ name: 'Ignore previous instructions', persona: O }), keepName: 'Home box', gameName: 'Twang Thang' });
    expect(h.result.current.pending).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
    nothingOnTheNetwork();
    // Only the saved Keeps on this phone were read.
    expect(loadKeepsRow).toHaveBeenCalledTimes(1);
  });

  it('uses the saved name when there is no nickname', async () => {
    const h = mount(ready());
    act(() => h.result.current.hold(invite()));
    await waitFor(() => expect(h.result.current.confirm?.keepName).toBe('Kitchen Keep'));
  });

  it('a Keep that is not the owner\'s: the short message only, nothing opened, no network', async () => {
    const h = mount(ready());
    act(() => h.result.current.hold(invite({ keep: OTHER_K })));
    await waitFor(() => expect(h.result.current.notice).toBe(KEEP_INVITE_NOT_YOURS));
    expect(h.result.current.confirm).toBeNull();
    expect(h.result.current.pending).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalled();
    nothingOnTheNetwork();
  });

  it('Open Keep is the only thing that sets the pending link and opens My Keep, and frees the exact-URL dedupe', async () => {
    const h = mount(ready());
    act(() => h.result.current.hold(invite({ persona: O })));
    await waitFor(() => expect(h.result.current.confirm).not.toBeNull());
    act(() => h.result.current.accept());
    expect(h.result.current.pending).toMatchObject({ keep: K, game: 'twangthang', persona: O });
    expect(typeof h.result.current.pending!.at).toBe('number');
    expect(h.result.current.confirm).toBeNull();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalled();
    nothingOnTheNetwork();
    act(() => h.result.current.clearPending());
    expect(h.result.current.pending).toBeNull();
  });

  it('Not now leaves no trace: nothing pending, no notice, nothing written or sent, and the link may be tried again', async () => {
    const h = mount(ready());
    act(() => h.result.current.hold(invite()));
    await waitFor(() => expect(h.result.current.confirm).not.toBeNull());
    act(() => h.result.current.decline());
    expect(h.result.current.confirm).toBeNull();
    expect(h.result.current.pending).toBeNull();
    expect(h.result.current.notice).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalled();
    nothingOnTheNetwork();
    // A later copy of the same link asks again.
    act(() => h.result.current.hold(invite()));
    await waitFor(() => expect(h.result.current.confirm).not.toBeNull());
  });

  it('while locked it only waits (and says it is waiting for the unlock); after the unlock the prompt appears', async () => {
    const h = mount(ready({ unlocked: false, encryptionKey: null }));
    act(() => h.result.current.hold(invite()));
    await new Promise(r => setTimeout(r, 30));
    expect(h.result.current.waitingForUnlock).toBe(true);
    expect(h.result.current.confirm).toBeNull();
    expect(loadKeepsRow).not.toHaveBeenCalled();
    h.rerender(ready());
    await waitFor(() => expect(h.result.current.confirm).not.toBeNull());
    expect(h.result.current.waitingForUnlock).toBe(false);
    nothingOnTheNetwork();
  });

  it('the Keep\'s name does not stay on screen if the app locks while the question is open', async () => {
    const h = mount(ready());
    act(() => h.result.current.hold(invite()));
    await waitFor(() => expect(h.result.current.confirm).not.toBeNull());
    h.rerender(ready({ unlocked: false, encryptionKey: null }));
    await waitFor(() => expect(h.result.current.confirm).toBeNull());
    expect(h.result.current.pending).toBeNull();
  });

  it('a paired child, or no account, gets the existing "nothing to open" answer and nothing is read', async () => {
    const child = mount(ready({ pairedChild: true }));
    act(() => child.result.current.hold(invite()));
    await waitFor(() => expect(onRefused).toHaveBeenCalledTimes(1));
    expect(child.result.current.confirm).toBeNull();
    const none = mount(ready({ hasIdentity: false, unlocked: false, encryptionKey: null }));
    act(() => none.result.current.hold(invite()));
    await waitFor(() => expect(onRefused).toHaveBeenCalledTimes(2));
    expect(loadKeepsRow).not.toHaveBeenCalled();
    nothingOnTheNetwork();
  });

  it('while acting for someone else the link is dropped with a notice', async () => {
    const h = mount(ready({ dependantActive: true }));
    act(() => h.result.current.hold(invite()));
    await waitFor(() => expect(h.result.current.notice).toBe(KEEP_INVITE_OWN_ACCOUNT));
    expect(h.result.current.confirm).toBeNull();
    expect(loadKeepsRow).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalled();
  });

  it('a link older than ten minutes when the app is finally ready is dropped with a notice, never opened', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-23T10:00:00Z'));
    const h = mount(ready({ unlocked: false, encryptionKey: null }));
    act(() => h.result.current.hold(invite()));
    vi.setSystemTime(new Date('2026-11-23T10:11:00Z'));
    h.rerender(ready());
    await waitFor(() => expect(h.result.current.notice).toBe(KEEP_INVITE_EXPIRED));
    expect(h.result.current.confirm).toBeNull();
    expect(loadKeepsRow).not.toHaveBeenCalled();
  });

  it('a replayed launch link is only ever a prompt: nothing opens without the press', async () => {
    // Capacitor's launch URL can be handed over again after the page remounts: a fresh hook holds it as a new arrival.
    const first = mount(ready());
    act(() => first.result.current.hold(invite()));
    await waitFor(() => expect(first.result.current.confirm).not.toBeNull());
    first.unmount();
    const again = mount(ready());
    act(() => again.result.current.hold(invite()));
    await waitFor(() => expect(again.result.current.confirm).not.toBeNull());
    expect(again.result.current.pending).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('saved Keeps that cannot be read: a notice, nothing opened', async () => {
    unreadable = true;
    const h = mount(ready());
    act(() => h.result.current.hold(invite()));
    await waitFor(() => expect(h.result.current.notice).toBe(KEEP_INVITE_UNREADABLE));
    expect(h.result.current.confirm).toBeNull();
    nothingOnTheNetwork();
  });
});

describe('layering, bursts, locking and the dedupe entry', () => {
  it('while a PIN prompt, approval or other prompt is showing the link stays held, then the question appears once it has gone', async () => {
    const h = mount(ready({ otherPromptOpen: true }));
    act(() => h.result.current.hold(invite(), 'url-1'));
    await new Promise(r => setTimeout(r, 30));
    expect(h.result.current.confirm).toBeNull();
    expect(loadKeepsRow).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
    h.rerender(ready({ otherPromptOpen: false }));
    await waitFor(() => expect(h.result.current.confirm).not.toBeNull());
  });

  it('a held link that outlives the prompt in front of it by more than ten minutes expires instead of opening', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-23T10:00:00Z'));
    const h = mount(ready({ otherPromptOpen: true }));
    act(() => h.result.current.hold(invite(), 'url-1'));
    vi.setSystemTime(new Date('2026-11-23T10:11:00Z'));
    h.rerender(ready({ otherPromptOpen: false }));
    await waitFor(() => expect(h.result.current.notice).toBe(KEEP_INVITE_EXPIRED));
    expect(h.result.current.confirm).toBeNull();
  });

  it('while a question is showing, a further link is dropped: the first stays, nothing is queued', async () => {
    const OTHER = getPublicKey(hexToBytes('0'.repeat(63) + '6'));
    row = [stored(K), stored(OTHER, 'Shed Keep')];
    const h = mount(ready());
    act(() => h.result.current.hold(invite(), 'url-1'));
    await waitFor(() => expect(h.result.current.confirm).not.toBeNull());
    onSettled.mockClear();
    act(() => h.result.current.hold(invite({ keep: OTHER, game: 'axenstax' }), 'url-2'));
    await new Promise(r => setTimeout(r, 30));
    expect(h.result.current.confirm).toMatchObject({ keepName: 'Kitchen Keep', gameName: 'Twang Thang', url: 'url-1' });
    expect(onSettled).toHaveBeenCalledWith('url-2');
    // After the first is answered nothing from the dropped link follows.
    act(() => h.result.current.decline());
    await new Promise(r => setTimeout(r, 30));
    expect(h.result.current.confirm).toBeNull();
    expect(loadKeepsRow).toHaveBeenCalledTimes(1);
  });

  it('a link arriving while the first is still being looked up is dropped too', async () => {
    const h = mount(ready());
    act(() => { h.result.current.hold(invite(), 'url-1'); });
    await waitFor(() => expect(loadKeepsRow).toHaveBeenCalledTimes(1));
    act(() => h.result.current.hold(invite({ game: 'axenstax' }), 'url-2'));
    await waitFor(() => expect(h.result.current.confirm).not.toBeNull());
    await new Promise(r => setTimeout(r, 30));
    expect(h.result.current.confirm).toMatchObject({ url: 'url-1', gameName: 'Twang Thang' });
  });

  it('locking while the question shows closes it and lets that link go, so tapping it again after the unlock asks again', async () => {
    const h = mount(ready());
    act(() => h.result.current.hold(invite(), 'url-1'));
    await waitFor(() => expect(h.result.current.confirm).not.toBeNull());
    onSettled.mockClear();
    h.rerender(ready({ unlocked: false, encryptionKey: null }));
    await waitFor(() => expect(h.result.current.confirm).toBeNull());
    expect(onSettled).toHaveBeenCalledWith('url-1');
    expect(h.result.current.pending).toBeNull();
    h.rerender(ready());
    act(() => h.result.current.hold(invite(), 'url-1'));
    await waitFor(() => expect(h.result.current.confirm).not.toBeNull());
  });

  it('hands the link\'s own URL back when it is opened, declined or refused', async () => {
    const h = mount(ready());
    act(() => h.result.current.hold(invite(), 'url-a'));
    await waitFor(() => expect(h.result.current.confirm).not.toBeNull());
    onSettled.mockClear();
    act(() => h.result.current.accept());
    expect(onSettled).toHaveBeenCalledWith('url-a');
    act(() => h.result.current.hold(invite({ keep: OTHER_K }), 'url-b'));
    await waitFor(() => expect(h.result.current.notice).toBe(KEEP_INVITE_NOT_YOURS));
    expect(onSettled).toHaveBeenCalledWith('url-b');
  });

  it('dedupeAfterSettled clears only the settled link\'s own entry', () => {
    expect(dedupeAfterSettled('url-a', 'url-a')).toBeNull();
    expect(dedupeAfterSettled('https://mysignet.app/?auth=1&x=1', 'url-a')).toBe('https://mysignet.app/?auth=1&x=1');
    expect(dedupeAfterSettled('url-a', undefined)).toBe('url-a');
    expect(dedupeAfterSettled(null, 'url-a')).toBeNull();
  });
});
