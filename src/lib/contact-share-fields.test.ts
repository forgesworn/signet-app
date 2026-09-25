import { describe, expect, it } from 'vitest';
import type { EffectiveContact } from '../types';
import { contactVCard, defaultShareFields } from './contact-share-fields';
import { planShare } from './contacts-v2-family-ops';

const contact: EffectiveContact = {
  directoryId: 'owner', contactId: 'a'.repeat(32), displayName: 'Sam', type: 'person', tier: 'kin', roles: ['Neighbour'], notes: 'Owner note',
  primaryIdentityPubkey: 'b'.repeat(64), listMemberships: [{ ownerIdentityPubkey: 'b'.repeat(64), addedAt: 1 }],
  identities: [{ itemId: 'c'.repeat(32), pubkey: 'd'.repeat(64), provenance: 'direct', verification: 'mutual', addedAt: 1,
    direct: { ownerPubkey: 'b'.repeat(64), verifiedAt: 1, sharedSecret: 'NEVER-SHARE', bondAssertion: { private: 'EVIDENCE' } } }],
  contactMethods: [
    { itemId: 'e'.repeat(32), kind: 'phone', value: '+44 123', sharingPolicy: 'private', verification: 'proven', addedAt: 1 },
    { itemId: 'f'.repeat(32), kind: 'email', value: 'sam@example.org', sharingPolicy: 'grantable', verification: 'unverified', addedAt: 1 },
  ],
  lifecycle: 'active', createdAt: 1, updatedAt: 1, createdByActorRole: 'owner', createdByOperationId: '0'.repeat(32),
  accessGrants: [], blocks: [], ceilings: [], vouches: [], blocked: false, blockedBy: [], effectiveTier: 'kin', tierSource: 'direct',
};

describe('selected-field sharing', () => {
  it('defaults to name and keys for people, adding only phone for dependants', () => {
    const people = defaultShareFields(contact), child = defaultShareFields(contact, true);
    expect(people.methods).toEqual([]);
    expect(child.methods).toEqual(['e'.repeat(32)]);
    const card = contactVCard(contact, people).replace(/\r\n /g, '');
    expect(card).toContain('FN:Sam\r\nIMPP:nostr:npub1');
    for (const hidden of ['+44', 'sam@example', 'Owner note', 'Neighbour', 'NEVER-SHARE', 'EVIDENCE', 'b'.repeat(64)]) expect(card).not.toContain(hidden);
  });
  it('exports selected methods and notes but never evidence or owning-list metadata', () => {
    const fields = { ...defaultShareFields(contact), methods: ['f'.repeat(32)], notes: true, checks: true };
    const card = contactVCard(contact, fields).replace(/\r\n /g, '');
    expect(card).toContain('EMAIL:sam@example.org');
    expect(card).toContain('NOTE:Owner note');
    expect(card).toContain('mutual');
    for (const hidden of ['+44', 'NEVER-SHARE', 'EVIDENCE', 'b'.repeat(64)]) expect(card).not.toContain(hidden);
  });
  it('escapes property injection and folds UTF-8 without splitting characters', () => {
    const record = { ...contact, displayName: '😀'.repeat(40) + '\r\nNOTE:injected,;\\' };
    const card = contactVCard(record, defaultShareFields(record));
    expect(card).not.toContain('\r\nNOTE:injected');
    expect(card.replace(/\r\n /g, '')).toContain('\\nNOTE:injected\\,\\;\\\\');
    for (const line of card.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
  });
  it('copies only selected family fields, with checks attributed and no cross-vault source link', () => {
    const fields = { ...defaultShareFields(contact, true), name: false, tier: true, checks: true, notes: true };
    const plan = planShare({ source: contact, fields, guardianPubkey: 'b'.repeat(64),
      targets: [{ directoryId: `dependant:${'9'.repeat(64)}`, label: 'Child', contactId: null, ownerIdentityPubkey: '8'.repeat(64) }] });
    const step = plan.steps[0];
    expect(step.add).toMatchObject({ displayName: 'Shared contact', tier: 'ken', ownerIdentityPubkey: '8'.repeat(64) });
    expect(step.methods?.map(m => m.value)).toEqual(['+44 123']);
    expect(step.identities[0].verification).toBe('unverified');
    expect(step.context).toMatchObject({ guardianPubkey: 'b'.repeat(64), tier: 'kin', checks: [{ pubkey: 'd'.repeat(64), verification: 'mutual', verifiedAt: 1 }] });
    expect(step.note).toBe('Owner note');
    expect(JSON.stringify(step)).not.toContain('NEVER-SHARE');
    expect(JSON.stringify(step)).not.toContain(contact.contactId);
  });
});
it('exports check methods and dates only when selected, without private sources or evidence', () => {
  const checked = { ...contact, checks: [{ id: 'a'.repeat(32), identityPubkey: 'd'.repeat(64), ownerIdentityPubkey: 'b'.repeat(64),
    method: 'words' as const, checkedAt: 123000, source: 'website' as const, evidence: 'private-check-url' }] };
  expect(contactVCard(checked, defaultShareFields(checked))).not.toContain('CHECK-METHOD');
  const card = contactVCard(checked, { ...defaultShareFields(checked), checks: true }).replace(/\r\n /g, '');
  expect(card).toContain(';words;123000');
  expect(card).not.toContain('private-check-url');
  expect(card).not.toContain('website');
});
