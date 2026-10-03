import { describe, it, expect } from 'vitest';
import { recordKey, validateOperation, validateRecord, sortOperations, applyOperations } from './contacts-v2-reducer';
import type { ContactOperation, ContactRecord } from '../types';

const DIR = 'owner';
const CID = '0'.repeat(32);
const OWNER = '1'.repeat(64);
const OTHER = '2'.repeat(64);

function op(overrides: Partial<ContactOperation> & { operationId: string }): ContactOperation {
  return {
    directoryId: DIR,
    contactId: CID,
    actorPubkey: OWNER,
    actorRole: 'owner',
    actorDeviceId: 'd'.repeat(32),
    logicalClock: 1,
    action: 'add',
    value: { type: 'person', displayName: 'Dave', tier: 'kith' },
    createdAt: 1_000,
    ...overrides,
  };
}

const addOp = op({ operationId: 'a'.repeat(32), logicalClock: 1 });

describe('recordKey', () => {
  it('joins directory and contact', () => {
    expect(recordKey(DIR, CID)).toBe(`${DIR}/${CID}`);
  });
});

describe('validateOperation', () => {
  it('accepts a well-formed add', () => {
    expect(validateOperation(addOp)).toBe(true);
  });

  it('rejects malformed ids, clocks, actions and values', () => {
    expect(validateOperation(null)).toBe(false);
    expect(validateOperation({ ...addOp, operationId: 'nope' })).toBe(false);
    expect(validateOperation({ ...addOp, actorPubkey: 'nope' })).toBe(false);
    expect(validateOperation({ ...addOp, logicalClock: -1 })).toBe(false);
    expect(validateOperation({ ...addOp, logicalClock: 1.5 })).toBe(false);
    expect(validateOperation({ ...addOp, action: 'launch-missiles' })).toBe(false);
    expect(validateOperation({ ...addOp, value: { type: 'person', displayName: 'Dave', tier: 'boss' } })).toBe(false);
    expect(validateOperation({ ...addOp, value: 'not-an-object' })).toBe(false);
    expect(validateOperation({ ...addOp, action: 'rename', value: { displayName: 42 } })).toBe(false);
    expect(validateOperation({ ...addOp, action: 'unblock', value: {} })).toBe(false); // needs targetOperationId
  });
});

function record(overrides: Partial<ContactRecord> = {}): ContactRecord {
  return {
    directoryId: DIR,
    contactId: CID,
    type: 'person',
    displayName: 'Dave',
    tier: 'kith',
    roles: [],
    identities: [],
    contactMethods: [],
    accessGrants: [],
    lifecycle: 'active',
    createdAt: 1_000,
    updatedAt: 1_000,
    createdByActorRole: 'owner',
    createdByOperationId: 'a'.repeat(32),
    vouches: [],
    ceilings: [],
    blocks: [],
    ...overrides,
  };
}

describe('validateRecord', () => {
  it('accepts a well-formed record, notes included or omitted', () => {
    expect(validateRecord(record())).toBe(true);
    expect(validateRecord(record({ notes: 'a private note' }))).toBe(true);
  });

  it('accepts an empty (but capped) displayName — sanitizeDisplayName can legitimately produce one', () => {
    expect(validateRecord(record({ displayName: '' }))).toBe(true);
  });

  it('rejects a record with a missing or malformed array field', () => {
    const { vouches: _vouches, ...missingVouches } = record();
    expect(validateRecord(missingVouches)).toBe(false);
    expect(validateRecord({ ...record(), vouches: 'x' })).toBe(false);
    expect(validateRecord({ ...record(), identities: 'x' })).toBe(false);
    expect(validateRecord({ ...record(), ceilings: undefined })).toBe(false);
    expect(validateRecord({ ...record(), blocks: null })).toBe(false);
    expect(validateRecord({ ...record(), roles: [1, 2] })).toBe(false);
  });

  it('rejects malformed ids, enums and scalars', () => {
    expect(validateRecord(null)).toBe(false);
    expect(validateRecord({ ...record(), contactId: 'nope' })).toBe(false);
    expect(validateRecord({ ...record(), type: 'ghost' })).toBe(false);
    expect(validateRecord({ ...record(), tier: 'boss' })).toBe(false);
    expect(validateRecord({ ...record(), lifecycle: 'launched' })).toBe(false);
    expect(validateRecord({ ...record(), createdByActorRole: 'stranger' })).toBe(false);
    expect(validateRecord({ ...record(), createdByOperationId: 'nope' })).toBe(false);
    expect(validateRecord({ ...record(), createdAt: NaN })).toBe(false);
    expect(validateRecord({ ...record(), updatedAt: 'later' })).toBe(false);
    expect(validateRecord({ ...record(), notes: 42 })).toBe(false);
  });

  // I2: the resolver dereferences `v.guardianPubkey` / `c.maxTier` /
  // `b.blockedBy` without checking, so an element guard is what stops a
  // `[null]` row throwing inside it instead of being dropped here.
  it('rejects a fact array whose ELEMENTS are null or empty objects', () => {
    for (const field of ['vouches', 'ceilings', 'blocks', 'identities', 'contactMethods'] as const) {
      expect(validateRecord({ ...record(), [field]: [null] })).toBe(false);
      expect(validateRecord({ ...record(), [field]: [{}] })).toBe(false);
      expect(validateRecord({ ...record(), [field]: ['x'] })).toBe(false);
    }
  });

  it('accepts well-formed elements and rejects one bad field inside each', () => {
    const vouch = { vouchId: '9'.repeat(32), guardianPubkey: OWNER, tier: 'kin', createdAt: 1, operationId: '9'.repeat(32) };
    const ceiling = { guardianPubkey: OWNER, maxTier: 'none', createdAt: 1, operationId: 'c'.repeat(32) };
    const block = { blockedBy: OWNER, scope: { kind: 'contact' }, blockedAt: 1, operationId: 'b'.repeat(32) };
    const identity = { itemId: '9'.repeat(32), pubkey: OTHER, provenance: 'direct', verification: 'proven', addedAt: 1 };
    const method = { itemId: '8'.repeat(32), kind: 'phone', value: '07700 900000', verification: 'unverified', sharingPolicy: 'private', addedAt: 1 };

    expect(validateRecord(record({
      vouches: [vouch], ceilings: [ceiling], blocks: [block], identities: [identity], contactMethods: [method],
    } as Partial<ContactRecord>))).toBe(true);

    expect(validateRecord({ ...record(), vouches: [{ ...vouch, guardianPubkey: 'nope' }] })).toBe(false);
    expect(validateRecord({ ...record(), vouches: [{ ...vouch, tier: 'boss' }] })).toBe(false);
    expect(validateRecord({ ...record(), vouches: [{ ...vouch, revokedByOperationId: 'nope' }] })).toBe(false);
    expect(validateRecord({ ...record(), ceilings: [{ ...ceiling, maxTier: 'everything' }] })).toBe(false);
    expect(validateRecord({ ...record(), ceilings: [{ ...ceiling, createdAt: 'later' }] })).toBe(false);
    expect(validateRecord({ ...record(), blocks: [{ ...block, scope: { kind: 'identity' } }] })).toBe(false);
    expect(validateRecord({ ...record(), blocks: [{ ...block, blockedBy: 'A'.repeat(64) }] })).toBe(false); // uppercase hex is not lowercase hex
    expect(validateRecord({ ...record(), identities: [{ ...identity, pubkey: 'nope' }] })).toBe(false);
    expect(validateRecord({ ...record(), contactMethods: [{ ...method, kind: 'telepathy' }] })).toBe(false);
  });

  it('accepts a ceiling maxTier of none — a ceiling may forbid every tier', () => {
    expect(validateRecord({
      ...record(),
      ceilings: [{ guardianPubkey: OWNER, maxTier: 'none', createdAt: 1, operationId: 'c'.repeat(32) }],
    })).toBe(true);
  });
});

describe('sortOperations', () => {
  it('orders by clock, then actor pubkey, then operation id', () => {
    const later = op({ operationId: 'b'.repeat(32), logicalClock: 2 });
    const sameClockLowActor = op({ operationId: 'c'.repeat(32), logicalClock: 1, actorPubkey: OWNER });
    const sameClockHighActor = op({ operationId: 'd'.repeat(32), logicalClock: 1, actorPubkey: OTHER });
    const sorted = sortOperations([later, sameClockHighActor, sameClockLowActor]);
    expect(sorted.map(o => o.operationId)).toEqual([
      'c'.repeat(32),
      'd'.repeat(32),
      'b'.repeat(32),
    ]);
  });

  it('does not mutate its input', () => {
    const input = [op({ operationId: 'e'.repeat(32), logicalClock: 5 }), addOp];
    const before = input.map(o => o.operationId);
    sortOperations(input);
    expect(input.map(o => o.operationId)).toEqual(before);
  });
});

describe('applyOperations', () => {
  it('creates a record from an add and sanitises the display name', () => {
    const ops = [op({ operationId: 'a'.repeat(32), value: { type: 'person', displayName: '  Da‮ve  ', tier: 'kin', roles: ['uncle'] } })];
    const rec = applyOperations(ops).get(recordKey(DIR, CID))!;
    expect(rec.displayName).toBe('Dave');
    expect(rec.tier).toBe('kin');
    expect(rec.roles).toEqual(['uncle']);
    expect(rec.lifecycle).toBe('active');
    expect(rec.createdByActorRole).toBe('owner');
    expect(rec.createdByOperationId).toBe('a'.repeat(32));
  });

  it('ignores any operation for a contact that was never added', () => {
    const ops = [op({ operationId: 'f'.repeat(32), action: 'rename', value: { displayName: 'Ghost' } })];
    expect(applyOperations(ops).size).toBe(0);
  });

  // Pre-merge ruling: an app may not rename at all — not even a record it
  // created. Nothing constructs an app-authored rename (a
  // `rename-app-label` proposal writes the grant's own `appLabels`, never the
  // operation log), and a permission with no producer is one waiting to be
  // found.
  it('ignores an app rename even of a record the app itself created', () => {
    const appAdd = op({ operationId: '16'.repeat(16), actorRole: 'app', value: { type: 'person', displayName: 'Dave', tier: 'ken' } });
    const appRename = op({ operationId: '17'.repeat(16), logicalClock: 2, actorRole: 'app', action: 'rename', value: { displayName: 'David' } });
    const rec = applyOperations([appAdd, appRename]).get(recordKey(DIR, CID))!;
    expect(rec.displayName).toBe('Dave');
  });

  it('ignores an app rename of a record it did not create, without throwing', () => {
    const appRename = op({ operationId: '18'.repeat(16), logicalClock: 2, actorRole: 'app', action: 'rename', value: { displayName: 'Hijacked' } });
    const rec = applyOperations([addOp, appRename]).get(recordKey(DIR, CID))!;
    expect(rec.displayName).toBe('Dave'); // addOp's own display name, unchanged
    expect(rec.createdByActorRole).toBe('owner');
  });

  it('applies in sorted order regardless of input order', () => {
    // Distinct clocks AND distinct createdAt/displayName per op, so a wrong
    // fold order (e.g. applying input order instead of clock order) produces
    // a DIFFERENT updatedAt/displayName than the correct one — not just "some
    // defined value".
    const rename2 = op({ operationId: 'b'.repeat(32), logicalClock: 3, createdAt: 3_000, action: 'rename', value: { displayName: 'Second' } });
    const rename1 = op({ operationId: 'c'.repeat(32), logicalClock: 2, createdAt: 2_000, action: 'rename', value: { displayName: 'First' } });
    const rec = applyOperations([rename2, rename1, addOp]).get(recordKey(DIR, CID))!;
    expect(rec.displayName).toBe('Second');
    expect(rec.updatedAt).toBe(rename2.createdAt); // the HIGHER-clock op's createdAt, not rename1's
  });

  it('skips an invalid operation without throwing and keeps the rest', () => {
    const bad = { ...op({ operationId: '10'.repeat(16), logicalClock: 2, action: 'set-tier' }), value: { tier: 'boss' } } as ContactOperation;
    const good = op({ operationId: '11'.repeat(16), logicalClock: 3, action: 'set-tier', value: { tier: 'kin' } });
    const rec = applyOperations([addOp, bad, good]).get(recordKey(DIR, CID))!;
    expect(rec.tier).toBe('kin');
  });

  it('tombstones on remove and keeps a lower-clock mutation from undoing it', () => {
    const remove = op({ operationId: '12'.repeat(16), logicalClock: 5, action: 'remove', value: {} });
    const earlierRename = op({ operationId: '13'.repeat(16), logicalClock: 4, action: 'rename', value: { displayName: 'Stale' } });
    const rec = applyOperations([addOp, remove, earlierRename]).get(recordKey(DIR, CID))!;
    expect(rec.lifecycle).toBe('removed');
    expect(rec.removedAt).toBe(remove.createdAt);
    expect(rec.displayName).toBe('Stale'); // applied BEFORE the tombstone, then frozen
  });

  it('skips a mutation on a tombstoned record, then revives on a later add', () => {
    // remove at clock 5, then a rename at clock 6: the rename is skipped
    // outright (applyOne returns null for any non-'add' action once
    // lifecycle === 'removed') — the record stays removed with its old name.
    const remove = op({ operationId: '14'.repeat(16), logicalClock: 5, action: 'remove', value: {} });
    const staleRename = op({ operationId: '15'.repeat(16), logicalClock: 6, action: 'rename', value: { displayName: 'Should not apply' } });
    const afterRemove = applyOperations([addOp, remove, staleRename]).get(recordKey(DIR, CID))!;
    expect(afterRemove.lifecycle).toBe('removed');
    expect(afterRemove.displayName).toBe('Dave'); // from addOp — the skipped rename never touched it

    // A later add (clock 7) is the only thing that can revive it.
    const readd = op({ operationId: '16'.repeat(16), logicalClock: 7, createdAt: 3_000, value: { type: 'person', displayName: 'Dave reborn', tier: 'kith' } });
    const afterReadd = applyOperations([addOp, remove, staleRename, readd]).get(recordKey(DIR, CID))!;
    expect(afterReadd.lifecycle).toBe('active');
    expect(afterReadd.removedAt).toBeUndefined();
    expect(afterReadd.displayName).toBe('Dave reborn');
  });

  it('recreates as a new lifecycle when a later add arrives', () => {
    const remove = op({ operationId: '16'.repeat(16), logicalClock: 5, action: 'remove', value: {} });
    const readd = op({ operationId: '17'.repeat(16), logicalClock: 6, createdAt: 2_000, value: { type: 'person', displayName: 'Dave again', tier: 'ken' } });
    const rec = applyOperations([addOp, remove, readd]).get(recordKey(DIR, CID))!;
    expect(rec.lifecycle).toBe('active');
    expect(rec.removedAt).toBeUndefined();
    expect(rec.displayName).toBe('Dave again');
    expect(rec.tier).toBe('ken');
  });

  it('archives with a tombstone plus an archived flag', () => {
    const archive = op({ operationId: '18'.repeat(16), logicalClock: 5, action: 'archive', value: {} });
    const rec = applyOperations([addOp, archive]).get(recordKey(DIR, CID))!;
    expect(rec.lifecycle).toBe('removed');
    expect(rec.archived).toBe(true);
  });

  // M4: an archive keeps a read-only snapshot, and the spec's remedy for an
  // archive you no longer want is to delete it later — so a `remove` is the
  // one action a tombstone lets through when `archived === true`.
  it('lets a later remove harden an archived record into a plain removal', () => {
    const archive = op({ operationId: '1d'.repeat(16), logicalClock: 5, action: 'archive', value: {} });
    const remove = op({ operationId: '1e'.repeat(16), logicalClock: 6, action: 'remove', value: {}, createdAt: 2_000 });
    const rec = applyOperations([addOp, archive, remove]).get(recordKey(DIR, CID))!;
    expect(rec.lifecycle).toBe('removed');
    expect(rec.archived).toBeUndefined();
    expect(rec.removedAt).toBe(2_000);
  });

  it('still skips every other mutation on an archived record', () => {
    const archive = op({ operationId: '1f'.repeat(16), logicalClock: 5, action: 'archive', value: {} });
    const rename = op({ operationId: '20'.repeat(16), logicalClock: 6, action: 'rename', value: { displayName: 'Davey' } });
    const rec = applyOperations([addOp, archive, rename]).get(recordKey(DIR, CID))!;
    expect(rec.displayName).toBe('Dave');
    expect(rec.archived).toBe(true);
  });

  it('does not bump updatedAt for a remove-item that matches nothing', () => {
    const stray = op({ operationId: '21'.repeat(16), logicalClock: 2, action: 'remove-item', itemId: '7'.repeat(32), value: { itemId: '7'.repeat(32) }, createdAt: 5_000 });
    const rec = applyOperations([addOp, stray]).get(recordKey(DIR, CID))!;
    expect(rec.updatedAt).toBe(1_000);
  });

  // M5: single-line free text is sanitised in ONE place, at its own cap.
  it('strips control characters from roles, labels, method values and block reasons', () => {
    const roles = op({ operationId: '22'.repeat(16), logicalClock: 2, action: 'set-roles', value: { roles: ['un\u0007cle', ' aunt '] } });
    const method = op({
      operationId: '23'.repeat(16), logicalClock: 3, action: 'add-method', itemId: '6'.repeat(32),
      value: { itemId: '6'.repeat(32), kind: 'phone', label: 'Mo\u202ebile', value: '077\u000700 900000', verification: 'unverified', sharingPolicy: 'private' },
    });
    const block = op({ operationId: '24'.repeat(16), logicalClock: 4, action: 'block', value: { scope: { kind: 'contact' }, reason: 'bull\u0000ying' } });
    const rec = applyOperations([addOp, roles, method, block]).get(recordKey(DIR, CID))!;
    expect(rec.roles).toEqual(['uncle', 'aunt']);
    expect(rec.contactMethods[0].label).toBe('Mobile');
    expect(rec.contactMethods[0].value).toBe('07700 900000');
    expect(rec.blocks[0].reason).toBe('bullying');
  });

  it('keeps only the modelled fields of a direct evidence block', () => {
    const item = '5'.repeat(32);
    const identity = op({
      operationId: '25'.repeat(16), logicalClock: 2, action: 'add-identity', itemId: item,
      value: {
        itemId: item, pubkey: 'ab'.repeat(32), provenance: 'legacy-import', verification: 'mutual',
        direct: { ownerPubkey: OWNER, sharedSecret: 'deadbeef', verifiedAt: 5, smuggled: 'keep-me-forever' },
      },
    });
    const rec = applyOperations([addOp, identity]).get(recordKey(DIR, CID))!;
    expect(rec.identities[0].direct).toEqual({ ownerPubkey: OWNER, sharedSecret: 'deadbeef', verifiedAt: 5 });
  });

  it('rejects an oversized or non-hex shared secret and a non-object bondAssertion', () => {
    const item = '4'.repeat(32);
    const withDirect = (direct: unknown) => ({
      ...addOp, operationId: '26'.repeat(16), action: 'add-identity' as const, itemId: item,
      value: { itemId: item, pubkey: 'ab'.repeat(32), provenance: 'direct', verification: 'mutual', direct },
    });
    expect(validateOperation(withDirect({ ownerPubkey: OWNER, verifiedAt: 5, sharedSecret: 'deadbeef' }))).toBe(true);
    expect(validateOperation(withDirect({ ownerPubkey: OWNER, verifiedAt: 5, sharedSecret: 'a'.repeat(129) }))).toBe(false);
    expect(validateOperation(withDirect({ ownerPubkey: OWNER, verifiedAt: 5, sharedSecret: 'not hex' }))).toBe(false);
    expect(validateOperation(withDirect({ ownerPubkey: OWNER, verifiedAt: 5, bondAssertion: { proof: 'x' } }))).toBe(true);
    expect(validateOperation(withDirect({ ownerPubkey: OWNER, verifiedAt: 5, bondAssertion: 'a string' }))).toBe(false);
    expect(validateOperation(withDirect({ ownerPubkey: OWNER, verifiedAt: 5, bondAssertion: { blob: 'x'.repeat(5_000) } }))).toBe(false);
  });

  it('requires an object value on revoke-vouch and unblock', () => {
    const target = '3'.repeat(32);
    expect(validateOperation({ ...addOp, action: 'revoke-vouch', value: {}, targetOperationId: target })).toBe(true);
    expect(validateOperation({ ...addOp, action: 'revoke-vouch', value: null, targetOperationId: target })).toBe(false);
    expect(validateOperation({ ...addOp, action: 'unblock', value: 'lift it', targetOperationId: target })).toBe(false);
  });

  it('sets a non-removed lifecycle and a private note', () => {
    const pending = op({ operationId: '19'.repeat(16), logicalClock: 2, action: 'set-lifecycle', value: { lifecycle: 'pending' } });
    const note = op({ operationId: '1a'.repeat(16), logicalClock: 3, action: 'note', value: { note: 'met at the school gate' } });
    const rec = applyOperations([addOp, pending, note]).get(recordKey(DIR, CID))!;
    expect(rec.lifecycle).toBe('pending');
    expect(rec.notes).toBe('met at the school gate');
  });

  // I6: notes went through sanitizeDisplayName, which strips \n and \t, so a
  // two-line note came back as one glued line.
  it('keeps the line breaks and tabs in a note but still strips control and bidi characters', () => {
    const note = op({
      operationId: '1b'.repeat(16),
      logicalClock: 2,
      action: 'note',
      value: { note: '  Met at\nschool gate\tgreen coat\u0007\u202e  ' },
    });
    const rec = applyOperations([addOp, note]).get(recordKey(DIR, CID))!;
    expect(rec.notes).toBe('Met at\nschool gate\tgreen coat');
  });

  it('still strips line breaks from a display name', () => {
    const rename = op({ operationId: '1c'.repeat(16), logicalClock: 2, action: 'rename', value: { displayName: 'Dave\nSmith' } });
    const rec = applyOperations([addOp, rename]).get(recordKey(DIR, CID))!;
    expect(rec.displayName).toBe('DaveSmith');
  });

  it('keeps separate records per directory for the same contactId', () => {
    const depDir = `dependant:${'b'.repeat(64)}`;
    const depAdd = op({ operationId: '1b'.repeat(16), directoryId: depDir });
    const map = applyOperations([addOp, depAdd]);
    expect(map.size).toBe(2);
    expect(map.get(recordKey(depDir, CID))!.directoryId).toBe(depDir);
  });

  it('drops roles that clean to empty string (pure control characters) and dedupes duplicates', () => {
    const withEmptyRoles = op({
      operationId: '2a'.repeat(16),
      logicalClock: 2,
      action: 'set-roles',
      value: { roles: ['', 'friend', '‮', 'friend'] }, // BEL and RLO are pure control, clean to empty; friend is duplicated
    });
    const rec = applyOperations([addOp, withEmptyRoles]).get(recordKey(DIR, CID))!;
    expect(rec.roles).toEqual(['friend']);
    expect(validateRecord(rec)).toBe(true);
  });

  it('drops all roles when they all clean to empty strings', () => {
    const withAllEmpty = op({
      operationId: '2b'.repeat(16),
      logicalClock: 2,
      action: 'set-roles',
      value: { roles: ['', '‮', '​'] }, // all pure control chars, all clean to empty
    });
    const rec = applyOperations([addOp, withAllEmpty]).get(recordKey(DIR, CID))!;
    expect(rec.roles).toEqual([]);
    expect(validateRecord(rec)).toBe(true);
  });
});

describe('validateOperation — directoryId (R-15)', () => {
  const DEP = 'b'.repeat(64);
  const base = {
    operationId: '9'.repeat(32), contactId: 'a'.repeat(32),
    actorPubkey: '1'.repeat(64), actorRole: 'owner' as const, actorDeviceId: '2'.repeat(32),
    logicalClock: 1, action: 'add' as const, createdAt: 1,
    value: { type: 'person', displayName: 'Ada', tier: 'kith' },
  };

  it('accepts the three shapes a directory id can have', () => {
    for (const directoryId of ['owner', 'quarantine', `dependant:${DEP}`]) {
      expect(validateOperation({ ...base, directoryId })).toBe(true);
    }
  });

  it('refuses anything else, now that operations can arrive from a relay', () => {
    for (const directoryId of [
      'dependant:0', `dependant:${DEP.toUpperCase()}`, `dependant:${'b'.repeat(63)}`,
      'owner ', 'Owner', '', 'dependant:', 'dependant:' + DEP + ':extra',
    ]) {
      expect(validateOperation({ ...base, directoryId })).toBe(false);
    }
  });
});

describe('validateOperation — block authority (R-15)', () => {
  const base = {
    operationId: '9'.repeat(32), directoryId: 'owner', contactId: 'a'.repeat(32),
    actorPubkey: '1'.repeat(64), actorRole: 'owner' as const, actorDeviceId: '2'.repeat(32),
    logicalClock: 1, action: 'block' as const, createdAt: 1,
    value: { scope: { kind: 'contact' } },
  };

  it('accepts a block that does not name an author, or names its own actor', () => {
    expect(validateOperation(base)).toBe(true);
    expect(validateOperation({ ...base, value: { ...base.value, blockedBy: '1'.repeat(64) } })).toBe(true);
  });

  it('refuses a block claiming to be by someone else', () => {
    // Today the reducer derives `blockedBy` from `actorPubkey` and ignores the
    // field, so this is belt and braces — but an ignored-yet-present field is
    // a trap for the next reader, and only the blocking authority may lift a
    // block (§7.10), so who authored one has to be unambiguous.
    expect(validateOperation({ ...base, value: { ...base.value, blockedBy: '3'.repeat(64) } })).toBe(false);
  });
});

// Fix round 1 (Opus review gap): `actorRole: 'app'` was accepted for every
// action, so once Task 25 lets an app author ops it could `block` a contact
// and, under §7.10, become the ONLY authority able to lift its own block —
// or vouch, set a ceiling, or delete something it never added. An app may
// only ADD material it is proposing.
describe('validateOperation — app actor role restriction (Opus review gap)', () => {
  const ITEM = '5'.repeat(32);
  const PEER = 'ab'.repeat(32);
  const OPID = '4'.repeat(32);

  it('accepts an app actor for add, add-identity and add-method', () => {
    expect(validateOperation(op({ operationId: OPID, actorRole: 'app' }))).toBe(true); // op() defaults to action: 'add'
    expect(validateOperation(op({
      operationId: OPID, actorRole: 'app', action: 'add-identity', itemId: ITEM,
      value: { itemId: ITEM, pubkey: PEER, provenance: 'app-proposal', verification: 'unverified' },
    }))).toBe(true);
    expect(validateOperation(op({
      operationId: OPID, actorRole: 'app', action: 'add-method', itemId: ITEM,
      value: { itemId: ITEM, kind: 'email', value: 'a@b.com', verification: 'unverified', sharingPolicy: 'private' },
    }))).toBe(true);
  });

  it('refuses an app-authored rename — least privilege, no producer exists', () => {
    // A `rename-app-label` proposal writes `AppGrantV2.appLabels`, which is
    // grant-scoped and consulted only when building that one app's own
    // projection. Nothing ever builds a rename OPERATION from it, so the
    // permission bought nothing and could only ever be found by something
    // that should not have it.
    expect(validateOperation(op({
      operationId: OPID, actorRole: 'app', action: 'rename', value: { displayName: 'Ada' },
    }))).toBe(false);
  });

  it('refuses an app actor for every action with review or authority semantics', () => {
    const target = '7'.repeat(32);
    const cases: Array<[ContactOperation['action'], unknown, Partial<ContactOperation>?]> = [
      ['set-tier', { tier: 'kin' }],
      ['set-roles', { roles: ['friend'] }],
      ['update-identity', { itemId: ITEM }, { itemId: ITEM }],
      ['update-method', { itemId: ITEM }, { itemId: ITEM }],
      ['remove-item', { itemId: ITEM }, { itemId: ITEM }],
      ['evidence', { itemId: ITEM }, { itemId: ITEM }],
      ['vouch', { guardianPubkey: PEER, tier: 'kin' }],
      ['revoke-vouch', {}, { targetOperationId: target }],
      ['ceiling', { guardianPubkey: PEER, maxTier: 'kin' }],
      ['revoke-ceiling', { guardianPubkey: PEER }],
      ['block', { scope: { kind: 'contact' } }],
      ['unblock', {}, { targetOperationId: target }],
      ['set-lifecycle', { lifecycle: 'active' }],
      ['archive', {}],
      ['remove', {}],
      ['key-link', { itemId: ITEM, pubkey: PEER, linkedFromItemId: ITEM }, { itemId: ITEM }],
      ['note', { note: 'hi' }],
    ];
    for (const [action, value, extra] of cases) {
      expect(
        validateOperation(op({ operationId: OPID, actorRole: 'app', action, value, ...(extra ?? {}) })),
      ).toBe(false);
    }
  });
});

describe('applyOperations — key aliasing after remove-item', () => {
  const ALICE = '3'.repeat(32), MALLORY = '4'.repeat(32), BOB = '5'.repeat(32);
  const K = 'e'.repeat(64), K2 = 'f'.repeat(64);
  let n = 0;
  const id = () => (++n).toString(16).padStart(32, '0');
  const at = (clock: number, contactId: string, action: ContactOperation['action'], value: unknown, extra: Partial<ContactOperation> = {}) =>
    op({ operationId: id(), logicalClock: clock, createdAt: clock * 100, contactId, action, value, ...extra });
  const add = (clock: number, contactId: string, displayName: string) =>
    at(clock, contactId, 'add', { type: 'person', displayName, tier: 'ken' });
  const identity = (clock: number, contactId: string, itemId: string, pubkey = K) =>
    at(clock, contactId, 'add-identity', { itemId, pubkey, provenance: 'direct', verification: 'unverified' }, { itemId });
  const removeItem = (clock: number, contactId: string, itemId: string) =>
    at(clock, contactId, 'remove-item', { itemId }, { itemId });
  const names = (ops: ContactOperation[]) => [...applyOperations(ops).values()]
    .map(r => [r.displayName, r.identities.map(i => i.pubkey)]);
  const permutations = (ops: ContactOperation[]) => [ops, [...ops].reverse(), [...ops.slice(1), ops[0]]];

  it('a key removed from a contact does not re-attach it when a new contact is filed with that key', () => {
    const impostorItem = '6'.repeat(32), malloryItem = '7'.repeat(32);
    const ops = [add(1, ALICE, 'Alice'), identity(2, ALICE, impostorItem), removeItem(3, ALICE, impostorItem),
      add(4, MALLORY, 'Mallory'), identity(5, MALLORY, malloryItem)];
    for (const order of permutations(ops)) {
      expect(names(order)).toEqual([['Alice', []], ['Mallory', [K]]]);
    }
    const blocked = applyOperations([...ops, at(6, MALLORY, 'block', { scope: { kind: 'contact' } })]);
    expect(blocked.get(recordKey(DIR, MALLORY))!.blocks).toHaveLength(1);
    expect(blocked.get(recordKey(DIR, ALICE))!.blocks).toEqual([]);
    expect(blocked.get(recordKey(DIR, ALICE))!.mergedContactIds).toBeUndefined();
  });

  it('still merges same-npub records created concurrently on two devices', () => {
    const ops = [add(1, ALICE, 'Alice'), identity(2, ALICE, '6'.repeat(32)),
      add(1, MALLORY, 'Alice again'), identity(2, MALLORY, '7'.repeat(32))];
    for (const order of permutations(ops)) {
      const records = [...applyOperations(order).values()];
      expect(records).toHaveLength(1);
      expect(records[0].mergedContactIds).toHaveLength(1);
    }
  });

  it('keeps a formed merge when the shared key is later removed, and a later contact with it stays apart', () => {
    const ops = [add(1, ALICE, 'Alice'), identity(2, ALICE, '6'.repeat(32)),
      add(3, MALLORY, 'Alice again'), identity(4, MALLORY, '7'.repeat(32)),
      removeItem(5, ALICE, '6'.repeat(32)),
      add(6, BOB, 'Stranger'), identity(7, BOB, '8'.repeat(32))];
    for (const order of permutations(ops)) {
      const map = applyOperations(order);
      expect(map.size).toBe(2);
      expect(map.get(recordKey(DIR, ALICE))!.mergedContactIds).toEqual([MALLORY]);
      expect(map.get(recordKey(DIR, ALICE))!.identities).toEqual([]);
      expect(map.get(recordKey(DIR, BOB))!.identities.map(i => i.pubkey)).toEqual([K]);
    }
  });

  it('a key rotated in by key-link aliases a record that holds the new key', () => {
    const ops = [add(1, ALICE, 'Alice'), identity(2, ALICE, '6'.repeat(32)),
      at(3, ALICE, 'key-link', { itemId: '9'.repeat(32), pubkey: K2, linkedFromItemId: '6'.repeat(32) }, { itemId: '9'.repeat(32) }),
      add(4, MALLORY, 'Alice new'), identity(5, MALLORY, '7'.repeat(32), K2)];
    for (const order of permutations(ops)) {
      const records = [...applyOperations(order).values()];
      expect(records).toHaveLength(1);
      expect(records[0].identities.map(i => i.pubkey)).toEqual([K, K2]);
    }
  });

  it('a key removed and re-added to the same contact aliases again', () => {
    const ops = [add(1, ALICE, 'Alice'), identity(2, ALICE, '6'.repeat(32)), removeItem(3, ALICE, '6'.repeat(32)),
      identity(4, ALICE, '8'.repeat(32)), add(5, MALLORY, 'Alice again'), identity(6, MALLORY, '7'.repeat(32))];
    for (const order of permutations(ops)) {
      const records = [...applyOperations(order).values()];
      expect(records).toHaveLength(1);
      expect(records[0].identities.map(i => i.pubkey)).toEqual([K]);
    }
  });

  it('a deleted contact still holds its key, so adding that key elsewhere merges (refused upstream)', () => {
    const ops = [add(1, BOB, 'Bob'), identity(2, BOB, '6'.repeat(32)), at(3, BOB, 'remove', {}),
      add(4, ALICE, 'Alice'), identity(5, ALICE, '7'.repeat(32))];
    expect(applyOperations(ops).size).toBe(1);
  });
});
