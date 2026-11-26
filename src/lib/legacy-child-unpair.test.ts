/**
 * The guardian's "this phone was revoked" notice for a LEGACY phone-paired
 * child. Real keys, real signatures and real NIP-44 throughout.
 *
 * Old-build safety: an older child build that is handed the notice must
 * ignore it, never read it as an (empty) persona inventory. Its inventory
 * reader is fed the notice here through a relay that ignores every filter.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NostrEvent } from 'signet-protocol';

const relayMock = vi.hoisted(() => ({
  filters: [] as unknown[],
  deliver: null as null | ((ev: NostrEvent) => void),
}));
vi.mock('signet-protocol', async () => {
  const actual = await vi.importActual<typeof import('signet-protocol')>('signet-protocol');
  return {
    ...actual,
    // Hands over whatever the test delivers: no `#d` or `authors` filtering.
    RelayClient: class MockRelayClient {
      async connect(): Promise<void> {}
      subscribe(filters: unknown[], onEvent: (ev: NostrEvent) => void): string {
        relayMock.filters = filters;
        relayMock.deliver = onEvent;
        return 'sub';
      }
      closeSubscription(): void {}
      disconnect(): void {}
    },
  };
});

import { bytesToHex } from '@noble/hashes/utils.js';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { hexToBytes } from '@noble/hashes/utils.js';
import { LocalSigningBackend } from './signing-backend';
import { subscribePersonaInventory, parsePersonaInventoryPayload } from './persona-inventory-sync';
import { CHILD_UNPAIRED_D_TAG } from './child-activity';
import {
  acceptLegacyUnpairedNotice, buildLegacyUnpairedNotice, publishLegacyUnpairedNotice, clearThenPublishLegacyUnpair, LEGACY_UNPAIR_CLOCK_SKEW_S,
} from './legacy-child-unpair';
import type { PairedChildRecord } from '../types';

const freshKey = () => bytesToHex(generateSecretKey());
const RELAY = 'wss://relay.example';
const NOW = 1_800_000_000;
const flush = () => new Promise(r => setTimeout(r, 20));

let endpointPriv: string, endpointPub: string, clientPriv: string, clientPub: string;

function record(over: Partial<PairedChildRecord> = {}): PairedChildRecord {
  return {
    id: 'd'.repeat(64), bunkerUri: `bunker://${endpointPub}?relay=${encodeURIComponent(RELAY)}&secret=x`,
    clientKeypair: { publicKey: clientPub, privateKey: clientPriv }, dependantPubkey: 'd'.repeat(64), dependantName: 'Lily',
    pairedAt: NOW - 3600, hasPaired: true, ...over,
  };
}
const notice = (nowS = NOW, priv = endpointPriv, client = clientPub) =>
  buildLegacyUnpairedNotice({ privateKey: priv, authorizedClientPubkey: client }, nowS)!;

beforeEach(() => {
  relayMock.filters = [];
  relayMock.deliver = null;
  endpointPriv = freshKey(); endpointPub = getPublicKey(hexToBytes(endpointPriv));
  clientPriv = freshKey(); clientPub = getPublicKey(hexToBytes(clientPriv));
});

describe('old child builds ignore the notice', () => {
  it('the old inventory parser rejects its content (it can never read as an empty inventory)', () => {
    const ev = notice();
    expect(JSON.parse(ev.content)).toEqual({ v: 1, clientPubkey: clientPub });
    expect(parsePersonaInventoryPayload(ev.content)).toBeNull();
  });

  it('its d tag is not the inventory\'s, so an old reader\'s relay filter never returns it', () => {
    const ev = notice();
    expect(ev.tags).toEqual([['d', CHILD_UNPAIRED_D_TAG], ['p', clientPub]]);
    expect(ev.tags[0][1]).not.toBe('signet:persona-inventory');
  });

  it('the old inventory subscriber, handed the notice by a relay ignoring every filter, delivers nothing', async () => {
    const child = new LocalSigningBackend(clientPriv);
    const onPayload = vi.fn();
    const unsubscribe = subscribePersonaInventory(endpointPub, child, RELAY, onPayload);
    await flush();
    expect(relayMock.filters).toEqual([expect.objectContaining({ '#d': ['signet:persona-inventory'] })]);
    relayMock.deliver!(notice());
    await flush();
    expect(onPayload).not.toHaveBeenCalled();
    // The content is plaintext: the NIP-44 decrypt an old reader runs first fails on it.
    await expect(child.nip44Decrypt(endpointPub, notice().content)).rejects.toThrow();
    unsubscribe();
    child.destroy();
  });
});

describe('acceptLegacyUnpairedNotice', () => {
  it('accepts a notice from the pairing\'s endpoint naming this client, newer than the pairing', () => {
    expect(acceptLegacyUnpairedNotice(notice(), record())).toBe(true);
    // Within the clock allowance (guardian's clock behind the child's).
    expect(acceptLegacyUnpairedNotice(notice(NOW - 3600 - LEGACY_UNPAIR_CLOCK_SKEW_S), record())).toBe(true);
  });

  it('ignores a notice from another author', () => {
    expect(acceptLegacyUnpairedNotice(notice(NOW, freshKey()), record())).toBe(false);
  });

  it('ignores a notice addressed to another client', () => {
    const other = getPublicKey(hexToBytes(freshKey()));
    expect(acceptLegacyUnpairedNotice(notice(NOW, endpointPriv, other), record())).toBe(false);
  });

  it('ignores a notice older than the pairing (beyond the allowance)', () => {
    expect(acceptLegacyUnpairedNotice(notice(NOW - 3600 - LEGACY_UNPAIR_CLOCK_SKEW_S - 1), record())).toBe(false);
  });

  it('ignores a tampered or re-dated notice (signature), and an extra tag', () => {
    const ev = notice();
    expect(acceptLegacyUnpairedNotice({ ...ev, created_at: ev.created_at + 1 }, record())).toBe(false);
    const extraTag = finalizeEvent({ kind: 30078, created_at: NOW, tags: [...ev.tags, ['x', 'y']], content: ev.content }, hexToBytes(endpointPriv));
    expect(acceptLegacyUnpairedNotice(extraTag as unknown as NostrEvent, record())).toBe(false);
  });

  it('ignores a body naming another client under a matching p tag', () => {
    const forged = finalizeEvent({ kind: 30078, created_at: NOW, tags: [['d', CHILD_UNPAIRED_D_TAG], ['p', clientPub]],
      content: JSON.stringify({ v: 1, clientPubkey: 'e'.repeat(64) }) }, hexToBytes(endpointPriv));
    expect(acceptLegacyUnpairedNotice(forged as unknown as NostrEvent, record())).toBe(false);
  });

  it('never applies on a child-direct record (that reader is useChildDeviceLink)', () => {
    expect(acceptLegacyUnpairedNotice(notice(), record({ mode: 'heartwood-direct', railPubkey: endpointPub }))).toBe(false);
  });

  it('after a re-pair, an older notice is ignored: by the new endpoint, and by the pairing time even from the same endpoint', () => {
    const old = notice(NOW);
    // The usual re-pair: a fresh endpoint key, the same client key (a legacy re-pair keeps it).
    const newEndpoint = getPublicKey(hexToBytes(freshKey()));
    const repaired = record({ bunkerUri: `bunker://${newEndpoint}?relay=${encodeURIComponent(RELAY)}&secret=y`, pairedAt: NOW + 600 });
    expect(acceptLegacyUnpairedNotice(old, repaired)).toBe(false);
    // Worst case, the same endpoint: the pairing time still rules it out.
    expect(acceptLegacyUnpairedNotice(old, record({ pairedAt: NOW + 600 }))).toBe(false);
    // A genuine revoke of the new pairing is accepted.
    expect(acceptLegacyUnpairedNotice(notice(NOW + 900), record({ pairedAt: NOW + 600 }))).toBe(true);
  });
});

describe('publishLegacyUnpairedNotice (guardian, before the endpoint is cleared)', () => {
  it('publishes the signed notice to the given relays', async () => {
    const publish = vi.fn(async () => true);
    expect(await publishLegacyUnpairedNotice({ privateKey: endpointPriv, authorizedClientPubkey: clientPub.toUpperCase() }, [RELAY], { publish, nowS: NOW })).toBe(true);
    const [ev, relays] = publish.mock.calls[0] as unknown as [NostrEvent, string[]];
    expect(relays).toEqual([RELAY]);
    expect(acceptLegacyUnpairedNotice(ev, record())).toBe(true);
  });

  it('sends nothing for a phone that never connected', async () => {
    const publish = vi.fn(async () => true);
    expect(await publishLegacyUnpairedNotice({ privateKey: endpointPriv }, [RELAY], { publish })).toBe(false);
    expect(await publishLegacyUnpairedNotice(undefined, [RELAY], { publish })).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });

  it('never throws and never holds the revoke past the cap', async () => {
    const throwing = vi.fn(async () => { throw new Error('offline'); });
    expect(await publishLegacyUnpairedNotice({ privateKey: endpointPriv, authorizedClientPubkey: clientPub }, [RELAY], { publish: throwing })).toBe(false);
    const hanging = vi.fn(() => new Promise<boolean>(() => {}));
    expect(await publishLegacyUnpairedNotice({ privateKey: endpointPriv, authorizedClientPubkey: clientPub }, [RELAY], { publish: hanging, capMs: 30 })).toBe(false);
  });
});

describe('clearThenPublishLegacyUnpair (the notice follows the clear)', () => {
  const target = () => ({ endpoint: { privateKey: endpointPriv, authorizedClientPubkey: clientPub }, relays: [RELAY] });

  it('publishes only after the clear has completed', async () => {
    const order: string[] = [];
    const publish = vi.fn(async () => { order.push('publish'); return true; });
    await clearThenPublishLegacyUnpair(target(), async () => { await flush(); order.push('cleared'); }, { publish, nowS: NOW });
    expect(order).toEqual(['cleared', 'publish']);
  });

  it('sends no notice when the clear fails, and rethrows (the endpoint survives, so a re-pair onto it must not meet a notice)', async () => {
    const publish = vi.fn(async () => true);
    await expect(clearThenPublishLegacyUnpair(target(), async () => { throw new Error('idb'); }, { publish })).rejects.toThrow('idb');
    expect(publish).not.toHaveBeenCalled();
  });

  it('completes and returns the clear result when the publish fails or hangs', async () => {
    const throwing = vi.fn(async () => { throw new Error('offline'); });
    expect(await clearThenPublishLegacyUnpair(target(), async () => 'done', { publish: throwing })).toBe('done');
    const hanging = vi.fn(() => new Promise<boolean>(() => {}));
    expect(await clearThenPublishLegacyUnpair(target(), async () => 'done', { publish: hanging, capMs: 30 })).toBe('done');
  });

  it('with nothing to tell, just clears', async () => {
    const publish = vi.fn(async () => true);
    expect(await clearThenPublishLegacyUnpair(null, async () => 7, { publish })).toBe(7);
    expect(publish).not.toHaveBeenCalled();
  });
});
