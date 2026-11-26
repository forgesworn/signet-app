import { describe, it, expect, vi } from 'vitest';
import { runBackdropBackfill } from './backdrop-backfill';
import { buildDependantBackdropLookup, removeBackdropFromChild, sendBackdropToChild, supersedeBackdropSends, type BackdropLinkEnv } from './backdrop-send';
import { backdropDigest } from './backdrop-digest';
import { BACKDROP_COPY } from './child-device-copy';

const SERVER = 'https://nostr.download';
const NP = 'a'.repeat(64), EXTRA = 'c'.repeat(64);
const META = (n: string) => ({ hash: n.repeat(64), blossomUrl: SERVER, keyHex: n.repeat(64), updatedAt: 5 });
const pic = (s: string) => new Blob([s], { type: 'image/jpeg' });

let seq = 0;
/** A dependant with its own id per test, so the module-level slot sequencer never carries over. */
function setupEnv(over: { dep?: Record<string, unknown>; env?: Partial<BackdropLinkEnv>; locals?: Record<string, Blob> } = {}) {
  const id = (++seq).toString(16).padStart(64, '0');
  const dep = {
    id, displayName: 'Lily', bunkerEndpoint: { authorizedClientPubkey: 'f'.repeat(64) }, naturalPersonActive: true,
    naturalPerson: { publicKey: NP }, persona: { publicKey: id }, extraPersonas: [{ publicKey: EXTRA }], ...over.dep,
  };
  const uploads: string[] = [];
  const saves: Array<{ target: string; hash: string | null }> = [];
  let uploadN = 0;
  const env: BackdropLinkEnv = {
    isPairedChild: false, dependants: [dep as never], getKey: () => 'key', blossomUrl: SERVER, blossomConsent: true,
    upload: vi.fn(async (blob: Blob) => { uploads.push(await blob.text()); return META(String((++uploadN) % 10)); }),
    setSlot: vi.fn(async (_d: string, target: string, meta: { hash: string } | null) => { saves.push({ target, hash: meta?.hash ?? null }); return {}; }),
    deleteBlob: vi.fn(async () => 'deleted' as const),
    ...over.env,
  };
  const locals = new Map(Object.entries(over.locals ?? { [id]: pic('persona-pic') }));
  const run = (extra: { attempted?: Map<string, number>; isLive?: () => boolean; readLocal?: (pk: string) => Promise<Blob | null> } = {}) => {
    const lookup = buildDependantBackdropLookup(env);
    return runBackdropBackfill({
      slotPubkeys: () => [id, NP, EXTRA],
      lookup: () => lookup,
      readLocal: extra.readLocal ?? (async pk => locals.get(pk) ?? null),
      digest: backdropDigest,
      attempted: extra.attempted ?? new Map(),
      isLive: extra.isLive ?? (() => true),
    });
  };
  return { id, dep, env, uploads, saves, locals, run };
}

describe('runBackdropBackfill', () => {
  it('sends an unsent slot once per unlock, and not again for the same picture', async () => {
    const s = setupEnv();
    const attempted = new Map<string, number>();
    expect(await s.run({ attempted })).toBe(1);
    expect(s.uploads).toEqual(['persona-pic']);
    expect(s.saves).toEqual([{ target: 'persona', hash: META('1').hash }]);
    // The dependants snapshot is stale (still unsent): the in-memory set stops a resend.
    expect(await s.run({ attempted })).toBe(0);
    expect(s.uploads).toHaveLength(1);
  });

  it('after an unpair and a re-pair in the same unlock the new phone gets the picture again', async () => {
    const s = setupEnv();
    const attempted = new Map<string, number>();
    expect(await s.run({ attempted })).toBe(1);
    // Unpaired: the pointer was cleared and the phone is gone; nothing is sent meanwhile.
    s.dep.bunkerEndpoint = undefined as never;
    expect(await s.run({ attempted })).toBe(0);
    // Re-paired with another phone: the slot reads as unsent again.
    s.dep.bunkerEndpoint = { authorizedClientPubkey: '9'.repeat(64) };
    expect(await s.run({ attempted })).toBe(1);
    expect(s.uploads).toEqual(['persona-pic', 'persona-pic']);
  });

  it('hidden from the phone (sent copy cleared) and shown again in the same unlock: sent again, once', async () => {
    const s = setupEnv();
    const attempted = new Map<string, number>();
    expect(await s.run({ attempted })).toBe(1);
    // The send saved: the reloaded slot records it.
    const digest = await backdropDigest(pic('persona-pic'));
    const sentSlot = { publicKey: s.id, backdropHash: '1'.repeat(64), backdropKey: '1'.repeat(64), backdropBlossomUrl: SERVER, backdropSentDigest: digest };
    s.dep.persona = sentSlot;
    expect(await s.run({ attempted })).toBe(0);
    // Hidden: the hide clears the sent pointer and bumps the slot (useDependants).
    (s.dep as Record<string, unknown>).hiddenOnPairedDeviceKeys = [s.id];
    s.dep.persona = { publicKey: s.id } as never;
    supersedeBackdropSends(s.id, ['persona']);
    expect(await s.run({ attempted })).toBe(0);
    // Shown again: the slot reads unsent, so it goes again.
    (s.dep as Record<string, unknown>).hiddenOnPairedDeviceKeys = [];
    expect(await s.run({ attempted })).toBe(1);
    // And not a third time from the still-stale snapshot.
    expect(await s.run({ attempted })).toBe(0);
    expect(s.uploads).toEqual(['persona-pic', 'persona-pic']);
  });

  it('a failed send is not retried in the same unlock while nothing else touches the slot', async () => {
    const s = setupEnv({ env: { upload: vi.fn(async () => { throw new Error('refused'); }) } });
    const attempted = new Map<string, number>();
    expect(await s.run({ attempted })).toBe(1);
    expect(await s.run({ attempted })).toBe(0);
    expect(await s.run({ attempted })).toBe(0);
  });

  it('a different picture on the same slot is a new attempt', async () => {
    const s = setupEnv();
    const attempted = new Map<string, number>();
    await s.run({ attempted });
    s.locals.set(s.id, pic('new-pic'));
    await s.run({ attempted });
    expect(s.uploads).toEqual(['persona-pic', 'new-pic']);
  });

  it('skips a slot that recorded sending this exact picture, and resends one that sent another', async () => {
    const digest = await backdropDigest(pic('persona-pic'));
    const sent = (d: string) => ({ publicKey: '', backdropHash: '1'.repeat(64), backdropKey: '1'.repeat(64), backdropBlossomUrl: SERVER, backdropSentDigest: d });
    const same = setupEnv();
    same.dep.persona = { ...sent(digest), publicKey: same.id };
    expect(await same.run()).toBe(0);
    const other = setupEnv();
    other.dep.persona = { ...sent('0'.repeat(64)), publicKey: other.id };
    expect(await other.run()).toBe(1);
  });

  it('skips a slot with no local picture, a hidden slot, an unpaired dependant and a dormant real-name slot', async () => {
    const none = setupEnv({ locals: {} });
    expect(await none.run()).toBe(0);
    const hidden = setupEnv({ dep: { hiddenOnPairedDeviceKeys: [EXTRA] }, locals: { [EXTRA]: pic('x') } });
    expect(await hidden.run()).toBe(0);
    const unpaired = setupEnv({ dep: { bunkerEndpoint: undefined } });
    expect(await unpaired.run()).toBe(0);
    const dormant = setupEnv({ dep: { naturalPersonActive: false }, locals: { [NP]: pic('x') } });
    expect(await dormant.run()).toBe(0);
    for (const s of [none, hidden, unpaired, dormant]) expect(s.uploads).toEqual([]);
  });

  it('does nothing on a paired-child install, while locked, or without consent', async () => {
    const child = setupEnv({ env: { isPairedChild: true } });
    expect(await child.run()).toBe(0);
    const locked = setupEnv({ env: { getKey: () => null } });
    expect(await locked.run()).toBe(0);
    const noConsent = setupEnv({ env: { blossomConsent: false } });
    await noConsent.run();
    for (const s of [child, locked, noConsent]) { expect(s.uploads).toEqual([]); expect(s.saves).toEqual([]); }
  });

  it('stops as soon as the run is no longer live', async () => {
    const s = setupEnv({ locals: { ['x']: pic('x') } });
    expect(await s.run({ isLive: () => false })).toBe(0);
    expect(s.uploads).toEqual([]);
  });

  it('skips a slot with a user send in flight, and never supersedes it', async () => {
    const s = setupEnv();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const slotKey = `${s.id}:persona`;
    const userSend = sendBackdropToChild(pic('user-pic'), {
      slotKey, encryptionKey: 'key', getKey: () => 'key', blossomUrl: SERVER, blossomConsent: true,
      upload: async () => { await gate; return META('9'); },
      saveSlot: async meta => { s.saves.push({ target: 'persona', hash: meta?.hash ?? null }); return {}; },
      deleteBlob: async () => 'deleted',
    });
    expect(await s.run()).toBe(0);
    release();
    expect((await userSend).ok).toBe(true);
    expect(s.uploads).toEqual([]);
    expect(s.saves).toEqual([{ target: 'persona', hash: META('9').hash }]);
  });

  it('skips a slot with a user remove in flight', async () => {
    const s = setupEnv();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const removal = removeBackdropFromChild({
      slotKey: `${s.id}:persona`,
      saveSlot: async () => { await gate; return {}; },
      deleteBlob: async () => 'deleted',
    });
    expect(await s.run()).toBe(0);
    release();
    await removal;
    expect(s.uploads).toEqual([]);
  });

  it('a user set that starts after the backfill looked at the slot but before it sent wins', async () => {
    const s = setupEnv();
    const slotKey = `${s.id}:persona`;
    let userDone: Promise<unknown> = Promise.resolve();
    const readLocal = async (pk: string) => {
      // While the backfill reads the stored picture, the user picks another one.
      if (pk === s.id) {
        userDone = sendBackdropToChild(pic('user-pic'), {
          slotKey, encryptionKey: 'key', getKey: () => 'key', blossomUrl: SERVER, blossomConsent: true,
          upload: async () => META('9'),
          saveSlot: async meta => { s.saves.push({ target: 'persona', hash: meta?.hash ?? null }); return {}; },
          deleteBlob: async () => 'deleted',
        });
      }
      return s.locals.get(pk) ?? null;
    };
    await s.run({ readLocal });
    await userDone;
    expect(s.uploads).toEqual([]);
    expect(s.saves).toEqual([{ target: 'persona', hash: META('9').hash }]);
  });

  it('a user set that starts while the backfill is uploading wins: the backfill discards its upload', async () => {
    const s = setupEnv();
    const slotKey = `${s.id}:persona`;
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    s.env.upload = vi.fn(async () => { await gate; return META('1'); });
    const deleted: string[] = [];
    s.env.deleteBlob = vi.fn(async (_d: string, hash: string) => { deleted.push(hash); return 'deleted' as const; });
    const run = s.run();
    await vi.waitFor(() => expect(s.env.upload).toHaveBeenCalled());
    const user = await sendBackdropToChild(pic('user-pic'), {
      slotKey, encryptionKey: 'key', getKey: () => 'key', blossomUrl: SERVER, blossomConsent: true,
      upload: async () => META('9'),
      saveSlot: async meta => { s.saves.push({ target: 'persona', hash: meta?.hash ?? null }); return {}; },
      deleteBlob: async () => 'deleted',
    });
    expect(user.ok).toBe(true);
    release();
    await run;
    // Only the user's pointer was saved; the backfill's blob was thrown away.
    expect(s.saves).toEqual([{ target: 'persona', hash: META('9').hash }]);
    await vi.waitFor(() => expect(deleted).toContain(META('1').hash));
  });

  it('hidden while the backfill is uploading, then shown again in the same unlock: sent again', async () => {
    const s = setupEnv();
    const attempted = new Map<string, number>();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let n = 0;
    s.env.upload = vi.fn(async (blob: Blob) => { s.uploads.push(await blob.text()); if (++n === 1) await gate; return META('1'); });
    const first = s.run({ attempted });
    await vi.waitFor(() => expect(s.env.upload).toHaveBeenCalled());
    // Hidden mid-upload: the hide bumps the slot, so the upload is discarded.
    (s.dep as Record<string, unknown>).hiddenOnPairedDeviceKeys = [s.id];
    supersedeBackdropSends(s.id, ['persona']);
    release();
    await first;
    expect(s.saves).toEqual([]);
    // Shown again: nothing bumps, but the discarded attempt must not count as tried.
    (s.dep as Record<string, unknown>).hiddenOnPairedDeviceKeys = [];
    expect(await s.run({ attempted })).toBe(1);
    expect(s.saves).toEqual([{ target: 'persona', hash: META('1').hash }]);
  });

  it('reports a superseded backfill with the superseded reason', async () => {
    const s = setupEnv();
    const link = buildDependantBackdropLookup(s.env)(s.id)!;
    const result = await link.send(pic('x'), { backfill: { generation: -1 } });
    expect(result).toEqual({ ok: false, reason: BACKDROP_COPY.reasons.superseded });
  });
});
