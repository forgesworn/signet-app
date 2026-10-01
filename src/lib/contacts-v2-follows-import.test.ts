import { describe, it, expect } from 'vitest';
import { planFollowsImport, type FollowImportEntry } from './contacts-v2-follows-import';
import {
  CHECKPOINT_IMPORT_LINE_BYTES,
  CHECKPOINT_IMPORT_LINE_OPS,
  MAX_CHECKPOINT_OPS,
  MAX_CHUNKS,
  projectCheckpointBytes,
  splitCheckpoint,
  type CheckpointPayload,
} from './contacts-v2-sync';
import { applyOperations, validateOperation } from './contacts-v2-reducer';
const validate = validateOperation;
import type { ContactOperation, ContactRecord } from '../types';
import type { MutationActor } from './contacts-v2-mutations';

const OWNER = '1'.repeat(64);
const OTHER_LIST = '2'.repeat(64);
const DIR = 'owner';
const actor: MutationActor = { actorPubkey: OWNER, actorRole: 'owner', actorDeviceId: 'd'.repeat(32) };
const NOW = 1_750_000_000_000;

let counter = 0;
function hex(n: number, len: number): string { return n.toString(16).padStart(len, '0'); }
function newId(): string { counter += 1; return hex(counter, 32); }
function pubkeyOf(i: number): string { return hex(i + 1, 64).replace(/^0/, 'a'); }
function entry(i: number): FollowImportEntry {
  return { pubkey: pubkeyOf(i), displayName: `Peer ${i}` };
}
function entries(n: number): FollowImportEntry[] { return Array.from({ length: n }, (_, i) => entry(i)); }

function run(over: Partial<Parameters<typeof planFollowsImport>[0]> = {}) {
  return planFollowsImport({
    entries: [], ownerIdentityPubkey: OWNER, originMethod: 'import', caption: 'Nostr follows', directoryId: DIR,
    records: [], actor, baseClock: 0, now: NOW, wholeLog: [], newId, ...over,
  });
}

/** Apply a plan's ops over an existing log and return the directory's records. */
function reduce(log: ContactOperation[]): ContactRecord[] {
  return [...applyOperations(log).values()].filter(r => r.directoryId === DIR);
}

function op(over: Partial<ContactOperation> & Pick<ContactOperation, 'action' | 'value' | 'contactId'>): ContactOperation {
  counter += 1;
  return {
    operationId: hex(counter + 9_000_000, 32), directoryId: DIR, actorPubkey: OWNER, actorRole: 'owner',
    actorDeviceId: 'd'.repeat(32), logicalClock: counter, createdAt: NOW - 5000, ...over,
  };
}

describe('planFollowsImport', () => {
  it('builds add + add-identity + origin per new follow on one contiguous clock range', () => {
    const plan = run({ entries: entries(3), baseClock: 40 });
    expect(plan.ops).toHaveLength(9);
    expect(plan.ops.map(o => o.logicalClock)).toEqual([41, 42, 43, 44, 45, 46, 47, 48, 49]);
    expect(plan.ops.slice(0, 3).map(o => o.action)).toEqual(['add', 'add-identity', 'record-origin']);
    expect(plan.added).toBe(3);
    expect(plan.linked).toBe(0);
    expect(plan.ops.every(o => validateOperation(o))).toBe(true);
    const add = plan.ops[0].value as { tier: string; ownerIdentityPubkey: string };
    expect(add.tier).toBe('ken');
    expect(add.ownerIdentityPubkey).toBe(OWNER);
    const ident = plan.ops[1].value as { provenance: string; verification: string };
    expect([ident.provenance, ident.verification]).toEqual(['direct', 'unverified']);
    const origin = plan.ops[2].value as { method: string; caption: string; ownerIdentityPubkey: string };
    expect([origin.method, origin.caption, origin.ownerIdentityPubkey]).toEqual(['import', 'Nostr follows', OWNER]);
  });

  it('only links an existing contact to the list: tier, name and notes untouched', () => {
    const base = [
      op({ action: 'add', contactId: 'c'.repeat(32), value: { type: 'person', displayName: 'Existing Pal', tier: 'kin', ownerIdentityPubkey: OTHER_LIST } }),
      op({ action: 'add-identity', contactId: 'c'.repeat(32), itemId: 'e'.repeat(32), value: { itemId: 'e'.repeat(32), pubkey: pubkeyOf(0), provenance: 'direct', verification: 'proven' } }),
      op({ action: 'note', contactId: 'c'.repeat(32), value: { note: 'met at the market' } }),
    ];
    const plan = run({ entries: [{ pubkey: pubkeyOf(0), displayName: 'Different Name' }], records: reduce(base), wholeLog: base, baseClock: 10 });
    expect(plan.ops.map(o => o.action)).toEqual(['link-list', 'record-origin']);
    expect(plan.linked).toBe(1);
    expect(plan.added).toBe(0);

    const after = reduce([...base, ...plan.ops]);
    expect(after).toHaveLength(1);
    const rec = after[0];
    expect(rec.tier).toBe('kin');
    expect(rec.displayName).toBe('Existing Pal');
    expect(rec.notes).toBe('met at the market');
    expect(rec.listMemberships?.filter(m => m.removedAt === undefined).map(m => m.ownerIdentityPubkey).sort()).toEqual([OWNER, OTHER_LIST].sort());
    expect(rec.origins?.[0]).toMatchObject({ method: 'import', caption: 'Nostr follows', ownerIdentityPubkey: OWNER });
  });

  it('is idempotent: a re-run over the result writes zero operations', () => {
    const first = run({ entries: entries(5) });
    const log = first.ops;
    const second = run({ entries: entries(5), records: reduce(log), wholeLog: log, baseClock: 99 });
    expect(second.ops).toEqual([]);
    expect(second.unchanged).toBe(5);
    expect(second.added + second.linked).toBe(0);
  });

  it('adds only the new follows on a refresh', () => {
    const first = run({ entries: entries(3) });
    const second = run({ entries: entries(5), records: reduce(first.ops), wholeLog: first.ops, baseClock: 20 });
    expect(second.added).toBe(2);
    expect(second.unchanged).toBe(3);
    expect(second.ops).toHaveLength(6);
  });

  it('skips the origin (never throws) for a contact already holding 64', () => {
    const cid = 'c'.repeat(32);
    const base: ContactOperation[] = [
      op({ action: 'add', contactId: cid, value: { type: 'person', displayName: 'Busy Peer', tier: 'ken', ownerIdentityPubkey: OTHER_LIST } }),
      op({ action: 'add-identity', contactId: cid, itemId: 'e'.repeat(32), value: { itemId: 'e'.repeat(32), pubkey: pubkeyOf(0), provenance: 'direct', verification: 'unverified' } }),
      ...Array.from({ length: 64 }, (_, i) => op({
        action: 'record-origin', contactId: cid, ownerIdentityPubkey: OTHER_LIST,
        value: { id: hex(i + 1, 32), ownerIdentityPubkey: OTHER_LIST, method: 'manual', addedAt: NOW - 1000 - i },
      })),
    ];
    const records = reduce(base);
    expect(records[0].origins).toHaveLength(64);
    const plan = run({ entries: [entry(0)], records, wholeLog: base });
    expect(plan.ops.map(o => o.action)).toEqual(['link-list']);
    expect(plan.linked).toBe(1);
  });

  it('never revives a removed contact: skips it and counts it as skipped', () => {
    const cid = 'c'.repeat(32);
    const base: ContactOperation[] = [
      op({ action: 'add', contactId: cid, value: { type: 'person', displayName: 'Gone Peer', tier: 'kith', ownerIdentityPubkey: OWNER } }),
      op({ action: 'add-identity', contactId: cid, itemId: 'e'.repeat(32), value: { itemId: 'e'.repeat(32), pubkey: pubkeyOf(0), provenance: 'direct', verification: 'unverified' } }),
      op({ action: 'remove', contactId: cid, value: {} }),
    ];
    const plan = run({
      entries: [{ pubkey: pubkeyOf(0), displayName: 'Other Name' }, entry(5)],
      records: reduce(base), wholeLog: base, baseClock: 1_000_000,
    });
    expect(plan.skippedRemoved).toBe(1);
    expect(plan.added).toBe(1); // only the new follow
    expect(plan.unchanged).toBe(0);
    expect(plan.ops.every(o => o.contactId !== cid)).toBe(true);
    const after = reduce([...base, ...plan.ops]);
    expect(after.find(r => r.contactId === cid)).toMatchObject({ lifecycle: 'removed' });
    expect(after).toHaveLength(2);
  });

  it('a follow list of only removed contacts plans nothing', () => {
    const cid = 'c'.repeat(32);
    const base: ContactOperation[] = [
      op({ action: 'add', contactId: cid, value: { type: 'person', displayName: 'Gone Peer', tier: 'ken', ownerIdentityPubkey: OWNER } }),
      op({ action: 'add-identity', contactId: cid, itemId: 'e'.repeat(32), value: { itemId: 'e'.repeat(32), pubkey: pubkeyOf(0), provenance: 'direct', verification: 'unverified' } }),
      op({ action: 'remove', contactId: cid, value: {} }),
    ];
    const plan = run({ entries: [entry(0)], records: reduce(base), wholeLog: base });
    expect(plan.ops).toEqual([]);
    expect(plan.skippedRemoved).toBe(1);
    expect(plan.trimmed).toBe(false);
  });

  it('files two keys of one contact once, and a repeated key once', () => {
    const cid = 'c'.repeat(32);
    const base: ContactOperation[] = [
      op({ action: 'add', contactId: cid, value: { type: 'person', displayName: 'Two Keys', tier: 'ken', ownerIdentityPubkey: OTHER_LIST } }),
      op({ action: 'add-identity', contactId: cid, itemId: '1'.repeat(32), value: { itemId: '1'.repeat(32), pubkey: pubkeyOf(0), provenance: 'direct', verification: 'unverified' } }),
      op({ action: 'add-identity', contactId: cid, itemId: '2'.repeat(32), value: { itemId: '2'.repeat(32), pubkey: pubkeyOf(1), provenance: 'direct', verification: 'unverified' } }),
    ];
    const plan = run({ entries: [entry(0), entry(1), entry(1)], records: reduce(base), wholeLog: base });
    expect(plan.ops.filter(o => o.action === 'link-list')).toHaveLength(1);
    expect(plan.covered).toBe(1);
  });

  it('drops a malformed key and normalises the name', () => {
    const plan = run({ entries: [{ pubkey: 'nope', displayName: 'x' }, { pubkey: pubkeyOf(3).toUpperCase(), displayName: '' }] });
    expect(plan.added).toBe(1);
    expect((plan.ops[0].value as { displayName: string }).displayName).toBe('Unnamed');
    expect((plan.ops[1].value as { pubkey: string }).pubkey).toBe(pubkeyOf(3));
  });

  it('trims to the MOST RECENT follows when the checkpoint would pass the byte line', () => {
    const all = entries(400);
    const full = run({ entries: all });
    expect(full.trimmed).toBe(false);
    const fullBytes = projectCheckpointBytes(full.ops).bytes;

    const lineBytes = Math.floor(fullBytes / 2);
    const plan = run({ entries: all, lineBytes });
    expect(plan.trimmed).toBe(true);
    expect(plan.covered).toBeGreaterThan(150);
    expect(plan.covered).toBeLessThan(250);
    expect(projectCheckpointBytes(plan.ops).bytes).toBeLessThanOrEqual(lineBytes);
    // The newest are kept: the last entry is in, the first is out.
    const keys = plan.ops.filter(o => o.action === 'add-identity').map(o => (o.value as { pubkey: string }).pubkey);
    expect(keys).toContain(pubkeyOf(399));
    expect(keys).not.toContain(pubkeyOf(0));
    expect(plan.added).toBe(plan.covered);
    // One more follow than the plan kept would have crossed the line.
    const oneMore = run({ entries: all.slice(all.length - plan.covered - 1), lineBytes });
    expect(oneMore.trimmed).toBe(true);
  });

  it('counts the rest of the log against the line, and imports nothing when it is already over', () => {
    const big = Array.from({ length: 300 }, (_, i) => op({
      action: 'add', contactId: hex(i + 1, 32), value: { type: 'person', displayName: `Old ${i}`, tier: 'ken' },
    }));
    const lineBytes = projectCheckpointBytes(big).bytes + 2000;
    const plan = run({ entries: entries(100), wholeLog: big, baseClock: 1000, lineBytes });
    expect(plan.trimmed).toBe(true);
    expect(plan.covered).toBeLessThan(10);
    const over = run({ entries: entries(100), wholeLog: big, lineBytes: 1000 });
    expect(over.ops).toEqual([]);
    expect(over.covered).toBe(0);
  });

  it('trims to the operation line as well', () => {
    const plan = run({ entries: entries(10), lineOps: 12 });
    expect(plan.trimmed).toBe(true);
    expect(plan.ops.length).toBeLessThanOrEqual(12);
    expect(plan.added).toBe(4);
  });
});

describe('projectCheckpointBytes against the real chunker', () => {
  function sample(n: number): ContactOperation[] {
    return run({ entries: entries(n), baseClock: 1_000 }).ops;
  }
  function realBytes(ops: ContactOperation[], seq: number): { bytes: number; chunks: number } {
    const checkpoint: CheckpointPayload = {
      v: 2, kind: 'checkpoint', seq, createdAt: NOW, deviceIds: ['d'.repeat(32)],
      frontier: { maxClock: 1, opIds: [] }, ops,
    };
    const split = splitCheckpoint(checkpoint, i => `tag${i}`)!;
    return {
      bytes: split.chunks.reduce((n, c) => n + new TextEncoder().encode(JSON.stringify(c)).length, 0),
      chunks: split.chunks.length,
    };
  }

  it('matches the real chunk count and total bytes exactly (several chunks)', () => {
    const ops = sample(700);                                  // ~2100 ops, several 64 KiB chunks
    const real = realBytes(ops, 12);
    const projected = projectCheckpointBytes(ops, 12);
    expect(real.chunks).toBeGreaterThan(3);
    expect(projected.chunks).toBe(real.chunks);
    expect(projected.bytes).toBe(real.bytes);
    expect(projected.fits).toBe(true);
  });

  it('matches for a small log too, and for a non-ASCII name', () => {
    const ops = [
      ...sample(5),
      ...run({ entries: [{ pubkey: pubkeyOf(900), displayName: 'Müller 🌍 — 山田' }], baseClock: 2_000 }).ops,
    ];
    const real = realBytes(ops, 3);
    const projected = projectCheckpointBytes(ops, 3);
    expect(projected).toMatchObject({ chunks: real.chunks, bytes: real.bytes });
  });

  it('reports a log the rail cannot publish as not fitting', () => {
    const huge = sample(1).map(o => ({ ...o, value: { ...(o.value as object), pad: 'x'.repeat(70_000) } }));
    expect(projectCheckpointBytes(huge).fits).toBe(false);
    expect(splitCheckpoint({
      v: 2, kind: 'checkpoint', seq: 1, createdAt: NOW, deviceIds: [], frontier: { maxClock: 1, opIds: [] }, ops: huge,
    }, i => `t${i}`)).toBeNull();
  });
});

describe('the size line', () => {
  it('is 75 % of the byte and operation budgets', () => {
    expect(CHECKPOINT_IMPORT_LINE_BYTES).toBe(1.5 * 1024 * 1024);
    expect(CHECKPOINT_IMPORT_LINE_OPS).toBe(Math.floor(MAX_CHECKPOINT_OPS * 0.75));
    expect(MAX_CHUNKS * 65_532).toBeGreaterThan(CHECKPOINT_IMPORT_LINE_BYTES);
  });

  it('measures what a follow really costs, and the cap that implies (1000 follows do NOT fit the line)', () => {
    // Names around the length real profiles have; every op carries 64-hex actor and owner keys.
    const named = Array.from({ length: 1000 }, (_, i) => ({ pubkey: pubkeyOf(i), displayName: `Contact number ${i} (display name)` }));
    const unbounded = run({ entries: named, baseClock: 5_000, lineBytes: 1e12, lineOps: 1e9 });
    expect(unbounded.ops).toHaveLength(3000);
    expect(unbounded.ops.every(o => validate(o))).toBe(true);
    const projection = projectCheckpointBytes(unbounded.ops);
    const perFollow = projection.bytes / 1000;
    // About 1.6 KB a follow (three ~550-byte operations), not the ~1 KB first assumed.
    expect(perFollow).toBeGreaterThan(1400);
    expect(perFollow).toBeLessThan(1900);
    // 1000 of them still fit the rail's true ceiling (32 chunks) ...
    expect(projection.fits).toBe(true);
    // ... but not the 1.5 MiB line, so the default import trims to roughly 900 follows.
    expect(projection.bytes).toBeGreaterThan(CHECKPOINT_IMPORT_LINE_BYTES);
    const lined = run({ entries: named, baseClock: 5_000 });
    expect(lined.trimmed).toBe(true);
    expect(lined.covered).toBeGreaterThan(800);
    expect(lined.covered).toBeLessThan(1000);
    expect(projectCheckpointBytes(lined.ops).bytes).toBeLessThanOrEqual(CHECKPOINT_IMPORT_LINE_BYTES);
  });
});
