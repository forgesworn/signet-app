import { describe, it, expect } from 'vitest';
import { buildRows, buildChildRows, wrapIndex, clampIndex, resolveActiveIdentity, resolveAuthSelectionIdentity, findRowForGuardianKeypair, findRowForDependant, showNaturalPersonRow, resolveRenameTarget, resolveDependantCardSlot } from './carousel-utils';
import type { SignetIdentity, DependantIdentity } from '../types';

const mockIdentity: SignetIdentity = {
  id: 'abc123',
  mnemonic: '',
  naturalPerson: { publicKey: 'np-pub', privateKey: '', displayName: 'Alice Smith' },
  persona: { publicKey: 'p-pub', privateKey: '', displayName: 'CryptoAlice' },
  primaryKeypair: 'natural-person',
  isChild: false,
  createdAt: 0,
  encrypted: true,
};

const mockIdentityNoPersona: SignetIdentity = {
  ...mockIdentity,
  persona: { publicKey: '', privateKey: '', displayName: '' },
};

const mockDependant: DependantIdentity = {
  id: 'dep1',
  guardianPubkey: 'abc123',
  displayName: 'Ben Smith',
  dateOfBirth: '2015-06-01',
  naturalPerson: { publicKey: 'dep-np', privateKey: '', displayName: 'Ben Smith' },
  persona: { publicKey: 'dep-p', privateKey: '', displayName: 'BenGamer' },
  derivationPath: 'dependant-0',
  createdAt: 0,
  autonomyStage: 'full-control',
  primaryKeypair: 'natural-person',
};

describe('buildRows', () => {
  it('omits persona row when persona has no pubkey', () => {
    const rows = buildRows(mockIdentityNoPersona, []);
    // [natural-person(0), add(1)] — no persona slot, NP active by fallback
    expect(rows).toHaveLength(2);
    expect(rows[0].type).toBe('natural-person');
    expect(rows[1].type).toBe('add');
  });

  it('includes extra personas after the built-in persona', () => {
    const id = {
      ...mockIdentity,
      extraPersonas: [
        { publicKey: 'ep1', privateKey: '', displayName: 'TechMum', derivationName: 'persona-2' },
      ],
    };
    const rows = buildRows(id, []);
    // [persona(0), extra-persona(1), natural-person(2), add(3)]
    expect(rows).toHaveLength(4);
    expect(rows[1].type).toBe('extra-persona');
    expect(rows[3].type).toBe('add');
  });

  it('always includes an add-dependant row at the bottom', () => {
    const empty = buildRows(mockIdentityNoPersona, []);
    expect(empty[empty.length - 1].type).toBe('add');
    const full = buildRows(mockIdentity, [mockDependant]);
    expect(full[full.length - 1].type).toBe('add');
  });
});

const activeIdentity: SignetIdentity = { ...mockIdentity, naturalPersonActive: true };
const dormantIdentity: SignetIdentity = {
  ...mockIdentity,
  naturalPersonActive: false,
  naturalPerson: { publicKey: 'np-pub', privateKey: '', displayName: '' },
};

describe('buildRows — order', () => {
  it('puts the persona first and the active real identity after the personas', () => {
    const rows = buildRows(activeIdentity, []);
    // [persona(0), natural-person(1), add(2)]
    expect(rows.map(r => r.type)).toEqual(['persona', 'natural-person', 'add']);
  });

  it('omits the real-identity row entirely while it is dormant', () => {
    const rows = buildRows(dormantIdentity, []);
    expect(rows.map(r => r.type)).toEqual(['persona', 'add']);
  });

  it('puts visible extras between the persona and the real identity', () => {
    const withExtras: SignetIdentity = {
      ...activeIdentity,
      extraPersonas: [
        { publicKey: 'x1', privateKey: '', displayName: 'Gamer', derivationName: 'persona-1' },
        { publicKey: 'x2', privateKey: '', displayName: 'Hidden', derivationName: 'persona-2', hidden: true },
        { publicKey: 'x3', privateKey: '', displayName: 'Forum', derivationName: 'persona-3' },
      ],
    };
    const rows = buildRows(withExtras, []);
    expect(rows.map(r => r.type)).toEqual(['persona', 'extra-persona', 'extra-persona', 'natural-person', 'add']);
  });

  it('puts dependants after the real identity', () => {
    const rows = buildRows(activeIdentity, [mockDependant]);
    expect(rows.map(r => r.type)).toEqual(['persona', 'natural-person', 'dependant', 'add']);
  });

  it('puts dependants straight after the personas when the real identity is dormant', () => {
    const rows = buildRows(dormantIdentity, [mockDependant]);
    expect(rows.map(r => r.type)).toEqual(['persona', 'dependant', 'add']);
  });
});

describe('showNaturalPersonRow', () => {
  it('is false for a dormant slot', () => {
    expect(showNaturalPersonRow(dormantIdentity)).toBe(false);
  });

  it('is true for an active slot', () => {
    expect(showNaturalPersonRow(activeIdentity)).toBe(true);
  });

  it('is false when there is no natural-person key at all (nsec import)', () => {
    expect(showNaturalPersonRow({
      ...dormantIdentity,
      naturalPerson: { publicKey: '', privateKey: '', displayName: '' },
    })).toBe(false);
  });

  it('shows a dormant natural person when it is the ONLY keypair — never an identity-less ring', () => {
    expect(showNaturalPersonRow({
      ...dormantIdentity,
      persona: { publicKey: '', privateKey: '', displayName: '' },
    })).toBe(true);
  });
});

describe('findRowForGuardianKeypair — dynamic', () => {
  it('finds the persona at row 0', () => {
    expect(findRowForGuardianKeypair(activeIdentity, 'persona')).toBe(0);
  });

  it('finds an active natural person after the personas', () => {
    expect(findRowForGuardianKeypair(activeIdentity, 'natural-person')).toBe(1);
  });

  it('falls back to row 0 for a dormant natural person', () => {
    expect(findRowForGuardianKeypair(dormantIdentity, 'natural-person')).toBe(0);
  });

  it('falls back to row 0 for an unknown keypair', () => {
    expect(findRowForGuardianKeypair(activeIdentity, 'unknown-pubkey')).toBe(0);
  });

  it('skips hidden extras when indexing', () => {
    const withExtras: SignetIdentity = {
      ...activeIdentity,
      extraPersonas: [
        { publicKey: 'x1', privateKey: '', displayName: 'Gamer', derivationName: 'persona-1', hidden: true },
        { publicKey: 'x2', privateKey: '', displayName: 'Forum', derivationName: 'persona-2' },
      ],
    };
    expect(findRowForGuardianKeypair(withExtras, 'x2')).toBe(1);
    expect(findRowForGuardianKeypair(withExtras, 'natural-person')).toBe(2);
  });
});

describe('findRowForDependant — dynamic', () => {
  it('indexes past an active real identity', () => {
    expect(findRowForDependant(activeIdentity, [mockDependant], 'dep1')).toBe(2);
  });

  it('indexes without one when the real identity is dormant', () => {
    expect(findRowForDependant(dormantIdentity, [mockDependant], 'dep1')).toBe(1);
  });

  it('returns null for an unknown dependant', () => {
    expect(findRowForDependant(activeIdentity, [mockDependant], 'nope')).toBeNull();
  });
});

describe('buildChildRows', () => {
  it('surfaces the dependant\'s built-in persona between NP and the add row', () => {
    const rows = buildChildRows(mockDependant);
    // [dependant, dependant-persona, add]
    expect(rows).toHaveLength(3);
    expect(rows[0].type).toBe('dependant');
    expect(rows[1].type).toBe('dependant-persona');
    expect(rows[2].type).toBe('add');
  });

  it('omits the persona row when the dependant has no persona pubkey (view-only import)', () => {
    const dep = {
      ...mockDependant,
      persona: { publicKey: '', privateKey: '', displayName: '' },
    };
    const rows = buildChildRows(dep);
    expect(rows).toHaveLength(2);
    expect(rows[0].type).toBe('dependant');
    expect(rows[1].type).toBe('add');
  });

  it('includes each extra persona after the built-in persona row', () => {
    const dep = {
      ...mockDependant,
      extraPersonas: [
        { publicKey: 'ep1', privateKey: '', displayName: 'BenGamer2', derivationName: 'dependant-0-persona-1' },
        { publicKey: 'ep2', privateKey: '', displayName: 'BenGamer3', derivationName: 'dependant-0-persona-2' },
      ],
    };
    const rows = buildChildRows(dep);
    // [dependant, dependant-persona, dependant-extra-persona × 2, add]
    expect(rows).toHaveLength(5);
    expect(rows[0].type).toBe('dependant');
    expect(rows[1].type).toBe('dependant-persona');
    expect(rows[2].type).toBe('dependant-extra-persona');
    expect(rows[3].type).toBe('dependant-extra-persona');
    expect(rows[4].type).toBe('add');
  });
});

describe('wrapIndex', () => {
  it('wraps positive overflow', () => {
    expect(wrapIndex(4, 4)).toBe(0);
    expect(wrapIndex(5, 4)).toBe(1);
  });

  it('wraps negative underflow', () => {
    expect(wrapIndex(-1, 4)).toBe(3);
    expect(wrapIndex(-2, 4)).toBe(2);
  });

  it('passes through in-range values', () => {
    expect(wrapIndex(2, 4)).toBe(2);
  });
});

describe('clampIndex', () => {
  it('clamps at the lower bound', () => {
    expect(clampIndex(-1, 4)).toBe(0);
    expect(clampIndex(-10, 4)).toBe(0);
  });

  it('clamps at the upper bound', () => {
    expect(clampIndex(4, 4)).toBe(3);
    expect(clampIndex(10, 4)).toBe(3);
  });

  it('passes through in-range values', () => {
    expect(clampIndex(2, 4)).toBe(2);
    expect(clampIndex(0, 4)).toBe(0);
    expect(clampIndex(3, 4)).toBe(3);
  });

  it('returns 0 for an empty list', () => {
    expect(clampIndex(5, 0)).toBe(0);
  });
});

describe('resolveActiveIdentity', () => {
  it('returns NP identity for natural-person row', () => {
    const rows = buildRows(mockIdentity, []);
    // [persona(0), natural-person(1), add(2)] — NP active by fallback
    const result = resolveActiveIdentity(rows[1]);
    expect(result.displayName).toBe('Alice Smith');
    expect(result.publicKey).toBe('np-pub');
  });

  it('returns persona identity for persona row', () => {
    const rows = buildRows(mockIdentity, []);
    // persona is at the top of the ring
    const result = resolveActiveIdentity(rows[0]);
    expect(result.displayName).toBe('CryptoAlice');
    expect(result.publicKey).toBe('p-pub');
  });

  it('returns dependant identity for dependant row', () => {
    const rows = buildRows(mockIdentity, [mockDependant]);
    // [persona(0), natural-person(1), dependant(2), add(3)]
    const result = resolveActiveIdentity(rows[2]);
    expect(result.displayName).toBe('Ben Smith');
    expect(result.publicKey).toBe('dep-np');
    expect(result.isDependant).toBe(true);
  });

  it('returns the built-in persona for a dependant-persona row', () => {
    const rows = buildChildRows(mockDependant);
    // [dependant, dependant-persona, add]
    const result = resolveActiveIdentity(rows[1]);
    expect(result.displayName).toBe('BenGamer');
    expect(result.publicKey).toBe('dep-p');
    expect(result.type).toBe('Persona');
    expect(result.isDependant).toBe(false);
    expect(result.dependantId).toBe('dep1');
  });

  it('returns the extra persona for a dependant-extra-persona row', () => {
    const dep = {
      ...mockDependant,
      extraPersonas: [
        { publicKey: 'ep1', privateKey: '', displayName: 'BenGamer2', derivationName: 'dependant-0-persona-1' },
      ],
    };
    const rows = buildChildRows(dep);
    // [dependant, dependant-persona, dependant-extra-persona, add]
    const result = resolveActiveIdentity(rows[2]);
    expect(result.displayName).toBe('BenGamer2');
    expect(result.publicKey).toBe('ep1');
    expect(result.type).toBe('Persona');
    expect(result.isDependant).toBe(false);
    expect(result.dependantId).toBe('dep1');
  });
});

describe('resolveAuthSelectionIdentity', () => {
  it('resolves a guardian natural-person selection from identity', () => {
    const result = resolveAuthSelectionIdentity(
      { source: 'guardian', keypairType: 'natural-person' },
      mockIdentity,
      [],
    );
    expect(result?.displayName).toBe('Alice Smith');
    expect(result?.publicKey).toBe('np-pub');
    expect(result?.type).toBe('Natural Person');
    expect(result?.isDependant).toBe(false);
  });

  it('resolves a guardian persona selection from identity', () => {
    const result = resolveAuthSelectionIdentity(
      { source: 'guardian', keypairType: 'persona' },
      mockIdentity,
      [],
    );
    expect(result?.displayName).toBe('CryptoAlice');
    expect(result?.publicKey).toBe('p-pub');
    expect(result?.type).toBe('Persona');
  });

  it('resolves a dependant extra-persona selection — the row-drift fix', () => {
    const dep = {
      ...mockDependant,
      extraPersonas: [
        { publicKey: 'ep1', privateKey: '', displayName: 'BenGamer2', derivationName: 'dependant-0-persona-1' },
      ],
    };
    // Even though `carousel.row` has drifted to 0 (the dependant NP row),
    // resolving from the captured selection still produces the persona.
    const result = resolveAuthSelectionIdentity(
      { source: 'dependant', dependantId: 'dep1', keypairType: 'ep1' },
      mockIdentity,
      [dep],
    );
    expect(result?.displayName).toBe('BenGamer2');
    expect(result?.publicKey).toBe('ep1');
    expect(result?.type).toBe('Persona');
    expect(result?.isDependant).toBe(false);
    expect(result?.dependantId).toBe('dep1');
  });

  it('resolves a dependant natural-person selection', () => {
    const result = resolveAuthSelectionIdentity(
      { source: 'dependant', dependantId: 'dep1', keypairType: 'natural-person' },
      mockIdentity,
      [mockDependant],
    );
    expect(result?.displayName).toBe('Ben Smith');
    expect(result?.publicKey).toBe('dep-np');
    expect(result?.type).toBe('Dependant');
    expect(result?.isDependant).toBe(true);
    expect(result?.dependantId).toBe('dep1');
  });

  it('returns null when the dependant has been removed', () => {
    const result = resolveAuthSelectionIdentity(
      { source: 'dependant', dependantId: 'gone', keypairType: 'natural-person' },
      mockIdentity,
      [],
    );
    expect(result).toBeNull();
  });

  it('returns null when an extra persona no longer exists on the identity', () => {
    const result = resolveAuthSelectionIdentity(
      { source: 'guardian', keypairType: 'unknown-pubkey' },
      mockIdentity,
      [],
    );
    expect(result).toBeNull();
  });
});

describe('resolveActiveIdentity — displayNameIsSet', () => {
  it('is false when the persona slot displayName is empty (fallback takes effect)', () => {
    const id: SignetIdentity = {
      ...mockIdentity,
      persona: { publicKey: 'p-pub', privateKey: '', displayName: '' },
    };
    const rows = buildRows(id, []);
    // persona row is at the top of the ring
    const result = resolveActiveIdentity(rows[0]);
    expect(result.displayName).toBe('Persona');
    expect(result.displayNameIsSet).toBe(false);
  });

  it('is true when the persona slot displayName is non-empty', () => {
    const rows = buildRows(mockIdentity, []);
    const result = resolveActiveIdentity(rows[0]);
    expect(result.displayName).toBe('CryptoAlice');
    expect(result.displayNameIsSet).toBe(true);
  });

  it('is false when the NP slot displayName is empty (fallback to Natural Person)', () => {
    const id: SignetIdentity = {
      ...mockIdentity,
      // naturalPersonActive forced true so the (otherwise inactive-by-fallback)
      // empty-displayName NP still gets a row to resolve against.
      naturalPersonActive: true,
      naturalPerson: { publicKey: 'np-pub', privateKey: '', displayName: '' },
    };
    const rows = buildRows(id, []);
    // [persona(0), natural-person(1), add(2)]
    const result = resolveActiveIdentity(rows[1]);
    expect(result.displayName).toBe('Natural Person');
    expect(result.displayNameIsSet).toBe(false);
  });

  it('is true when the NP slot displayName is non-empty', () => {
    const rows = buildRows(mockIdentity, []);
    const result = resolveActiveIdentity(rows[1]);
    expect(result.displayName).toBe('Alice Smith');
    expect(result.displayNameIsSet).toBe(true);
  });

  it('resolveAuthSelectionIdentity — is false for empty persona name', () => {
    const id: SignetIdentity = {
      ...mockIdentity,
      persona: { publicKey: 'p-pub', privateKey: '', displayName: '' },
    };
    const result = resolveAuthSelectionIdentity(
      { source: 'guardian', keypairType: 'persona' },
      id,
      [],
    );
    expect(result?.displayName).toBe('Persona');
    expect(result?.displayNameIsSet).toBe(false);
  });

  it('resolveAuthSelectionIdentity — is true for non-empty NP name', () => {
    const result = resolveAuthSelectionIdentity(
      { source: 'guardian', keypairType: 'natural-person' },
      mockIdentity,
      [],
    );
    expect(result?.displayName).toBe('Alice Smith');
    expect(result?.displayNameIsSet).toBe(true);
  });
});

describe('resolveActiveIdentity — contact-avatar fields', () => {
  it('carries slotTarget + contactAvatarKey for an NP row', () => {
    const identity: any = {
      naturalPerson: { publicKey: 'p'.repeat(64), displayName: 'Me', avatarHash: 'h', avatarBlossomUrl: 'u', avatarKey: 'k', contactAvatarKey: 'e'.repeat(64), contactAvatarHash: 'ch', contactAvatarBlossomUrl: 'https://b' },
      persona: { publicKey: '' }, extraPersonas: [],
    };
    const r = resolveActiveIdentity({ type: 'natural-person', identity });
    expect(r.slotTarget).toBe('natural-person');
    expect(r.contactAvatarKey).toBe('e'.repeat(64));
  });

  it('reads dep contactAvatar* from row.dependant.naturalPerson (copy-paste guard)', () => {
    const dependant: DependantIdentity = {
      ...mockDependant,
      naturalPerson: { ...mockDependant.naturalPerson, contactAvatarKey: 'f'.repeat(64), contactAvatarHash: 'dh', contactAvatarBlossomUrl: 'https://b' },
    };
    const r = resolveActiveIdentity({ type: 'dependant', dependant });
    expect(r.slotTarget).toBe('natural-person');
    expect(r.isDependant).toBe(true);
    expect(r.contactAvatarKey).toBe('f'.repeat(64));
  });
});

describe('findRowForDependant', () => {
  it('finds the row for a single dependant after persona+NP', () => {
    // [persona(0), natural-person(1), dep1(2), add]
    expect(findRowForDependant(mockIdentity, [mockDependant], 'dep1')).toBe(2);
  });

  it('finds the row for multiple dependants', () => {
    const dep2: DependantIdentity = { ...mockDependant, id: 'dep2' };
    const dep3: DependantIdentity = { ...mockDependant, id: 'dep3' };
    // [persona(0), natural-person(1), dep1(2), dep2(3), dep3(4), add]
    expect(findRowForDependant(mockIdentity, [mockDependant, dep2, dep3], 'dep1')).toBe(2);
    expect(findRowForDependant(mockIdentity, [mockDependant, dep2, dep3], 'dep2')).toBe(3);
    expect(findRowForDependant(mockIdentity, [mockDependant, dep2, dep3], 'dep3')).toBe(4);
  });

  it('accounts for missing built-in persona', () => {
    // [natural-person(0), dep1(1), add]
    expect(findRowForDependant(mockIdentityNoPersona, [mockDependant], 'dep1')).toBe(1);
  });

  it('accounts for extra personas in the row offset', () => {
    const idWithExtras: SignetIdentity = {
      ...mockIdentity,
      extraPersonas: [
        { publicKey: 'extra-1-pub', privateKey: '', displayName: 'X1', derivationName: 'persona-2' },
        { publicKey: 'extra-2-pub', privateKey: '', displayName: 'X2', derivationName: 'persona-3' },
      ],
    };
    // [persona(0), extra1(1), extra2(2), natural-person(3), dep1(4), add]
    expect(findRowForDependant(idWithExtras, [mockDependant], 'dep1')).toBe(4);
  });

  it('returns null when the dependant id is not found', () => {
    expect(findRowForDependant(mockIdentity, [mockDependant], 'unknown-dep')).toBeNull();
  });

  it('returns null when the dependants array is empty', () => {
    expect(findRowForDependant(mockIdentity, [], 'dep1')).toBeNull();
  });
});

describe('resolveRenameTarget', () => {
  const withExtras: SignetIdentity = {
    ...mockIdentity,
    extraPersonas: [
      { publicKey: 'extra-1-pub', privateKey: '', displayName: '', derivationName: 'persona-2' },
    ],
  };

  it('targets the real-identity slot from the natural-person row', () => {
    expect(resolveRenameTarget({ type: 'natural-person', identity: mockIdentity })).toBe('natural-person');
  });

  it('targets the default persona slot from the persona row', () => {
    expect(resolveRenameTarget({ type: 'persona', identity: mockIdentity })).toBe('persona');
  });

  it("targets the extra's own pubkey from an extra-persona row", () => {
    expect(resolveRenameTarget({ type: 'extra-persona', identity: withExtras, personaIndex: 0 }))
      .toBe('extra-1-pub');
  });

  it('returns null for an extra-persona row whose slot is missing', () => {
    expect(resolveRenameTarget({ type: 'extra-persona', identity: mockIdentity, personaIndex: 3 })).toBeNull();
  });

  it('returns null for every dependant row — the owner rename handler must never write there', () => {
    expect(resolveRenameTarget({ type: 'dependant', dependant: mockDependant })).toBeNull();
    expect(resolveRenameTarget({ type: 'dependant-persona', dependant: mockDependant })).toBeNull();
    expect(resolveRenameTarget({ type: 'dependant-extra-persona', dependant: mockDependant, personaIndex: 0 })).toBeNull();
  });

  it('returns null for the add row', () => {
    expect(resolveRenameTarget({ type: 'add' })).toBeNull();
  });
});

const personaFirstDep: DependantIdentity = {
  ...mockDependant,
  id: 'dep-p',
  primaryKeypair: 'persona',
  naturalPersonActive: false,
  naturalPerson: { publicKey: 'dep-np', privateKey: '', displayName: '' },
  persona: { publicKey: 'dep-p', privateKey: '', displayName: 'Lily' },
};

describe('resolveDependantCardSlot (spec §7.6)', () => {
  it('resolves to the persona slot while the real identity is dormant', () => {
    const r = resolveDependantCardSlot(personaFirstDep);
    expect(r.slotTarget).toBe('persona');
    expect(r.slot.publicKey).toBe('dep-p');
  });

  it('resolves to the NP slot for an existing (lifted-active) dependant', () => {
    const r = resolveDependantCardSlot(mockDependant);
    expect(r.slotTarget).toBe('natural-person');
    expect(r.slot.publicKey).toBe('dep-np');
  });

  it('falls back to the NP slot when dormant but there is no persona key', () => {
    const r = resolveDependantCardSlot({
      ...personaFirstDep,
      persona: { publicKey: '', privateKey: '', displayName: '' },
    });
    expect(r.slotTarget).toBe('natural-person');
  });
});

describe('dependant card never exposes a dormant NP pubkey', () => {
  it('resolveActiveIdentity binds the dependant row to the persona', () => {
    const rows = buildRows(mockIdentity, [personaFirstDep]);
    const depRow = rows.find(r => r.type === 'dependant')!;
    const resolved = resolveActiveIdentity(depRow);
    expect(resolved.publicKey).toBe('dep-p');
    expect(resolved.publicKey).not.toBe('dep-np');
    expect(resolved.slotTarget).toBe('persona');
    // The family label is unchanged — spec §7.6 leaves top-level displayName alone.
    expect(resolved.displayName).toBe('Ben Smith');
    expect(resolved.isDependant).toBe(true);
  });

  it('keeps an existing dependant row on its NP', () => {
    const rows = buildRows(mockIdentity, [mockDependant]);
    const resolved = resolveActiveIdentity(rows.find(r => r.type === 'dependant')!);
    expect(resolved.publicKey).toBe('dep-np');
    expect(resolved.slotTarget).toBe('natural-person');
  });
});

describe('buildChildRows with a dormant real identity', () => {
  it('omits the dependant (NP) row and opens on the persona', () => {
    const rows = buildChildRows(personaFirstDep);
    // [dependant-persona, add]
    expect(rows).toHaveLength(2);
    expect(rows[0].type).toBe('dependant-persona');
    expect(rows[1].type).toBe('add');
  });

  it('keeps the NP row for an existing dependant', () => {
    const rows = buildChildRows(mockDependant);
    expect(rows[0].type).toBe('dependant');
  });

  it('still renders one identity row when dormant AND persona-less', () => {
    const rows = buildChildRows({
      ...personaFirstDep,
      persona: { publicKey: '', privateKey: '', displayName: '' },
    });
    expect(rows[0].type).toBe('dependant');
    expect(rows).toHaveLength(2);
  });

  it('keeps extras after the persona row when dormant', () => {
    const rows = buildChildRows({
      ...personaFirstDep,
      extraPersonas: [
        { publicKey: 'ep1', privateKey: '', displayName: 'LilyPlays', derivationName: 'dependant-0-persona-1' },
      ],
    });
    expect(rows.map(r => r.type)).toEqual(['dependant-persona', 'dependant-extra-persona', 'add']);
  });
});

describe('bot inventory rows', () => {
  it('places visible bots after extra personas, labels every resolved bot, and preserves dependant landing indexes', () => {
    const bot = { publicKey: 'b'.repeat(64), ownerPersona: 'c'.repeat(64), label: 'Helper', source: 'derived' as const,
      derivationName: 'bot-0', hidden: false, createdAt: 1, updatedAt: 1 };
    const identity = { ...mockIdentity, naturalPersonActive: true,
      extraPersonas: [{ publicKey: 'extra', privateKey: '', displayName: 'Extra', derivationName: 'persona-2' }] };
    const bots = [bot, { ...bot, publicKey: 'hidden', hidden: true }, { ...bot, publicKey: 'removed', removedAt: 2 }];
    const rows = buildRows(identity, [mockDependant], bots);
    expect(rows.map(row => row.type)).toEqual(['persona', 'extra-persona', 'bot', 'natural-person', 'dependant', 'add']);
    expect(resolveActiveIdentity(rows[2])).toMatchObject({ displayName: 'Helper · Bot', publicKey: bot.publicKey, type: 'Bot' });
    expect(resolveRenameTarget(rows[2])).toBeNull();
    expect(findRowForGuardianKeypair(identity, 'natural-person', bots)).toBe(3);
    expect(findRowForDependant(identity, [mockDependant], mockDependant.id, bots)).toBe(4);
    expect(buildChildRows(mockDependant).some(row => row.type === 'bot')).toBe(false);
  });
});
