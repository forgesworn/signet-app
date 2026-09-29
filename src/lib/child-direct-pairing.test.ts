import { describe, it, expect, vi } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { NostrEvent } from 'signet-protocol';
import {
  buildChildPairReplyEvent, openChildPairRequestEvent, pairCheckWords, pairRequestDTag, pairReplyDTag,
  type ChildPairOffer,
} from './child-pair-wire';
import { parseNostrConnectURI } from './nip46';
import {
  runChildDirectPairing, buildChildNostrConnectUri, directBunkerUri, ChildDirectPairError, pairedChildSignerPubkey, childPairRunTimeoutMs,
  type ChildDirectPairingDeps,
} from './child-direct-pairing';

const railSk = generateSecretKey();
const railPriv = bytesToHex(railSk);
const railPub = getPublicKey(railSk);
const PERSONA = 'ab'.repeat(32);
const NOW = 1_800_000_000;

function offer(over: Partial<ChildPairOffer> = {}): ChildPairOffer {
  return {
    v: 2, rail: railPub, guardian: 'cd'.repeat(32), dependant: 'ef'.repeat(32), persona: PERSONA,
    name: 'Alice', relay: 'wss://rail.example', hwRelays: ['wss://hw1.example', 'wss://hw2.example'],
    code: '0123456789abcdef0123456789abcdef', t: NOW, ...over,
  };
}

interface Harness {
  deps: ChildDirectPairingDeps;
  published: { ev: NostrEvent; relays: string[] }[];
  subs: { filters: unknown[]; relays: string[]; onEvent: (e: NostrEvent) => void; closed: boolean }[];
  handshake: ReturnType<typeof vi.fn>;
}

function harness(opts: { publishOk?: boolean; handshake?: (...a: unknown[]) => Promise<string> } = {}): Harness {
  const published: Harness['published'] = [];
  const subs: Harness['subs'] = [];
  const handshake = vi.fn(opts.handshake ?? (async () => `bunker://${PERSONA}?relay=wss%3A%2F%2Fhw1.example`));
  return {
    published, subs, handshake,
    deps: {
      publish: async (ev, relays) => { published.push({ ev, relays }); return { ok: opts.publishOk ?? true, message: '' }; },
      subscribe: (filters, relays, onEvent) => {
        const s = { filters, relays, onEvent, closed: false };
        subs.push(s);
        return () => { s.closed = true; };
      },
      handshake: handshake as unknown as ChildDirectPairingDeps['handshake'],
      nowS: () => NOW + 5,
    },
  };
}

async function tick() { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); }

describe('buildChildNostrConnectUri', () => {
  it('lists every Heartwood relay, carries the secret, and parses back to our client pubkey', () => {
    const uri = buildChildNostrConnectUri('a1'.repeat(32), ['wss://hw1.example', 'wss://hw2.example'], 'aa'.repeat(16));
    const parsed = parseNostrConnectURI(uri);
    expect(parsed?.clientPubkey).toBe('a1'.repeat(32));
    expect(parsed?.secret).toBe('aa'.repeat(16));
    expect(new URL(uri.replace('nostrconnect://', 'https://')).searchParams.getAll('relay'))
      .toEqual(['wss://hw1.example', 'wss://hw2.example']);
  });
  it('directBunkerUri is a secret-free bunker URI to the persona on the Heartwood relays', () => {
    const uri = directBunkerUri(PERSONA, ['wss://hw1.example']);
    expect(uri.startsWith(`bunker://${PERSONA}?`)).toBe(true);
    expect(uri).not.toContain('secret');
  });
});

describe('runChildDirectPairing', () => {
  it('publishes the request on the rail relay with the hashed d tag, shows the check words, and resolves on an ok reply', async () => {
    const h = harness();
    const onCheckWords = vi.fn();
    const p = runChildDirectPairing(offer(), h.deps, { onCheckWords, timeoutMs: 5_000 });
    await tick();

    expect(h.handshake).toHaveBeenCalledTimes(1);
    const [, ncUri, expected] = h.handshake.mock.calls[0];
    expect(expected).toBe(PERSONA);
    expect(String(ncUri)).toContain(encodeURIComponent('wss://hw1.example'));

    expect(h.published).toHaveLength(1);
    const { ev, relays } = h.published[0];
    expect(relays).toEqual(['wss://rail.example']);
    expect(ev.tags).toContainEqual(['d', pairRequestDTag(offer().code)]);
    expect(ev.tags).toContainEqual(['p', railPub]);
    const req = await openChildPairRequestEvent(ev, railPriv, { code: offer().code, nowS: NOW + 5 });
    expect(req).not.toBeNull();
    expect(onCheckWords).toHaveBeenCalledWith(pairCheckWords(offer().code, req!.clientPubkey));

    // Reply subscription: authored by the rail, to our client, hashed reply d tag.
    const sub = h.subs[0];
    expect(sub.relays).toEqual(['wss://rail.example']);
    expect(sub.filters[0]).toMatchObject({ authors: [railPub], '#d': [pairReplyDTag(offer().code)], '#p': [req!.clientPubkey] });

    const reply = await buildChildPairReplyEvent({ v: 1, code: offer().code, ok: true, stage: 'request-approve',
      personas: [{ pubkey: PERSONA, name: 'Ally', role: 'persona' }] }, railPriv, req!.clientPubkey);
    sub.onEvent(reply);
    const res = await p;
    expect(res.clientKeypair.publicKey).toBe(req!.clientPubkey);
    expect(res.bunkerUri.startsWith(`bunker://${PERSONA}`)).toBe(true);
    expect(res.personas).toEqual([{ pubkey: PERSONA, name: 'Ally', role: 'persona' }]);
    expect(res.stage).toBe('request-approve');
    expect(sub.closed).toBe(true);
  });

  it('ignores a reply from a different author', async () => {
    const h = harness();
    const p = runChildDirectPairing(offer(), h.deps, { onCheckWords: () => {}, timeoutMs: 200 });
    await tick();
    const req = await openChildPairRequestEvent(h.published[0].ev, railPriv, { code: offer().code, nowS: NOW + 5 });
    const other = bytesToHex(generateSecretKey());
    h.subs[0].onEvent(await buildChildPairReplyEvent({ v: 1, code: offer().code, ok: true, stage: 'full-control', personas: [] }, other, req!.clientPubkey));
    await expect(p).rejects.toMatchObject({ code: 'timeout' });
  });

  it('times out with no reply', async () => {
    const h = harness();
    await expect(runChildDirectPairing(offer(), h.deps, { onCheckWords: () => {}, timeoutMs: 50 }))
      .rejects.toBeInstanceOf(ChildDirectPairError);
    expect(h.subs[0].closed).toBe(true);
  });

  it('a refusal carries the guardian reason', async () => {
    const h = harness();
    const p = runChildDirectPairing(offer(), h.deps, { onCheckWords: () => {}, timeoutMs: 5_000 });
    await tick();
    const req = await openChildPairRequestEvent(h.published[0].ev, railPriv, { code: offer().code, nowS: NOW + 5 });
    h.subs[0].onEvent(await buildChildPairReplyEvent({ v: 1, code: offer().code, ok: false, reason: 'check-mismatch',
      stage: 'full-control', personas: [] }, railPriv, req!.clientPubkey));
    await expect(p).rejects.toMatchObject({ code: 'refused', reason: 'check-mismatch' });
  });

  it('a failed publish rejects without waiting', async () => {
    const h = harness({ publishOk: false });
    await expect(runChildDirectPairing(offer(), h.deps, { onCheckWords: () => {}, timeoutMs: 5_000 }))
      .rejects.toMatchObject({ code: 'publish' });
  });

  it('a signer that answers as a different pubkey fails the pairing', async () => {
    const h = harness({ handshake: async () => { throw new Error('Bunker pubkey mismatch'); } });
    const p = runChildDirectPairing(offer(), h.deps, { onCheckWords: () => {}, timeoutMs: 5_000 });
    await tick();
    const req = await openChildPairRequestEvent(h.published[0].ev, railPriv, { code: offer().code, nowS: NOW + 5 });
    h.subs[0].onEvent(await buildChildPairReplyEvent({ v: 1, code: offer().code, ok: true, stage: 'full-control', personas: [] }, railPriv, req!.clientPubkey));
    await expect(p).rejects.toMatchObject({ code: 'signer' });
  });

  it('abort cancels the run', async () => {
    const h = harness({ handshake: () => new Promise(() => {}) });
    const ac = new AbortController();
    const p = runChildDirectPairing(offer(), h.deps, { onCheckWords: () => {}, timeoutMs: 5_000, signal: ac.signal });
    await tick();
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    expect(h.subs[0].closed).toBe(true);
  });
});

describe('childPairRunTimeoutMs (A28)', () => {
  it('is 300 s while the code has more than that left', () => {
    expect(childPairRunTimeoutMs(NOW, NOW + 5)).toBe(300_000);
  });
  it('shrinks to the time left on the 600 s code', () => {
    expect(childPairRunTimeoutMs(NOW, NOW + 500)).toBe(100_000);
  });
  it('is zero once the code has expired', () => {
    expect(childPairRunTimeoutMs(NOW, NOW + 700)).toBe(0);
  });
  it('a run on an expired code times out without publishing', async () => {
    const h = harness();
    h.deps.nowS = () => NOW + 601;
    await expect(runChildDirectPairing(offer(), h.deps, { onCheckWords: () => {} }))
      .rejects.toMatchObject({ code: 'timeout' });
    expect(h.published).toHaveLength(0);
    expect(h.handshake).not.toHaveBeenCalled();
  });
  it('the handshake gets the capped timeout', async () => {
    const h = harness({ handshake: () => new Promise<string>(() => {}) });
    h.deps.nowS = () => NOW + 599;
    await expect(runChildDirectPairing(offer(), h.deps, { onCheckWords: () => {} }))
      .rejects.toMatchObject({ code: 'timeout' });
    expect(h.handshake.mock.calls[0][3]).toBe(1_000);
  });
});

describe('pairedChildSignerPubkey', () => {
  const base = { dependantPubkey: 'ef'.repeat(32) };
  it('pins the persona for a direct pairing (not the dormant real-identity slot)', () => {
    expect(pairedChildSignerPubkey({ ...base, mode: 'heartwood-direct', personaPubkey: PERSONA })).toBe(PERSONA);
  });
  it('pins the dependant pubkey for a legacy phone pairing, unchanged', () => {
    expect(pairedChildSignerPubkey(base)).toBe('ef'.repeat(32));
    expect(pairedChildSignerPubkey({ ...base, mode: 'phone', personaPubkey: PERSONA })).toBe('ef'.repeat(32));
  });
  it('a direct record without a persona pins nothing reachable', () => {
    expect(pairedChildSignerPubkey({ ...base, mode: 'heartwood-direct' })).toBe('');
  });
});
