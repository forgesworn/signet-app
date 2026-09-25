import { describe, it, expect } from 'vitest';
import { stripIdentityKeys, stripDependantKeys, clearMigratedKeyReferences } from './heartwood-strip';
import type { SignetIdentity } from '../types/identity';
import type { DependantIdentity } from '../types/dependants';

const NP_PUBKEY = 'aaaa00000000000000000000000000000000000000000000000000000000aaaa';
const PERSONA_PUBKEY = 'bbbb00000000000000000000000000000000000000000000000000000000bbbb';
const PRO_PUBKEY = 'cccc00000000000000000000000000000000000000000000000000000000cccc';
const P1 = 'dddd00000000000000000000000000000000000000000000000000000000dddd'; // hidden tree-derived extra
const P2 = 'eeee00000000000000000000000000000000000000000000000000000000eeee'; // imported extra
const P3 = 'ffff00000000000000000000000000000000000000000000000000000000ffff'; // mirror extra
const D1 = '11110000000000000000000000000000000000000000000000000000000011a1'; // dep NP
const D2 = '22220000000000000000000000000000000000000000000000000000000022b2'; // dep persona
const D3 = '33330000000000000000000000000000000000000000000000000000000033c3'; // dep extra (tree-derived)
const D4 = '44440000000000000000000000000000000000000000000000000000000044d4'; // dep imported extra

// Full token set for an identity with NP + persona + pro + the hidden
// tree-derived extra (token === derivationName === 'persona-2').
const FULL_IDENTITY_TOKENS = new Set(['natural-person', 'persona', 'professional', 'persona-2']);

// Full token set for the standard dependant fixture below.
const FULL_DEP_TOKENS = new Set(['dependant-0-np', 'dependant-0-persona', 'dependant-0-persona-1']);

describe('post-commit memory cleanup', () => {
  it('clears secrets in previously retained nested references while preserving unrelated secrets', () => {
    const identity = makeIdentity();
    const retained = { identity, np: identity.naturalPerson, pro: identity.professionalPersona!, extra: identity.extraPersonas![0] };
    const importedKey = identity.extraPersonas![1].privateKey;
    const removed = clearMigratedKeyReferences(identity, [], FULL_IDENTITY_TOKENS);
    expect(retained.identity.mnemonic).toBe('');
    expect(retained.np.privateKey).toBe('');
    expect(retained.pro.privateKey).toBe('');
    expect(retained.extra.privateKey).toBe('');
    expect(retained.np.avatarKey).toBe('np-avatar-key');
    expect(identity.extraPersonas![1].privateKey).toBe(importedKey);
    expect(removed.has(NP_PUBKEY)).toBe(true);
    expect(removed.has(P2)).toBe(false);
  });

  it('keeps unverified slots and an unverified mnemonic available', () => {
    const identity = makeIdentity();
    const original = structuredClone(identity);
    clearMigratedKeyReferences(identity, [], new Set());
    expect(identity).toEqual(original);
    clearMigratedKeyReferences(identity, [], new Set(['natural-person']));
    expect(identity.mnemonic).toBe('');
    expect(identity.persona.privateKey).toBe(original.persona.privateKey);
    expect(identity.professionalPersona?.privateKey).toBe(original.professionalPersona?.privateKey);
  });

  it('clears verified dependant references without deleting unverified or transport keys', () => {
    const identity = makeIdentity();
    const dep = makeDependant();
    const original = structuredClone(dep);
    const np = dep.naturalPerson;
    const removed = clearMigratedKeyReferences(identity, [dep], new Set(['dependant-0-np']));
    expect(np.privateKey).toBe('');
    expect(dep.persona.privateKey).toBe(original.persona.privateKey);
    expect(dep.bunkerEndpoint).toEqual(original.bunkerEndpoint);
    expect(dep.appBunkerEndpoint).toEqual(original.appBunkerEndpoint);
    expect(removed.has(dep.naturalPerson.publicKey)).toBe(true);
    expect(removed.has(dep.persona.publicKey)).toBe(false);
  });
});

function makeIdentity(overrides: Partial<SignetIdentity> = {}): SignetIdentity {
  return {
    id: NP_PUBKEY,
    mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    naturalPerson: {
      publicKey: NP_PUBKEY,
      privateKey: 'np-priv',
      displayName: 'Alex',
      avatarKey: 'np-avatar-key',
    },
    persona: {
      publicKey: PERSONA_PUBKEY,
      privateKey: 'persona-priv',
      displayName: 'Anon persona',
      contactAvatarKey: 'persona-contact-key',
    },
    professionalPersona: {
      publicKey: PRO_PUBKEY,
      privateKey: 'pro-priv',
      displayName: 'Alex (Pro)',
    },
    extraPersonas: [
      { derivationName: 'persona-2', publicKey: P1, privateKey: 'p1-priv', displayName: 'Hidden Extra', hidden: true },
      { derivationName: '', imported: true, publicKey: P2, privateKey: 'p2-priv', displayName: 'Imported Extra' },
      { derivationName: '', publicKey: P3, privateKey: 'p3-priv', displayName: 'Mirror Extra' },
    ],
    primaryKeypair: 'natural-person',
    isChild: false,
    createdAt: 1,
    encrypted: true,
    backedUp: true,
    ...overrides,
  };
}

function makeDependant(overrides: Partial<DependantIdentity> = {}): DependantIdentity {
  return {
    id: D1,
    guardianPubkey: NP_PUBKEY,
    displayName: 'Robin',
    naturalPerson: { publicKey: D1, privateKey: 'd1-np-priv', displayName: 'Robin', avatarKey: 'd1-avatar-key' },
    persona: { publicKey: D2, privateKey: 'd1-persona-priv', displayName: 'Robin Persona' },
    extraPersonas: [
      { derivationName: 'dependant-0-persona-1', publicKey: D3, privateKey: 'd1-extra-priv', displayName: 'Robin Extra' },
      { derivationName: '', imported: true, publicKey: D4, privateKey: 'd1-imported-extra-priv', displayName: 'Robin Imported Extra' },
    ],
    derivationPath: 'dependant-0',
    createdAt: 1,
    autonomyStage: 'full-control',
    primaryKeypair: 'natural-person',
    bunkerEndpoint: {
      publicKey: 'bunker-pub',
      privateKey: 'bunker-priv',
      createdAt: 1,
    },
    appBunkerEndpoint: {
      publicKey: 'app-bunker-pub',
      privateKey: 'app-bunker-priv',
      createdAt: 1,
      pairings: [],
    },
    ...overrides,
  };
}

describe('stripIdentityKeys', () => {
  it('clears the mnemonic when at least one token verified', () => {
    const identity = makeIdentity();
    const stripped = stripIdentityKeys(identity, FULL_IDENTITY_TOKENS);
    expect(stripped.mnemonic).toBe('');
  });

  it('clears NP and persona private keys but keeps everything else (full token set)', () => {
    const identity = makeIdentity();
    const stripped = stripIdentityKeys(identity, FULL_IDENTITY_TOKENS);
    expect(stripped.naturalPerson.privateKey).toBe('');
    expect(stripped.naturalPerson.publicKey).toBe(NP_PUBKEY);
    expect(stripped.naturalPerson.displayName).toBe('Alex');
    expect(stripped.naturalPerson.avatarKey).toBe('np-avatar-key');
    expect(stripped.persona.privateKey).toBe('');
    expect(stripped.persona.publicKey).toBe(PERSONA_PUBKEY);
    expect(stripped.persona.contactAvatarKey).toBe('persona-contact-key');
  });

  it('clears professionalPersona.privateKey when its token verified, keeps publicKey', () => {
    const identity = makeIdentity();
    const stripped = stripIdentityKeys(identity, FULL_IDENTITY_TOKENS);
    expect(stripped.professionalPersona?.privateKey).toBe('');
    expect(stripped.professionalPersona?.publicKey).toBe(PRO_PUBKEY);
    expect(stripped.professionalPersona?.displayName).toBe('Alex (Pro)');
  });

  it('leaves professionalPersona absent when the identity has none', () => {
    const identity = makeIdentity({ professionalPersona: undefined });
    const stripped = stripIdentityKeys(identity, FULL_IDENTITY_TOKENS);
    expect(stripped.professionalPersona).toBeUndefined();
  });

  it('strips tree-derived extra persona keys whose token verified (derivationName !== "")', () => {
    const identity = makeIdentity();
    const stripped = stripIdentityKeys(identity, FULL_IDENTITY_TOKENS);
    const hidden = stripped.extraPersonas?.find((e) => e.publicKey === P1);
    expect(hidden?.privateKey).toBe('');
    expect(hidden?.displayName).toBe('Hidden Extra');
    expect(hidden?.hidden).toBe(true);
  });

  it('keeps imported extra persona keys unchanged (imported === true) even with a full token set', () => {
    const identity = makeIdentity();
    const stripped = stripIdentityKeys(identity, FULL_IDENTITY_TOKENS);
    const imported = stripped.extraPersonas?.find((e) => e.publicKey === P2);
    expect(imported?.privateKey).toBe('p2-priv');
    expect(imported).toEqual(identity.extraPersonas?.[1]);
  });

  it('keeps mirror extra persona keys unchanged (both derivationName and imported empty)', () => {
    const identity = makeIdentity();
    const stripped = stripIdentityKeys(identity, FULL_IDENTITY_TOKENS);
    const mirror = stripped.extraPersonas?.find((e) => e.publicKey === P3);
    expect(mirror?.privateKey).toBe('p3-priv');
    expect(mirror).toEqual(identity.extraPersonas?.[2]);
  });

  it('is pure — does not mutate the input identity', () => {
    const identity = makeIdentity();
    const snapshot = JSON.parse(JSON.stringify(identity));
    stripIdentityKeys(identity, FULL_IDENTITY_TOKENS);
    expect(identity).toEqual(snapshot);
  });

  it('preserves all non-key top-level fields byte-for-byte', () => {
    const identity = makeIdentity();
    const stripped = stripIdentityKeys(identity, FULL_IDENTITY_TOKENS);
    expect(stripped.id).toBe(identity.id);
    expect(stripped.primaryKeypair).toBe(identity.primaryKeypair);
    expect(stripped.isChild).toBe(identity.isChild);
    expect(stripped.createdAt).toBe(identity.createdAt);
    expect(stripped.encrypted).toBe(identity.encrypted);
    expect(stripped.backedUp).toBe(identity.backedUp);
  });

  it('keeps a slot whose token is absent from a partial verified set (persona not verified)', () => {
    const identity = makeIdentity();
    const stripped = stripIdentityKeys(identity, new Set(['natural-person']));
    expect(stripped.naturalPerson.privateKey).toBe('');
    expect(stripped.persona.privateKey).toBe('persona-priv');
    expect(stripped.persona).toEqual(identity.persona);
    expect(stripped.professionalPersona?.privateKey).toBe('pro-priv');
    expect(stripped.professionalPersona).toEqual(identity.professionalPersona);
    const hidden = stripped.extraPersonas?.find((e) => e.publicKey === P1);
    expect(hidden?.privateKey).toBe('p1-priv');
  });

  it('keeps a tree-derived extra whose own token is absent even when other tokens verified', () => {
    const identity = makeIdentity();
    const stripped = stripIdentityKeys(
      identity,
      new Set(['natural-person', 'persona', 'professional']), // 'persona-2' deliberately excluded
    );
    const hidden = stripped.extraPersonas?.find((e) => e.publicKey === P1);
    expect(hidden?.privateKey).toBe('p1-priv');
    expect(hidden).toEqual(identity.extraPersonas?.[0]);
  });

  it('leaves the identity completely unchanged, including the mnemonic, for an empty verified set', () => {
    const identity = makeIdentity();
    const snapshot = JSON.parse(JSON.stringify(identity));
    const stripped = stripIdentityKeys(identity, new Set());
    expect(stripped).toEqual(snapshot);
    expect(stripped.mnemonic).toBe(snapshot.mnemonic);
    expect(stripped.mnemonic).not.toBe('');
  });
});

describe('stripDependantKeys', () => {
  it('returns null for a dependant whose derivationPath does not match dependant-N (imported)', () => {
    const dep = makeDependant({ derivationPath: 'imported-abc12345' });
    expect(stripDependantKeys(dep, FULL_DEP_TOKENS)).toBeNull();
  });

  it('clears NP and persona private keys for a tree-derived dependant (full token set)', () => {
    const dep = makeDependant();
    const stripped = stripDependantKeys(dep, FULL_DEP_TOKENS);
    expect(stripped).not.toBeNull();
    expect(stripped?.naturalPerson.privateKey).toBe('');
    expect(stripped?.naturalPerson.publicKey).toBe(D1);
    expect(stripped?.naturalPerson.avatarKey).toBe('d1-avatar-key');
    expect(stripped?.persona.privateKey).toBe('');
    expect(stripped?.persona.publicKey).toBe(D2);
  });

  it('strips tree-derived extra persona keys, keeps imported extra persona keys', () => {
    const dep = makeDependant();
    const stripped = stripDependantKeys(dep, FULL_DEP_TOKENS);
    const treeExtra = stripped?.extraPersonas?.find((e) => e.publicKey === D3);
    const importedExtra = stripped?.extraPersonas?.find((e) => e.publicKey === D4);
    expect(treeExtra?.privateKey).toBe('');
    expect(importedExtra?.privateKey).toBe('d1-imported-extra-priv');
    expect(importedExtra).toEqual(dep.extraPersonas?.[1]);
  });

  it('leaves bunkerEndpoint and appBunkerEndpoint untouched (transport keys survive)', () => {
    const dep = makeDependant();
    const stripped = stripDependantKeys(dep, FULL_DEP_TOKENS);
    expect(stripped?.bunkerEndpoint).toEqual(dep.bunkerEndpoint);
    expect(stripped?.appBunkerEndpoint).toEqual(dep.appBunkerEndpoint);
  });

  it('is pure — does not mutate the input dependant', () => {
    const dep = makeDependant();
    const snapshot = JSON.parse(JSON.stringify(dep));
    stripDependantKeys(dep, FULL_DEP_TOKENS);
    expect(dep).toEqual(snapshot);
  });

  it('preserves all non-key top-level fields byte-for-byte', () => {
    const dep = makeDependant();
    const stripped = stripDependantKeys(dep, FULL_DEP_TOKENS);
    expect(stripped?.id).toBe(dep.id);
    expect(stripped?.guardianPubkey).toBe(dep.guardianPubkey);
    expect(stripped?.displayName).toBe(dep.displayName);
    expect(stripped?.derivationPath).toBe(dep.derivationPath);
    expect(stripped?.autonomyStage).toBe(dep.autonomyStage);
    expect(stripped?.primaryKeypair).toBe(dep.primaryKeypair);
  });

  it('returns null and leaves the record untouched for a dependant with no extraPersonas but an imported path', () => {
    const dep = makeDependant({ derivationPath: 'imported-xyz', extraPersonas: undefined });
    const snapshot = JSON.parse(JSON.stringify(dep));
    const result = stripDependantKeys(dep, FULL_DEP_TOKENS);
    expect(result).toBeNull();
    expect(dep).toEqual(snapshot);
  });

  it('returns null when the dependant is tree-derived but none of its tokens are in the verified set', () => {
    const dep = makeDependant();
    const snapshot = JSON.parse(JSON.stringify(dep));
    const result = stripDependantKeys(dep, new Set(['dependant-1-np', 'natural-person']));
    expect(result).toBeNull();
    expect(dep).toEqual(snapshot);
  });

  it('returns null for an empty verified set even though the dependant is tree-derived', () => {
    const dep = makeDependant();
    const result = stripDependantKeys(dep, new Set());
    expect(result).toBeNull();
  });

  it('partial strip: only clears the field whose token verified, others survive untouched', () => {
    const dep = makeDependant();
    const stripped = stripDependantKeys(dep, new Set(['dependant-0-np']));
    expect(stripped).not.toBeNull();
    expect(stripped?.naturalPerson.privateKey).toBe('');
    expect(stripped?.persona.privateKey).toBe('d1-persona-priv');
    expect(stripped?.persona).toEqual(dep.persona);
    const treeExtra = stripped?.extraPersonas?.find((e) => e.publicKey === D3);
    expect(treeExtra?.privateKey).toBe('d1-extra-priv');
    expect(treeExtra).toEqual(dep.extraPersonas?.[0]);
  });

  it('dep-scoped: strips only the verified extra when just the extra token is in the set (np/persona survive)', () => {
    const dep = makeDependant();
    const stripped = stripDependantKeys(dep, new Set(['dependant-0-persona-1']));
    expect(stripped).not.toBeNull();
    expect(stripped?.naturalPerson.privateKey).toBe('d1-np-priv');
    expect(stripped?.naturalPerson).toEqual(dep.naturalPerson);
    expect(stripped?.persona.privateKey).toBe('d1-persona-priv');
    expect(stripped?.persona).toEqual(dep.persona);
    const treeExtra = stripped?.extraPersonas?.find((e) => e.publicKey === D3);
    const importedExtra = stripped?.extraPersonas?.find((e) => e.publicKey === D4);
    expect(treeExtra?.privateKey).toBe('');
    expect(importedExtra?.privateKey).toBe('d1-imported-extra-priv');
    expect(importedExtra).toEqual(dep.extraPersonas?.[1]);
  });

  it('dep-scoped: an imported/mirror extra never strips even when its "token" (empty derivationName) is coincidentally verified', () => {
    // derivationName === '' can never appear as a real slot token (buildEnrolmentPlan
    // never emits one for imported/mirror extras), but this guards the strip logic
    // itself against ever treating an empty derivationName as a match.
    const dep = makeDependant();
    const stripped = stripDependantKeys(dep, new Set(['dependant-0-np', 'dependant-0-persona', '']));
    const importedExtra = stripped?.extraPersonas?.find((e) => e.publicKey === D4);
    expect(importedExtra?.privateKey).toBe('d1-imported-extra-priv');
    expect(importedExtra).toEqual(dep.extraPersonas?.[1]);
  });
});
