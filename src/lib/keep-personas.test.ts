import { describe, expect, it } from 'vitest';
import { getPublicKey } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { EffectiveContact, SignetIdentity } from '../types';
import { accountPersonas, holdsKeyFor, inviteCandidates, keepDepsFor, localBackendFor, personaNameMap, shouldPromptUnlockForMyKeep } from './keep-personas';

const sk = (n: number) => '0'.repeat(63) + n.toString(16);
const pk = (n: number) => bytesToHex(hexToBytes(getPublicKey(hexToBytes(sk(n)))));
const identity = (over: Partial<SignetIdentity> = {}): SignetIdentity => ({
  id: pk(1), mnemonic: '', primaryKeypair: 'persona', isChild: false, createdAt: 1,
  naturalPerson: { publicKey: pk(1), privateKey: sk(1), displayName: 'Real me' },
  persona: { publicKey: pk(2), privateKey: sk(2), displayName: 'Anon' },
  ...over,
}) as SignetIdentity;

describe('localBackendFor', () => {
  it('signs as a persona whose key is held', () => {
    expect(localBackendFor(identity(), pk(2))?.activePublicKeyHex).toBe(pk(2));
    expect(holdsKeyFor(identity(), pk(2))).toBe(true);
  });
  it('finds extra personas too', () => {
    const id = identity({ extraPersonas: [{ publicKey: pk(3), privateKey: sk(3), displayName: 'Work', derivationName: 'persona-2' }] as never });
    expect(localBackendFor(id, pk(3))?.activePublicKeyHex).toBe(pk(3));
  });
  it('returns null for a persona with no local key (bunker or Heartwood)', () => {
    const id = identity({ persona: { publicKey: pk(2), privateKey: '', displayName: 'Anon' } });
    expect(localBackendFor(id, pk(2))).toBeNull();
    expect(holdsKeyFor(id, pk(2))).toBe(false);
  });
  it('returns null for a key that does not belong to the identity or does not match', () => {
    expect(localBackendFor(identity(), pk(9))).toBeNull();
    const wrong = identity({ persona: { publicKey: pk(2), privateKey: sk(5), displayName: 'Anon' } });
    expect(localBackendFor(wrong, pk(2))).toBeNull();
  });
  it('returns null while the identity is still encrypted', () => {
    expect(localBackendFor(identity({ encrypted: true }), pk(2))).toBeNull();
  });
});

describe('personaNameMap', () => {
  it('names the personas by the name the person gave them', () => {
    expect(personaNameMap(identity())[pk(2)]).toBe('Anon');
  });
});

describe('accountPersonas (what an All-my-personas Keep links)', () => {
  const extra = { publicKey: pk(3), privateKey: sk(3), displayName: 'Work', derivationName: 'persona-2' };

  it('lists the persona and the extra personas, and the real-name persona only once activated', () => {
    const dormant = identity({ extraPersonas: [extra] as never, naturalPersonActive: false });
    expect(accountPersonas(dormant).map(p => p.pubkey)).toEqual([pk(2), pk(3)]);
    const active = identity({ extraPersonas: [extra] as never, naturalPersonActive: true });
    expect(accountPersonas(active).map(p => p.pubkey)).toEqual([pk(2), pk(3), pk(1)]);
  });

  it('includes the professional persona', () => {
    const id = identity({ professionalPersona: { publicKey: pk(4), privateKey: sk(4), displayName: 'Pro' } as never });
    expect(accountPersonas(id).map(p => p.pubkey)).toContain(pk(4));
  });

  it('never lists a dependant\'s personas: they are separate records', () => {
    const id = identity({ extraPersonas: [extra] as never });
    expect(accountPersonas(id).map(p => p.pubkey)).not.toContain(pk(9));
    expect(accountPersonas(null)).toEqual([]);
  });

  it('says which personas this device can sign for; a bunker persona cannot be linked', () => {
    const id = identity({ extraPersonas: [{ ...extra, privateKey: '' }] as never, naturalPersonActive: false });
    expect(accountPersonas(id)).toEqual([
      { pubkey: pk(2), name: 'Anon', canSign: true },
      { pubkey: pk(3), name: 'Work', canSign: false },
    ]);
    expect(keepDepsFor(id, 'k').eligiblePersonas!()).toEqual([pk(2)]);
    expect(keepDepsFor(id, 'k').backendFor(pk(3))).toBeNull();
    expect(keepDepsFor(id, 'k').personaName!(pk(2))).toBe('Anon');
  });
});

describe('inviteCandidates', () => {
  const OWNER = pk(2);
  const friend = pk(7);
  const contact = (o: Partial<EffectiveContact> = {}): EffectiveContact => ({
    directoryId: 'owner', contactId: 'c', type: 'person', displayName: 'Dave', tier: 'kin', roles: [],
    identities: [{ itemId: 'i', pubkey: friend, provenance: 'direct', verification: 'proven', addedAt: 1 }],
    contactMethods: [], accessGrants: [], lifecycle: 'active', createdAt: 1, updatedAt: 1,
    createdByActorRole: 'owner', createdByOperationId: 'o', vouches: [], ceilings: [], blocks: [],
    listMemberships: [{ ownerIdentityPubkey: OWNER, addedAt: 1 }],
    effectiveTier: 'kin', tierSource: 'direct', blocked: false, blockedBy: [], ...o,
  });

  it('offers Kin and Kith on the owner persona\'s list, with the contact\'s persona key', () => {
    const out = inviteCandidates([contact(), contact({ contactId: 'a', displayName: 'Amy', effectiveTier: 'kith' })], OWNER);
    expect(out).toEqual([
      { contactId: 'a', name: 'Amy', tier: 'kith', persona: friend },
      { contactId: 'c', name: 'Dave', tier: 'kin', persona: friend },
    ]);
  });
  it('leaves out Ken, blocked, removed, keyless and other personas\' contacts', () => {
    const out = inviteCandidates([
      contact({ contactId: 'ken', effectiveTier: 'ken' }),
      contact({ contactId: 'blocked', blocked: true }),
      contact({ contactId: 'gone', lifecycle: 'removed' }),
      contact({ contactId: 'archived', archived: true }),
      contact({ contactId: 'keyless', identities: [] }),
      contact({ contactId: 'other', listMemberships: [{ ownerIdentityPubkey: pk(8), addedAt: 1 }] }),
      contact({ contactId: 'unlisted', listMemberships: undefined }),
      contact({ contactId: 'self', identities: [{ itemId: 'i', pubkey: OWNER, provenance: 'direct', verification: 'proven', addedAt: 1 }] }),
    ], OWNER);
    expect(out).toEqual([]);
  });
  it('takes the first persona listed when a contact has several', () => {
    const second = pk(8);
    const out = inviteCandidates([contact({
      identities: [
        { itemId: 'i1', pubkey: friend, provenance: 'direct', verification: 'unverified', addedAt: 9 },
        { itemId: 'i2', pubkey: second, provenance: 'direct', verification: 'mutual', addedAt: 1 },
      ],
    })], OWNER);
    expect(out[0].persona).toBe(friend);
  });
});

describe('shouldPromptUnlockForMyKeep', () => {
  const base = {
    onMyKeep: true, loading: false, hasIdentity: true, pairedChild: false, authSetUp: true,
    unlocked: false, promptOpen: false, alreadyAsked: false,
  };
  it('asks for the PIN when My Keep is opened on a locked app', () => {
    expect(shouldPromptUnlockForMyKeep(base)).toBe(true);
  });
  it('waits for the identity and preferences to load', () => {
    expect(shouldPromptUnlockForMyKeep({ ...base, loading: true })).toBe(false);
    expect(shouldPromptUnlockForMyKeep({ ...base, hasIdentity: false })).toBe(false);
  });
  it('does not ask elsewhere, when unlocked, when a prompt is open, or after a cancel', () => {
    expect(shouldPromptUnlockForMyKeep({ ...base, onMyKeep: false })).toBe(false);
    expect(shouldPromptUnlockForMyKeep({ ...base, unlocked: true })).toBe(false);
    expect(shouldPromptUnlockForMyKeep({ ...base, promptOpen: true })).toBe(false);
    expect(shouldPromptUnlockForMyKeep({ ...base, alreadyAsked: true })).toBe(false);
  });
  it('does not ask a paired child, or where no PIN is set up', () => {
    expect(shouldPromptUnlockForMyKeep({ ...base, pairedChild: true })).toBe(false);
    expect(shouldPromptUnlockForMyKeep({ ...base, authSetUp: false })).toBe(false);
  });
});
