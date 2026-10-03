import { describe, it, expect } from 'vitest';
import { nip19 } from 'nostr-tools';
import {
  CONTACT_FILTERS, filterLabel, primaryIdentityPubkey, isKeyless,
  isVisibleContact, arrangeContactsV2,
} from './contacts-v2-list';
import type { ContactIdentity, EffectiveContact } from '../types';

const PK_A = 'a'.repeat(64);
const PK_B = 'b'.repeat(64);

function identity(pubkey: string, over: Partial<ContactIdentity> = {}): ContactIdentity {
  return {
    itemId: `it-${pubkey.slice(0, 2)}`, pubkey, provenance: 'direct',
    verification: 'proven', addedAt: 1, ...over,
  };
}

function contact(over: Partial<EffectiveContact> = {}): EffectiveContact {
  return {
    directoryId: 'owner', contactId: 'c1', type: 'person', displayName: 'Dave',
    tier: 'kin', roles: [], identities: [], contactMethods: [], accessGrants: [],
    lifecycle: 'active', createdAt: 1, updatedAt: 2,
    createdByActorRole: 'owner', createdByOperationId: 'op-1',
    vouches: [], ceilings: [], blocks: [],
    effectiveTier: 'kin', tierSource: 'direct', blocked: false, blockedBy: [],
    ...over,
  };
}

describe('filters', () => {
  it('offers All, the three tiers, Not confirmed and Blocked in order', () => {
    expect(CONTACT_FILTERS).toEqual(['all', 'kin', 'kith', 'ken', 'not-confirmed', 'blocked']);
    expect(CONTACT_FILTERS.map(filterLabel)).toEqual(['All', 'Kin', 'Kith', 'Ken', 'Not confirmed', 'Blocked']);
  });
});

describe('identity helpers', () => {
  it('prefers a proven identity as the avatar key', () => {
    const record = contact({
      identities: [identity(PK_A, { verification: 'unverified', addedAt: 1 }), identity(PK_B, { addedAt: 2 })],
    });
    expect(primaryIdentityPubkey(record)).toBe(PK_B);
  });

  it('falls back to the earliest identity when none is proven', () => {
    const record = contact({
      identities: [identity(PK_B, { verification: 'unverified', addedAt: 5 }), identity(PK_A, { verification: 'unverified', addedAt: 2 })],
    });
    expect(primaryIdentityPubkey(record)).toBe(PK_A);
  });

  it('reports a keyless contact', () => {
    expect(isKeyless(contact())).toBe(true);
    expect(primaryIdentityPubkey(contact())).toBeNull();
    expect(isKeyless(contact({ identities: [identity(PK_A)] }))).toBe(false);
  });
});

describe('visibility', () => {
  it('hides removed and archived records', () => {
    expect(isVisibleContact({ lifecycle: 'active' })).toBe(true);
    expect(isVisibleContact({ lifecycle: 'removed' })).toBe(false);
    expect(isVisibleContact({ lifecycle: 'active', archived: true })).toBe(false);
  });
});

describe('arrangeContactsV2', () => {
  const dave = contact({ contactId: 'dave', displayName: 'Dave', effectiveTier: 'kin' });
  const amy = contact({ contactId: 'amy', displayName: 'Amy', effectiveTier: 'kith' });
  const shop = contact({ contactId: 'shop', displayName: 'Corner Shop', type: 'organisation', effectiveTier: 'ken' });
  const bad = contact({ contactId: 'bad', displayName: 'Blocked Bob', effectiveTier: 'kin', blocked: true });
  const gone = contact({ contactId: 'gone', displayName: 'Gone', lifecycle: 'removed' });
  const all = [dave, amy, shop, bad, gone];

  it('sorts A to Z and puts blocked contacts last under All', () => {
    const out = arrangeContactsV2(all, { filter: 'all', query: '' });
    expect(out.map(c => c.contactId)).toEqual(['amy', 'shop', 'dave', 'bad']);
  });

  it('keeps blocked contacts out of the tier filters', () => {
    expect(arrangeContactsV2(all, { filter: 'kin', query: '' }).map(c => c.contactId)).toEqual(['dave']);
  });

  it('shows only blocked contacts under Blocked', () => {
    expect(arrangeContactsV2(all, { filter: 'blocked', query: '' }).map(c => c.contactId)).toEqual(['bad']);
  });

  it('lists under Not confirmed only keyed, unblocked contacts none of whose keys is confirmed, whatever their tier', () => {
    const unconfirmedKen = contact({ contactId: 'u-ken', displayName: 'Ken One', effectiveTier: 'ken', identities: [identity(PK_A, { verification: 'unverified' })] });
    const unconfirmedKith = contact({ contactId: 'u-kith', displayName: 'Kith One', effectiveTier: 'kith', identities: [identity(PK_B, { verification: 'unverified' })] });
    const provenOne = contact({ contactId: 'proven', displayName: 'Proven', effectiveTier: 'ken', identities: [identity(PK_A, { verification: 'proven' })] });
    const mutualOne = contact({ contactId: 'mutual', displayName: 'Mutual', effectiveTier: 'kith', identities: [identity(PK_A, { verification: 'mutual' })] });
    const mixed = contact({ contactId: 'mixed', displayName: 'Mixed', effectiveTier: 'ken', identities: [identity(PK_A, { verification: 'unverified' }), identity(PK_B, { verification: 'proven' })] });
    const keyless = contact({ contactId: 'keyless', displayName: 'Keyless', effectiveTier: 'ken', identities: [] });
    const blockedUnconfirmed = contact({ contactId: 'bu', displayName: 'Blocked', effectiveTier: 'ken', blocked: true, identities: [identity(PK_A, { verification: 'unverified' })] });
    const list = [unconfirmedKen, unconfirmedKith, provenOne, mutualOne, mixed, keyless, blockedUnconfirmed];
    expect(arrangeContactsV2(list, { filter: 'not-confirmed', query: '' }).map(c => c.contactId)).toEqual(['u-ken', 'u-kith']);
  });

  it('searches name, roles and identity pubkeys', () => {
    const withRole = contact({ contactId: 'gp', displayName: 'Dr Patel', roles: ['GP'], effectiveTier: 'ken' });
    const withKey = contact({ contactId: 'keyed', displayName: 'Zed', identities: [identity(PK_A)], effectiveTier: 'ken' });
    const list = [withRole, withKey];
    expect(arrangeContactsV2(list, { filter: 'all', query: 'gp' }).map(c => c.contactId)).toEqual(['gp']);
    expect(arrangeContactsV2(list, { filter: 'all', query: PK_A.slice(0, 8) }).map(c => c.contactId)).toEqual(['keyed']);
    expect(arrangeContactsV2(list, { filter: 'all', query: '  PATEL ' }).map(c => c.contactId)).toEqual(['gp']);
  });

  it('never returns a removed record', () => {
    expect(arrangeContactsV2(all, { filter: 'all', query: 'gone' })).toEqual([]);
  });
});

describe('contacts with no real name', () => {
  const KEY = '66dd41aa' + 'b'.repeat(56);
  const nameless = () => contact({ contactId: 'n1', displayName: '66dd41aa…', identities: [identity(KEY)] });
  it('searches by the npub form as well as the hex key', () => {
    const npub = nip19.npubEncode(KEY);
    expect(arrangeContactsV2([nameless()], { filter: 'all', query: npub.slice(0, 20) })).toHaveLength(1);
    expect(arrangeContactsV2([nameless()], { filter: 'all', query: '66dd41aa' })).toHaveLength(1);
  });
  it('sorts by the name shown, not the stored hex label', () => {
    const out = arrangeContactsV2([contact({ contactId: 'z', displayName: 'Zed' }), nameless()], { filter: 'all', query: '' });
    expect(out.map(c => c.contactId)).toEqual(['n1', 'z']);
  });
});
