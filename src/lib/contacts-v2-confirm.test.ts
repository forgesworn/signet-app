import { describe, it, expect } from 'vitest';
import { nip19 } from 'nostr-tools';
import {
  ConfirmMergeRefusedError, applyConfirmSteps, confirmMergeRefusal, decideScan, isConfirmed, keyHolderIds, isContactConfirmed, newestCheckFor, npubReadoutGroups,
  planMatch, planMismatch, planTierMove, scannedKeyToHex, shouldOfferTierMove, verificationUpgrade,
  type ConfirmOps, type ConfirmStep,
} from './contacts-v2-confirm';
import { buildContactQR } from './contact-qr';
import { encodeNpub } from './signet';
import { hexToBytes } from '@noble/hashes/utils.js';
import { applyOperations, validateOperation } from './contacts-v2-reducer';
import { resolveEffective } from './contacts-v2-effective';
import { buildOperation } from './contacts-v2-mutations';
import type { ContactIdentity, ContactOperation, EffectiveContact } from '../types';

const OWNER = '1'.repeat(64);
const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);
const OTHER_KEY = 'c'.repeat(64);
const npubOf = (hex: string) => encodeNpub(hexToBytes(hex));

const ident = (over: Partial<ContactIdentity> = {}): ContactIdentity => ({
  itemId: '1'.repeat(32), pubkey: OLD, provenance: 'direct', verification: 'unverified', addedAt: 1, ...over,
});

describe('verification rank', () => {
  it('only ever moves up', () => {
    expect(verificationUpgrade('unverified', 'proven')).toBe('proven');
    expect(verificationUpgrade('unverified', 'mutual')).toBe('mutual');
    expect(verificationUpgrade('proven', 'mutual')).toBe('mutual');
    expect(verificationUpgrade('proven', 'proven')).toBeNull();
    expect(verificationUpgrade('mutual', 'proven')).toBeNull();
    expect(verificationUpgrade('mutual', 'mutual')).toBeNull();
  });
  it('treats proven and mutual as confirmed, and a keyless contact as not', () => {
    expect(isConfirmed(ident())).toBe(false);
    expect(isConfirmed(ident({ verification: 'proven' }))).toBe(true);
    expect(isContactConfirmed({ identities: [] })).toBe(false);
    expect(isContactConfirmed({ identities: [ident(), ident({ itemId: '2'.repeat(32), verification: 'mutual' })] })).toBe(true);
  });
});

describe('newestCheckFor', () => {
  const check = (id: string, checkedAt: number, pk = OLD, owner = OWNER) => ({
    id, identityPubkey: pk, ownerIdentityPubkey: owner, method: 'in-person' as const, checkedAt,
  });
  it('returns the newest check for that key only', () => {
    const r = { checks: [check('1'.repeat(32), 5), check('2'.repeat(32), 9), check('3'.repeat(32), 99, NEW)] };
    expect(newestCheckFor(r, OLD)?.checkedAt).toBe(9);
    expect(newestCheckFor(r, 'd'.repeat(64))).toBeNull();
    expect(newestCheckFor(r, OLD, '9'.repeat(64))).toBeNull();
  });
});

describe('npubReadoutGroups', () => {
  it('is the last 16 characters of the npub in four groups of four', () => {
    const groups = npubReadoutGroups(OLD);
    expect(groups).toHaveLength(4);
    expect(groups.every(g => g.length === 4)).toBe(true);
    expect(groups.join('')).toBe(npubOf(OLD).slice(-16));
  });
  it('differs for keys that share their last four characters', () => {
    const a = npubReadoutGroups('0'.repeat(63) + '1').join('');
    const b = npubReadoutGroups('f'.repeat(63) + '1').join('');
    expect(a).not.toBe(b);
  });
});

describe('scannedKeyToHex', () => {
  it('reads npub, nostr:npub, nprofile, a My Signet card and bare hex', () => {
    expect(scannedKeyToHex(npubOf(NEW))).toBe(NEW);
    expect(scannedKeyToHex(`nostr:${npubOf(NEW)}`)).toBe(NEW);
    expect(scannedKeyToHex(`NOSTR:${npubOf(NEW)}`)).toBe(NEW);
    expect(scannedKeyToHex(nip19.nprofileEncode({ pubkey: NEW, relays: ['wss://relay.example'] }))).toBe(NEW);
    expect(scannedKeyToHex(`nostr:${nip19.nprofileEncode({ pubkey: NEW })}`)).toBe(NEW);
    expect(scannedKeyToHex(buildContactQR({ pubkey: NEW.toUpperCase(), name: 'Dave' }))).toBe(NEW);
    expect(scannedKeyToHex(NEW)).toBe(NEW);
    expect(scannedKeyToHex(`  ${npubOf(NEW)}\n`)).toBe(NEW);
  });
  it('rejects anything that is not a public key', () => {
    expect(scannedKeyToHex('')).toBeNull();
    expect(scannedKeyToHex('hello')).toBeNull();
    expect(scannedKeyToHex('npub1' + 'q'.repeat(58))).toBeNull();
    expect(scannedKeyToHex(nip19.nsecEncode(hexToBytes('2'.repeat(64))))).toBeNull();
    expect(scannedKeyToHex('https://example.com/')).toBeNull();
  });
});

describe('decideScan', () => {
  const record = { contactId: 'c-dave', identities: [ident(), ident({ itemId: '2'.repeat(32), pubkey: OTHER_KEY })] };
  const base = { record, identity: record.identities[0], contacts: [] as EffectiveContact[], ownPubkeys: [OWNER] };
  const other = (over: object) => ({ contactId: 'c-erin', displayName: 'Erin', lifecycle: 'active' as const, identities: [ident({ pubkey: NEW })], ...over });

  it('matches the key on file, case-insensitively', () => {
    expect(decideScan({ ...base, scannedHex: OLD.toUpperCase() })).toEqual({ kind: 'match' });
  });
  it('mismatches a stranger key', () => {
    expect(decideScan({ ...base, scannedHex: NEW })).toEqual({ kind: 'mismatch' });
  });
  it('names a different contact that already holds the scanned key', () => {
    expect(decideScan({ ...base, scannedHex: NEW, contacts: [other({})] }))
      .toEqual({ kind: 'belongs-to-other', contactId: 'c-erin', displayName: 'Erin', state: 'active' });
  });
  it('names a deleted or archived contact that still holds the key (the reducer would merge into it)', () => {
    expect(decideScan({ ...base, scannedHex: NEW, contacts: [other({ lifecycle: 'removed' })] }))
      .toEqual({ kind: 'belongs-to-other', contactId: 'c-erin', displayName: 'Erin', state: 'deleted' });
    expect(decideScan({ ...base, scannedHex: NEW, contacts: [other({ lifecycle: 'removed', archived: true })] }))
      .toEqual({ kind: 'belongs-to-other', contactId: 'c-erin', displayName: 'Erin', state: 'archived' });
  });
  it('prefers a live holder over a deleted one', () => {
    const contacts = [other({ contactId: 'c-bob', displayName: 'Bob', lifecycle: 'removed' }), other({})];
    expect(decideScan({ ...base, scannedHex: NEW, contacts })).toMatchObject({ contactId: 'c-erin', state: 'active' });
  });
  it('names a contact the key was once removed from, through the key history', () => {
    const contacts = [other({ identities: [] })];
    expect(decideScan({ ...base, scannedHex: NEW, contacts })).toEqual({ kind: 'mismatch' });
    expect(decideScan({ ...base, scannedHex: NEW, contacts, formerHolderIds: ['c-erin'] }))
      .toEqual({ kind: 'belongs-to-other', contactId: 'c-erin', displayName: 'Erin', state: 'removed-key' });
    expect(decideScan({ ...base, scannedHex: NEW, contacts: [other({ identities: [], lifecycle: 'removed' })], formerHolderIds: ['c-erin'] }))
      .toMatchObject({ kind: 'belongs-to-other', state: 'deleted' });
    // Through a merged id, and never the contact being confirmed itself.
    expect(decideScan({ ...base, scannedHex: NEW, contacts: [other({ identities: [], mergedContactIds: ['c-old'] })], formerHolderIds: ['c-old'] }))
      .toMatchObject({ contactId: 'c-erin', state: 'removed-key' });
    expect(decideScan({ ...base, scannedHex: NEW, contacts: [other({ contactId: 'c-dave', identities: [] })], formerHolderIds: ['c-dave'] }))
      .toEqual({ kind: 'mismatch' });
  });
  it('recognises the user own key and a sibling key of the same contact', () => {
    expect(decideScan({ ...base, scannedHex: OWNER })).toEqual({ kind: 'own-key' });
    expect(decideScan({ ...base, scannedHex: OTHER_KEY })).toEqual({ kind: 'other-key-of-this-contact', itemId: '2'.repeat(32) });
  });
});

describe('plans', () => {
  it('a match records a check and lifts an unverified identity to proven', () => {
    expect(planMatch({ identity: ident(), method: 'in-person' })).toEqual([
      { op: 'record-check', pubkey: OLD, method: 'in-person' },
      { op: 'update-identity', itemId: '1'.repeat(32), verification: 'proven' },
    ]);
    expect(planMatch({ identity: ident(), method: 'words' })[0]).toMatchObject({ method: 'words' });
  });
  it('a match never downgrades a mutual identity or rewrites a proven one', () => {
    expect(planMatch({ identity: ident({ verification: 'mutual' }), method: 'in-person' }).map(s => s.op)).toEqual(['record-check']);
    expect(planMatch({ identity: ident({ verification: 'proven' }), method: 'in-person' }).map(s => s.op)).toEqual(['record-check']);
  });
  it('offers a tier move only for a ken contact, on the contact own tier', () => {
    expect(shouldOfferTierMove({ tier: 'ken' })).toBe(true);
    expect(shouldOfferTierMove({ tier: 'kith' })).toBe(false);
    expect(shouldOfferTierMove({ tier: 'kin' })).toBe(false);
    expect(planTierMove('kin')).toEqual([{ op: 'set-tier', tier: 'kin' }]);
  });

  const args = { old: ident(), scannedHex: NEW  };
  it('use-new adds the scanned key confirmed, checks it, then removes the old key', () => {
    expect(planMismatch({ ...args, choice: 'use-new' })).toEqual([
      { op: 'add-identity', pubkey: NEW, verification: 'proven' },
      { op: 'record-check', pubkey: NEW, method: 'in-person' },
      { op: 'remove-item', itemId: '1'.repeat(32) },
    ]);
  });
  it('keep-both adds the scanned key confirmed and leaves the old one alone', () => {
    expect(planMismatch({ ...args, choice: 'keep-both' }).map(s => s.op)).toEqual(['add-identity', 'record-check']);
  });
  it('old-not-theirs adds the scanned key confirmed and removes the old one', () => {
    expect(planMismatch({ ...args, choice: 'old-not-theirs' }).map(s => s.op)).toEqual(['add-identity', 'record-check', 'remove-item']);
  });
  it('never writes a block: the reducer would read it as blocking the whole contact', () => {
    for (const choice of ['use-new', 'keep-both', 'old-not-theirs', 'cancel'] as const) {
      expect(planMismatch({ ...args, choice }).map(s => s.op)).not.toContain('block');
    }
  });
  it('the read-out path has no scanned key: only removal', () => {
    expect(planMismatch({ ...args, scannedHex: null, choice: 'old-not-theirs' }).map(s => s.op)).toEqual(['remove-item']);
    expect(planMismatch({ ...args, scannedHex: null, choice: 'use-new' })).toEqual([]);
    expect(planMismatch({ ...args, scannedHex: null, choice: 'keep-both' })).toEqual([]);
  });
  it('cancel writes nothing', () => {
    expect(planMismatch({ ...args, choice: 'cancel' })).toEqual([]);
  });
});

/** The real reducer behind the executor, so the outcomes are read off materialised records. */
function harness() {
  const log: ContactOperation[] = [];
  let n = 0;
  const id = () => (++n).toString(16).padStart(32, '0');
  const actor = { actorPubkey: OWNER, actorRole: 'owner' as const, actorDeviceId: 'd'.repeat(32) };
  const write = (contactId: string, action: ContactOperation['action'], value: unknown, itemId?: string) => {
    const op = { ...buildOperation({ directoryId: 'owner', contactId, action, value, clock: ++n, actor, now: 1_700_000_000_000 + n, operationId: id(), itemId }), ownerIdentityPubkey: OWNER };
    if (!validateOperation(op)) throw new Error(`invalid ${action}`);
    log.push(op);
  };
  const ops: ConfirmOps = {
    async addIdentity(c, v, opts) {
      const itemId = id();
      if (opts?.refuseMerge) {
        const op = { ...buildOperation({ directoryId: 'owner', contactId: c, action: 'add-identity', value: { ...v, itemId }, clock: n + 1, actor, now: 1, operationId: id(), itemId }), ownerIdentityPubkey: OWNER };
        const refusal = confirmMergeRefusal(log, [op], c);
        if (refusal) throw new ConfirmMergeRefusedError(refusal);
      }
      write(c, 'add-identity', { ...v, itemId }, itemId);
      return itemId;
    },
    async recordCheck(c, v) { write(c, 'record-check', { ...v, id: id(), ownerIdentityPubkey: OWNER }); },
    async updateIdentity(c, v) { write(c, 'update-identity', v, v.itemId); },
    async removeItem(c, itemId) { write(c, 'remove-item', { itemId }, itemId); },
    async setTier(c, tier) { write(c, 'set-tier', { tier }); },
  };
  const addContact = async (v: { type: 'person'; displayName: string; tier: 'ken' }) => { const c = id(); write(c, 'add', { ...v, ownerIdentityPubkey: OWNER }); return c; };
  const records = () => [...applyOperations(log).values()].map(r =>
    resolveEffective(r, { activeGuardianPubkeys: [], defaultChildCeiling: 'ken', directoryIsDependant: false }));
  return { ops, addContact, write, records, log };
}

async function seedDave(h: ReturnType<typeof harness>, verification: 'unverified' | 'proven' | 'mutual' = 'unverified') {
  const contactId = await h.addContact({ type: 'person', displayName: 'Dave', tier: 'ken' });
  const itemId = await h.ops.addIdentity(contactId, { pubkey: OLD, provenance: 'direct', verification });
  return { contactId, itemId };
}
const dave = (h: ReturnType<typeof harness>) => h.records().find(r => r.displayName === 'Dave')!;

describe('applyConfirmSteps against the real reducer', () => {
  it('a match confirms the key, records the check, and leaves the tier alone', async () => {
    const h = harness();
    const { contactId, itemId } = await seedDave(h);
    await applyConfirmSteps(planMatch({ identity: ident({ itemId }), method: 'in-person' }), contactId, h.ops, () => 1_700_000_000_000);
    const d = dave(h);
    expect(d.identities[0].verification).toBe('proven');
    expect(d.checks?.[0]).toMatchObject({ identityPubkey: OLD, method: 'in-person', checkedAt: 1_700_000_000_000 });
    expect(d.tier).toBe('ken');
  });
  it('a read-out match records a words check', async () => {
    const h = harness();
    const { contactId, itemId } = await seedDave(h);
    await applyConfirmSteps(planMatch({ identity: ident({ itemId }), method: 'words' }), contactId, h.ops);
    expect(dave(h).checks?.[0].method).toBe('words');
  });
  it('confirming a mutual identity writes no update-identity, so mutual survives', async () => {
    const h = harness();
    const { contactId, itemId } = await seedDave(h, 'mutual');
    const before = h.log.length;
    await applyConfirmSteps(planMatch({ identity: ident({ itemId, verification: 'mutual' }), method: 'in-person' }), contactId, h.ops);
    expect(h.log.slice(before).map(o => o.action)).toEqual(['record-check']);
    expect(dave(h).identities[0].verification).toBe('mutual');
  });
  it('the tier move is a plain set-tier', async () => {
    const h = harness();
    const { contactId } = await seedDave(h);
    await applyConfirmSteps(planTierMove('kith'), contactId, h.ops);
    expect(dave(h).tier).toBe('kith');
  });
  it('use-new swaps the key for a confirmed one', async () => {
    const h = harness();
    const { contactId, itemId } = await seedDave(h);
    await applyConfirmSteps(planMismatch({ choice: 'use-new', old: ident({ itemId }), scannedHex: NEW  }), contactId, h.ops);
    const d = dave(h);
    expect(d.identities.map(i => [i.pubkey, i.verification])).toEqual([[NEW, 'proven']]);
    expect(d.checks?.[0]).toMatchObject({ identityPubkey: NEW, method: 'in-person' });
  });
  it('keep-both leaves the old key unconfirmed beside the confirmed one', async () => {
    const h = harness();
    const { contactId, itemId } = await seedDave(h);
    await applyConfirmSteps(planMismatch({ choice: 'keep-both', old: ident({ itemId }), scannedHex: NEW  }), contactId, h.ops);
    expect(dave(h).identities.map(i => [i.pubkey, i.verification])).toEqual([[OLD, 'unverified'], [NEW, 'proven']]);
  });
  it('old-not-theirs removes the old key and confirms the scanned one', async () => {
    const h = harness();
    const { contactId, itemId } = await seedDave(h);
    await applyConfirmSteps(planMismatch({ choice: 'old-not-theirs', old: ident({ itemId }), scannedHex: NEW }), contactId, h.ops);
    expect(h.records()).toHaveLength(1);
    expect(dave(h).blocked).toBe(false);
    expect(dave(h).identities.map(i => [i.pubkey, i.verification])).toEqual([[NEW, 'proven']]);
  });
  it('the read-out mismatch just removes the old key', async () => {
    const h = harness();
    const { contactId, itemId } = await seedDave(h);
    await applyConfirmSteps(planMismatch({ choice: 'old-not-theirs', old: ident({ itemId }), scannedHex: null }), contactId, h.ops);
    expect(dave(h).identities).toHaveLength(0);
  });
  it('stops at the first failing step and writes nothing after it', async () => {
    const h = harness();
    const { contactId, itemId } = await seedDave(h);
    const failing: ConfirmOps = { ...h.ops, recordCheck: async () => { throw new Error('no owner'); } };
    const steps: ConfirmStep[] = planMismatch({ choice: 'use-new', old: ident({ itemId }), scannedHex: NEW  });
    await expect(applyConfirmSteps(steps, contactId, failing)).rejects.toThrow('no owner');
    expect(dave(h).identities.map(i => i.pubkey)).toEqual([OLD, NEW]);
  });
});

describe('the merge guard: a confirmation never folds two people together', () => {
  async function bobDeletedAndAlice(h: ReturnType<typeof harness>) {
    const bob = await h.addContact({ type: 'person', displayName: 'Bob', tier: 'ken' });
    await h.ops.addIdentity(bob, { pubkey: NEW, provenance: 'direct', verification: 'unverified' });
    h.write(bob, 'remove', {});
    const alice = await h.addContact({ type: 'person', displayName: 'Alice', tier: 'ken' });
    const itemId = await h.ops.addIdentity(alice, { pubkey: OLD, provenance: 'direct', verification: 'unverified' });
    return { bob, alice, itemId };
  }

  for (const choice of ['use-new', 'keep-both', 'old-not-theirs'] as const) {
    it(`${choice}: refuses a key held by a deleted contact and writes nothing`, async () => {
      const h = harness();
      const { bob, alice, itemId } = await bobDeletedAndAlice(h);
      const before = h.log.length;
      const err = await applyConfirmSteps(planMismatch({ choice, old: ident({ itemId }), scannedHex: NEW }), alice, h.ops)
        .catch(e => e);
      expect(err).toBeInstanceOf(ConfirmMergeRefusedError);
      expect((err as ConfirmMergeRefusedError).refusal).toEqual({ contactId: bob, displayName: 'Bob', state: 'deleted' });
      expect(h.log).toHaveLength(before);
      expect(h.records().map(r => [r.displayName, r.lifecycle])).toEqual([['Bob', 'removed'], ['Alice', 'active']]);
    });
  }

  it('the key history names a contact the key was removed from', async () => {
    const h = harness();
    const erin = await h.addContact({ type: 'person', displayName: 'Erin', tier: 'ken' });
    const stray = await h.ops.addIdentity(erin, { pubkey: NEW, provenance: 'direct', verification: 'unverified' });
    await h.ops.removeItem(erin, stray);
    expect(keyHolderIds(h.log, NEW.toUpperCase())).toEqual([erin]);
    expect(keyHolderIds(h.log, OTHER_KEY)).toEqual([]);
  });

  it('allows a confirmation on a contact that is already a legitimate merge', async () => {
    const h = harness();
    const { contactId, itemId } = await seedDave(h);
    const twin = await h.addContact({ type: 'person', displayName: 'Dave', tier: 'ken' });
    await h.ops.addIdentity(twin, { pubkey: OLD, provenance: 'direct', verification: 'unverified' });
    expect(dave(h).mergedContactIds).toEqual([twin]);
    await applyConfirmSteps(planMismatch({ choice: 'keep-both', old: ident({ itemId }), scannedHex: NEW }), contactId, h.ops);
    expect(dave(h).identities.map(i => i.pubkey)).toEqual([OLD, NEW]);
  });

  it('confirmMergeRefusal is null for a safe write and names the contact a write would merge with', () => {
    const h = harness();
    const at = (contactId: string, pubkey: string) => ({ ...buildOperation({ directoryId: 'owner', contactId, action: 'add-identity',
      value: { itemId: '9'.repeat(32), pubkey, provenance: 'direct', verification: 'proven' }, clock: 99,
      actor: { actorPubkey: OWNER, actorRole: 'owner', actorDeviceId: 'd'.repeat(32) }, now: 1, operationId: 'f'.repeat(32), itemId: '9'.repeat(32) }) });
    return (async () => {
      const erin = await h.addContact({ type: 'person', displayName: 'Erin', tier: 'ken' });
      await h.ops.addIdentity(erin, { pubkey: NEW, provenance: 'direct', verification: 'unverified' });
      const { contactId } = await seedDave(h);
      expect(confirmMergeRefusal(h.log, [at(contactId, OTHER_KEY)], contactId)).toBeNull();
      expect(confirmMergeRefusal(h.log, [at(contactId, NEW)], contactId)).toEqual({ contactId: erin, displayName: 'Erin', state: 'active' });
    })();
  });
});
