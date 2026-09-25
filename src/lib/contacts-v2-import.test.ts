import { describe, it, expect } from 'vitest';
import { buildImportOps, importOps, type ImportInput } from './contacts-v2-import';
import { applyOperations, recordKey, validateOperation } from './contacts-v2-reducer';
import { importContactId, importSourceKey } from './contacts-v2-ids';
import type { Contact } from '../types';
import type { KenEntry } from '@forgesworn/kenspeckle';

const OWNER_NP = 'a'.repeat(64);
const OWNER_PERSONA = 'b'.repeat(64);
const DEP_NP = 'c'.repeat(64);
const STRANGER = 'd'.repeat(64);
const PEER_1 = '1'.repeat(64);
const PEER_2 = '2'.repeat(64);
const PEER_3 = '3'.repeat(64);
// Fix round 1: a real 64-hex dependant id, not the old placeholder
// `dependant:0` — `validateOperation` now refuses anything else (R-15), so a
// loose fixture here would make every dependant-directory import op silently
// fail validation without any test noticing.
const DEP_DIR = `dependant:${'b'.repeat(64)}`;

function contact(over: Partial<Contact> = {}): Contact {
  return {
    pubkey: PEER_1,
    ownerPubkey: OWNER_NP,
    displayName: 'Dave',
    sharedSecret: 'deadbeef',
    verifiedAt: 1_700,
    ...over,
  };
}

function ken(over: Partial<KenEntry> = {}): KenEntry {
  return {
    pubkey: PEER_3,
    ownerPubkey: OWNER_NP,
    tier: 'ken',
    displayName: 'Local chip shop',
    addedAt: 1_800,
    provenance: { source: 'manual', locator: 'shopfront', confirmedAt: 1_800 },
    ...over,
  } as KenEntry;
}

function input(over: Partial<ImportInput> = {}): ImportInput {
  return {
    contacts: [],
    kens: [],
    ownerPubkeys: [OWNER_NP, OWNER_PERSONA],
    dependants: [{ directoryId: DEP_DIR, slotPubkeys: [DEP_NP] }],
    deviceId: 'd'.repeat(32),
    actorPubkey: OWNER_NP,
    now: 9_000,
    ...over,
  };
}

describe('buildImportOps — directory routing', () => {
  it('routes an owner-owned row to the owner directory', () => {
    const plan = buildImportOps(input({ contacts: [contact()] }));
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0].directoryId).toBe('owner');
    expect(plan.entries[0].quarantined).toBe(false);
    expect(plan.entries[0].sourceKeys).toEqual([importSourceKey('contact', PEER_1)]);
    expect(plan.entries[0].contactId).toBe(importContactId('owner', PEER_1));
  });

  it('routes a dependant-slot-owned row to that dependant directory', () => {
    const plan = buildImportOps(input({ contacts: [contact({ ownerPubkey: DEP_NP })] }));
    expect(plan.entries[0].directoryId).toBe(DEP_DIR);
  });

  it('quarantines a row whose owner maps to nothing', () => {
    const plan = buildImportOps(input({ contacts: [contact({ ownerPubkey: STRANGER })] }));
    expect(plan.entries[0].directoryId).toBe('quarantine');
    expect(plan.entries[0].quarantined).toBe(true);
  });

  it('routes a mixed-case ownerPubkey the same as its lowercase form', () => {
    const mixedCase = OWNER_NP.slice(0, 32).toUpperCase() + OWNER_NP.slice(32);
    const plan = buildImportOps(input({ contacts: [contact({ ownerPubkey: mixedCase, sharedSecret: '' })] }));
    expect(plan.entries[0].directoryId).toBe('owner');
    expect(plan.entries[0].quarantined).toBe(false);
  });

  it('routes a mixed-case dependant slot pubkey to that dependant directory', () => {
    const mixedCaseDep = DEP_NP.slice(0, 32).toUpperCase() + DEP_NP.slice(32);
    const plan = buildImportOps(input({ contacts: [contact({ ownerPubkey: mixedCaseDep, sharedSecret: '' })] }));
    expect(plan.entries[0].directoryId).toBe(DEP_DIR);
    expect(plan.entries[0].quarantined).toBe(false);
  });

  it('produces operations that all pass validateOperation for a mixed-case ownerPubkey with a shared secret', () => {
    const mixedCase = OWNER_NP.slice(0, 32).toUpperCase() + OWNER_NP.slice(32);
    const plan = buildImportOps(input({ contacts: [contact({ ownerPubkey: mixedCase })] }));
    const ops = importOps(plan);
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.every(op => validateOperation(op))).toBe(true);
  });
});

describe('buildImportOps — shared secret shape', () => {
  it('imports a row whose shared secret is not hex as unverified, with no direct evidence', () => {
    const plan = buildImportOps(input({ contacts: [contact({ sharedSecret: 'not a hex secret' })] }));
    const ops = importOps(plan);
    expect(ops.every(op => validateOperation(op))).toBe(true);
    const identity = ops.find(o => o.action === 'add-identity')!.value as { verification: string; direct?: unknown };
    expect(identity.verification).toBe('unverified');
    expect(identity.direct).toBeUndefined();
  });
});

describe('buildImportOps — actor role by directory', () => {
  it('stamps operations landing in a dependant directory as guardian, not owner', () => {
    const ops = importOps(buildImportOps(input({ contacts: [contact({ ownerPubkey: DEP_NP })] })));
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.every(o => o.actorRole === 'guardian')).toBe(true);
    // Fix round 1: with a real 64-hex DEP_DIR fixture (R-15 tightened
    // `directoryId`), this is the one place a dependant-directory import op
    // is actually run through `validateOperation` — a loose placeholder id
    // here would previously have let every such op fail silently.
    expect(ops.every(o => validateOperation(o))).toBe(true);
  });

  it('stamps operations landing in the owner directory as owner', () => {
    const ops = importOps(buildImportOps(input({ contacts: [contact()] })));
    expect(ops.every(o => o.actorRole === 'owner')).toBe(true);
  });

  it('stamps quarantined operations as owner, not guardian', () => {
    const ops = importOps(buildImportOps(input({ contacts: [contact({ ownerPubkey: STRANGER })] })));
    expect(ops.every(o => o.actorRole === 'owner')).toBe(true);
  });
});

describe('buildImportOps — tier and evidence mapping', () => {
  it('maps a contact with a relationship to Kin with the relationship as a role', () => {
    const plan = buildImportOps(input({ contacts: [contact({ relationship: 'parent' })] }));
    const record = applyOperations(importOps(plan)).get(recordKey('owner', plan.entries[0].contactId))!;
    expect(record.tier).toBe('kin');
    expect(record.roles).toEqual(['parent']);
  });

  it('maps a contact with no relationship to Kith', () => {
    const plan = buildImportOps(input({ contacts: [contact()] }));
    const record = applyOperations(importOps(plan)).get(recordKey('owner', plan.entries[0].contactId))!;
    expect(record.tier).toBe('kith');
    expect(record.roles).toEqual([]);
  });

  it('maps a ken row to Ken with no invented trust evidence', () => {
    const plan = buildImportOps(input({ kens: [ken()] }));
    const record = applyOperations(importOps(plan)).get(recordKey('owner', plan.entries[0].contactId))!;
    expect(record.tier).toBe('ken');
    expect(record.identities[0].provenance).toBe('legacy-import');
    expect(record.identities[0].verification).toBe('unverified');
    expect(record.identities[0].direct).toBeUndefined();
  });

  it('preserves the shared secret, verification time, group and label on the identity', () => {
    const plan = buildImportOps(input({
      contacts: [contact({ groupId: 'g1', label: 'Gaming', isDefaultForGroup: true })],
    }));
    const record = applyOperations(importOps(plan)).get(recordKey('owner', plan.entries[0].contactId))!;
    const identity = record.identities[0];
    expect(identity.pubkey).toBe(PEER_1);
    expect(identity.label).toBe('Gaming');
    expect(identity.verification).toBe('mutual');
    expect(identity.direct).toEqual({
      ownerPubkey: OWNER_NP,
      sharedSecret: 'deadbeef',
      verifiedAt: 1_700,
      groupId: 'g1',
      isDefaultForGroup: true,
    });
  });

  it('marks a secretless legacy contact unverified rather than mutual', () => {
    const plan = buildImportOps(input({ contacts: [contact({ sharedSecret: '' })] }));
    const record = applyOperations(importOps(plan)).get(recordKey('owner', plan.entries[0].contactId))!;
    expect(record.identities[0].verification).toBe('unverified');
    expect(record.identities[0].direct).toBeUndefined();
  });

  it('sanitises the imported display name', () => {
    const plan = buildImportOps(input({ contacts: [contact({ displayName: ' Da​ve ' })] }));
    const record = applyOperations(importOps(plan)).get(recordKey('owner', plan.entries[0].contactId))!;
    expect(record.displayName).toBe('Dave');
  });

  it('attributes import operations to this device and the owner actor', () => {
    const ops = importOps(buildImportOps(input({ contacts: [contact()] })));
    expect(ops.every(o => o.actorDeviceId === 'd'.repeat(32))).toBe(true);
    expect(ops.every(o => o.actorPubkey === OWNER_NP)).toBe(true);
    expect(ops.every(o => o.actorRole === 'owner')).toBe(true);
    expect(ops.map(o => o.action)).toEqual(['add', 'add-identity', 'link-list']);
    expect(ops.map(o => o.logicalClock)).toEqual([1, 2, 3]);
  });

  it('merges a contact row and a ken row for the same person into one record, the contact row winning', () => {
    const plan = buildImportOps(input({
      contacts: [contact({ pubkey: PEER_2, relationship: 'sibling' })],
      kens: [ken({ pubkey: PEER_2 })],
    }));
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0].sourceKeys).toEqual([
      importSourceKey('contact', PEER_2),
      importSourceKey('ken', PEER_2),
    ]);

    const ops = importOps(plan);
    expect(ops).toHaveLength(3);
    const records = applyOperations(ops);
    expect(records.size).toBe(1);
    const record = records.get(recordKey('owner', plan.entries[0].contactId))!;

    // Tier, roles and evidence all come from the CONTACT row — the ken row
    // never upgrades, downgrades or duplicates anything.
    expect(record.tier).toBe('kin');
    expect(record.roles).toEqual(['sibling']);
    expect(record.identities).toHaveLength(1);
    expect(record.identities[0].pubkey).toBe(PEER_2);
    expect(record.identities[0].verification).toBe('mutual');
    expect(record.updatedAt).toBeGreaterThanOrEqual(record.createdAt);
  });
});

describe('buildImportOps — determinism', () => {
  it('produces byte-identical operations for the same input', () => {
    const args = input({ contacts: [contact({ relationship: 'sibling' })], kens: [ken()] });
    expect(JSON.stringify(buildImportOps(args))).toBe(JSON.stringify(buildImportOps(args)));
  });

  it('produces byte-identical operations for a contact+ken collision on the same pubkey', () => {
    const args = input({
      contacts: [contact({ pubkey: PEER_2, relationship: 'sibling' })],
      kens: [ken({ pubkey: PEER_2 })],
    });
    expect(JSON.stringify(buildImportOps(args))).toBe(JSON.stringify(buildImportOps(args)));
  });

  it('separates the same pubkey held in two directories', () => {
    const plan = buildImportOps(input({
      contacts: [contact(), contact({ ownerPubkey: DEP_NP })],
    }));
    const ids = plan.entries.map(e => `${e.directoryId}/${e.contactId}`);
    expect(new Set(ids).size).toBe(2);
    expect(new Set(importOps(plan).map(o => o.operationId)).size).toBe(importOps(plan).length);
  });

  it('merges contact and ken rows for the same pubkey in the same directory into one entry', () => {
    const plan = buildImportOps(input({ contacts: [contact({ pubkey: PEER_2 })], kens: [ken({ pubkey: PEER_2 })] }));
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0].sourceKeys).toEqual([
      importSourceKey('contact', PEER_2),
      importSourceKey('ken', PEER_2),
    ]);
    expect(new Set(importOps(plan).map(o => o.operationId)).size).toBe(3);
  });
});

describe('legacy import identity list membership', () => {
  it('merges one npub across owner lists, preserving earliest primary and strongest evidence', () => {
    const ops = importOps(buildImportOps(input({
      contacts: [contact({ ownerPubkey: OWNER_NP, verifiedAt: 1700 })],
      kens: [ken({ pubkey: PEER_1, ownerPubkey: OWNER_PERSONA.toUpperCase(), addedAt: 1000 })],
    })));
    expect(ops.every(validateOperation)).toBe(true);
    // Existing deterministic operations are immutable; membership is appended.
    const original = importOps(buildImportOps(input({ contacts: [contact({ ownerPubkey: OWNER_NP, verifiedAt: 1700 })] })));
    expect(ops.slice(0, 2)).toEqual(original.slice(0, 2));
    expect(ops[0].value).not.toHaveProperty("ownerIdentityPubkey");
    expect(ops.slice(2).map(op => op.action)).toEqual(["link-list", "link-list"]);
    const records = applyOperations(ops);
    expect(records.size).toBe(1);
    const record = [...records.values()][0];
    expect(record.primaryIdentityPubkey).toBe(OWNER_PERSONA);
    expect(record.createdAt).toBe(1000);
    expect(record.tier).toBe('kith');
    expect(record.identities[0].direct?.verifiedAt).toBe(1700);
    expect(record.listMemberships).toEqual([
      { ownerIdentityPubkey: OWNER_PERSONA, addedAt: 1000 },
      { ownerIdentityPubkey: OWNER_NP, addedAt: 1700 },
    ]);
    expect([...applyOperations([...ops].reverse()).values()]).toEqual([...records.values()]);
  });

  it('deduplicates membership for two legacy sources owned by the same identity', () => {
    const record = [...applyOperations(importOps(buildImportOps(input({
      contacts: [contact()], kens: [ken({ pubkey: PEER_1 })],
    })))).values()][0];
    expect(record.listMemberships).toEqual([{ ownerIdentityPubkey: OWNER_NP, addedAt: 1700 }]);
  });

  it('keeps the same npub in owner and dependant vaults as separate records', () => {
    const records = [...applyOperations(importOps(buildImportOps(input({
      contacts: [contact()], kens: [ken({ pubkey: PEER_1, ownerPubkey: DEP_NP })],
    })))).values()];
    expect(records).toHaveLength(2);
    expect(records.find(r => r.directoryId === 'owner')?.listMemberships)
      .toEqual([{ ownerIdentityPubkey: OWNER_NP, addedAt: 1700 }]);
    expect(records.find(r => r.directoryId === DEP_DIR)?.listMemberships)
      .toEqual([{ ownerIdentityPubkey: DEP_NP, addedAt: 1800 }]);
  });
});
