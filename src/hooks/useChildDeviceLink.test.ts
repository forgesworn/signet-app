// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { NostrEvent } from 'signet-protocol';
import { buildChildRulesEvent, CHILD_RULES_WIRE_D_TAG, type ChildRulesPayload } from '../lib/child-rules-wire';
import { clearChildRulesCache, loadChildRulesCache, saveChildRulesCache } from '../lib/db';
import type { BunkerBackendRouter } from '../lib/bunker-router';
import type { PairedChildRecord } from '../types';
import { useChildDeviceLink, APPROVE_IDENTITY_PLAINTEXT, type ChildLinkTransport } from './useChildDeviceLink';
import { buildUnpairedNotice, CHILD_UNPAIRED_D_TAG } from '../lib/child-activity';
import { withRequestCreatedAt } from '../lib/signing-backend';

const KEY = 'k'.repeat(64);
const DEP = 'ef'.repeat(32);
const PERSONA = 'ab'.repeat(32), EXTRA = '34'.repeat(32), NP = '56'.repeat(32);
const railSk = generateSecretKey(), railPriv = bytesToHex(railSk), railPub = getPublicKey(railSk);
const clientSk = generateSecretKey(), clientPriv = bytesToHex(clientSk), clientPub = getPublicKey(clientSk);

function record(over: Partial<PairedChildRecord> = {}): PairedChildRecord {
  return {
    id: DEP, bunkerUri: `bunker://${PERSONA}?relay=wss%3A%2F%2Fhw.example`,
    clientKeypair: { publicKey: clientPub, privateKey: clientPriv },
    dependantPubkey: DEP, dependantName: 'Alice', pairedAt: 1, hasPaired: true,
    mode: 'heartwood-direct', railPubkey: railPub, personaPubkey: PERSONA,
    hwRelays: ['wss://hw.example'], railRelay: 'wss://rail.example',
    personas: [{ pubkey: PERSONA, name: 'Ally', role: 'persona' }, { pubkey: EXTRA, name: 'Gamer', role: 'extra' }],
    ...over,
  };
}

function payload(updatedAt: number, stage: ChildRulesPayload['stage'] = 'request-approve'): ChildRulesPayload {
  return { v: 1, dependantId: DEP, stage, ceilingKinds: [1], rules: [], disconnectedApps: [], updatedAt };
}

function fakeTransport() {
  const subs: { filters: unknown[]; relays: string[]; onEvent: (e: NostrEvent) => void; closed: boolean }[] = [];
  const t: ChildLinkTransport = {
    subscribe: (filters, relays, onEvent) => {
      const s = { filters, relays, onEvent, closed: false };
      subs.push(s);
      return () => { s.closed = true; };
    },
  };
  return { t, subs };
}

function fakeRouter(behaviour: Record<string, 'ok' | 'fail'>, primaryClient: string = clientPub, confirm: () => Promise<string> = async () => PERSONA) {
  const calls: { slot: string; args: string[] }[] = [];
  const router = {
    primaryClientPubkeyHex: primaryClient,
    primary: { request: async () => confirm() },
    backendFor: (slot: string) => ({
      nip44Encrypt: async (recipient: string, text: string) => {
        calls.push({ slot, args: [recipient, text] });
        if (behaviour[slot] === 'fail') throw new Error('denied');
        return 'ciphertext';
      },
    }),
  } as unknown as BunkerBackendRouter;
  return { router, calls, behaviour };
}

beforeEach(async () => { await clearChildRulesCache(DEP); });

describe('useChildDeviceLink — rules', () => {
  it('no cache and no live rules → rules null (fail closed)', async () => {
    const { t } = fakeTransport();
    const { result } = renderHook(() => useChildDeviceLink({ record: record(), encryptionKey: KEY, router: null, onRecordUpdated: async () => {}, transport: t }));
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(result.current.rules).toBeNull();
    expect(result.current.unpaired).toBe(false);
  });

  it('subscribes on the rail relay, applies a live payload, caches it encrypted, and it survives a remount', async () => {
    const { t, subs } = fakeTransport();
    const opts = { record: record(), encryptionKey: KEY, router: null, onRecordUpdated: async () => {}, transport: t };
    const first = renderHook(() => useChildDeviceLink(opts));
    await waitFor(() => expect(subs.length).toBe(1));
    expect(subs[0].relays).toEqual(['wss://rail.example']);
    expect(subs[0].filters[0]).toMatchObject({ kinds: [30078], authors: [railPub], '#d': [CHILD_RULES_WIRE_D_TAG], '#p': [clientPub] });
    await act(async () => { subs[0].onEvent(await buildChildRulesEvent(payload(100), railPriv, clientPub, 1_800_000_000)); });
    await waitFor(() => expect(first.result.current.rules?.updatedAt).toBe(100));
    await waitFor(async () => expect((await loadChildRulesCache(DEP, KEY))?.updatedAt).toBe(100));
    first.unmount();
    expect(subs[0].closed).toBe(true);

    const second = renderHook(() => useChildDeviceLink(opts));
    await waitFor(() => expect(second.result.current.rules?.updatedAt).toBe(100));
  });

  it('keeps the newest payload: an older event is ignored (A18)', async () => {
    await saveChildRulesCache(DEP, payload(200, 'full-control'), KEY);
    const { t, subs } = fakeTransport();
    const { result } = renderHook(() => useChildDeviceLink({ record: record(), encryptionKey: KEY, router: null, onRecordUpdated: async () => {}, transport: t }));
    await waitFor(() => expect(result.current.rules?.updatedAt).toBe(200));
    await waitFor(() => expect(subs.length).toBe(1));
    await act(async () => { subs[0].onEvent(await buildChildRulesEvent(payload(150, 'full-autonomy'), railPriv, clientPub, 1_800_000_000)); });
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(result.current.rules?.stage).toBe('full-control');
    expect((await loadChildRulesCache(DEP, KEY))?.updatedAt).toBe(200);
  });

  it('ignores rules signed by anyone but the rail key', async () => {
    const { t, subs } = fakeTransport();
    const { result } = renderHook(() => useChildDeviceLink({ record: record(), encryptionKey: KEY, router: null, onRecordUpdated: async () => {}, transport: t }));
    await waitFor(() => expect(subs.length).toBe(1));
    await act(async () => { subs[0].onEvent(await buildChildRulesEvent(payload(100), bytesToHex(generateSecretKey()), clientPub, 1_800_000_000)); });
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(result.current.rules).toBeNull();
  });

  it('does nothing for a legacy phone pairing', async () => {
    const { t, subs } = fakeTransport();
    const { result } = renderHook(() => useChildDeviceLink({ record: record({ mode: undefined }), encryptionKey: KEY, router: null, onRecordUpdated: async () => {}, transport: t }));
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(subs).toHaveLength(0);
    expect(result.current.rules).toBeNull();
    expect(result.current.personas).toEqual([]);
  });
});

describe('useChildDeviceLink — identity approvals ceremony', () => {
  it('asks the Heartwood once per non-bound persona, as that persona, and records approved / failed', async () => {
    const { t } = fakeTransport();
    const { router, calls } = fakeRouter({ [NP]: 'fail' });
    const saved: PairedChildRecord[] = [];
    const { result } = renderHook(() => useChildDeviceLink({
      record: record(), encryptionKey: KEY, router, transport: t,
      inventoryPersonas: [{ pubkey: NP, name: 'Alice Real' }],
      onRecordUpdated: async (r) => { saved.push(r); },
    }));
    await waitFor(() => expect(result.current.personas.find(p => p.pubkey === NP)?.approval).toBe('failed'));
    await waitFor(() => expect(result.current.personas.find(p => p.pubkey === EXTRA)?.approval).toBe('approved'));
    expect(result.current.personas.find(p => p.pubkey === PERSONA)?.approval).toBe('approved');
    expect(calls.map(c => c.slot).sort()).toEqual([EXTRA, NP].sort());
    for (const c of calls) expect(c.args).toEqual([c.slot, APPROVE_IDENTITY_PLAINTEXT]);
    expect(saved.at(-1)?.identityApprovals).toMatchObject({ [EXTRA]: 'approved', [NP]: 'failed' });
  });

  it('retryApproval re-asks a failed persona', async () => {
    const { t } = fakeTransport();
    const fr = fakeRouter({ [EXTRA]: 'fail' });
    const { result } = renderHook(() => useChildDeviceLink({ record: record(), encryptionKey: KEY, router: fr.router, transport: t, onRecordUpdated: async () => {} }));
    await waitFor(() => expect(result.current.personas.find(p => p.pubkey === EXTRA)?.approval).toBe('failed'));
    fr.behaviour[EXTRA] = 'ok';
    await act(async () => { await result.current.retryApproval(EXTRA); });
    expect(result.current.personas.find(p => p.pubkey === EXTRA)?.approval).toBe('approved');
    expect(fr.calls.filter(c => c.slot === EXTRA)).toHaveLength(2);
  });

  it('does not re-ask a persona already approved, and runs for a persona that appears later', async () => {
    const { t } = fakeTransport();
    const fr = fakeRouter({});
    let inv = [{ pubkey: EXTRA, name: 'Gamer' }];
    const { result, rerender } = renderHook(() => useChildDeviceLink({
      record: record({ identityApprovals: { [EXTRA]: 'approved' } }), encryptionKey: KEY, router: fr.router, transport: t,
      inventoryPersonas: inv, onRecordUpdated: async () => {},
    }));
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(fr.calls).toHaveLength(0);
    inv = [...inv, { pubkey: NP, name: 'Alice Real' }];
    rerender();
    await waitFor(() => expect(result.current.personas.find(p => p.pubkey === NP)?.approval).toBe('approved'));
    expect(fr.calls.map(c => c.slot)).toEqual([NP]);
  });

  it('A27: a router still bound to an older pairing client is never used for the ceremony', async () => {
    const { t } = fakeTransport();
    const stale = fakeRouter({}, getPublicKey(generateSecretKey()));
    const { result, rerender } = renderHook(({ router }) => useChildDeviceLink({
      record: record(), encryptionKey: KEY, router, transport: t, onRecordUpdated: async () => {},
    }), { initialProps: { router: stale.router } });
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(stale.calls).toHaveLength(0);
    expect(result.current.personas.find(p => p.pubkey === EXTRA)?.approval).toBe('waiting');
    const fresh = fakeRouter({});
    rerender({ router: fresh.router });
    await waitFor(() => expect(result.current.personas.find(p => p.pubkey === EXTRA)?.approval).toBe('approved'));
    expect(stale.calls).toHaveLength(0);
  });

  it('A26: a withheld (dormant) real identity is never asked for, even if the pairing reply listed it', async () => {
    const { t } = fakeTransport();
    const fr = fakeRouter({});
    const { result } = renderHook(() => useChildDeviceLink({
      record: record({ personas: [{ pubkey: PERSONA, name: 'Ally', role: 'persona' }, { pubkey: NP, name: 'Alice', role: 'natural-person' }, { pubkey: EXTRA, name: 'Gamer', role: 'extra' }] }),
      encryptionKey: KEY, router: fr.router, transport: t, withheldSlots: [NP], onRecordUpdated: async () => {},
    }));
    await waitFor(() => expect(result.current.personas.find(p => p.pubkey === EXTRA)?.approval).toBe('approved'));
    expect(result.current.personas.some(p => p.pubkey === NP)).toBe(false);
    expect(fr.calls.map(c => c.slot)).toEqual([EXTRA]);
  });

  it('A43: retryApproval refuses a persona outside the ceremony candidates (a withheld dormant NP, a stranger)', async () => {
    const { t } = fakeTransport();
    const fr = fakeRouter({});
    const { result } = renderHook(() => useChildDeviceLink({
      record: record({ personas: [{ pubkey: PERSONA, name: 'Ally', role: 'persona' }, { pubkey: NP, name: 'Alice', role: 'natural-person' }, { pubkey: EXTRA, name: 'Gamer', role: 'extra' }] }),
      encryptionKey: KEY, router: fr.router, transport: t, withheldSlots: [NP], onRecordUpdated: async () => {},
    }));
    await waitFor(() => expect(result.current.personas.find(p => p.pubkey === EXTRA)?.approval).toBe('approved'));
    await act(async () => { await result.current.retryApproval(NP); });
    await act(async () => { await result.current.retryApproval('99'.repeat(32)); });
    expect(fr.calls.map(c => c.slot)).toEqual([EXTRA]);
  });

  it('waits for the router before asking', async () => {
    const { t } = fakeTransport();
    const { result } = renderHook(() => useChildDeviceLink({ record: record(), encryptionKey: KEY, router: null, transport: t, onRecordUpdated: async () => {} }));
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(result.current.personas.find(p => p.pubkey === EXTRA)?.approval).toBe('waiting');
  });
});

describe('useChildDeviceLink — unpaired (§9.4)', () => {
  const stamped = (fail: string | null, persona: string = PERSONA) => ({
    activePublicKeyHex: persona,
    stamped: () => ({
      signEvent: async () => { if (fail) throw fail; return {} as never; },
      nip44Encrypt: async () => 'x', nip44Decrypt: async () => 'x',
    }),
  }) as unknown as import('../lib/signing-backend').DecryptingSigningBackend;

  it('the rail-key notice for this client sets unpaired and clears the rules cache', async () => {
    await saveChildRulesCache(DEP, payload(100), KEY);
    const { t, subs } = fakeTransport();
    const { result } = renderHook(() => useChildDeviceLink({ record: record(), encryptionKey: KEY, router: null, onRecordUpdated: async () => {}, transport: t }));
    await waitFor(() => expect(result.current.rules?.updatedAt).toBe(100));
    expect(subs[0].filters[1]).toMatchObject({ kinds: [30078], authors: [railPub], '#d': [CHILD_UNPAIRED_D_TAG], '#p': [clientPub] });
    await act(async () => { subs[0].onEvent(buildUnpairedNotice(railPriv, clientPub)); });
    expect(result.current.unpaired).toBe(true);
    expect(result.current.rules).toBeNull();
    await waitFor(async () => expect(await loadChildRulesCache(DEP, KEY)).toBeNull());
  });

  it('a notice from the wrong author is ignored', async () => {
    const { t, subs } = fakeTransport();
    const { result } = renderHook(() => useChildDeviceLink({ record: record(), encryptionKey: KEY, router: null, onRecordUpdated: async () => {}, transport: t }));
    await waitFor(() => expect(subs.length).toBe(1));
    const stranger = bytesToHex(generateSecretKey());
    await act(async () => { subs[0].onEvent({ ...buildUnpairedNotice(stranger, clientPub), pubkey: railPub }); });
    await act(async () => { subs[0].onEvent(buildUnpairedNotice(stranger, clientPub)); });
    expect(result.current.unpaired).toBe(false);
  });

  it('three "unauthorised" answers in a row from the Heartwood set unpaired; a success in between resets', async () => {
    const { t } = fakeTransport();
    const { router } = fakeRouter({}, clientPub, async () => { throw new Error('unauthorised'); });
    const { result } = renderHook(() => useChildDeviceLink({ record: record(), encryptionKey: KEY, router, onRecordUpdated: async () => {}, transport: t }));
    const call = (fail: string | null) => withRequestCreatedAt(stamped(fail), 5).signEvent({} as never).catch(() => {});
    await act(async () => { await call('unauthorised'); await call('unauthorised'); await call(null); await call('unauthorised'); await call('unauthorised'); });
    expect(result.current.unpaired).toBe(false);
    await act(async () => { await call('user denied'); });
    expect(result.current.unpaired).toBe(false);
    await act(async () => { await call('unauthorised'); await call('unauthorised'); await call('unauthorised'); });
    await waitFor(() => expect(result.current.unpaired).toBe(true));
  });

  it('A62: three refusals but the confirmation succeeds → not unpaired, strikes reset', async () => {
    const { t } = fakeTransport();
    const { router } = fakeRouter({}, clientPub, async () => PERSONA);
    const { result } = renderHook(() => useChildDeviceLink({ record: record(), encryptionKey: KEY, router, onRecordUpdated: async () => {}, transport: t }));
    const call = () => withRequestCreatedAt(stamped('unauthorised'), 5).signEvent({} as never).catch(() => {});
    await act(async () => { await call(); await call(); await call(); await new Promise(r => setTimeout(r, 20)); });
    expect(result.current.unpaired).toBe(false);
    // Strikes were reset: two more refusals are not enough.
    await act(async () => { await call(); await call(); await new Promise(r => setTimeout(r, 20)); });
    expect(result.current.unpaired).toBe(false);
  });

  it('A62: three refusals and the confirmation is unauthorised → unpaired', async () => {
    const { t } = fakeTransport();
    const { router } = fakeRouter({}, clientPub, async () => { throw new Error('Unauthorized'); });
    const { result } = renderHook(() => useChildDeviceLink({ record: record(), encryptionKey: KEY, router, onRecordUpdated: async () => {}, transport: t }));
    const call = () => withRequestCreatedAt(stamped('unauthorised'), 5).signEvent({} as never).catch(() => {});
    await act(async () => { await call(); await call(); await call(); });
    await waitFor(() => expect(result.current.unpaired).toBe(true));
  });

  it('A51: refusals on another persona route never count — only the bound primary connection', async () => {
    const { t } = fakeTransport();
    const { router } = fakeRouter({}, clientPub, async () => { throw new Error('unauthorised'); });
    const { result } = renderHook(() => useChildDeviceLink({ record: record(), encryptionKey: KEY, router, onRecordUpdated: async () => {}, transport: t }));
    const call = (persona: string) => withRequestCreatedAt(stamped('unauthorised', persona), 5).signEvent({} as never).catch(() => {});
    await act(async () => { for (let i = 0; i < 5; i++) await call(EXTRA); });
    expect(result.current.unpaired).toBe(false);
    // An EXTRA refusal between bound-persona refusals neither counts nor resets.
    await act(async () => { await call(PERSONA); await call(EXTRA); await call(PERSONA); await call(PERSONA); });
    await waitFor(() => expect(result.current.unpaired).toBe(true));
  });

  it('A51: the ceremony skips a persona the rules payload no longer allows on this phone', async () => {
    await saveChildRulesCache(DEP, { ...payload(100), personas: [PERSONA] }, KEY);
    const { t } = fakeTransport();
    const { router, calls } = fakeRouter({});
    const { result } = renderHook(() => useChildDeviceLink({ record: record(), encryptionKey: KEY, router, onRecordUpdated: async () => {}, transport: t }));
    await waitFor(() => expect(result.current.rules?.updatedAt).toBe(100));
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(result.current.personas.map(p => p.pubkey)).toEqual([PERSONA]);
    expect(calls.some(c => c.slot === EXTRA)).toBe(false);
  });

  it('a legacy phone pairing never listens', async () => {
    const { t, subs } = fakeTransport();
    const { result } = renderHook(() => useChildDeviceLink({ record: record({ mode: undefined }), encryptionKey: KEY, router: null, onRecordUpdated: async () => {}, transport: t }));
    await act(async () => { await withRequestCreatedAt(stamped('unauthorised'), 5).signEvent({} as never).catch(() => {}); });
    expect(subs.length).toBe(0);
    expect(result.current.unpaired).toBe(false);
  });
});
