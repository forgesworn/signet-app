import { describe, it, expect, vi } from 'vitest';
import type { NostrEvent, NostrFilter } from 'signet-protocol';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { v2 as nip44 } from 'nostr-tools/nip44';
import { bytesToHex } from '@noble/hashes/utils.js';
import { HeartwoodDeviceError, HeartwoodMgmtClient, MGMT_KIND, type MgmtTransport } from './heartwood-mgmt';
import {
  HANDOFF_METHODS,
  HANDOFF_NO_ANSWER_COPY,
  HandoffNoAnswerError,
  findHeartwoodHolder,
  HandoffNotSavedError,
  HandoffStrandedError,
  HandoffUnavailableError,
  handOffNostrConnect,
  handoffReach,
  handoffWarning,
  HANDOFF_ALWAYS_ASK_KINDS,
  handoffScope,
  handoffsForClient,
  mergeHandoffs,
  revokeHandoffSlot,
  revokeEveryHandoff,
  runHandoffApproval,
  HANDOFF_PRIOR_REMOVED_COPY,
  HANDOFF_MISMATCH_KEPT_COPY,
  HandoffKeptError,
  endsConnectRequest,
  mintHandoff,
  missingOperatorError,
  HandoffUnmanagedError,
  HANDOFF_UNCERTAIN_KEPT_COPY,
  HANDOFF_LOCKED_KEPT_COPY,
  HANDOFF_EARLIER_KEPT_COPY,
  HANDOFF_STILL_CONNECTING_COPY,
  type HandoffPlan,
  type HandoffResult,
  sameHandoff,
  holderTarget,
  pickHandoffRelay,
  settleHandoff,
} from './heartwood-handoff';
import { buildOwnerPersonaRoutes } from './persona-bunker-routes';
import { buildSlotBunkerUri } from './bunker-router';
import type { DecryptingSigningBackend } from './signing-backend';
import type { DeviceClientSlot } from './heartwood-mgmt-types';

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

  it('grants a scoped invitation only what it asked for', async () => {
    const m0 = hex();
    const b = fakeClient(m0, [{ kind: 'master', slot: 0, npub_hex: m0 }]);
    await handOffNostrConnect({ request: { ...request, permissions: ['sign_event:1', 'nip44_encrypt'] }, personaHex: m0, clients: [b] });
    const [, params] = b.request.mock.calls.find(c => c[0] === 'nostrconnect_v2')!;
    expect((params as { policy: Record<string, unknown> }).policy).toMatchObject({
      allowed_methods: ['get_public_key', 'sign_event', 'nip44_encrypt'], allowed_kinds: [1], auto_approve: true,
    });
  });

  it('an invitation that asks to sign deletions can still be handed off, granted only what it asked', async () => {
    const m0 = hex();
    const b = fakeClient(m0, [{ kind: 'master', slot: 0, npub_hex: m0 }]);
    await handOffNostrConnect({ request: { ...request, permissions: ['sign_event:5', 'sign_event:1'] }, personaHex: m0, clients: [b] });
    const [, params] = b.request.mock.calls.find(c => c[0] === 'nostrconnect_v2')!;
    expect((params as { policy: Record<string, unknown> }).policy).toMatchObject({ allowed_kinds: [1, 5] });
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

describe('handoffScope', () => {
  it('an unscoped invitation gets the full hand-off set, any kind', () => {
    expect(handoffScope(undefined)).toEqual({ methods: [...HANDOFF_METHODS], kinds: [] });
  });
  it('only narrows: no sign_event unless asked, and kinds are listed unless plain sign_event was asked', () => {
    expect(handoffScope(['nip44_decrypt'])).toEqual({ methods: ['get_public_key', 'nip44_decrypt'], kinds: [] });
    expect(handoffScope(['sign_event:7', 'sign_event:1', 'sign_event:7'])).toEqual({ methods: ['get_public_key', 'sign_event'], kinds: [1, 7] });
    expect(handoffScope(['sign_event', 'sign_event:1'])).toEqual({ methods: ['get_public_key', 'sign_event'], kinds: [] });
    // nip04 is not served by a hand-off, scoped or not.
    expect(handoffScope(['nip04_encrypt', 'get_public_key'])).toEqual({ methods: ['get_public_key'], kinds: [] });
  });
});

describe('handoffReach: what the Heartwood would sign that this phone asks about', () => {
  it('safe: a list with no plain sign_event and none of the always-ask kinds', () => {
    expect(handoffReach(['sign_event:1', 'sign_event:7', 'nip44_encrypt'])).toEqual({ kind: 'safe' });
    expect(handoffReach(['nip44_decrypt'])).toEqual({ kind: 'safe' });
  });
  it('every kind: no list, or plain sign_event', () => {
    expect(handoffReach(undefined)).toEqual({ kind: 'wide', covers: 'everything' });
    expect(handoffReach(['sign_event', 'sign_event:1'])).toEqual({ kind: 'wide', covers: 'everything' });
  });
  it('a list naming always-ask kinds covers just those', () => {
    expect(handoffReach(['sign_event:1', 'sign_event:5', 'sign_event:31000'])).toEqual({ kind: 'wide', covers: [5, 31000] });
    for (const k of HANDOFF_ALWAYS_ASK_KINDS) expect(handoffReach([`sign_event:${k}`]).kind).toBe('wide');
    // Kinterest family authorisations are kind 30078, told apart only by a d tag the device can't see.
    expect(HANDOFF_ALWAYS_ASK_KINDS).toContain(30078);
  });
  it('says in plain words what the Heartwood will sign with no press', () => {
    expect(handoffWarning({ kind: 'safe' })).toBeNull();
    expect(handoffWarning({ kind: 'wide', covers: 'everything' })).toBe(
      'Your Heartwood will sign anything this app asks, without a press, including profile changes, deletions and pairing other devices.');
    expect(handoffWarning({ kind: 'wide', covers: [5] })).toBe('Your Heartwood will sign deletions for this app, without a press.');
    expect(handoffWarning({ kind: 'wide', covers: [30078, 0, 24133] })).toBe(
      'Your Heartwood will sign profile changes, pairing other devices and family permissions for Kinterest for this app, without a press.');
    expect(handoffWarning({ kind: 'wide', covers: [...HANDOFF_ALWAYS_ASK_KINDS] })).not.toMatch(/\d/);
  });
});

describe('settleHandoff', () => {
  function harness(opts: { persist?: 'ok' | 'fail'; undo?: 'ok' | 'fail' } = {}) {
    const log: string[] = [];
    let tracked = false;
    return {
      log,
      get tracked() { return tracked; },
      p: {
        track: () => { tracked = true; log.push('track'); },
        untrack: () => { tracked = false; log.push('untrack'); },
        persist: async () => { log.push('persist'); if (opts.persist === 'fail') throw new Error('idb'); },
        undo: async () => { log.push('undo'); if (opts.undo === 'fail') throw new Error('offline'); },
      },
    };
  }
  it('keeps and saves a pairing nobody cancelled', async () => {
    const h = harness();
    expect(await settleHandoff({ cancelled: false, ...h.p })).toBe('kept');
    expect(h.log).toEqual(['track', 'persist']);
    expect(h.tracked).toBe(true);
  });
  it('undoes a pairing cancelled while minting, and saves nothing', async () => {
    const h = harness();
    expect(await settleHandoff({ cancelled: true, ...h.p })).toBe('undone');
    expect(h.log).toEqual(['track', 'undo', 'untrack']);
    expect(h.tracked).toBe(false);
  });
  it('a cancelled pairing the device would not undo is saved, so Disconnect can reach it', async () => {
    const h = harness({ undo: 'fail' });
    expect(await settleHandoff({ cancelled: true, ...h.p })).toBe('cancelled-kept');
    expect(h.log).toEqual(['track', 'undo', 'persist']);
    expect(h.tracked).toBe(true);
  });
  it('a pairing that cannot be saved is undone on the device', async () => {
    const h = harness({ persist: 'fail' });
    await expect(settleHandoff({ cancelled: false, ...h.p })).rejects.toBeInstanceOf(HandoffNotSavedError);
    expect(h.log).toEqual(['track', 'persist', 'undo', 'untrack']);
    expect(h.tracked).toBe(false);
  });
  it('neither saved nor undone: stays tracked for this session and says to remove it in Sapwood', async () => {
    const h = harness({ persist: 'fail', undo: 'fail' });
    await expect(settleHandoff({ cancelled: false, ...h.p })).rejects.toBeInstanceOf(HandoffStrandedError);
    expect(h.tracked).toBe(true);
  });
});

describe('findHeartwoodHolder when a device does not list its identities', () => {
  function failing(err: () => Error) {
    const request = vi.fn(async () => { throw err(); });
    return { deviceHex: hex(), relays: ['wss://relay.ditto.pub'], request } as unknown as HeartwoodMgmtClient & { request: typeof request };
  }
  function holding(master: string) {
    const request = vi.fn(async () => ({ identities: [{ kind: 'master', slot: 0, npub_hex: master }] }));
    return { deviceHex: master, relays: ['wss://relay.ditto.pub'], request } as unknown as HeartwoodMgmtClient;
  }

  it("says what the device replied, not that it didn't answer", async () => {
    const c = failing(() => new HeartwoodDeviceError('device low on memory; state unchanged, retry shortly', 'list_identities'));
    const err = await findHeartwoodHolder([c], hex()).catch(e => e);
    expect(err).toBeInstanceOf(HandoffNoAnswerError);
    expect(err.message).toMatch(/short of memory/);
    expect(err.message).toMatch(/Through My Signet/);
    expect(err.message).not.toMatch(/didn't answer/);
    expect(c.request).toHaveBeenCalledTimes(2);
  });

  it("a silent device still reads as not answering", async () => {
    const c = failing(() => new Error('timeout waiting for device (list_identities)'));
    await expect(findHeartwoodHolder([c], hex())).rejects.toThrow(HANDOFF_NO_ANSWER_COPY);
  });

  it('another Heartwood that holds the key still wins', async () => {
    const m = hex();
    const bad = failing(() => new HeartwoodDeviceError('device low on memory', 'list_identities'));
    const good = holding(m);
    await expect(findHeartwoodHolder([bad, good], m)).resolves.toMatchObject({ client: good, targetHex: m });
  });
});

describe('the hand-off list this phone holds', () => {
  const rec = (c: string, slotIndex = 2) => ({ clientPubkey: c.repeat(64), appName: 'App', persona: 'd'.repeat(64), deviceHex: 'e'.repeat(64),
    targetHex: 'd'.repeat(64), slotIndex, secretFingerprint: 'ab'.repeat(8), relay: 'wss://r.example', createdAt: 1 });

  it('a refresh from the store keeps records tracked but not saved, and adds no duplicate', () => {
    const saved = rec('a');
    const beingSaved = rec('b');
    expect(mergeHandoffs([saved], [beingSaved]).map(h => h.clientPubkey[0])).toEqual(['a', 'b']);
    expect(mergeHandoffs([saved, beingSaved], [{ ...beingSaved }])).toHaveLength(2);
  });

  it('a record dropped from the store and not tracked stays dropped', () => {
    expect(mergeHandoffs([], [])).toEqual([]);
  });

  it('one app may hold more than one record; each one is found', () => {
    const list = [rec('a', 1), rec('b'), rec('a', 3)];
    expect(handoffsForClient(list, 'A'.repeat(64)).map(h => h.slotIndex)).toEqual([1, 3]);
    expect(sameHandoff(rec('a', 1), rec('a', 3))).toBe(false);
    expect(sameHandoff(rec('a', 1), { ...rec('a', 1), secretFingerprint: 'AB'.repeat(8) })).toBe(true);
  });
});

describe('revokeHandoffSlot: only the device list proves an app is gone', () => {
  const app = hex();
  const slot = { slotIndex: 3, secretFingerprint: 'ab'.repeat(8) };
  const row = (over: Partial<DeviceClientSlot>): DeviceClientSlot => ({
    slotIndex: 0, label: 'x', secretFingerprint: 'cd'.repeat(8), autoApprove: true, signingApproved: true, strictPermissions: true,
    currentPubkey: null, authorizedPubkeys: [], allowedKinds: [], allowedMethods: [], escalate: false, petitionOnDeny: false,
    auditChildWrap: false, boundIdentity: null, ...over,
  });
  function io(opts: { revoke?: (s: { slotIndex: number }) => Promise<void>; list?: () => Promise<DeviceClientSlot[]> } = {}) {
    const revoke = vi.fn(opts.revoke ?? (async () => {}));
    const listClients = vi.fn(opts.list ?? (async () => []));
    return { revoke, listClients, p: { clientPubkey: app, slot, revoke, listClients } };
  }
  const noSuchSlot = () => new HeartwoodDeviceError('no such slot: 3', 'revoke_client');
  const stale = () => new HeartwoodDeviceError('stale_client_slot: slot credential changed', 'revoke_client');

  it('a confirmed revoke needs no listing', async () => {
    const h = io();
    await revokeHandoffSlot(h.p);
    expect(h.revoke).toHaveBeenCalledTimes(1);
    expect(h.listClients).not.toHaveBeenCalled();
  });

  it('any other failure keeps the record, without a listing', async () => {
    const h = io({ revoke: async () => { throw new Error('timeout waiting for device (revoke_client)'); } });
    await expect(revokeHandoffSlot(h.p)).rejects.toThrow(/timeout/);
    expect(h.listClients).not.toHaveBeenCalled();
  });

  it('the exact messages only: a device text merely mentioning them keeps the record', async () => {
    const h = io({ revoke: async () => { throw new HeartwoodDeviceError('refused: no such slot: 3 (busy)', 'revoke_client'); } });
    await expect(revokeHandoffSlot(h.p)).rejects.toThrow(/busy/);
    expect(h.listClients).not.toHaveBeenCalled();
  });

  it('"no such slot" and the app on no slot: gone', async () => {
    const h = io({ revoke: async () => { throw noSuchSlot(); }, list: async () => [row({ currentPubkey: hex() })] });
    await expect(revokeHandoffSlot(h.p)).resolves.toBeUndefined();
    expect(h.revoke).toHaveBeenCalledTimes(1);
  });

  it('"stale_client_slot" with the app under another index: that slot is revoked once', async () => {
    const calls: number[] = [];
    const h = io({
      revoke: async s => { calls.push(s.slotIndex); if (s.slotIndex === 3) throw stale(); },
      list: async () => [row({ slotIndex: 7, secretFingerprint: 'ef'.repeat(8), authorizedPubkeys: [app] })],
    });
    await revokeHandoffSlot(h.p);
    expect(calls).toEqual([3, 7]);
    expect(h.revoke.mock.calls[1][0]).toEqual({ slotIndex: 7, secretFingerprint: 'ef'.repeat(8) });
  });

  it('the app still listed and its slot will not go: throws, so the record is kept', async () => {
    const h = io({
      revoke: async () => { throw stale(); },
      list: async () => [row({ slotIndex: 7, currentPubkey: app.toUpperCase() })],
    });
    await expect(revokeHandoffSlot(h.p)).rejects.toThrow(/stale_client_slot/);
    expect(h.revoke).toHaveBeenCalledTimes(2);
  });

  it('a listing that fails keeps the record', async () => {
    const h = io({ revoke: async () => { throw noSuchSlot(); }, list: async () => { throw new Error('list_clients reply had no client list'); } });
    await expect(revokeHandoffSlot(h.p)).rejects.toThrow(/no client list/);
  });

  it('a record with no fingerprint is found by the app key', async () => {
    const h = io({ list: async () => [row({ slotIndex: 9, secretFingerprint: '12'.repeat(8), currentPubkey: app })] });
    await revokeHandoffSlot({ ...h.p, slot: { slotIndex: 9, secretFingerprint: '' } });
    expect(h.revoke.mock.calls).toEqual([[{ slotIndex: 9, secretFingerprint: '12'.repeat(8) }]]);
  });

  it('a record kept with no slot (the phone locked mid-mint): a slot holding the app is revoked', async () => {
    const h = io({ list: async () => [row({ slotIndex: 4, secretFingerprint: '34'.repeat(8), authorizedPubkeys: [app] })] });
    await revokeHandoffSlot({ ...h.p, slot: { secretFingerprint: '' } });
    expect(h.listClients).toHaveBeenCalledTimes(1);
    expect(h.revoke.mock.calls).toEqual([[{ slotIndex: 4, secretFingerprint: '34'.repeat(8) }]]);
  });

  it('a record kept with no slot, and the app on no slot: gone, with nothing revoked', async () => {
    const h = io({ list: async () => [row({ currentPubkey: hex() })] });
    await expect(revokeHandoffSlot({ ...h.p, slot: { secretFingerprint: '' } })).resolves.toBeUndefined();
    expect(h.revoke).not.toHaveBeenCalled();
  });
});

describe('revokeEveryHandoff: one record that will not go does not hold up the rest', () => {
  const rec = (c: string, d: string) => ({ clientPubkey: 'a'.repeat(64), appName: 'App', persona: 'd'.repeat(64), deviceHex: d.repeat(64),
    targetHex: 'd'.repeat(64), slotIndex: 2, secretFingerprint: c.repeat(8), relay: 'wss://r.example', createdAt: 1 });

  it('tries every record and throws the first failure once all were tried', async () => {
    const tried: string[] = [];
    const unmanaged = new HandoffUnmanagedError();
    const records = [rec('aa', 'e'), rec('bb', 'f'), rec('cc', 'e')];
    const err = await revokeEveryHandoff(records, async r => {
      tried.push(r.secretFingerprint.slice(0, 2));
      if (r.deviceHex === 'e'.repeat(64) && r.secretFingerprint.startsWith('aa')) throw unmanaged;
      if (r.secretFingerprint.startsWith('cc')) throw new Error('timeout waiting for device (revoke_client)');
    }).then(() => null, (e: unknown) => e);
    expect(tried).toEqual(['aa', 'bb', 'cc']);
    expect(err).toBe(unmanaged);
  });

  it('resolves when every record went', async () => {
    const revoke = vi.fn(async () => {});
    await expect(revokeEveryHandoff([rec('aa', 'e'), rec('bb', 'f')], revoke)).resolves.toBeUndefined();
    expect(revoke).toHaveBeenCalledTimes(2);
  });
});

describe('runHandoffApproval: nothing is revoked for a check that could fail first', () => {
  const prior = { clientPubkey: 'a'.repeat(64), appName: 'App', persona: 'd'.repeat(64), deviceHex: 'e'.repeat(64),
    targetHex: 'd'.repeat(64), slotIndex: 2, secretFingerprint: 'ab'.repeat(8), relay: 'wss://r.example', createdAt: 1 };
  const plan = { relay: 'wss://r.example', persona: 'd'.repeat(64) } as unknown as HandoffPlan;
  const handed = { slotIndex: 5 } as unknown as HandoffResult;
  function io(o: { prepare?: () => Promise<HandoffPlan>; claim?: boolean; revoke?: () => Promise<void>; mint?: () => Promise<HandoffResult>; priors?: typeof prior[]; cancelled?: () => boolean } = {}) {
    const log: string[] = [];
    return {
      log,
      p: {
        priors: o.priors ?? [prior],
        prepare: async () => { log.push('prepare'); return (o.prepare ?? (async () => plan))(); },
        claim: () => { log.push('claim'); return o.claim ?? true; },
        unclaim: () => { log.push('unclaim'); },
        cancelRequested: () => (o.cancelled ?? (() => false))(),
        endCancelled: () => { log.push('end-cancelled'); },
        revokePrior: async () => { log.push('revoke'); await (o.revoke ?? (async () => {}))(); },
        mint: async () => { log.push('mint'); return (o.mint ?? (async () => handed))(); },
      },
    };
  }

  it('finds the Heartwood and claims the request before the earlier hand-off is revoked', async () => {
    const h = io();
    expect(await runHandoffApproval(h.p)).toEqual({ status: 'minted', handed });
    expect(h.log).toEqual(['prepare', 'claim', 'revoke', 'mint']);
  });

  it('a Heartwood that cannot take it leaves the earlier hand-off alone', async () => {
    const h = io({ prepare: async () => { throw new HandoffUnavailableError(); } });
    await expect(runHandoffApproval(h.p)).rejects.toBeInstanceOf(HandoffUnavailableError);
    expect(h.log).toEqual(['prepare']);
  });

  it('a request cancelled meanwhile changes nothing', async () => {
    const h = io({ claim: false });
    expect(await runHandoffApproval(h.p)).toEqual({ status: 'withdrawn' });
    expect(h.log).toEqual(['prepare', 'claim']);
  });

  it('a Cancel during the revoke stops the mint: the request ends cancelled and stays answered', async () => {
    let cancelled = false;
    const h = io({ revoke: async () => { cancelled = true; }, cancelled: () => cancelled });
    expect(await runHandoffApproval(h.p)).toEqual({ status: 'withdrawn' });
    expect(h.log).toEqual(['prepare', 'claim', 'revoke', 'end-cancelled']);
  });

  it('a Cancel during a revoke that then fails ends cancelled too, with nothing minted or given back', async () => {
    let cancelled = false;
    const h = io({ revoke: async () => { cancelled = true; throw new Error("Your Heartwood didn't answer."); }, cancelled: () => cancelled });
    expect(await runHandoffApproval(h.p)).toEqual({ status: 'withdrawn' });
    expect(h.log).toEqual(['prepare', 'claim', 'revoke', 'end-cancelled']);
  });

  it('no Cancel: the mint goes ahead and nothing is ended early', async () => {
    const h = io({ cancelled: () => false });
    expect(await runHandoffApproval(h.p)).toEqual({ status: 'minted', handed });
    expect(h.log).not.toContain('end-cancelled');
  });

  it('a revoke that fails mints nothing and gives the request back', async () => {
    const h = io({ revoke: async () => { throw new Error("Your Heartwood didn't answer."); } });
    await expect(runHandoffApproval(h.p)).rejects.toThrow(/didn't answer/);
    expect(h.log).toEqual(['prepare', 'claim', 'revoke', 'unclaim']);
  });

  it('a mint that fails after the revoke says the app was removed and to scan its code again', async () => {
    const h = io({ mint: async () => { throw new Error("Your Heartwood didn't answer."); } });
    const err = await runHandoffApproval(h.p).then(() => null, (e: Error) => e);
    expect(err?.message).toBe(`Your Heartwood didn't answer. ${HANDOFF_PRIOR_REMOVED_COPY}`);
    expect(h.log).toEqual(['prepare', 'claim', 'revoke', 'mint', 'unclaim']);
  });

  it('with no earlier hand-off a failed mint reads as itself', async () => {
    const h = io({ priors: [], mint: async () => { throw new Error('That did not work. Try again.'); } });
    await expect(runHandoffApproval(h.p)).rejects.toThrow(/^That did not work. Try again.$/);
  });
});

describe('a mint the device may still hold is kept, never retried blind', () => {
  const m0 = 'f'.repeat(64);
  const request = { clientPubkey: 'c'.repeat(64), relayUrl: 'wss://relay.primal.net', relayUrls: ['wss://relay.primal.net'], secret: 's3cret', appName: 'KithMoot' };
  const plan = (request: (m: string) => Promise<unknown>) => ({
    holder: { client: { deviceHex: m0, relays: ['wss://relay.primal.net'], request: vi.fn(request) } as unknown as HeartwoodMgmtClient, targetHex: m0 },
    relay: 'wss://relay.primal.net',
    persona: m0,
  });

  it('a mismatched mint the device would not undo keeps its slot and fingerprint', async () => {
    const p = plan(async (method) => {
      if (method === 'nostrconnect_v2') return { slot_index: 6, secret_fingerprint: 'AB12', identity: 'd'.repeat(64), policy_version: 2, allowed_methods: [], allowed_kinds: [], auto_approve: true };
      throw new HeartwoodDeviceError('boom', 'revoke_client');
    });
    const err = await mintHandoff(p, { request }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(HandoffKeptError);
    expect((err as HandoffKeptError).slot).toEqual({ slotIndex: 6, secretFingerprint: 'ab12', deviceHex: m0, targetHex: m0, relay: 'wss://relay.primal.net' });
    expect((err as Error).message).toBe(HANDOFF_MISMATCH_KEPT_COPY);
    expect(endsConnectRequest(err)).toBe(true);
  });

  it('the request stays answered: no unclaim, no "scan again" rewrite', async () => {
    const log: string[] = [];
    const kept = new HandoffKeptError({ slotIndex: 1, secretFingerprint: '', deviceHex: m0, targetHex: m0, relay: 'wss://r' }, 'kept');
    const p = plan(async () => ({}));
    await expect(runHandoffApproval({
      priors: [{ clientPubkey: 'c'.repeat(64), appName: 'A', persona: m0, deviceHex: m0, targetHex: m0, slotIndex: 0, secretFingerprint: 'aa', relay: 'wss://r', createdAt: 1 }],
      prepare: async () => p, claim: () => true, unclaim: () => { log.push('unclaim'); },
      cancelRequested: () => false, endCancelled: () => { log.push('end-cancelled'); },
      revokePrior: async () => {}, mint: async () => { throw kept; },
    })).rejects.toBe(kept);
    expect(log).toEqual([]);
  });

  it('only errors that answered the request close it', () => {
    expect(endsConnectRequest(new HandoffNotSavedError())).toBe(true);
    expect(endsConnectRequest(new HandoffStrandedError())).toBe(true);
    expect(endsConnectRequest(new HandoffUnavailableError())).toBe(false);
    expect(endsConnectRequest(new Error('x'))).toBe(false);
    expect(new HandoffNotSavedError().message).toMatch(/Scan the app's code again/);
    expect(new HandoffStrandedError().message).toMatch(/Sapwood, then scan the app's code again/);
  });
});

describe('missingOperatorError: unmanaged only when the stored keys say so', () => {
  const dev = 'e'.repeat(64);
  it('no stored key for the device: unmanaged, with Forget on this phone and the Sapwood hint', () => {
    const e = missingOperatorError(['a'.repeat(64)], dev);
    expect(e).toBeInstanceOf(HandoffUnmanagedError);
    expect((e as HandoffUnmanagedError).unmanaged).toBe(true);
    expect(e.message).toMatch(/Forget on this phone/);
    expect(e.message).toMatch(/Sapwood/);
  });
  it('a stored key whose link is not up yet, or keys that cannot be read: try again', () => {
    expect(missingOperatorError(['E'.repeat(64)], dev).message).toBe(HANDOFF_STILL_CONNECTING_COPY);
    expect(missingOperatorError(null, dev)).not.toBeInstanceOf(HandoffUnmanagedError);
  });
});

describe('a mint that got no answer: look before giving the request back', () => {
  const m0 = 'f'.repeat(64);
  const app = 'c'.repeat(64);
  const request = { clientPubkey: app, relayUrl: 'wss://relay.primal.net', relayUrls: ['wss://relay.primal.net'], secret: 's3cret', appName: 'KithMoot' };
  const row = (over: Record<string, unknown>) => ({
    slot_index: 8, secret_fingerprint: 'fp8', auto_approve: true, signing_approved: true, strict_permissions: true,
    current_pubkey: null, authorized_pubkeys: [], allowed_kinds: [], allowed_methods: [], ...over,
  });
  function plan(onList: () => Promise<unknown>, mintError: Error = new Error('timeout waiting for device (nostrconnect_v2)')) {
    const request = vi.fn(async (method: string, _p?: unknown, opts?: { targetHex?: string }) => {
      if (method === 'nostrconnect_v2') throw mintError;
      if (method === 'list_clients') { expect(opts).toEqual({ targetHex: m0 }); return onList(); }
      throw new Error(`unexpected ${method}`);
    });
    return {
      request,
      plan: { holder: { client: { deviceHex: 'e'.repeat(64), relays: [], request } as unknown as HeartwoodMgmtClient, targetHex: m0 }, relay: 'wss://relay.primal.net', persona: m0 },
    };
  }

  it('the app listed on the device: kept as a record that can be disconnected, and the outcome called uncertain', async () => {
    const p = plan(async () => ({ clients: [row({ current_pubkey: app, bound_identity: m0 })] }));
    const err = await mintHandoff(p.plan, { request }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(HandoffKeptError);
    expect((err as HandoffKeptError).slot).toEqual({ slotIndex: 8, secretFingerprint: 'fp8', deviceHex: 'e'.repeat(64), targetHex: m0, relay: 'wss://relay.primal.net' });
    expect((err as Error).message).toBe(HANDOFF_UNCERTAIN_KEPT_COPY);
  });

  it('not listed, or the listing fails: the request is given back with the no-answer copy', async () => {
    for (const onList of [async () => ({ clients: [row({ current_pubkey: 'd'.repeat(64) })] }), async () => { throw new Error('timeout waiting for device (list_clients)'); }]) {
      const err = await mintHandoff(plan(onList).plan, { request }).then(() => null, (e: unknown) => e);
      expect(err).not.toBeInstanceOf(HandoffKeptError);
      expect((err as Error).message).toMatch(/didn't answer/);
    }
  });

  it('listed under another identity: kept under that identity, and called an earlier pairing', async () => {
    const other = 'b'.repeat(64);
    const p = plan(async () => ({ clients: [row({ authorized_pubkeys: [app], bound_identity: other })] }));
    const err = await mintHandoff(p.plan, { request }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(HandoffKeptError);
    expect((err as HandoffKeptError).slot).toEqual({ slotIndex: 8, secretFingerprint: 'fp8', deviceHex: 'e'.repeat(64), targetHex: m0, relay: 'wss://relay.primal.net', persona: other });
    expect((err as Error).message).toBe(HANDOFF_EARLIER_KEPT_COPY);
  });

  it('listed with no identity: called an earlier pairing, filed under the persona chosen', async () => {
    const p = plan(async () => ({ clients: [row({ current_pubkey: app })] }));
    const err = await mintHandoff(p.plan, { request }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(HandoffKeptError);
    expect((err as HandoffKeptError).slot.persona).toBeUndefined();
    expect((err as Error).message).toBe(HANDOFF_EARLIER_KEPT_COPY);
  });

  it('no answer to the challenge: nothing was sent, so nothing is looked for', async () => {
    const p = plan(async () => ({ clients: [row({ current_pubkey: app, bound_identity: m0 })] }), new Error('timeout waiting for device (get_management_challenge)'));
    const err = await mintHandoff(p.plan, { request }).then(() => null, (e: unknown) => e);
    expect(err).not.toBeInstanceOf(HandoffKeptError);
    expect((err as Error).message).toMatch(/didn't answer/);
    expect(p.request.mock.calls.some(c => c[0] === 'list_clients')).toBe(false);
  });

  it('the link closed before the device answered (the phone locked): kept with no slot, without a listing', async () => {
    const p = plan(async () => ({ clients: [] }), new Error('transport closed'));
    const err = await mintHandoff(p.plan, { request }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(HandoffKeptError);
    expect((err as HandoffKeptError).slot).toEqual({ secretFingerprint: '', deviceHex: 'e'.repeat(64), targetHex: m0, relay: 'wss://relay.primal.net' });
    expect((err as Error).message).toBe(HANDOFF_LOCKED_KEPT_COPY);
    expect(endsConnectRequest(err)).toBe(true);
    expect(p.request.mock.calls.some(c => c[0] === 'list_clients')).toBe(false);
  });

  it('a device that answered with an error is not looked for', async () => {
    const p = plan(async () => ({ clients: [] }), new HeartwoodDeviceError('slot table full', 'nostrconnect_v2'));
    await expect(mintHandoff(p.plan, { request })).rejects.toThrow(/slot table full/);
    expect(p.request.mock.calls.some(c => c[0] === 'list_clients')).toBe(false);
  });
});
