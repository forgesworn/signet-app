import { describe, it, expect } from 'vitest';
import {
  grantOwnerPubkey, buildProjectionDirectories, grantDirectoryOptions, projectableDirectoryRefs,
} from './contacts-grant-directories';
import { OWNER_DIRECTORY_LABEL } from './contacts-v2-copy';
import type { FamilyDirectoryRef } from '../hooks/useFamilyContactsV2';

const OWNER_PERSONA = '1'.repeat(64);
const OWNER_NP = '2'.repeat(64);
const DEP_ID = 'b'.repeat(64);
const DEP_PERSONA = '3'.repeat(64);

const identity = {
  id: OWNER_PERSONA,
  persona: { publicKey: OWNER_PERSONA },
  naturalPerson: { publicKey: OWNER_NP },
  naturalPersonActive: true,
} as never;

const dependants = [{ id: DEP_ID, displayName: 'Robin', persona: { publicKey: DEP_PERSONA } }] as never[];

const refs: FamilyDirectoryRef[] = [
  { directoryId: 'owner', label: OWNER_DIRECTORY_LABEL, isOwner: true, activeGuardianPubkeys: [OWNER_NP], defaultChildCeiling: 'ken' },
  { directoryId: `dependant:${DEP_ID}`, label: 'Robin', isOwner: false, activeGuardianPubkeys: [OWNER_NP], defaultChildCeiling: 'ken' },
];

describe('grantOwnerPubkey', () => {
  it('is the owner’s PERSONA, never the natural person, even when it is active', () => {
    // R-31 took this key off the wire, but it is still the resolvability
    // test, and resolving the PERSONA rather than the real-name key is what
    // keeps it that way: a directory this device holds, named by a key it
    // would not mind having named.
    expect(grantOwnerPubkey(identity, dependants, 'owner')).toBe(OWNER_PERSONA);
  });

  it('is the dependant’s persona for a dependant directory', () => {
    expect(grantOwnerPubkey(identity, dependants, `dependant:${DEP_ID}`)).toBe(DEP_PERSONA);
  });

  it('is null for a directory this device does not know', () => {
    expect(grantOwnerPubkey(identity, dependants, `dependant:${'c'.repeat(64)}`)).toBeNull();
    expect(grantOwnerPubkey(identity, dependants, 'quarantine')).toBeNull();
    expect(grantOwnerPubkey(null, dependants, 'owner')).toBeNull();
  });
});

describe('buildProjectionDirectories', () => {
  it('composes one entry per ref, with each directory’s own context', () => {
    const dirs = buildProjectionDirectories(refs, identity, dependants);
    expect(dirs).toHaveLength(2);
    expect(dirs[0]).toEqual({
      directoryId: 'owner',
      ownerIdentityPubkeys: [OWNER_PERSONA, OWNER_NP],
      context: { activeGuardianPubkeys: [OWNER_NP], defaultChildCeiling: 'ken', directoryIsDependant: false },
    });
    expect(dirs[1]?.context.directoryIsDependant).toBe(true);
    // R-31: the owner persona resolves the directory but never rides out on it.
    expect(dirs[1]?.ownerIdentityPubkeys).toContain(DEP_PERSONA);
    expect(dirs[0]?.ownerIdentityPubkeys).toContain(OWNER_PERSONA);
  });

  it('drops a ref whose owner persona this device cannot resolve', () => {
    const orphan: FamilyDirectoryRef = {
      directoryId: `dependant:${'c'.repeat(64)}`, label: 'Gone', isOwner: false,
      activeGuardianPubkeys: [], defaultChildCeiling: 'ken',
    };
    expect(buildProjectionDirectories([...refs, orphan], identity, dependants)).toHaveLength(2);
  });

  it('is empty without an identity', () => {
    expect(buildProjectionDirectories(refs, null, dependants)).toEqual([]);
  });
});

describe('projectableDirectoryRefs (R-34)', () => {
  it('holds a dependant directory until its child settings have actually been read', () => {
    // `defaultChildCeiling` decides the tier a child's own contacts are
    // projected AT. Publishing under DEFAULT_CHILD_CEILING as a stand-in, then
    // republishing the same directory with different tiers once the row loads,
    // made an app's view of the family flip according to the owner's
    // navigation.
    expect(projectableDirectoryRefs(refs, dependants, new Set()).map(r => r.directoryId))
      .toEqual(['owner']);
    expect(projectableDirectoryRefs(refs, dependants, new Set([DEP_ID])).map(r => r.directoryId))
      .toEqual(['owner', `dependant:${DEP_ID}`]);
  });

  it('never holds the owner directory — it has no child settings to wait for', () => {
    expect(projectableDirectoryRefs(refs, [], new Set()).map(r => r.directoryId)).toEqual(['owner']);
  });

  it('treats “read completed, no stored row” as resolved — that is a real default', () => {
    // The resolved SET is the signal, not a populated settings map: a
    // dependant with no stored row legitimately resolves to the default
    // ceiling, and must not be held out for ever waiting on a row that will
    // never exist.
    expect(projectableDirectoryRefs(refs, dependants, new Set([DEP_ID]))).toHaveLength(2);
  });

  it('holds a dependant whose id is not in the resolved set even when another is', () => {
    const other = { id: 'd'.repeat(64), displayName: 'Sam', persona: { publicKey: '4'.repeat(64) } } as never;
    const twoRefs: FamilyDirectoryRef[] = [
      ...refs,
      { directoryId: `dependant:${'d'.repeat(64)}`, label: 'Sam', isOwner: false, activeGuardianPubkeys: [OWNER_NP], defaultChildCeiling: 'ken' },
    ];
    expect(projectableDirectoryRefs(twoRefs, [...dependants, other], new Set([DEP_ID])).map(r => r.directoryId))
      .toEqual(['owner', `dependant:${DEP_ID}`]);
  });
});

describe('grantDirectoryOptions', () => {
  it('uses the refs’ own labels, owner first, with no literal copy of its own', () => {
    const dirs = buildProjectionDirectories(refs, identity, dependants);
    expect(grantDirectoryOptions(refs, dirs)).toEqual([
      { directoryId: 'owner', label: OWNER_DIRECTORY_LABEL },
      { directoryId: `dependant:${DEP_ID}`, label: 'Robin' },
    ]);
  });

  it('offers only directories that actually resolved (M1)', () => {
    // A ref the projection builder dropped is a choice the approval handler
    // would refuse — it must never reach the picker.
    const orphan: FamilyDirectoryRef = {
      directoryId: `dependant:${'c'.repeat(64)}`, label: 'Gone', isOwner: false,
      activeGuardianPubkeys: [], defaultChildCeiling: 'ken',
    };
    const withOrphan = [...refs, orphan];
    const dirs = buildProjectionDirectories(withOrphan, identity, dependants);
    expect(grantDirectoryOptions(withOrphan, dirs).map(o => o.directoryId))
      .toEqual(['owner', `dependant:${DEP_ID}`]);
  });

  it('is empty when nothing resolved', () => {
    expect(grantDirectoryOptions(refs, [])).toEqual([]);
  });
});
