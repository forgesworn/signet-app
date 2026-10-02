// @vitest-environment jsdom
/**
 * A41: on a direct child with the real identity ACTIVE, the NP seams the
 * app's own acts use (Venue Entry, Blossom) sign through the child's gate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { NostrEvent } from 'signet-protocol';
import type { PairedChildRecord } from '../types';
import type { ChildRulesPayload } from '../lib/child-rules-wire';
import { openAskEvent } from '../lib/child-sign-asks';
import { childOwnActsBackend, gatedSigningBackend, ungatedInner, CHILD_OWN_APP_ID } from '../lib/child-bunker';
import type { DecryptingSigningBackend } from '../lib/signing-backend';
import { useChildGate, resetRequestCreatedAtForTests, type ChildGateTransport } from './useChildGate';

const DEP = 'ef'.repeat(32);
const railSk = generateSecretKey(), railPriv = bytesToHex(railSk), railPub = getPublicKey(railSk);
const clientSk = generateSecretKey(), clientPriv = bytesToHex(clientSk), clientPub = getPublicKey(clientSk);
const NP = getPublicKey(generateSecretKey());
const PERSONA = getPublicKey(generateSecretKey());

function record(): PairedChildRecord {
  return {
    id: DEP, bunkerUri: `bunker://${PERSONA}?relay=wss%3A%2F%2Fhw.example`,
    clientKeypair: { publicKey: clientPub, privateKey: clientPriv },
    dependantPubkey: DEP, dependantName: 'Alice', pairedAt: 1, hasPaired: true,
    mode: 'heartwood-direct', railPubkey: railPub, personaPubkey: PERSONA,
    hwRelays: ['wss://hw.example'], railRelay: 'wss://rail.example',
  };
}
const rules: ChildRulesPayload = { v: 1, dependantId: DEP, stage: 'request-approve', ceilingKinds: [], rules: [], disconnectedApps: [], updatedAt: 1 };

function setup() {
  const published: NostrEvent[] = [];
  const t: ChildGateTransport = {
    publish: async (ev) => { published.push(ev); return { ok: true, message: '' }; },
    subscribe: () => () => {},
  };
  const hook = renderHook(() => useChildGate({
    record: record(), rules, relays: ['wss://rail.example'], unpaired: false, onActivity: () => {}, transport: t,
  }));
  // The NP's Heartwood route: recorded, never reached while the ask is open.
  const inner = {
    type: 'bunker', activePublicKeyHex: NP,
    signEvent: vi.fn(), nip44Encrypt: vi.fn(), nip44Decrypt: vi.fn(), destroy: () => {},
  } as unknown as DecryptingSigningBackend;
  const np = childOwnActsBackend({ childDirect: true, backend: inner, authorise: (r) => hook.result.current.authorise(r) });
  return { published, hook, inner, np };
}

async function openAsk(ev: NostrEvent) {
  return openAskEvent(ev, railPriv, { clientPubkey: clientPub, dependantId: DEP, personas: [NP], nowS: Math.floor(Date.now() / 1000) });
}

beforeEach(() => resetRequestCreatedAtForTests());

describe('A41: the NP seam on a direct child goes through the gate', () => {
  it('a Venue Entry sign raises an ask under request-approve and never reaches the Heartwood', async () => {
    const s = setup();
    await act(async () => {
      void s.np.signEvent({ kind: 21235, created_at: Math.floor(Date.now() / 1000), tags: [['t', 'signet-venue-entry']], content: '', pubkey: '' }).catch(() => {});
      await new Promise(r => setTimeout(r, 0));
    });
    await waitFor(() => expect(s.published).toHaveLength(1));
    const ask = await openAsk(s.published[0]);
    expect(ask?.persona).toBe(NP);
    expect(ask?.kind).toBe(21235);
    expect(s.hook.result.current.pendingAsks).toHaveLength(1);
    expect(s.inner.signEvent).not.toHaveBeenCalled();
  });

  it('a Blossom upload auth (kind 24242) raises an ask too', async () => {
    const s = setup();
    await act(async () => {
      void s.np.signEvent({ kind: 24242, created_at: Math.floor(Date.now() / 1000), tags: [['t', 'upload']], content: 'Upload', pubkey: '' }).catch(() => {});
      await new Promise(r => setTimeout(r, 0));
    });
    await waitFor(() => expect(s.published).toHaveLength(1));
    expect((await openAsk(s.published[0]))?.kind).toBe(24242);
    expect(s.inner.signEvent).not.toHaveBeenCalled();
  });

  it('is a no-op off a direct child, and a second gate replaces rather than stacks the first', async () => {
    const inner = { activePublicKeyHex: NP } as unknown as DecryptingSigningBackend;
    expect(childOwnActsBackend({ childDirect: false, backend: inner, authorise: vi.fn() })).toBe(inner);
    expect(childOwnActsBackend({ childDirect: true, backend: null, authorise: vi.fn() })).toBeNull();
    const authorise = vi.fn(async () => ({ ok: false as const, error: 'denied' as const }));
    const own = childOwnActsBackend({ childDirect: true, backend: inner, authorise });
    expect(ungatedInner(own)).toBe(inner);
    const site = gatedSigningBackend(own, async () => ({ ok: false, error: 'denied' }));
    expect(ungatedInner(site)).toBe(inner);
    await site.signEvent({ kind: 21236, created_at: 1, tags: [], content: '', pubkey: '' }).catch(() => {});
    expect(authorise).not.toHaveBeenCalled();
    await own.signEvent({ kind: 1, created_at: 1, tags: [], content: '', pubkey: '' }).catch(() => {});
    expect(authorise).toHaveBeenCalledWith(expect.objectContaining({ appId: CHILD_OWN_APP_ID, persona: NP }));
  });
});
