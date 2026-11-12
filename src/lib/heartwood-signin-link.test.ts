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
  SIGN_IN_LINK_UNAVAILABLE_COPY,
  SIGN_IN_LINK_SIGNER_MISMATCH_COPY,
  SIGNIN_LINK_UNBOUND_TTL_MS,
  abandonSignInLink,
  ackStateAfterLock,
  failedAckCarriesLink,
  assertSignedByLinkPersona,
  isUnboundSlot,
  reconcileSignInLinks,
  settleSignInLink,
  signInLinkFate,
  signInRequestCanCarryLink,
  signInRequestIsRelay,
  type ReconcileIo,
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
  selectionKeypairType: 'persona', requestCanCarryLink: true,
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
    ['the real identity', { selectionKeypairType: 'natural-person' }],
    ['a request with nowhere to put a link', { requestCanCarryLink: false }],
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
const LABEL = 'mysignet:kithmoot.com:0123abcd';
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
    const r = checkSignInLinkEcho(goodReply(), { persona: PERSONA, policy, label: LABEL });
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
    ['a label that is not the one asked for', { label: 'mysignet:kithmoot.com:ffffffff' }],
    ['no label', { label: '' }],
    ['a link over 8192 characters', { bunkerUri: `bunker://${PERSONA}?relay=wss%3A%2F%2Fhw.example&secret=${SECRET}&pad=${'x'.repeat(8200)}` }],
    ['a plaintext relay', { bunkerUri: `bunker://${PERSONA}?relay=ws%3A%2F%2Fhw.example&secret=${SECRET}` }],
    ['one plaintext relay among good ones', { bunkerUri: `bunker://${PERSONA}?relay=wss%3A%2F%2Fa.example&relay=ws%3A%2F%2Fb.example&secret=${SECRET}` }],
    ['a relay that is not a websocket', { bunkerUri: `bunker://${PERSONA}?relay=https%3A%2F%2Fa.example&secret=${SECRET}` }],
  ])('refuses %s', (_name, over) => {
    expect(checkSignInLinkEcho(goodReply(over), { persona: PERSONA, policy, label: LABEL }).ok).toBe(false);
  });
  it('accepts loopback ws:// relays and links with no relay, as the app does elsewhere', () => {
    expect(checkSignInLinkEcho(goodReply({ bunkerUri: `bunker://${PERSONA}?relay=ws%3A%2F%2Flocalhost%3A7777&relay=ws%3A%2F%2F127.0.0.1&secret=${SECRET}` }), { persona: PERSONA, policy, label: LABEL }).ok).toBe(true);
    expect(checkSignInLinkEcho(goodReply({ bunkerUri: `bunker://${PERSONA}?secret=${SECRET}` }), { persona: PERSONA, policy, label: LABEL }).ok).toBe(true);
  });
  it('never names a slot in a refusal: the caller finds it by the label it chose', () => {
    const wrongIdentity = checkSignInLinkEcho(goodReply({ npubHex: OTHER }), { persona: PERSONA, policy, label: LABEL });
    expect(wrongIdentity).toEqual({ ok: false, reason: 'npub_hex' });
    expect(Object.keys(wrongIdentity)).not.toContain('slot');
  });
  it('never puts the link in the verdict of a refusal', () => {
    const r = checkSignInLinkEcho(goodReply({ npubHex: OTHER }), { persona: PERSONA, policy, label: LABEL });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
});

const rec = (over: Partial<HeartwoodSignInLinkRecord> = {}): HeartwoodSignInLinkRecord => ({
  origin: ORIGIN, appName: 'KithMoot', persona: PERSONA, deviceHex: 'd'.repeat(64), targetHex: 'e'.repeat(64),
  label: 'mysignet:kithmoot.com:aaaaaaaa', slotIndex: 1, secretFingerprint: 'fp1', createdAt: 1, ...over,
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
  it('says no managed Heartwood holds it, not "didn\'t answer", when every device answered and none does', async () => {
    const c = clientWith([id('master', 0, 'a'.repeat(64))]);
    await expect(findSignInHolder({ clients: [c], persona: PERSONA })).rejects.toThrow(SIGN_IN_LINK_UNAVAILABLE_COPY);
    expect(SIGN_IN_LINK_UNAVAILABLE_COPY).not.toMatch(/didn't answer/);
    expect(SIGN_IN_LINK_UNAVAILABLE_COPY).not.toMatch(/Through My Signet/);
  });
  it('says it when no device answered, without pointing at Through My Signet', async () => {
    const c = clientWith(new Error('timeout waiting for device (list_identities)'));
    let err: unknown;
    try { await findSignInHolder({ clients: [c], persona: PERSONA }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(HeartwoodCopyError);
    expect((err as Error).message).toMatch(/didn't answer/);
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
  it('goes holder, capability, pending record, mint, record the slot, and hands back the link, leaving earlier links of the site alone', async () => {
    const r = rig([rec({ label: 'mysignet:kithmoot.com:aaaaaaaa', slotIndex: 1, secretFingerprint: 'fp1' })]);
    const out = await runSignInLinkApproval(r.io);
    expect(r.log).toEqual([
      'holder', 'capable',
      'put cafef00d -',
      'mint',
      'put cafef00d 10',
    ]);
    expect(out.record).toMatchObject({ origin: ORIGIN, persona: PERSONA, label: 'mysignet:kithmoot.com:cafef00d', slotIndex: 10, secretFingerprint: 'fpnew', targetHex: 'e'.repeat(64), deviceHex: 'd'.repeat(64), createdAt: 1000 });
    expect(out.bunkerUri).toBe(`bunker://${PERSONA}?relay=wss%3A%2F%2Fhw.example&secret=${SECRET}`);
    // Several browsers of one site may each hold a link: the earlier one stays (the reconcile reaps what nothing uses).
    expect(r.store.map(x => x.label)).toEqual(['mysignet:kithmoot.com:aaaaaaaa', 'mysignet:kithmoot.com:cafef00d']);
    expect(r.device.map(s => s.slotIndex)).toEqual([1, 10]);
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
  });

  it.each<[string, Partial<CreateClientV2Reply>]>([
    ['a link to another identity', { bunkerUri: `bunker://${OTHER}?secret=${SECRET}`, npubHex: OTHER }],
    ['a widened grant', { allowedMethods: [...policy.allowedMethods, 'nip04_encrypt'] }],
    ['an old policy version', { policyVersion: 1 }],
    ['a link with no secret', { bunkerUri: `bunker://${PERSONA}?relay=wss%3A%2F%2Fhw.example` }],
    ['a reply about another label', { label: 'mysignet:kithmoot.com:ffffffff' }],
    ['a plaintext relay in the link', { bunkerUri: `bunker://${PERSONA}?relay=ws%3A%2F%2Fhw.example&secret=${SECRET}` }],
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
    r.failure.revokeIf = x => (x.label.endsWith('cafef00d') ? new Error('timeout waiting for device (revoke_client)') : null);
    await expect(runSignInLinkApproval(r.io)).rejects.toThrow(SIGN_IN_LINK_MISMATCH_KEPT_COPY);
    expect(r.store).toHaveLength(1);
    // Kept as a pending record (no slot named): the reconcile finds it by its label.
    expect(r.store[0]).toMatchObject({ label: 'mysignet:kithmoot.com:cafef00d', secretFingerprint: '' });
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

// ─── S6: the same flow with the REAL revoke, over a fake device list ────────

describe('runSignInLinkApproval — through the real revokeSignInLinkSlot', () => {
  function wired(seed: HeartwoodSignInLinkRecord[] = [], extraDevice: DeviceClientSlot[] = []) {
    const r = rig(seed);
    r.device.push(...extraDevice);
    r.io.revokeRecord = async rec => {
      r.log.push(`revoke ${rec.label.slice(-8)}`);
      await revokeSignInLinkSlot({
        rec,
        revoke: async slot => {
          const at = r.device.findIndex(s => s.slotIndex === slot.slotIndex && s.secretFingerprint === slot.secretFingerprint);
          if (at < 0) throw new Error(`no such slot: ${slot.slotIndex}`);
          r.log.push(`device-revoke ${slot.slotIndex}`);
          r.device.splice(at, 1);
        },
        listClients: async () => { r.log.push('device-list'); return r.device.map(s => ({ ...s })); },
      });
    };
    return r;
  }

  it('a mint that got no answer but landed is revoked by label through the real revoke', async () => {
    const r = wired();
    r.failure.mint = new Error('timeout waiting for device (create_client_v2)');
    r.failure.mintLands = true;
    await expect(runSignInLinkApproval(r.io)).rejects.toBeInstanceOf(HeartwoodCopyError);
    expect(r.log).toContain('device-list');
    expect(r.device).toEqual([]);
    expect(r.store).toEqual([]);
  });

  it('a reply that names ANOTHER real slot revokes only the labelled one, and leaves that slot alone', async () => {
    const other = slotRow({ slotIndex: 3, label: 'mysignet:other.example:99999999', secretFingerprint: 'fp3' });
    const r = wired([], [other]);
    r.failure.reply = { slotIndex: 3, secretFingerprint: 'fp3', npubHex: OTHER };
    await expect(runSignInLinkApproval(r.io)).rejects.toThrow(SIGN_IN_LINK_MISMATCH_COPY);
    expect(r.device.map(s => s.slotIndex)).toEqual([3]);
    expect(r.store).toEqual([]);
  });
});

// ─── Request shape, signer pin ──────────────────────────────────────────────

describe('signInRequestIsRelay / signInRequestCanCarryLink', () => {
  it('a relay request needs the relay and the session key', () => {
    expect(signInRequestIsRelay({ relay: 'wss://r', sessionPubkey: 'a'.repeat(64) })).toBe(true);
    expect(signInRequestIsRelay({ relay: 'wss://r' })).toBe(false);
    expect(signInRequestIsRelay({ callbackUrl: 'https://x/cb' })).toBe(false);
  });
  it('can carry a link by relay or by redirect callback, and never on a bare BroadcastChannel request', () => {
    expect(signInRequestCanCarryLink({ relay: 'wss://r', sessionPubkey: 'a'.repeat(64) })).toBe(true);
    expect(signInRequestCanCarryLink({ callbackUrl: 'https://x/cb' })).toBe(true);
    expect(signInRequestCanCarryLink({})).toBe(false);
    expect(signInRequestCanCarryLink({ relay: 'wss://r' })).toBe(false);
  });
});

describe('assertSignedByLinkPersona', () => {
  it('passes for the identity the link is for, in any case', () => {
    expect(() => assertSignedByLinkPersona(PERSONA.toUpperCase(), PERSONA)).not.toThrow();
  });
  it('throws, so nothing is minted, when another key signed', () => {
    expect(() => assertSignedByLinkPersona(OTHER, PERSONA)).toThrow(SIGN_IN_LINK_SIGNER_MISMATCH_COPY);
  });
});

// ─── S6: keep or abandon ────────────────────────────────────────────────────

describe('signInLinkFate / settleSignInLink', () => {
  it('nothing minted: nothing to do', () => {
    expect(signInLinkFate({ minted: null, delivered: false })).toBe('none');
    expect(signInLinkFate({ minted: null, delivered: true })).toBe('none');
  });
  it('minted and delivered: kept; minted and not delivered: abandoned', () => {
    expect(signInLinkFate({ minted: rec(), delivered: true })).toBe('keep');
    expect(signInLinkFate({ minted: rec(), delivered: false })).toBe('abandon');
  });
  it('abandons only what was never delivered (revoke, then drop), and never throws', async () => {
    const log: string[] = [];
    const io = { revokeRecord: async () => { log.push('revoke'); }, dropRecord: async () => { log.push('drop'); } };
    expect(await settleSignInLink(io, { minted: rec(), delivered: true })).toBe('keep');
    expect(log).toEqual([]);
    expect(await settleSignInLink(io, { minted: rec(), delivered: false })).toBe('abandon');
    expect(log).toEqual(['revoke', 'drop']);
    const failing = { revokeRecord: async () => { throw new Error('no answer'); }, dropRecord: async () => { log.push('drop2'); } };
    await expect(settleSignInLink(failing, { minted: rec(), delivered: false })).resolves.toBe('abandon');
    expect(log).not.toContain('drop2');
  });
});

// ─── S2/S3/N10: reconcile ───────────────────────────────────────────────────

describe('isUnboundSlot', () => {
  it('is unbound only with no current key and none authorised', () => {
    expect(isUnboundSlot(slotRow({}))).toBe(true);
    expect(isUnboundSlot(slotRow({ currentPubkey: 'k'.repeat(64) }))).toBe(false);
    expect(isUnboundSlot(slotRow({ authorizedPubkeys: ['k'.repeat(64)] }))).toBe(false);
  });
});

describe('reconcileSignInLinks', () => {
  const NOW_MS = 100_000_000;
  const oldAt = Math.floor((NOW_MS - SIGNIN_LINK_UNBOUND_TTL_MS) / 1000) - 1;
  const youngAt = Math.floor((NOW_MS - SIGNIN_LINK_UNBOUND_TTL_MS) / 1000) + 60;
  const target = (r: HeartwoodSignInLinkRecord) => `${r.deviceHex}:${r.targetHex}`;

  function recon(lists: Record<string, DeviceClientSlot[] | null | Error>) {
    const log: string[] = [];
    const listCalls: string[] = [];
    const io: ReconcileIo & { failRevoke?: (slotIndex: number) => boolean } = {
      nowMs: () => NOW_MS,
      listSlots: async t => {
        const key = `${t.deviceHex}:${t.targetHex}`;
        listCalls.push(key);
        const v = lists[key];
        if (v instanceof Error) throw v;
        return v ?? null;
      },
      revokeSlot: async (_t, slot) => {
        if (io.failRevoke?.(slot.slotIndex)) throw new Error('timeout waiting for device (revoke_client)');
        log.push(`revoke ${slot.slotIndex}`);
      },
      dropRecord: async r => { log.push(`drop ${r.label.slice(-8)}`); },
    };
    return { io, log, listCalls };
  }
  const R = (over: Partial<HeartwoodSignInLinkRecord>) => rec({ createdAt: oldAt, ...over });
  const T = target(rec());
  const slotFor = (r: HeartwoodSignInLinkRecord, over: Partial<DeviceClientSlot> = {}) =>
    slotRow({ slotIndex: r.slotIndex ?? 5, label: r.label, secretFingerprint: r.secretFingerprint || 'fpx', ...over });

  it('drops a confirmed record whose slot is not on the device', async () => {
    const a = R({ label: 'mysignet:kithmoot.com:aaaaaaaa' });
    const { io, log } = recon({ [T]: [] });
    expect(await reconcileSignInLinks([a], io)).toEqual({ dropped: 1, revoked: 0, skipped: 0 });
    expect(log).toEqual(['drop aaaaaaaa']);
  });

  it('drops it even when young: a slot that is not there is not there', async () => {
    const a = R({ createdAt: youngAt });
    const { io, log } = recon({ [T]: [] });
    await reconcileSignInLinks([a], io);
    expect(log).toEqual([`drop ${a.label.slice(-8)}`]);
  });

  it('revokes an unbound slot older than the TTL, then drops the record', async () => {
    const a = R({});
    const { io, log } = recon({ [T]: [slotFor(a)] });
    expect(await reconcileSignInLinks([a], io)).toEqual({ dropped: 1, revoked: 1, skipped: 0 });
    expect(log).toEqual([`revoke ${a.slotIndex}`, `drop ${a.label.slice(-8)}`]);
  });

  it('leaves an unbound slot alone while it is younger than the TTL', async () => {
    const a = R({ createdAt: youngAt });
    const { io, log } = recon({ [T]: [slotFor(a)] });
    expect(await reconcileSignInLinks([a], io)).toEqual({ dropped: 0, revoked: 0, skipped: 1 });
    expect(log).toEqual([]);
  });

  it('leaves a bound slot alone however old it is (current key, or an authorised one)', async () => {
    const a = R({ label: 'mysignet:kithmoot.com:aaaaaaaa', slotIndex: 1, secretFingerprint: 'fp1' });
    const b = R({ label: 'mysignet:kithmoot.com:bbbbbbbb', slotIndex: 2, secretFingerprint: 'fp2' });
    const { io, log } = recon({ [T]: [slotFor(a, { currentPubkey: 'k'.repeat(64) }), slotFor(b, { authorizedPubkeys: ['k'.repeat(64)] })] });
    expect(await reconcileSignInLinks([a, b], io)).toEqual({ dropped: 0, revoked: 0, skipped: 2 });
    expect(log).toEqual([]);
  });

  it('finds the slot by label when it has moved index, and revokes it where it is now', async () => {
    const a = R({ slotIndex: 1, secretFingerprint: 'fp1' });
    const { io, log } = recon({ [T]: [slotRow({ slotIndex: 9, label: a.label, secretFingerprint: 'fp9' })] });
    await reconcileSignInLinks([a], io);
    expect(log).toEqual(['revoke 9', `drop ${a.label.slice(-8)}`]);
  });

  it('does not confuse another slot at the same index with the record', async () => {
    const a = R({ slotIndex: 1, secretFingerprint: 'fp1' });
    const { io, log } = recon({ [T]: [slotRow({ slotIndex: 1, label: 'someone-else', secretFingerprint: 'other' })] });
    await reconcileSignInLinks([a], io);
    expect(log).toEqual([`drop ${a.label.slice(-8)}`]);
  });

  describe('a pending record (the mint never answered)', () => {
    const pending = (over: Partial<HeartwoodSignInLinkRecord> = {}) => R({ slotIndex: undefined, secretFingerprint: '', ...over });
    it('younger than the TTL is a mint in flight: untouched', async () => {
      const p = pending({ createdAt: youngAt });
      const { io, log } = recon({ [T]: [] });
      expect(await reconcileSignInLinks([p], io)).toEqual({ dropped: 0, revoked: 0, skipped: 1 });
      expect(log).toEqual([]);
    });
    it('older, with no slot by its label: dropped', async () => {
      const p = pending();
      const { io, log } = recon({ [T]: [slotRow({ slotIndex: 2, label: 'other' })] });
      await reconcileSignInLinks([p], io);
      expect(log).toEqual([`drop ${p.label.slice(-8)}`]);
    });
    it('older, found by label and unbound: revoked, then dropped', async () => {
      const p = pending();
      const { io, log } = recon({ [T]: [slotRow({ slotIndex: 4, label: p.label, secretFingerprint: 'fp4' })] });
      await reconcileSignInLinks([p], io);
      expect(log).toEqual(['revoke 4', `drop ${p.label.slice(-8)}`]);
    });
    it('older, found by label and bound: kept', async () => {
      const p = pending();
      const { io, log } = recon({ [T]: [slotRow({ slotIndex: 4, label: p.label, currentPubkey: 'k'.repeat(64) })] });
      await reconcileSignInLinks([p], io);
      expect(log).toEqual([]);
    });
  });

  it('leaves a target with no operator client on this phone alone (and still does the others)', async () => {
    const away = R({ label: 'mysignet:kithmoot.com:aaaaaaaa', deviceHex: '1'.repeat(64) });
    const here = R({ label: 'mysignet:kithmoot.com:bbbbbbbb' });
    const { io, log } = recon({ [target(away)]: null, [T]: [] });
    expect(await reconcileSignInLinks([away, here], io)).toEqual({ dropped: 1, revoked: 0, skipped: 1 });
    expect(log).toEqual(['drop bbbbbbbb']);
  });

  it('leaves a target that does not answer alone, and never throws', async () => {
    const away = R({ label: 'mysignet:kithmoot.com:aaaaaaaa', deviceHex: '1'.repeat(64) });
    const here = R({ label: 'mysignet:kithmoot.com:bbbbbbbb' });
    const { io, log } = recon({ [target(away)]: new Error('timeout waiting for device (list_clients)'), [T]: [] });
    await expect(reconcileSignInLinks([away, here], io)).resolves.toEqual({ dropped: 1, revoked: 0, skipped: 1 });
    expect(log).toEqual(['drop bbbbbbbb']);
  });

  it('asks each target once per pass', async () => {
    const a = R({ label: 'mysignet:kithmoot.com:aaaaaaaa', slotIndex: 1, secretFingerprint: 'fp1' });
    const b = R({ label: 'mysignet:kithmoot.com:bbbbbbbb', slotIndex: 2, secretFingerprint: 'fp2' });
    const c = R({ label: 'mysignet:kithmoot.com:cccccccc', slotIndex: 3, secretFingerprint: 'fp3', targetHex: '2'.repeat(64) });
    const { io, listCalls } = recon({ [T]: [], [target(c)]: [] });
    await reconcileSignInLinks([a, b, c], io);
    expect(listCalls.sort()).toEqual([T, target(c)].sort());
  });

  it('keeps a record whose revoke failed for the next pass, and carries on with the rest', async () => {
    const a = R({ label: 'mysignet:kithmoot.com:aaaaaaaa', slotIndex: 1, secretFingerprint: 'fp1' });
    const b = R({ label: 'mysignet:kithmoot.com:bbbbbbbb', slotIndex: 2, secretFingerprint: 'fp2' });
    const { io, log } = recon({ [T]: [slotFor(a), slotFor(b)] });
    io.failRevoke = i => i === 1;
    expect(await reconcileSignInLinks([a, b], io)).toEqual({ dropped: 1, revoked: 1, skipped: 1 });
    expect(log).toEqual(['revoke 2', 'drop bbbbbbbb']);
  });
});

// ─── The failed-ack state across a lock ─────────────────────────────────────

describe('failedAckCarriesLink / ackStateAfterLock', () => {
  const failed = (extra: { carriesLink?: boolean } = {}) => ({ status: 'failed' as const, siteName: 'KithMoot', ...extra });

  it('marks a failed answer only when it is a Straight link carrying a bunkerUri', () => {
    expect(failedAckCarriesLink({ straightLink: true, bunkerUri: 'bunker://x' })).toEqual({ carriesLink: true });
    expect(failedAckCarriesLink({ straightLink: true, bunkerUri: undefined })).toEqual({});
    // Today's in-page pairing URI or a legacy remote URI: not a Straight sign-in, so not marked.
    expect(failedAckCarriesLink({ straightLink: false, bunkerUri: 'bunker://x' })).toEqual({});
  });

  it('drops a failed answer that carries a Straight link when the app locks', () => {
    expect(ackStateAfterLock(failed({ carriesLink: true }))).toBeNull();
  });

  it('keeps every other state exactly as it was: a failed delivery that did not choose Straight, an approved ack, none', () => {
    const plain = failed();
    expect(ackStateAfterLock(plain)).toBe(plain);
    const viaInPage = { ...failed(), ...failedAckCarriesLink({ straightLink: false, bunkerUri: 'bunker://in-page' }) };
    expect(ackStateAfterLock(viaInPage)).toBe(viaInPage);
    const approved = { status: 'approved' as const, siteName: 'KithMoot', carriesLink: true };
    expect(ackStateAfterLock(approved)).toBe(approved);
    expect(ackStateAfterLock(null)).toBeNull();
  });
});
