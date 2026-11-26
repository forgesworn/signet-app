import { describe, it, expect, vi } from 'vitest';
import { syncGuardianBackdrops, dropGuardianBackdrops, slotsOf, type GuardianBackdropDeps } from './guardian-backdrop-sync';

const PERSONA = 'a'.repeat(64), NP = 'b'.repeat(64), EXTRA = 'c'.repeat(64), GONE = 'd'.repeat(64);
const H = (n: string) => n.repeat(64);
const bd = (n: string) => ({ backdropHash: H(n), backdropBlossomUrl: 'https://nostr.download', backdropKey: H(n), backdropUpdatedAt: 1 });
const BLOB = new Blob(['jpeg'], { type: 'image/jpeg' });

function identity(over: Record<string, unknown> = {}) {
  return {
    id: PERSONA,
    naturalPerson: { publicKey: NP }, persona: { publicKey: PERSONA, ...bd('1') }, extraPersonas: [{ publicKey: EXTRA }], ...over,
  };
}

function makeDeps(rows: { own?: string[]; guardian?: Record<string, string> } = {}, over: Partial<GuardianBackdropDeps> = {}) {
  const guardian = new Map(Object.entries(rows.guardian ?? {}));
  const own = new Set(rows.own ?? []);
  const refreshed: string[] = [];
  const deps: GuardianBackdropDeps = {
    fetchBackdrop: vi.fn(async () => BLOB),
    getGuardianBackdrop: vi.fn(async (pk: string) => (guardian.has(pk) ? { blob: BLOB, hash: guardian.get(pk)! } : null)),
    setGuardianBackdrop: vi.fn(async (pk: string, _b: Blob, hash: string) => { guardian.set(pk, hash); }),
    deleteGuardianBackdrop: vi.fn(async (pk: string) => { guardian.delete(pk); }),
    deleteOwnBackdrop: vi.fn(async (pk: string) => { own.delete(pk); }),
    listRowPubkeys: vi.fn(async () => ({ own: [...own], guardian: [...guardian.keys()] })),
    loadDeviceKeepSet: vi.fn(async () => new Set<string>()),
    refresh: vi.fn(async (pk: string) => { refreshed.push(pk); }),
    isLive: () => true,
    ...over,
  };
  return { deps, guardian, own, refreshed };
}

describe('syncGuardianBackdrops', () => {
  it('fetches a slot\'s backdrop, stores it with its hash in the guardian row and repaints', async () => {
    const { deps, guardian, refreshed } = makeDeps();
    await syncGuardianBackdrops(identity(), deps);
    expect(deps.fetchBackdrop).toHaveBeenCalledWith({ hash: H('1'), blossomUrl: 'https://nostr.download', keyHex: H('1') });
    expect(deps.setGuardianBackdrop).toHaveBeenCalledWith(PERSONA, BLOB, H('1'));
    expect(guardian.get(PERSONA)).toBe(H('1'));
    expect(refreshed).toContain(PERSONA);
  });

  it('does not fetch again when the stored guardian copy has the same hash', async () => {
    const { deps } = makeDeps({ guardian: { [PERSONA]: H('1') } });
    await syncGuardianBackdrops(identity(), deps);
    expect(deps.fetchBackdrop).not.toHaveBeenCalled();
    expect(deps.setGuardianBackdrop).not.toHaveBeenCalled();
  });

  it('fetches again when the guardian changed the picture (different hash)', async () => {
    const { deps, guardian } = makeDeps({ guardian: { [PERSONA]: H('9') } });
    await syncGuardianBackdrops(identity(), deps);
    expect(deps.fetchBackdrop).toHaveBeenCalledTimes(1);
    expect(guardian.get(PERSONA)).toBe(H('1'));
  });

  it('covers the real-name slot and extras too', async () => {
    const { deps } = makeDeps();
    await syncGuardianBackdrops(identity({ naturalPerson: { publicKey: NP, ...bd('2') }, extraPersonas: [{ publicKey: EXTRA, ...bd('3') }] }), deps);
    expect((deps.setGuardianBackdrop as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]).sort()).toEqual([PERSONA, NP, EXTRA].sort());
  });

  it('a failed fetch is silent, leaves any earlier copy in place and is retried on the next run', async () => {
    const { deps, guardian } = makeDeps({ guardian: { [PERSONA]: H('9') } }, { fetchBackdrop: vi.fn(async () => { throw new Error('offline'); }) });
    await expect(syncGuardianBackdrops(identity(), deps)).resolves.toBeUndefined();
    expect(guardian.get(PERSONA)).toBe(H('9'));
    (deps.fetchBackdrop as ReturnType<typeof vi.fn>).mockResolvedValueOnce(BLOB);
    await syncGuardianBackdrops(identity(), deps);
    expect(guardian.get(PERSONA)).toBe(H('1'));
  });

  it('a slot with no backdrop fields deletes its guardian row', async () => {
    const { deps, guardian, refreshed } = makeDeps({ guardian: { [PERSONA]: H('1') } });
    await syncGuardianBackdrops(identity({ persona: { publicKey: PERSONA } }), deps);
    expect(guardian.has(PERSONA)).toBe(false);
    expect(refreshed).toContain(PERSONA);
    expect(deps.fetchBackdrop).not.toHaveBeenCalled();
  });

  it('never touches the child\'s own pick on a slot that is still in the inventory', async () => {
    const { deps, own } = makeDeps({ own: [PERSONA, EXTRA] });
    await syncGuardianBackdrops(identity({ persona: { publicKey: PERSONA } }), deps);
    expect(deps.deleteOwnBackdrop).not.toHaveBeenCalled();
    expect(own.has(PERSONA)).toBe(true);
  });

  it('a persona that left the inventory loses both its guardian row and the child\'s own row', async () => {
    const { deps, guardian, own, refreshed } = makeDeps({ own: [GONE, PERSONA], guardian: { [GONE]: H('5') } });
    await syncGuardianBackdrops(identity(), deps);
    expect(guardian.has(GONE)).toBe(false);
    expect(own.has(GONE)).toBe(false);
    expect(own.has(PERSONA)).toBe(true);
    expect(refreshed).toContain(GONE);
  });

  it('keeps a row keyed by the identity id even when no slot carries it (the pair-time stub)', async () => {
    const { deps, own } = makeDeps({ own: [GONE] });
    await syncGuardianBackdrops(identity({ id: GONE }), deps);
    expect(own.has(GONE)).toBe(true);
  });

  it('sweeps rows a crashed earlier run left behind (idempotent key-range scan)', async () => {
    const { deps, own } = makeDeps({ own: [GONE] });
    await syncGuardianBackdrops(identity(), deps);
    await syncGuardianBackdrops(identity(), deps);
    expect(own.size).toBe(0);
  });

  it('refuses to sweep when the identity names no slot at all (a bad or empty inventory must not wipe the child\'s pictures)', async () => {
    const { deps, own } = makeDeps({ own: [GONE, PERSONA] });
    await syncGuardianBackdrops({ id: PERSONA, naturalPerson: { publicKey: '' }, persona: { publicKey: '' }, extraPersonas: [] }, deps);
    expect(deps.listRowPubkeys).not.toHaveBeenCalled();
    expect(own.size).toBe(2);
    await syncGuardianBackdrops(null, deps);
    expect(own.size).toBe(2);
  });

  it('stores nothing and repaints nothing once the run has been cancelled (lock, unmount)', async () => {
    let live = true;
    const { deps } = makeDeps({}, { fetchBackdrop: vi.fn(async () => { live = false; return BLOB; }), isLive: () => live });
    await syncGuardianBackdrops(identity(), deps);
    expect(deps.setGuardianBackdrop).not.toHaveBeenCalled();
    expect(deps.refresh).not.toHaveBeenCalled();
  });

  it('two overlapping runs fetch a given picture once', async () => {
    let release!: (b: Blob) => void;
    const slow = vi.fn(() => new Promise<Blob>(r => { release = r; }));
    const { deps } = makeDeps({}, { fetchBackdrop: slow });
    const a = syncGuardianBackdrops(identity(), deps);
    const b = syncGuardianBackdrops(identity(), deps);
    await new Promise(r => setTimeout(r, 0));
    release(BLOB);
    await Promise.all([a, b]);
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it('a live run that joins a cancelled run\'s fetch still stores the picture (one fetch)', async () => {
    let release!: (b: Blob) => void;
    const slow = vi.fn(() => new Promise<Blob>(r => { release = r; }));
    let aLive = true;
    const { deps: depsA, guardian } = makeDeps({}, { fetchBackdrop: slow, isLive: () => aLive });
    const depsB: GuardianBackdropDeps = { ...depsA, isLive: () => true };
    const a = syncGuardianBackdrops(identity(), depsA);
    await new Promise(r => setTimeout(r, 0));
    aLive = false;                                   // another inventory event cancelled run A
    const b = syncGuardianBackdrops(identity(), depsB);
    await new Promise(r => setTimeout(r, 0));
    release(BLOB);
    await Promise.all([a, b]);
    expect(slow).toHaveBeenCalledTimes(1);
    expect(guardian.get(PERSONA)).toBe(H('1'));
  });

  it('keeps the other paired children\'s pictures: rows for pubkeys on the device\'s other accounts survive the sweep', async () => {
    const OTHER = 'e'.repeat(64);
    const { deps, own, guardian } = makeDeps({ own: [OTHER, GONE], guardian: { [OTHER]: H('8') } }, { loadDeviceKeepSet: vi.fn(async () => new Set([OTHER])) });
    await syncGuardianBackdrops(identity(), deps);
    expect(own.has(OTHER)).toBe(true);
    expect(guardian.has(OTHER)).toBe(true);
    expect(own.has(GONE)).toBe(false);
  });

  it('sweeps nothing when the device\'s other accounts cannot be read', async () => {
    const { deps, own } = makeDeps({ own: [GONE] }, { loadDeviceKeepSet: vi.fn(async () => null) });
    await syncGuardianBackdrops(identity(), deps);
    expect(own.has(GONE)).toBe(true);
    expect(deps.deleteOwnBackdrop).not.toHaveBeenCalled();
  });

  it('a key shared by two slots is one picture: the pointer wins, and the row is stored and kept', async () => {
    const { deps, guardian } = makeDeps();
    await syncGuardianBackdrops(identity({ naturalPerson: { publicKey: PERSONA } }), deps);
    expect(guardian.get(PERSONA)).toBe(H('1'));
    expect(deps.deleteGuardianBackdrop).not.toHaveBeenCalled();
  });
});

describe('slotsOf', () => {
  it('lists non-empty slot keys with their pointer, persona first', () => {
    expect(slotsOf(identity()).map(s => s.pubkey)).toEqual([PERSONA, NP, EXTRA]);
    expect(slotsOf(identity())[0].pointer).toEqual({ hash: H('1'), blossomUrl: 'https://nostr.download', keyHex: H('1') });
    expect(slotsOf(identity())[1].pointer).toBeNull();
  });

  it('treats a half-formed pointer as none, and lowercases nothing it did not get', () => {
    expect(slotsOf(identity({ persona: { publicKey: PERSONA, backdropHash: H('1') } }))[0].pointer).toBeNull();
  });

  it('lists a pubkey once, with the pointer from whichever slot has one', () => {
    const slots = slotsOf(identity({ naturalPerson: { publicKey: PERSONA }, persona: { publicKey: PERSONA } }));
    expect(slots.filter(s => s.pubkey === PERSONA)).toHaveLength(1);
    const reversed = slotsOf(identity({ persona: { publicKey: PERSONA }, naturalPerson: { publicKey: PERSONA, ...bd('4') } }));
    expect(reversed.find(s => s.pubkey === PERSONA)!.pointer?.hash).toBe(H('4'));
  });

  it('skips a slot with no key yet (a dormant real identity)', () => {
    expect(slotsOf({ id: GONE, naturalPerson: { publicKey: '' }, persona: { publicKey: PERSONA }, extraPersonas: [] }).map(s => s.pubkey)).toEqual([PERSONA]);
  });
});

describe('an unpair that lands while a sync pass is running', () => {
  it('a pass still fetching when the drop runs writes no row afterwards', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const { deps, guardian } = makeDeps({}, { fetchBackdrop: vi.fn(async () => { await gate; return BLOB; }) });
    const running = syncGuardianBackdrops(identity(), deps);
    await vi.waitFor(() => expect(deps.fetchBackdrop).toHaveBeenCalled());
    await dropGuardianBackdrops(deps);
    release();
    await running;
    expect(deps.setGuardianBackdrop).not.toHaveBeenCalled();
    expect(guardian.size).toBe(0);
  });

  it('a row already being written when the drop runs is deleted by it', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const store = makeDeps();
    const deps = { ...store.deps, setGuardianBackdrop: vi.fn(async (pk: string, _b: Blob, hash: string) => { await gate; store.guardian.set(pk, hash); }) };
    const running = syncGuardianBackdrops(identity(), deps);
    await vi.waitFor(() => expect(deps.setGuardianBackdrop).toHaveBeenCalled());
    const dropping = dropGuardianBackdrops(deps);
    release();
    await Promise.all([running, dropping]);
    expect(store.guardian.size).toBe(0);
  });

  it('a pass started after the drop (a re-pair) writes as normal', async () => {
    const { deps, guardian } = makeDeps();
    await dropGuardianBackdrops(deps);
    await syncGuardianBackdrops(identity(), deps);
    expect(guardian.get(PERSONA)).toBe(H('1'));
  });
});
