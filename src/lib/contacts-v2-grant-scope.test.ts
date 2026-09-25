import { describe, it, expect } from 'vitest';
import type { AppGrantV2, ContactOperation } from '../types';
import { applyOperations, validateRecord } from './contacts-v2-reducer';
import { resolveEffectiveDirectory } from './contacts-v2-effective';
import { contactsForGrant } from './contacts-v2-grant-scope';
import { applyContactProposal } from './contacts-v2-proposals';
import { buildContactProjection } from './contact-projection';

const A = 'a'.repeat(64), B = 'b'.repeat(64), KEY = 'c'.repeat(64), G = 'd'.repeat(32);
const grant = { grantId: G, directoryId: 'owner', ownerIdentityPubkey: B } as AppGrantV2;
function op(n: number, action: ContactOperation['action'], value: unknown, list?: string): ContactOperation {
  return { operationId: n.toString(16).padStart(32, '0'), contactId: 'f'.repeat(32), directoryId: 'owner',
    actorPubkey: A, actorRole: 'owner', actorDeviceId: 'e'.repeat(32), logicalClock: n, createdAt: n,
    action, value, ...(list ? { ownerIdentityPubkey: list } : {}) };
}
const original = [op(1, 'add', { type: 'person', displayName: 'Secret name', tier: 'kin', ownerIdentityPubkey: A }),
  op(2, 'add-identity', { itemId: 'a'.repeat(32), pubkey: KEY, provenance: 'direct', verification: 'mutual' }),
  op(3, 'add-method', { itemId: 'b'.repeat(32), kind: 'phone', value: 'private-old-phone', verification: 'proven', sharingPolicy: 'grantable' }),
  op(4, 'note', { note: 'private note' })];
const effective = (ops: ContactOperation[]) => resolveEffectiveDirectory([...applyOperations(ops).values()], {
  activeGuardianPubkeys: [A], defaultChildCeiling: 'ken', directoryIsDependant: false,
});
function propose(ops = original, g = G) {
  const result = applyContactProposal('owner', { pubkey: KEY, displayName: 'App supplied' }, {
    grantId: g, ownerIdentityPubkey: B, actorPubkey: A, actorDeviceId: 'e'.repeat(32), existingOps: ops, now: 5,
  });
  if (!result.ok) throw new Error(result.reason);
  return [...ops, ...result.operations];
}

describe('identity-scoped grants and app introductions', () => {
  it('fails closed for old grants, other lists and other vaults', () => {
    expect(contactsForGrant(grant, effective(original), original)).toEqual([]);
    expect(contactsForGrant({ ...grant, ownerIdentityPubkey: undefined }, effective(original), original)).toEqual([]);
    expect(contactsForGrant({ ...grant, ownerIdentityPubkey: A, directoryId: `dependant:${A}` }, effective(original), original)).toEqual([]);
  });
  it('requires review without duplicating or overwriting the canonical contact', () => {
    const ops = propose();
    const records = [...applyOperations(ops).values()];
    expect(records).toHaveLength(1);
    expect(records[0].displayName).toBe('Secret name');
    expect(records[0].appIntroductions?.[0].status).toBe('pending');
    expect(validateRecord(records[0])).toBe(true);
    expect(contactsForGrant(grant, effective(ops), ops)).toEqual([]);
    const rejected = [...ops, op(10, 'review-app-list', { grantId: G, accept: false })];
    expect(contactsForGrant(grant, effective(rejected), rejected)).toEqual([]);
  });
  it('confirmation cannot expose existing fields even with every relevant capability', () => {
    const ops = [...propose(), op(10, 'review-app-list', { grantId: G, accept: true })];
    const contacts = contactsForGrant(grant, effective(ops), ops);
    expect(contacts[0]).toMatchObject({ displayName: 'App supplied', tier: 'ken', contactMethods: [] });
    const projection = buildContactProjection({ grantId: G, contacts,
      capabilities: ['signet.contacts.read:directory', 'signet.contacts.read:tier', 'signet.contacts.read:checks', 'signet.contacts.read:method:phone'],
      frontier: { maxClock: 0, opCount: 0, deviceId: G, publishedAt: 1 }, issuedAt: 1, maxStalenessSeconds: 3600, appLabels: {},
    });
    const text = JSON.stringify(projection);
    for (const secret of ['Secret name', 'private-old-phone', 'private note', 'mutual', A, B]) expect(text).not.toContain(secret);
  });
  it('only shares subsequent user edits under the app identity; updates cannot import an old method', () => {
    const ops = [...propose(), op(10, 'review-app-list', { grantId: G, accept: true }),
      op(11, 'rename', { displayName: 'Other list name' }, A),
      op(12, 'update-method', { itemId: 'b'.repeat(32), value: 'old method edited' }, B),
      op(13, 'add-method', { itemId: 'c'.repeat(32), kind: 'email', value: 'new@example.org', verification: 'unverified', sharingPolicy: 'grantable' }, B),
      op(14, 'rename', { displayName: 'Unscoped edit' })];
    const copy = contactsForGrant(grant, effective(ops), ops)[0];
    expect(copy.displayName).toBe('App supplied');
    expect(copy.contactMethods.map(m => m.value)).toEqual(['new@example.org']);
  });
  it('another app cannot bypass restrictions by proposing the already linked key', () => {
    const accepted = [...propose(), op(10, 'review-app-list', { grantId: G, accept: true })];
    const otherGrant = { ...grant, grantId: '9'.repeat(32) };
    const ops = propose(accepted, otherGrant.grantId);
    const copy = contactsForGrant(otherGrant, effective(ops), ops)[0];
    expect(copy.displayName).toBe('App supplied');
    expect(copy.contactMethods).toEqual([]);
    expect(copy.identities[0].verification).toBe('unverified');
  });
  it('keeps a removed blocked key only for lists that held it', () => {
    const ops = [...original, op(6, 'block', { scope: { kind: 'contact' } }), op(7, 'remove', {})];
    expect(contactsForGrant({ ...grant, ownerIdentityPubkey: A }, effective(ops), ops)).toHaveLength(1);
    expect(contactsForGrant(grant, effective(ops), ops)).toEqual([]);
  });
});

it('a privacy withdrawal made from another list still removes a previously shared method', () => {
  const ops = [...propose(), op(10, 'review-app-list', { grantId: G, accept: true }),
    op(11, 'add-method', { itemId: 'c'.repeat(32), kind: 'phone', value: 'new phone', verification: 'unverified', sharingPolicy: 'grantable' }, B),
    op(12, 'update-method', { itemId: 'c'.repeat(32), sharingPolicy: 'private' }, A)];
  expect(contactsForGrant(grant, effective(ops), ops)[0].contactMethods[0].sharingPolicy).toBe('private');
});

it('a human can classify an app-added contact; the app itself cannot set a stronger tier', () => {
  const ops = propose([]);
  const record = [...applyOperations(ops).values()][0];
  const edited = [...ops, { ...op(10, 'set-tier', { tier: 'kin' }, B), contactId: record.contactId }];
  expect(effective(ops)[0].effectiveTier).toBe('ken');
  expect(effective(edited)[0].effectiveTier).toBe('kin');
  expect(contactsForGrant(grant, effective(edited), edited)[0].effectiveTier).toBe('kin');
});

it('keeps check records scoped to the consenting identity even for ordinary linked contacts', () => {
  const ops = [...original, op(10, 'link-list', { ownerIdentityPubkey: B }),
    op(11, 'record-check', { id: '1'.repeat(32), identityPubkey: KEY, ownerIdentityPubkey: A, method: 'words', checkedAt: 1000, evidence: 'only A' }, A),
    op(12, 'record-check', { id: '2'.repeat(32), identityPubkey: KEY, ownerIdentityPubkey: B, method: 'in-person', checkedAt: 2000 }, B)];
  expect(contactsForGrant(grant, effective(ops), ops)[0].checks?.map(c => c.method)).toEqual(['in-person']);
  expect(contactsForGrant({ ...grant, ownerIdentityPubkey: A }, effective(ops), ops)[0].checks?.map(c => c.method)).toEqual(['words']);
});
