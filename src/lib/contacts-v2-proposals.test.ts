import { describe, it, expect } from 'vitest';
import { applyContactProposal } from './contacts-v2-proposals';
import { recordKey, validateOperation, applyOperations } from './contacts-v2-reducer';
import { buildOperation } from './contacts-v2-mutations';
import { MAX_APP_CREATED_CONTACTS } from '../types';
import type { ContactOperation } from '../types';

const ACTOR = '1'.repeat(64);
const DEVICE = '2'.repeat(32);
const DEP = 'b'.repeat(64);
const PUBKEY = 'c'.repeat(64);
const NOW = 1_700_000_000_000;

const ctx = (over: Record<string, unknown> = {}) => ({
  grantId: 'e'.repeat(32), ownerIdentityPubkey: ACTOR, actorPubkey: ACTOR, actorDeviceId: DEVICE, existingOps: [] as ContactOperation[], now: NOW, ...over,
});

describe('applyContactProposal', () => {
  it('builds an add plus an add-identity, both valid, both app-authored', () => {
    const result = applyContactProposal('owner', { pubkey: PUBKEY, displayName: 'Ada' }, ctx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.operations).toHaveLength(2);
    for (const op of result.operations) {
      expect(validateOperation(op)).toBe(true);
      expect(op.actorRole).toBe('app');
      expect(op.actorPubkey).toBe(ACTOR);
      expect(op.directoryId).toBe('owner');
      expect(op.contactId).toBe(result.contactId);
    }
    expect(result.operations[0]?.action).toBe('add');
    expect(result.operations[1]?.action).toBe('add-identity');
  });

  it('lands as a ken, unverified, with app-proposal provenance', () => {
    const result = applyContactProposal('owner', { pubkey: PUBKEY, displayName: 'Ada' }, ctx());
    if (!result.ok) throw new Error('expected ok');
    const record = applyOperations(result.operations).get(recordKey('owner', result.contactId))!;
    expect(record.tier).toBe('ken');
    expect(record.lifecycle).toBe('active');
    expect(record.createdByActorRole).toBe('app');
    expect(record.identities[0]).toMatchObject({
      pubkey: PUBKEY, provenance: 'app-proposal', verification: 'unverified',
    });
    expect(record.identities[0]?.direct).toBeUndefined(); // an app never supplies proof
  });

  it('seeds the clock from the directory’s frontier, above everything already there', () => {
    const existing = applyContactProposal('owner', { pubkey: PUBKEY, displayName: 'Ada' }, ctx());
    if (!existing.ok) throw new Error('expected ok');
    const next = applyContactProposal(
      'owner', { pubkey: 'd'.repeat(64), displayName: 'Bo' },
      ctx({ existingOps: existing.operations }),
    );
    if (!next.ok) throw new Error('expected ok');
    const highestBefore = Math.max(...existing.operations.map((o) => o.logicalClock));
    expect(Math.min(...next.operations.map((o) => o.logicalClock))).toBeGreaterThan(highestBefore);
  });

  it('accepts a dependant directory and refuses anything unroutable', () => {
    expect(applyContactProposal(`dependant:${DEP}`, { pubkey: PUBKEY, displayName: 'Ada' }, ctx()).ok).toBe(true);
    for (const bad of ['dependant:0', 'quarantine', '', 'Owner']) {
      expect(applyContactProposal(bad, { pubkey: PUBKEY, displayName: 'Ada' }, ctx()))
        .toEqual({ ok: false, reason: 'invalid-directory' });
    }
  });

  it('refuses a malformed actor', () => {
    expect(applyContactProposal('owner', { pubkey: PUBKEY, displayName: 'Ada' }, ctx({ actorPubkey: 'nope' })))
      .toEqual({ ok: false, reason: 'invalid-actor' });
    expect(applyContactProposal('owner', { pubkey: PUBKEY, displayName: 'Ada' }, ctx({ actorDeviceId: 'nope' })))
      .toEqual({ ok: false, reason: 'invalid-actor' });
  });

  it('refuses a malformed pubkey or an empty name, and sanitises a hostile one', () => {
    expect(applyContactProposal('owner', { pubkey: 'nope', displayName: 'Ada' }, ctx()).ok).toBe(false);
    expect(applyContactProposal('owner', { pubkey: PUBKEY, displayName: '   ' }, ctx()).ok).toBe(false);
    const result = applyContactProposal('owner', { pubkey: PUBKEY.toUpperCase(), displayName: '  A‮db  ' }, ctx());
    if (!result.ok) throw new Error('expected ok');
    const record = applyOperations(result.operations).get(recordKey('owner', result.contactId))!;
    expect(record.displayName).toBe('Adb');
    expect(record.identities[0]?.pubkey).toBe(PUBKEY); // lowercased
  });

  it('mints a fresh contact id per call, so a replay cannot collide', () => {
    const a = applyContactProposal('owner', { pubkey: PUBKEY, displayName: 'Ada' }, ctx());
    const b = applyContactProposal('owner', { pubkey: PUBKEY, displayName: 'Ada' }, ctx());
    if (!a.ok || !b.ok) throw new Error('expected ok');
    expect(a.contactId).not.toBe(b.contactId);
  });
});

describe('R-28(a) — content idempotency, not just operationId', () => {
  it('writes nothing for a pubkey already in the directory, and names the record that holds it', () => {
    // `operationId` is a device-local, 500-deep replay window, and the proposal
    // event is replaceable — so before this, the same key under a fresh id was
    // a brand new contact every time.
    const first = applyContactProposal('owner', { pubkey: PUBKEY, displayName: 'Ada' }, ctx());
    if (!first.ok) throw new Error('expected ok');
    expect(first.outcome).toBe('created');

    const again = applyContactProposal(
      'owner', { pubkey: PUBKEY.toUpperCase(), displayName: 'Ada Again' },
      ctx({ existingOps: first.operations }),
    );
    expect(again).toEqual({ ok: true, outcome: 'existing', contactId: first.contactId, operations: [] });
  });

  it('matches a contact the OWNER added, so an app cannot shadow a real record', () => {
    const owned = buildOperation({
      directoryId: 'owner', contactId: 'a'.repeat(32), action: 'add', clock: 1,
      actor: { actorPubkey: ACTOR, actorRole: 'owner', actorDeviceId: DEVICE },
      now: NOW, operationId: '1'.repeat(32),
      value: { type: 'person', displayName: 'Ada', tier: 'kin', lifecycle: 'active' },
    });
    const identity = buildOperation({
      directoryId: 'owner', contactId: 'a'.repeat(32), action: 'add-identity', clock: 2,
      actor: { actorPubkey: ACTOR, actorRole: 'owner', actorDeviceId: DEVICE },
      now: NOW, operationId: '2'.repeat(32), itemId: '3'.repeat(32),
      value: { itemId: '3'.repeat(32), pubkey: PUBKEY, provenance: 'direct', verification: 'proven' },
    });
    const result = applyContactProposal(
      'owner', { pubkey: PUBKEY, displayName: 'Not Ada' }, ctx({ existingOps: [owned, identity] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contactId).toBe('a'.repeat(32));
    expect(result.operations[0].action).toBe('app-propose-list');
    expect([...applyOperations([owned, identity, ...result.operations]).values()][0].appIntroductions?.[0].status).toBe('pending');
  });

  it('does not match a record in a DIFFERENT directory', () => {
    const elsewhere = applyContactProposal(`dependant:${DEP}`, { pubkey: PUBKEY, displayName: 'Ada' }, ctx());
    if (!elsewhere.ok) throw new Error('expected ok');
    const here = applyContactProposal(
      'owner', { pubkey: PUBKEY, displayName: 'Ada' }, ctx({ existingOps: elsewhere.operations }),
    );
    if (!here.ok) throw new Error('expected ok');
    expect(here.outcome).toBe('created');
  });

  it('refuses to duplicate or revive a removed record', () => {
    const first = applyContactProposal('owner', { pubkey: PUBKEY, displayName: 'Ada' }, ctx());
    if (!first.ok) throw new Error('expected ok');
    const removal = buildOperation({
      directoryId: 'owner', contactId: first.contactId, action: 'remove', clock: 99,
      actor: { actorPubkey: ACTOR, actorRole: 'owner', actorDeviceId: DEVICE },
      now: NOW, operationId: '4'.repeat(32), value: {},
    });
    const again = applyContactProposal(
      'owner', { pubkey: PUBKEY, displayName: 'Ada' },
      ctx({ existingOps: [...first.operations, removal] }),
    );
    expect(again).toEqual({ ok: false, reason: 'invalid-operation' });
  });
});

describe('R-28(b) — the per-directory app-created ceiling', () => {
  /** N app-created contacts, each with its own key, in one directory. */
  function fill(n: number): ContactOperation[] {
    const ops: ContactOperation[] = [];
    for (let i = 0; i < n; i++) {
      const result = applyContactProposal(
        'owner', { pubkey: i.toString(16).padStart(64, '0'), displayName: `App ${i}` },
        ctx({ existingOps: ops }),
      );
      if (!result.ok) throw new Error(`expected ok at ${i}`);
      ops.push(...result.operations);
    }
    return ops;
  }

  it('refuses a proposal past the ceiling rather than evicting anything', () => {
    const full = fill(MAX_APP_CREATED_CONTACTS);
    const result = applyContactProposal(
      'owner', { pubkey: 'f'.repeat(64), displayName: 'One too many' }, ctx({ existingOps: full }),
    );
    expect(result).toEqual({ ok: false, reason: 'directory-full' });
    // Nothing already there was touched.
    expect(applyOperations(full).size).toBe(MAX_APP_CREATED_CONTACTS);
  });

  it('still accepts one at exactly the ceiling minus one', () => {
    const nearly = fill(MAX_APP_CREATED_CONTACTS - 1);
    const result = applyContactProposal(
      'owner', { pubkey: 'f'.repeat(64), displayName: 'Last one' }, ctx({ existingOps: nearly }),
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.outcome).toBe('created');
  });

  it('counts only APP-created records, and only live ones', () => {
    const ops: ContactOperation[] = [];
    // A directory full of OWNER-created contacts is not full for an app.
    for (let i = 0; i < 5; i++) {
      ops.push(buildOperation({
        directoryId: 'owner', contactId: i.toString(16).padStart(32, '0'), action: 'add', clock: i + 1,
        actor: { actorPubkey: ACTOR, actorRole: 'owner', actorDeviceId: DEVICE },
        now: NOW, operationId: (i + 1).toString(16).padStart(32, '0'),
        value: { type: 'person', displayName: `Owner ${i}`, tier: 'kin', lifecycle: 'active' },
      }));
    }
    const result = applyContactProposal(
      'owner', { pubkey: PUBKEY, displayName: 'Ada' }, ctx({ existingOps: ops }),
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.outcome).toBe('created');
  });
});
