import { expect, it } from 'vitest';
import { contactInviteDecision } from './contact-invite-policy';
import type { ChildSettings, ContactRecord } from '../types';
const child = '1'.repeat(64), guardian = '2'.repeat(64), peer = '3'.repeat(64);
const directoryId = `dependant:${child}`;
const context = { directoryId, activeGuardianPubkeys: [guardian] };
const settings = (contactPolicy: ChildSettings['contactPolicy']): ChildSettings => ({ childPubkey: child, guardianPubkey: guardian, contactPolicy });
const record = (over: Partial<ContactRecord> = {}): ContactRecord => ({ directoryId, contactId: 'a'.repeat(32), type: 'person', displayName: 'Friend', tier: 'kin', roles: [],
  identities: [{ itemId: 'b'.repeat(32), pubkey: peer, provenance: 'direct', verification: 'unverified', addedAt: 1 }], contactMethods: [], accessGrants: [], lifecycle: 'active',
  createdAt: 1, updatedAt: 1, createdByActorRole: 'guardian', createdByOperationId: 'c'.repeat(32), vouches: [], ceilings: [], blocks: [], ...over });
it('defaults to effective Kin and cannot be widened by a dependant calling someone Kin', () => {
  expect(contactInviteDecision(peer, [], context)).toBe('deny');
  expect(contactInviteDecision(peer, [record()], context)).toBe('allow');
  expect(contactInviteDecision(peer, [record({ createdByActorRole: 'dependant' })], context)).toBe('deny');
  expect(contactInviteDecision(peer, [record({ lifecycle: 'removed' })], context)).toBe('deny');
});
it('keeps unapproved requests for guardian review, while open admits an unblocked stranger', () => {
  expect(contactInviteDecision(peer, [], { ...context, settings: settings('approved') })).toBe('guardian-review');
  expect(contactInviteDecision(peer, [], { ...context, settings: { ...settings('approved'), approvedContacts: [peer] } })).toBe('allow');
  expect(contactInviteDecision(peer, [], { ...context, settings: settings('open') })).toBe('allow');
});
it('never allows a settings row for another dependant or departed guardian to widen access', () => {
  for (const row of [{ ...settings('open'), childPubkey: peer }, { ...settings('open'), guardianPubkey: peer }]) {
    expect(contactInviteDecision(peer, [], { ...context, settings: row })).toBe('deny');
    expect(contactInviteDecision(peer, [record({ createdByActorRole: 'dependant' })], { ...context, settings: { ...row, defaultChildCeiling: 'kin' } })).toBe('deny');
  }
});
it('lets a block win even for approved contacts and even after the blocking guardian departs', () => {
  const blocked = record({ blocks: [{ blockedBy: guardian, scope: { kind: 'contact' }, blockedAt: 1, operationId: 'e'.repeat(32) }] });
  expect(contactInviteDecision(peer, [blocked], { ...context, activeGuardianPubkeys: [], settings: settings('open') })).toBe('deny');
  expect(contactInviteDecision(peer, [blocked], { ...context, settings: { ...settings('approved'), approvedContacts: [peer] } })).toBe('deny');
});

it('never uses a contact from another directory as family permission', () => {
  expect(contactInviteDecision(peer, [record({ directoryId: 'owner' })], context)).toBe('deny');
});
