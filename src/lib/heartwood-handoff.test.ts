import { describe, it, expect, vi } from 'vitest';
import type { NostrEvent, NostrFilter } from 'signet-protocol';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { v2 as nip44 } from 'nostr-tools/nip44';
import { bytesToHex } from '@noble/hashes/utils.js';
import { HeartwoodMgmtClient, MGMT_KIND, type MgmtTransport } from './heartwood-mgmt';
import {
  HANDOFF_METHODS,
  HandoffUnavailableError,
  handOffNostrConnect,
  holderTarget,
  pickHandoffRelay,
} from './heartwood-handoff';
import { buildOwnerPersonaRoutes } from './persona-bunker-routes';
import { buildSlotBunkerUri } from './bunker-router';
import type { DecryptingSigningBackend } from './signing-backend';

const hex = () => bytesToHex(generateSecretKey());

describe('operator requests addressed to another identity on the device', () => {
  it('p-tags and encrypts to the target, and reads the reply it authors', async () => {
    const deviceSk = generateSecretKey();
    const targetSk = generateSecretKey();
    const opSk = generateSecretKey();
    const opHex = getPublicKey(opSk);
    let onEvent: ((ev: NostrEvent) => void) | null = null;
    const published: NostrEvent[] = [];
    const transport: MgmtTransport = {
      async publish(event) {
        published.push(event);
        const target = event.tags[0][1];
        const fromSk = target === getPublicKey(targetSk) ? targetSk : deviceSk;
        const ck = nip44.utils.getConversationKey(fromSk, opHex);
        const inner = JSON.parse(nip44.decrypt(event.content, ck)) as { id: string };
        // A stranger's reply first: ignored, never decrypted into a result.
        const stranger = generateSecretKey();
        onEvent?.(finalizeEvent({ kind: MGMT_KIND, created_at: Math.floor(Date.now() / 1000), tags: [['p', opHex]],
          content: nip44.encrypt(JSON.stringify({ id: inner.id, result: { from: 'stranger' } }), nip44.utils.getConversationKey(stranger, opHex)) }, stranger) as unknown as NostrEvent);
        onEvent?.(finalizeEvent({ kind: MGMT_KIND, created_at: Math.floor(Date.now() / 1000), tags: [['p', opHex]],
          content: nip44.encrypt(JSON.stringify({ id: inner.id, result: { from: target } }), ck) }, fromSk) as unknown as NostrEvent);
        return { ok: true, message: '' };
      },
      subscribe(_f: NostrFilter[], _r: string[], cb: (ev: NostrEvent) => void) { onEvent = cb; return () => { onEvent = null; }; },
    };
    const c = new HeartwoodMgmtClient({ skHex: bytesToHex(opSk), deviceHex: getPublicKey(deviceSk), relays: ['wss://r.example'] }, transport);
    c.start();
    const target = getPublicKey(targetSk);
    expect(await c.request('list_identities', {}, { targetHex: target })).toEqual({ from: target });
    expect(published[0].tags).toEqual([['p', target]]);
    expect(await c.request('list_identities')).toEqual({ from: getPublicKey(deviceSk) });
    expect(published[1].tags).toEqual([['p', getPublicKey(deviceSk)]]);
    c.stop();
  });
});

describe('holderTarget / pickHandoffRelay', () => {
  const m0 = hex(), m1 = hex(), p0 = hex();
  const ids = [
    { kind: 'master' as const, slot: 0, pubkeyHex: m0, label: 'a' },
    { kind: 'master' as const, slot: 1, pubkeyHex: m1, label: 'b' },
    { kind: 'persona' as const, slot: 0, pubkeyHex: p0, label: 'persona' },
  ];
  it('a master is its own target; a persona is reached through its master', () => {
    expect(holderTarget(ids, m1)).toBe(m1);
    expect(holderTarget(ids, p0)).toBe(m0);
    expect(holderTarget(ids, hex())).toBeNull();
  });
  it('prefers an app relay the device already serves', () => {
    expect(pickHandoffRelay(['wss://a.example', 'wss://relay.primal.net/'], ['wss://relay.primal.net'])).toBe('wss://relay.primal.net/');
    expect(pickHandoffRelay(['wss://a.example'], ['wss://relay.primal.net'])).toBe('wss://a.example');
    expect(pickHandoffRelay(['http://x'], [])).toBeNull();
  });
});

describe('handOffNostrConnect', () => {
  function fakeClient(deviceHex: string, identities: unknown[]) {
    const request = vi.fn(async (method: string, params: Record<string, unknown> = {}, _opts?: { targetHex?: string }) => {
      if (method === 'list_identities') return { identities };
      if (method === 'nostrconnect_v2') {
        const policy = params.policy as Record<string, unknown>;
        return { slot_index: 4, secret_fingerprint: 'ab'.repeat(8), identity: params.identity, policy_version: 2,
          allowed_methods: policy.allowed_methods, allowed_kinds: policy.allowed_kinds, auto_approve: policy.auto_approve };
      }
      throw new Error(`unexpected ${method}`);
    });
    return { deviceHex, relays: ['wss://relay.primal.net'], request } as unknown as HeartwoodMgmtClient & { request: typeof request };
  }
  const request = { clientPubkey: hex(), relayUrl: 'wss://relay.primal.net', relayUrls: ['wss://relay.primal.net', 'wss://relay.ditto.pub'], secret: 's3cret', appName: 'KithMoot' };

  it('asks the device that holds the key, addressed to its master, with an exact no-button policy', async () => {
    const m0 = hex(), m1 = hex();
    const a = fakeClient(hex(), [{ kind: 'master', slot: 0, npub_hex: hex() }]);
    const b = fakeClient(m0, [{ kind: 'master', slot: 0, npub_hex: m0 }, { kind: 'master', slot: 1, npub_hex: m1 }]);
    const out = await handOffNostrConnect({ request, personaHex: m1, clients: [a, b] });
    expect(out).toMatchObject({ slotIndex: 4, deviceHex: m0, targetHex: m1, relay: 'wss://relay.primal.net' });
    const [method, params, opts] = b.request.mock.calls.find(c => c[0] === 'nostrconnect_v2')!;
    expect(method).toBe('nostrconnect_v2');
    expect(opts).toEqual({ targetHex: m1 });
    expect(params).toMatchObject({ client_pubkey: request.clientPubkey, secret: 's3cret', identity: m1, relay: 'wss://relay.primal.net', label: 'mysignet:KithMoot' });
    expect((params as { policy: Record<string, unknown> }).policy).toMatchObject({ allowed_methods: [...HANDOFF_METHODS], allowed_kinds: [], auto_approve: true, bound_identity: m1 });
  });

  it('says so when no Heartwood on this phone holds the key', async () => {
    const a = fakeClient(hex(), [{ kind: 'master', slot: 0, npub_hex: hex() }]);
    await expect(handOffNostrConnect({ request, personaHex: hex(), clients: [a] })).rejects.toBeInstanceOf(HandoffUnavailableError);
  });
});

describe('My Signet signing for other apps with keys held on the Heartwood', () => {
  const routed = (pk: string) => ({ activePublicKeyHex: pk }) as unknown as DecryptingSigningBackend;
  it('routes the default persona and key-less extras through the Heartwood', () => {
    const persona = hex(), ext = hex(), local = hex();
    const routes = buildOwnerPersonaRoutes({
      primaryBackend: null, unlocked: true, personaBackend: null, personaPubkey: persona,
      extraPersonas: [{ publicKey: ext, privateKey: '' }, { publicKey: local, privateKey: 'aa'.repeat(32) }],
      routedBackendFor: routed,
    }, () => routed(local));
    expect(routes.map(r => r.pubkey)).toEqual([persona, ext, local]);
  });
  it('without a Heartwood, key-less personas still get no route', () => {
    const routes = buildOwnerPersonaRoutes({
      primaryBackend: null, unlocked: true, personaBackend: null, personaPubkey: hex(),
      extraPersonas: [{ publicKey: hex(), privateKey: '' }], routedBackendFor: null,
    }, () => routed(hex()));
    expect(routes).toEqual([]);
  });
});

describe('buildSlotBunkerUri with a key on another Heartwood', () => {
  it('swaps in that device\'s relays', () => {
    const pk = hex();
    const uri = buildSlotBunkerUri(`bunker://${hex()}?relay=wss://a.example&secret=x`, pk, ['wss://b.example', 'wss://c.example']);
    expect(uri).toBe(`bunker://${pk}?relay=wss%3A%2F%2Fb.example&relay=wss%3A%2F%2Fc.example`);
  });
});
