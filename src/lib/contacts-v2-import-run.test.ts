import { describe, it, expect, vi } from 'vitest';
import { runContactsV2Import, type ImportInput, type ImportIo } from './contacts-v2-import';
import { importSourceKey } from './contacts-v2-ids';
import type { Contact, ContactOperation } from '../types';
import type { KenEntry } from '@forgesworn/kenspeckle';

const OWNER = 'a'.repeat(64);
const PEER_1 = '1'.repeat(64);
const PEER_2 = '2'.repeat(64);
const DEP_SLOT = 'c'.repeat(64);
const DEP_DIR = `dependant:${DEP_SLOT}`;

function contact(pubkey: string): Contact {
  return { pubkey, ownerPubkey: OWNER, displayName: 'Dave', sharedSecret: 'deadbeef', verifiedAt: 1_700 };
}

function ken(pubkey: string): KenEntry {
  return {
    pubkey,
    ownerPubkey: OWNER,
    tier: 'ken',
    displayName: 'Local chip shop',
    addedAt: 1_800,
    provenance: { source: 'manual', locator: 'shopfront', confirmedAt: 1_800 },
  } as KenEntry;
}

function input(over: Partial<ImportInput> = {}): ImportInput {
  return {
    contacts: [],
    kens: [],
    ownerPubkeys: [OWNER],
    dependants: [],
    deviceId: 'd'.repeat(32),
    actorPubkey: OWNER,
    now: 9_000,
    ...over,
  };
}

function io(known: string[] = []) {
  const saved: ContactOperation[] = [];
  const marked: string[] = [];
  const spec: ImportIo = {
    listImportedSources: vi.fn(async () => known),
    saveOps: vi.fn(async (ops: ContactOperation[]) => { saved.push(...ops); }),
    markSources: vi.fn(async (keys: string[]) => { marked.push(...keys); }),
  };
  return { spec, saved, marked };
}

describe('runContactsV2Import', () => {
  it('imports unseen rows, saves their operations and marks their sources', async () => {
    const { spec, saved, marked } = io();
    const result = await runContactsV2Import(input({ contacts: [contact(PEER_1)] }), spec);
    expect(result).toEqual({ imported: 1, skipped: 0, quarantined: 0, operations: 4 });
    expect(saved).toHaveLength(4);
    expect(marked).toEqual([`contact:${PEER_1}`]);
    expect(spec.markSources).toHaveBeenCalledWith([`contact:${PEER_1}`], 9_000);
  });

  it('skips a row whose source is already marked', async () => {
    const { spec, saved, marked } = io([`contact:${PEER_1}`]);
    const result = await runContactsV2Import(input({ contacts: [contact(PEER_1)] }), spec);
    expect(result).toEqual({ imported: 0, skipped: 1, quarantined: 0, operations: 0 });
    expect(saved).toHaveLength(0);
    expect(marked).toHaveLength(0);
    expect(spec.saveOps).not.toHaveBeenCalled();
  });

  it('picks up a row the old UI wrote after the first run', async () => {
    const { spec, saved } = io([`contact:${PEER_1}`]);
    const result = await runContactsV2Import(input({ contacts: [contact(PEER_1), contact(PEER_2)] }), spec);
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
    expect(saved.every(op => op.contactId === saved[0].contactId)).toBe(true);
  });

  // R-QUARANTINE: a quarantined row is UNRESOLVED, not filed. Marking it would
  // be permanent — the marker makes every later run skip it — and the reason it
  // did not route may simply be that the dependant roster had not loaded yet.

  it('neither saves nor marks a row whose owner is unknown', async () => {
    const stranger = { ...contact(PEER_1), ownerPubkey: 'f'.repeat(64) };
    const { spec, saved, marked } = io();
    const result = await runContactsV2Import(input({ contacts: [stranger] }), spec);
    expect(result).toEqual({ imported: 0, skipped: 0, quarantined: 1, operations: 0 });
    expect(saved).toHaveLength(0);
    expect(marked).toHaveLength(0);
    expect(spec.saveOps).not.toHaveBeenCalled();
    expect(spec.markSources).not.toHaveBeenCalled();
  });

  it('imports a previously quarantined row on a later run once its dependant ref is supplied', async () => {
    const depOwned = { ...contact(PEER_1), ownerPubkey: DEP_SLOT };

    const first = io();
    const firstResult = await runContactsV2Import(input({ contacts: [depOwned] }), first.spec);
    expect(firstResult.quarantined).toBe(1);
    expect(first.marked).toHaveLength(0);

    // Next run: the roster has loaded, so the same row routes and imports.
    const second = io(first.marked);
    const secondResult = await runContactsV2Import(
      input({ contacts: [depOwned], dependants: [{ directoryId: DEP_DIR, slotPubkeys: [DEP_SLOT] }] }),
      second.spec,
    );
    expect(secondResult).toEqual({ imported: 1, skipped: 0, quarantined: 0, operations: 4 });
    expect(second.saved.every(op => op.directoryId === DEP_DIR)).toBe(true);
    expect(second.marked).toEqual([`contact:${PEER_1}`]);
  });

  it('saves and marks the routable rows of a mixed run and leaves the quarantined one alone', async () => {
    const stranger = { ...contact(PEER_2), ownerPubkey: 'f'.repeat(64) };
    const { spec, saved, marked } = io();
    const result = await runContactsV2Import(input({ contacts: [contact(PEER_1), stranger] }), spec);
    expect(result).toEqual({ imported: 1, skipped: 0, quarantined: 1, operations: 4 });
    expect(saved.every(op => op.directoryId === 'owner')).toBe(true);
    expect(marked).toEqual([`contact:${PEER_1}`]);
  });

  it('quarantines a legacy row whose own pubkey is not 64-hex rather than emitting an identity-less add', async () => {
    const malformed = { ...contact('not-a-pubkey'), ownerPubkey: OWNER };
    const { spec, saved, marked } = io();
    const result = await runContactsV2Import(input({ contacts: [malformed] }), spec);
    expect(result).toEqual({ imported: 0, skipped: 0, quarantined: 1, operations: 0 });
    expect(saved).toHaveLength(0);
    expect(marked).toHaveLength(0);
  });

  it('touches no storage when there is nothing to import', async () => {
    const { spec } = io();
    const result = await runContactsV2Import(input(), spec);
    expect(result).toEqual({ imported: 0, skipped: 0, quarantined: 0, operations: 0 });
    expect(spec.saveOps).not.toHaveBeenCalled();
    expect(spec.markSources).not.toHaveBeenCalled();
  });

  it('marks sources only after the operations are saved', async () => {
    const order: string[] = [];
    const spec: ImportIo = {
      listImportedSources: async () => [],
      saveOps: async () => { order.push('save'); },
      markSources: async () => { order.push('mark'); },
    };
    await runContactsV2Import(input({ contacts: [contact(PEER_1)] }), spec);
    expect(order).toEqual(['save', 'mark']);
  });

  // --- sourceKeys is a group (controller ruling): a merged contact+ken entry
  // carries both keys, must be skipped when EITHER is already marked, and
  // marks BOTH keys once its ops are saved.

  it('skips a merged contact+ken entry when only one of its two source keys is already marked', async () => {
    const { spec, saved, marked } = io([`ken:${PEER_1}`]);
    const result = await runContactsV2Import(input({ contacts: [contact(PEER_1)], kens: [ken(PEER_1)] }), spec);
    expect(result).toEqual({ imported: 0, skipped: 1, quarantined: 0, operations: 0 });
    expect(saved).toHaveLength(0);
    expect(marked).toHaveLength(0);
    expect(spec.saveOps).not.toHaveBeenCalled();
  });

  it('marks every source key of a merged entry once its operations are saved', async () => {
    const { spec, marked } = io();
    await runContactsV2Import(input({ contacts: [contact(PEER_1)], kens: [ken(PEER_1)] }), spec);
    expect(marked.sort()).toEqual([importSourceKey('contact', PEER_1), importSourceKey('ken', PEER_1)].sort());
  });

});

it('links a fresh legacy source into an existing v2 npub instead of making a duplicate', async () => {
  const { applyOperations } = await import('./contacts-v2-reducer');
  const existingId = '8'.repeat(32);
  const existing: ContactOperation[] = [{
    operationId: '6'.repeat(32), contactId: existingId, directoryId: 'owner', actorPubkey: OWNER,
    actorRole: 'owner', actorDeviceId: 'd'.repeat(32), logicalClock: 10, createdAt: 500,
    action: 'add', value: { type: 'person', displayName: 'My name', tier: 'kin', ownerIdentityPubkey: DEP_SLOT },
  }, {
    operationId: '7'.repeat(32), contactId: existingId, directoryId: 'owner', actorPubkey: OWNER,
    actorRole: 'owner', actorDeviceId: 'd'.repeat(32), logicalClock: 11, createdAt: 500,
    action: 'add-identity', value: { itemId: '9'.repeat(32), pubkey: PEER_1, provenance: 'direct', verification: 'unverified' },
  }];
  const store = io();
  store.spec.listExistingOps = async () => existing;
  await runContactsV2Import(input({ contacts: [contact(PEER_1)] }), store.spec);
  const records = [...applyOperations([...existing, ...store.saved]).values()];
  expect(records).toHaveLength(1);
  expect(records[0].displayName).toBe('My name');
  expect(records[0].origins).toEqual([expect.objectContaining({ method: 'import', ownerIdentityPubkey: OWNER, addedAt: 1_700_000 })]);
  expect(records[0].listMemberships?.map(m => m.ownerIdentityPubkey)).toEqual([DEP_SLOT, OWNER]);
  expect(store.saved.every(op => op.contactId === existingId && ['link-list', 'record-origin'].includes(op.action))).toBe(true);
});

it('keeps deleted imported history deleted if saving succeeded before its marker was written', async () => {
  const { applyOperations } = await import('./contacts-v2-reducer');
  const store = io();
  const data = input({ contacts: [contact(PEER_1)] });
  await runContactsV2Import(data, store.spec);
  const origin = store.saved.find(op => op.action === 'record-origin')!;
  const existing = [...store.saved, { ...origin, operationId: 'f'.repeat(32),
    action: 'remove-origin' as const, logicalClock: 20, value: { id: origin.operationId } }];
  const retry = io();
  retry.spec.listExistingOps = async () => existing;
  await runContactsV2Import(data, retry.spec);
  expect(retry.saved.some(op => op.action === 'record-origin')).toBe(false);
  const record = [...applyOperations([...existing, ...retry.saved]).values()][0];
  expect(record.origins).toEqual([]);
});
