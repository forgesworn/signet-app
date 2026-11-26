// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { NostrEvent } from 'signet-protocol';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { useLegacyChildUnpaired, type LegacyUnpairTransport } from './useLegacyChildUnpaired';
import { buildLegacyUnpairedNotice } from '../lib/legacy-child-unpair';
import { CHILD_UNPAIRED_D_TAG } from '../lib/child-activity';
import type { PairedChildRecord } from '../types';

const RELAY = 'wss://relay.example';
const KEY = 'k'.repeat(64);
const NOW = Math.floor(Date.now() / 1000);
const freshKey = () => bytesToHex(generateSecretKey());

let endpointPriv: string, endpointPub: string, clientPub: string;
let deliver: ((ev: NostrEvent) => void) | null;
let filters: unknown[];
let unsubscribes: number;
const transport: LegacyUnpairTransport = {
  subscribe: (f, _relays, onEvent) => { filters = f; deliver = onEvent; return () => { unsubscribes++; }; },
};

function record(over: Partial<PairedChildRecord> = {}, endpoint = endpointPub): PairedChildRecord {
  return {
    id: 'd'.repeat(64), bunkerUri: `bunker://${endpoint}?relay=${encodeURIComponent(RELAY)}&secret=x`,
    clientKeypair: { publicKey: clientPub, privateKey: freshKey() }, dependantPubkey: 'd'.repeat(64), dependantName: 'Lily',
    pairedAt: NOW - 3600, hasPaired: true, ...over,
  };
}
const notice = (nowS = NOW, priv = endpointPriv) => buildLegacyUnpairedNotice({ privateKey: priv, authorizedClientPubkey: clientPub }, nowS)!;

beforeEach(() => {
  endpointPriv = freshKey(); endpointPub = getPublicKey(hexToBytes(endpointPriv));
  clientPub = getPublicKey(hexToBytes(freshKey()));
  deliver = null; filters = []; unsubscribes = 0;
});

function mount(initial: PairedChildRecord | null, dropBackdrops = vi.fn(async () => undefined)) {
  const hook = renderHook(({ r, k }: { r: PairedChildRecord | null; k: string | null }) =>
    useLegacyChildUnpaired({ record: r, encryptionKey: k, relayUrl: RELAY, transport, dropBackdrops }), { initialProps: { r: initial, k: KEY as string | null } });
  return { hook, dropBackdrops };
}

describe('useLegacyChildUnpaired', () => {
  it('reads the notice from the pairing\'s endpoint, addressed to this client, on the inventory relay', () => {
    mount(record());
    expect(filters).toEqual([{ kinds: [30078], authors: [endpointPub], '#d': [CHILD_UNPAIRED_D_TAG], '#p': [clientPub] }]);
  });

  it('a valid notice marks the phone unpaired and drops the guardian\'s backdrops, once', () => {
    const { hook, dropBackdrops } = mount(record());
    expect(hook.result.current).toBe(false);
    act(() => { deliver!(notice()); });
    expect(hook.result.current).toBe(true);
    act(() => { deliver!(notice()); });
    expect(dropBackdrops).toHaveBeenCalledTimes(1);
  });

  it('ignores a wrong author, a wrong recipient and a notice older than the pairing', () => {
    const { hook, dropBackdrops } = mount(record());
    const otherClient = buildLegacyUnpairedNotice({ privateKey: endpointPriv, authorizedClientPubkey: getPublicKey(hexToBytes(freshKey())) }, NOW)!;
    act(() => {
      deliver!(notice(NOW, freshKey()));
      deliver!(otherClient);
      deliver!(notice(NOW - 3600 - 10_000));
    });
    expect(hook.result.current).toBe(false);
    expect(dropBackdrops).not.toHaveBeenCalled();
  });

  it('a re-pair resets it, and the old notice re-delivered for the new pairing is ignored', () => {
    const { hook, dropBackdrops } = mount(record());
    const old = notice(NOW - 60);
    act(() => { deliver!(old); });
    expect(hook.result.current).toBe(true);
    // Re-paired (fresh endpoint, new pairing time, same client key).
    const newPriv = freshKey();
    hook.rerender({ r: record({ pairedAt: NOW }, getPublicKey(hexToBytes(newPriv))), k: KEY });
    expect(hook.result.current).toBe(false);
    expect(unsubscribes).toBe(1);
    act(() => { deliver!(old); });
    expect(hook.result.current).toBe(false);
    // Same endpoint, worst case: the pairing time still rules the old notice out.
    hook.rerender({ r: record({ pairedAt: NOW + 3600 }), k: KEY });
    act(() => { deliver!(old); });
    expect(hook.result.current).toBe(false);
    // A genuine later revoke of the new pairing still lands.
    act(() => { deliver!(notice(NOW + 3700)); });
    expect(hook.result.current).toBe(true);
    expect(dropBackdrops).toHaveBeenCalledTimes(2);
  });

  it('does nothing on a direct install, while locked, or with no pairing', () => {
    mount(record({ mode: 'heartwood-direct', railPubkey: endpointPub }));
    expect(deliver).toBeNull();
    const locked = renderHook(() => useLegacyChildUnpaired({ record: record(), encryptionKey: null, relayUrl: RELAY, transport }));
    expect(deliver).toBeNull();
    expect(locked.result.current).toBe(false);
    mount(null);
    expect(deliver).toBeNull();
  });
});
