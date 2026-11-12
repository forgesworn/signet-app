import { describe, it, expect } from 'vitest';
import type { CreateClientV2Reply, HeartwoodMgmtClient } from './heartwood-mgmt';
import type { DeviceClientSlot, DeviceStatus } from './heartwood-mgmt-types';
import type { HeartwoodSignInLinkRecord } from './db';
import { HeartwoodCopyError } from './heartwood-mgmt-error-copy';
import { handoffPolicy } from './heartwood-handoff';
import {
  SIGN_IN_LINK_LABEL_MAX,
  SIGN_IN_LINK_MISMATCH_COPY,
  SIGN_IN_LINK_MISMATCH_KEPT_COPY,
  SIGN_IN_LINK_NOT_SAVED_COPY,
  SIGN_IN_LINK_NOT_SAVED_KEPT_COPY,
  SIGN_IN_LINK_NO_ANSWER_COPY,
  abandonSignInLink,
  checkSignInLinkEcho,
  findSignInHolder,
  isConfirmedSignInLink,
  parseBunkerLink,
  revokeSignInLinkSlot,
  runSignInLinkApproval,
  signInHolderError,
  signInLinkLabel,
  signInLinkOffered,
  signInLinkPolicy,
  signInLinkSupported,
  signInLinksToRevoke,
  type SignInLinkEligibility,
  type SignInLinkIo,
} from './heartwood-signin-link';

const PERSONA = 'b'.repeat(64);
const OTHER = 'c'.repeat(64);
const SECRET = '9'.repeat(64);
const ORIGIN = 'https://kithmoot.com';

const eligible: SignInLinkEligibility = {
  signingMode: 'bunker', isPairedChild: false, childDirect: false, hasActiveDependant: false,
  selectionSource: 'guardian', importedPersona: false, hasOperatorClient: true, combinedPermission: false,
};

describe('signInLinkOffered', () => {
  it('is offered when every condition holds', () => {
    expect(signInLinkOffered(eligible)).toBe(true);
  });
  it.each([
    ['not bunker mode', { signingMode: 'local' }],
    ['no signing mode', { signingMode: undefined }],
    ['paired child', { isPairedChild: true }],
    ['child direct', { childDirect: true }],
    ['a dependant is active', { hasActiveDependant: true }],
    ['a dependant is picked', { selectionSource: 'dependant' as const }],
    ['nothing picked', { selectionSource: undefined }],
    ['imported persona', { importedPersona: true }],
    ['no operator client', { hasOperatorClient: false }],
    ['combined app-permission sign-in', { combinedPermission: true }],
  ])('is not offered: %s', (_name, over) => {
    expect(signInLinkOffered({ ...eligible, ...over })).toBe(false);
  });
});

describe('signInLinkSupported', () => {
  const status = (capabilities: string[] | null): DeviceStatus => ({ capabilities, masterNpubHex: 'a'.repeat(64), truncated: capabilities === null });
  it('tries when the status is unknown or truncated', () => {
    expect(signInLinkSupported(null)).toBe(true);
    expect(signInLinkSupported(status(null))).toBe(true);
  });
  it('tries when both capabilities are listed', () => {
    expect(signInLinkSupported(status(['client_policy_v2', 'pairing_identity_v1']))).toBe(true);
  });
  it('does not try when either is definitely missing', () => {
    expect(signInLinkSupported(status(['client_policy_v2']))).toBe(false);
    expect(signInLinkSupported(status(['pairing_identity_v1']))).toBe(false);
    expect(signInLinkSupported(status([]))).toBe(false);
  });
});

describe('signInLinkLabel', () => {
  it('is mysignet:<host>:<8 hex>', () => {
    expect(signInLinkLabel(ORIGIN, () => 'DEADBEEF')).toBe('mysignet:kithmoot.com:deadbeef');
  });
  it('never exceeds the limit, cutting the host and never the suffix', () => {
    const label = signInLinkLabel('https://a-very-long-subdomain-name.another-long-label.example.com', () => '0123abcd');
    expect(label.length).toBeLessThanOrEqual(SIGN_IN_LINK_LABEL_MAX);
    expect(label.startsWith('mysignet:')).toBe(true);
    expect(label.endsWith(':0123abcd')).toBe(true);
  });
  it('uses 30 characters of host at most, so the whole label is exactly 48 when cut', () => {
    const label = signInLinkLabel(`https://${'a'.repeat(60)}.example`, () => '00000000');
    expect(label).toHaveLength(48);
  });
  it('lowercases the host, and falls back when there is no host', () => {
    expect(signInLinkLabel('https://Ex-Ample.COM', () => '00000000')).toBe('mysignet:ex-ample.com:00000000');
    expect(signInLinkLabel('not a url', () => '00000000')).toBe('mysignet:site:00000000');
  });
  it('makes a different label each time by default', () => {
    expect(signInLinkLabel(ORIGIN)).not.toBe(signInLinkLabel(ORIGIN));
    expect(signInLinkLabel(ORIGIN)).toMatch(/^mysignet:kithmoot\.com:[0-9a-f]{8}$/);
  });
});

describe('signInLinkPolicy', () => {
  it('is the wide hand-off grant bound to the identity', () => {
    expect(signInLinkPolicy(PERSONA.toUpperCase())).toEqual(handoffPolicy(PERSONA));
    expect(signInLinkPolicy(PERSONA)).toMatchObject({ autoApprove: true, allowedKinds: [], boundIdentity: PERSONA });
  });
});

describe('parseBunkerLink', () => {
  it('reads the identity and whether a secret is there, never the secret', () => {
    expect(parseBunkerLink(`bunker://${PERSONA.toUpperCase()}?relay=wss%3A%2F%2Fr.example&secret=${SECRET}`)).toEqual({ pubkey: PERSONA, hasSecret: true });
    expect(parseBunkerLink(`bunker://${PERSONA}?relay=wss%3A%2F%2Fr.example`)).toEqual({ pubkey: PERSONA, hasSecret: false });
    expect(parseBunkerLink(`bunker://${PERSONA}?secret=`)).toEqual({ pubkey: PERSONA, hasSecret: false });
  });
  it('rejects anything that is not a bunker link to a 64-hex identity', () => {
    for (const bad of ['', 'https://x', `bunker://${'z'.repeat(64)}?secret=1`, `bunker://${PERSONA}`, `nostrconnect://${PERSONA}?secret=1`, `bunker://${PERSONA.slice(1)}?secret=1`]) {
      expect(parseBunkerLink(bad)).toBeNull();
    }
  });
});

const policy = signInLinkPolicy(PERSONA);
const goodReply = (over: Partial<CreateClientV2Reply> = {}): CreateClientV2Reply => ({
  slotIndex: 4,
  secretFingerprint: 'fp4',
  label: 'mysignet:kithmoot.com:0123abcd',
  npubHex: PERSONA,
  bunkerUri: `bunker://${PERSONA}?relay=wss%3A%2F%2Fhw.example&secret=${SECRET}`,
  policyVersion: 2,
  allowedMethods: [...policy.allowedMethods].reverse(),
  allowedKinds: [],
  autoApprove: true,
  ...over,
});

describe('checkSignInLinkEcho', () => {
  it('accepts the slot that was asked for, in any order of methods', () => {
    const r = checkSignInLinkEcho(goodReply(), { persona: PERSONA, policy });
    expect(r).toMatchObject({ ok: true, slotIndex: 4, secretFingerprint: 'fp4' });
  });
  it.each<[string, Partial<CreateClientV2Reply>]>([
    ['policy version 1', { policyVersion: 1 }],
    ['no policy version', { policyVersion: null }],
    ['npub_hex of another identity', { npubHex: OTHER }],
    ['no npub_hex', { npubHex: '' }],
    ['link to another identity', { bunkerUri: `bunker://${OTHER}?secret=${SECRET}` }],
    ['link with no secret', { bunkerUri: `bunker://${PERSONA}?relay=wss%3A%2F%2Fhw.example` }],
    ['link that is not bunker://', { bunkerUri: `nostrconnect://${PERSONA}?secret=${SECRET}` }],
    ['no link', { bunkerUri: '' }],
    ['no slot index', { slotIndex: null }],
    ['no fingerprint', { secretFingerprint: '' }],
    ['a method added', { allowedMethods: [...policy.allowedMethods, 'nip04_decrypt'] }],
    ['a method missing', { allowedMethods: ['get_public_key'] }],
    ['no methods echoed', { allowedMethods: null }],
    ['kinds narrowed to a list', { allowedKinds: [1] }],
    ['no kinds echoed', { allowedKinds: null }],
    ['auto_approve off', { autoApprove: false }],
    ['no auto_approve', { autoApprove: null }],
  ])('refuses %s', (_name, over) => {
    expect(checkSignInLinkEcho(goodReply(over), { persona: PERSONA, policy }).ok).toBe(false);
  });
  it('names the slot for a revoke when the reply gave one, and not when it did not', () => {
    const wrongIdentity = checkSignInLinkEcho(goodReply({ npubHex: OTHER }), { persona: PERSONA, policy });
    expect(wrongIdentity).toMatchObject({ ok: false, slot: { slotIndex: 4, secretFingerprint: 'fp4' } });
    const noSlot = checkSignInLinkEcho(goodReply({ slotIndex: null }), { persona: PERSONA, policy });
    expect(noSlot).toMatchObject({ ok: false, slot: null });
    const noFp = checkSignInLinkEcho(goodReply({ secretFingerprint: '' }), { persona: PERSONA, policy });
    expect(noFp).toMatchObject({ ok: false, slot: null });
  });
  it('never puts the link in the verdict of a refusal', () => {
    const r = checkSignInLinkEcho(goodReply({ npubHex: OTHER }), { persona: PERSONA, policy });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
});

const rec = (over: Partial<HeartwoodSignInLinkRecord> = {}): HeartwoodSignInLinkRecord => ({
  origin: ORIGIN, appName: 'KithMoot', persona: PERSONA, deviceHex: 'd'.repeat(64), targetHex: 'e'.repeat(64),
  label: 'mysignet:kithmoot.com:aaaaaaaa', slotIndex: 1, secretFingerprint: 'fp1', createdAt: 1, ...over,
});

describe('signInLinksToRevoke', () => {
  it('picks every earlier link of the origin, any identity, any master, and not the one being made', () => {
    const records = [
      rec({ label: 'a' }),
      rec({ label: 'b', persona: OTHER, targetHex: 'f'.repeat(64) }),
      rec({ label: 'c', origin: 'https://other.example' }),
      rec({ label: 'now' }),
      rec({ label: 'd', origin: 'HTTPS://KITHMOOT.COM', slotIndex: undefined, secretFingerprint: '' }),
    ];
    expect(signInLinksToRevoke(records, ORIGIN, 'now').map(r => r.label)).toEqual(['a', 'b', 'd']);
  });
});

describe('isConfirmedSignInLink', () => {
  it('is true only once the device has answered', () => {
    expect(isConfirmedSignInLink(rec())).toBe(true);
    expect(isConfirmedSignInLink(rec({ secretFingerprint: '' }))).toBe(false);
    expect(isConfirmedSignInLink(rec({ slotIndex: undefined }))).toBe(false);
  });
});

const slotRow = (over: Partial<DeviceClientSlot>): DeviceClientSlot => ({
  slotIndex: 0, label: '', secretFingerprint: 'fp', autoApprove: true, signingApproved: true, strictPermissions: true,
  currentPubkey: null, authorizedPubkeys: [], allowedKinds: [], allowedMethods: [], escalate: false, petitionOnDeny: false,
  auditChildWrap: false, boundIdentity: null, ...over,
});

describe('revokeSignInLinkSlot', () => {
  it('revokes by index and fingerprint, and never lists when that works', async () => {
    const calls: string[] = [];
    await revokeSignInLinkSlot({
      rec: rec(),
      revoke: async s => { calls.push(`revoke ${s.slotIndex} ${s.secretFingerprint}`); },
      listClients: async () => { calls.push('list'); return []; },
    });
    expect(calls).toEqual(['revoke 1 fp1']);
  });
  it('lists and matches by label when the slot is no longer at that index, and revokes the match', async () => {
    const calls: string[] = [];
    await revokeSignInLinkSlot({
      rec: rec(),
      revoke: async s => {
        calls.push(`revoke ${s.slotIndex}`);
        if (s.slotIndex === 1) throw new Error('no such slot: 1');
      },
      listClients: async () => [slotRow({ slotIndex: 7, label: 'mysignet:kithmoot.com:aaaaaaaa', secretFingerprint: 'fp7' }), slotRow({ slotIndex: 8, label: 'mysignet:kithmoot.com:bbbbbbbb' })],
    });
    expect(calls).toEqual(['revoke 1', 'revoke 7']);
  });
  it('counts a record as gone only when the device list has no slot with its label', async () => {
    await expect(revokeSignInLinkSlot({
      rec: rec({ slotIndex: undefined, secretFingerprint: '' }),
      revoke: async () => { throw new Error('must not be called'); },
      listClients: async () => [slotRow({ slotIndex: 2, label: 'mysignet:other.example:aaaaaaaa' })],
    })).resolves.toBeUndefined();
  });
  it('goes straight to the list for a record with no slot yet', async () => {
    const revoked: number[] = [];
    await revokeSignInLinkSlot({
      rec: rec({ slotIndex: undefined, secretFingerprint: '' }),
      revoke: async s => { revoked.push(s.slotIndex); },
      listClients: async () => [slotRow({ slotIndex: 3, label: 'mysignet:kithmoot.com:aaaaaaaa', secretFingerprint: 'fp3' })],
    });
    expect(revoked).toEqual([3]);
  });
  it('throws (so the record is kept) when a revoke fails for any other reason or the list cannot be read', async () => {
    await expect(revokeSignInLinkSlot({
      rec: rec(), revoke: async () => { throw new Error('timeout waiting for device (revoke_client)'); }, listClients: async () => [],
    })).rejects.toThrow('timeout');
    await expect(revokeSignInLinkSlot({
      rec: rec({ slotIndex: undefined, secretFingerprint: '' }), revoke: async () => undefined, listClients: async () => { throw new Error('list_clients reply had no client list'); },
    })).rejects.toThrow('no client list');
  });
  it('a stale slot falls back to the list too', async () => {
    const revoked: number[] = [];
    await revokeSignInLinkSlot({
      rec: rec(),
      revoke: async s => { revoked.push(s.slotIndex); if (s.slotIndex === 1) throw new Error('stale_client_slot: slot credential changed'); },
      listClients: async () => [],
    });
    expect(revoked).toEqual([1]);
  });
});

describe('findSignInHolder / signInHolderError', () => {
  const clientWith = (identities: unknown[] | Error): HeartwoodMgmtClient => ({
    deviceHex: 'd'.repeat(64),
    request: async () => { if (identities instanceof Error) throw identities; return { identities }; },
  }) as unknown as HeartwoodMgmtClient;
  const id = (kind: 'master' | 'persona', slot: number, pk: string) => ({ kind, slot, npub_hex: pk, label: '' });

  it('finds the master that serves the identity', async () => {
    const c = clientWith([id('master', 0, 'a'.repeat(64)), id('persona', 0, PERSONA)]);
    const holder = await findSignInHolder({ clients: [c], persona: PERSONA });
    expect(holder.targetHex).toBe('a'.repeat(64));
    expect(holder.client).toBe(c);
  });
  it('says the Heartwood did not answer, in the sign-in wording, when no one holds it', async () => {
    const c = clientWith([id('master', 0, 'a'.repeat(64))]);
    await expect(findSignInHolder({ clients: [c], persona: PERSONA })).rejects.toThrow(SIGN_IN_LINK_NO_ANSWER_COPY);
  });
  it('says it when no device answered, without pointing at Through My Signet', async () => {
    const c = clientWith(new Error('timeout waiting for device (list_identities)'));
    let err: unknown;
    try { await findSignInHolder({ clients: [c], persona: PERSONA }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(HeartwoodCopyError);
    expect((err as Error).message).not.toMatch(/Through My Signet/);
  });
  it('keeps a device-specific reason and swaps only the other option', () => {
    expect(signInHolderError(new Error('x'))).toBeInstanceOf(HeartwoodCopyError);
  });
});

// ─── The approval flow, on injected I/O ─────────────────────────────────────

interface Rig {
  io: SignInLinkIo;
  log: string[];
  store: HeartwoodSignInLinkRecord[];
  device: DeviceClientSlot[];
  failure: { mint?: Error; putAt?: number; revokeIf?: (r: HeartwoodSignInLinkRecord) => Error | null; list?: Error; holder?: Error; capable?: Error; reply?: Partial<CreateClientV2Reply>; mintLands?: boolean };
}

function rig(seed: HeartwoodSignInLinkRecord[] = []): Rig {
  const log: string[] = [];
  const store = [...seed];
  const device: DeviceClientSlot[] = seed.filter(isConfirmedSignInLink).map(r => slotRow({ slotIndex: r.slotIndex!, label: r.label, secretFingerprint: r.secretFingerprint }));
  const failure: Rig['failure'] = {};
  let puts = 0;
  let next = 10;
  const io: SignInLinkIo = {
    request: { origin: ORIGIN, appName: 'KithMoot', persona: PERSONA },
    now: () => 1000,
    label: () => 'mysignet:kithmoot.com:cafef00d',
    findHolder: async () => { log.push('holder'); if (failure.holder) throw failure.holder; return { deviceHex: 'd'.repeat(64), targetHex: 'e'.repeat(64) }; },
    ensureCapable: async () => { log.push('capable'); if (failure.capable) throw failure.capable; },
    listRecords: async () => { log.push('list-records'); return store.map(r => ({ ...r })); },
    putRecord: async r => {
      puts++;
      log.push(`put ${r.label.slice(-8)} ${r.slotIndex ?? '-'}`);
      if (failure.putAt === puts) throw new Error('idb full');
      const at = store.findIndex(x => x.label === r.label);
      if (at >= 0) store[at] = { ...r }; else store.push({ ...r });
    },
    dropRecord: async r => { log.push(`drop ${r.label.slice(-8)}`); const at = store.findIndex(x => x.label === r.label); if (at >= 0) store.splice(at, 1); },
    revokeRecord: async r => {
      log.push(`revoke ${r.label.slice(-8)}`);
      const err = failure.revokeIf?.(r);
      if (err) throw err;
      if (failure.list && !(r.slotIndex !== undefined && r.secretFingerprint)) throw failure.list;
      const at = device.findIndex(s => s.label === r.label);
      if (at >= 0) device.splice(at, 1);
    },
    mint: async (_holder, label) => {
      log.push('mint');
      if (failure.mint) {
        if (failure.mintLands) device.push(slotRow({ slotIndex: next, label, secretFingerprint: 'fpnew' }));
        throw failure.mint;
      }
      const slotIndex = next++;
      device.push(slotRow({ slotIndex, label, secretFingerprint: 'fpnew' }));
      return goodReply({ slotIndex, secretFingerprint: 'fpnew', label, ...failure.reply });
    },
  };
  return { io, log, store, device, failure };
}

describe('runSignInLinkApproval', () => {
  it('goes holder, capability, pending record, revoke earlier, mint, record the slot, and hands back the link', async () => {
    const r = rig([rec({ label: 'mysignet:kithmoot.com:aaaaaaaa', slotIndex: 1, secretFingerprint: 'fp1' })]);
    const out = await runSignInLinkApproval(r.io);
    expect(r.log).toEqual([
      'holder', 'capable',
      'put cafef00d -',
      'list-records',
      'revoke aaaaaaaa', 'drop aaaaaaaa',
      'mint',
      'put cafef00d 10',
    ]);
    expect(out.record).toMatchObject({ origin: ORIGIN, persona: PERSONA, label: 'mysignet:kithmoot.com:cafef00d', slotIndex: 10, secretFingerprint: 'fpnew', targetHex: 'e'.repeat(64), deviceHex: 'd'.repeat(64), createdAt: 1000 });
    expect(out.bunkerUri).toBe(`bunker://${PERSONA}?relay=wss%3A%2F%2Fhw.example&secret=${SECRET}`);
    expect(r.store.map(x => x.label)).toEqual(['mysignet:kithmoot.com:cafef00d']);
    expect(r.device.map(s => s.slotIndex)).toEqual([10]);
  });

  it('never stores the link or its secret', async () => {
    const r = rig();
    await runSignInLinkApproval(r.io);
    expect(JSON.stringify(r.store)).not.toContain(SECRET);
    expect(JSON.stringify(r.store)).not.toContain('bunker://');
  });

  it('stops with the copy, changing nothing, when no Heartwood answers', async () => {
    const r = rig();
    r.failure.holder = new HeartwoodCopyError(SIGN_IN_LINK_NO_ANSWER_COPY);
    await expect(runSignInLinkApproval(r.io)).rejects.toThrow(SIGN_IN_LINK_NO_ANSWER_COPY);
    expect(r.log).toEqual(['holder']);
    expect(r.store).toEqual([]);
  });

  it('stops before any record or mint when the device can not do this', async () => {
    const r = rig();
    r.failure.capable = new HeartwoodCopyError('Too old.');
    await expect(runSignInLinkApproval(r.io)).rejects.toThrow('Too old.');
    expect(r.log).toEqual(['holder', 'capable']);
    expect(r.store).toEqual([]);
  });

  it('saves the pending record BEFORE it revokes or mints, and a record that cannot be saved stops everything', async () => {
    const r = rig();
    r.failure.putAt = 1;
    await expect(runSignInLinkApproval(r.io)).rejects.toThrow('idb full');
    expect(r.log).not.toContain('mint');
    expect(r.log).not.toContain('list-records');
  });

  it('revokes earlier links of the same site on any master and identity, before minting', async () => {
    const r = rig([
      rec({ label: 'mysignet:kithmoot.com:aaaaaaaa', slotIndex: 1, secretFingerprint: 'fp1' }),
      rec({ label: 'mysignet:kithmoot.com:bbbbbbbb', slotIndex: 2, secretFingerprint: 'fp2', persona: OTHER, targetHex: 'f'.repeat(64) }),
      rec({ label: 'mysignet:other.example:cccccccc', origin: 'https://other.example', slotIndex: 3, secretFingerprint: 'fp3' }),
    ]);
    await runSignInLinkApproval(r.io);
    const mintAt = r.log.indexOf('mint');
    expect(r.log.indexOf('revoke aaaaaaaa')).toBeLessThan(mintAt);
    expect(r.log.indexOf('revoke bbbbbbbb')).toBeLessThan(mintAt);
    expect(r.log).not.toContain('revoke cccccccc');
    expect(r.store.map(x => x.label).sort()).toEqual(['mysignet:kithmoot.com:cafef00d', 'mysignet:other.example:cccccccc']);
  });

  it('does not mint when an earlier link can not be revoked, keeps that record, and drops the pending one', async () => {
    const r = rig([rec({ label: 'mysignet:kithmoot.com:aaaaaaaa', slotIndex: 1, secretFingerprint: 'fp1' })]);
    r.failure.revokeIf = x => (x.label.endsWith('aaaaaaaa') ? new Error('timeout waiting for device (revoke_client)') : null);
    await expect(runSignInLinkApproval(r.io)).rejects.toBeInstanceOf(HeartwoodCopyError);
    expect(r.log).not.toContain('mint');
    expect(r.store.map(x => x.label)).toEqual(['mysignet:kithmoot.com:aaaaaaaa']);
    expect(r.device).toHaveLength(1);
  });

  it.each<[string, Partial<CreateClientV2Reply>]>([
    ['a link to another identity', { bunkerUri: `bunker://${OTHER}?secret=${SECRET}`, npubHex: OTHER }],
    ['a widened grant', { allowedMethods: [...policy.allowedMethods, 'nip04_encrypt'] }],
    ['an old policy version', { policyVersion: 1 }],
    ['a link with no secret', { bunkerUri: `bunker://${PERSONA}?relay=wss%3A%2F%2Fhw.example` }],
  ])('revokes the slot it just made, drops the record and throws on %s', async (_n, reply) => {
    const r = rig();
    r.failure.reply = reply;
    await expect(runSignInLinkApproval(r.io)).rejects.toThrow(SIGN_IN_LINK_MISMATCH_COPY);
    expect(r.device).toEqual([]);
    expect(r.store).toEqual([]);
    expect(r.log.slice(-2)).toEqual(['revoke cafef00d', 'drop cafef00d']);
  });

  it('keeps the record, and says so, when a mismatched slot can not be revoked', async () => {
    const r = rig();
    r.failure.reply = { npubHex: OTHER };
    r.failure.revokeIf = x => (x.slotIndex === 10 ? new Error('timeout waiting for device (revoke_client)') : null);
    await expect(runSignInLinkApproval(r.io)).rejects.toThrow(SIGN_IN_LINK_MISMATCH_KEPT_COPY);
    expect(r.store).toHaveLength(1);
    expect(r.store[0]).toMatchObject({ label: 'mysignet:kithmoot.com:cafef00d', slotIndex: 10 });
  });

  it('finds a mismatched slot by label when the reply named none', async () => {
    const r = rig();
    r.failure.reply = { slotIndex: null, secretFingerprint: '' };
    await expect(runSignInLinkApproval(r.io)).rejects.toThrow(SIGN_IN_LINK_MISMATCH_COPY);
    expect(r.device).toEqual([]);
  });

  it('a mint that got no answer looks for the slot by label and drops the record only when none exists', async () => {
    const r = rig();
    r.failure.mint = new Error('timeout waiting for device (create_client_v2)');
    await expect(runSignInLinkApproval(r.io)).rejects.toBeInstanceOf(HeartwoodCopyError);
    expect(r.store).toEqual([]);
    expect(r.device).toEqual([]);
  });

  it('a mint that got no answer but landed is revoked, and the record dropped', async () => {
    const r = rig();
    r.failure.mint = new Error('timeout waiting for device (create_client_v2)');
    r.failure.mintLands = true;
    await expect(runSignInLinkApproval(r.io)).rejects.toBeInstanceOf(HeartwoodCopyError);
    expect(r.device).toEqual([]);
    expect(r.store).toEqual([]);
  });

  it('a mint that got no answer while the device can not be listed keeps the pending record', async () => {
    const r = rig();
    r.failure.mint = new Error('timeout waiting for device (create_client_v2)');
    r.failure.list = new Error('timeout waiting for device (list_clients)');
    await expect(runSignInLinkApproval(r.io)).rejects.toBeInstanceOf(HeartwoodCopyError);
    expect(r.store.map(x => x.label)).toEqual(['mysignet:kithmoot.com:cafef00d']);
  });

  it('a record that can not be saved after the mint undoes the slot, and says so', async () => {
    const r = rig();
    r.failure.putAt = 2;
    await expect(runSignInLinkApproval(r.io)).rejects.toThrow(SIGN_IN_LINK_NOT_SAVED_COPY);
    expect(r.device).toEqual([]);
    expect(r.store).toEqual([]);
  });

  it('keeps the record, and says so, when it can not be saved and the slot can not be undone', async () => {
    const r = rig();
    r.failure.putAt = 2;
    r.failure.revokeIf = x => (x.slotIndex === 10 ? new Error('timeout waiting for device (revoke_client)') : null);
    await expect(runSignInLinkApproval(r.io)).rejects.toThrow(SIGN_IN_LINK_NOT_SAVED_KEPT_COPY);
    expect(r.device).toHaveLength(1);
    expect(r.store).toHaveLength(1);
  });

  it('puts none of the secret in any thrown error', async () => {
    const r = rig();
    r.failure.reply = { npubHex: OTHER };
    let err: unknown;
    try { await runSignInLinkApproval(r.io); } catch (e) { err = e; }
    expect(String((err as Error).message)).not.toContain(SECRET);
  });
});

describe('abandonSignInLink', () => {
  it('revokes the slot, then drops the record', async () => {
    const log: string[] = [];
    await abandonSignInLink({ revokeRecord: async () => { log.push('revoke'); }, dropRecord: async () => { log.push('drop'); } }, rec());
    expect(log).toEqual(['revoke', 'drop']);
  });
  it('keeps the record, and does not throw, when the revoke fails', async () => {
    const log: string[] = [];
    await abandonSignInLink({ revokeRecord: async () => { throw new Error('no answer'); }, dropRecord: async () => { log.push('drop'); } }, rec());
    expect(log).toEqual([]);
  });
});
