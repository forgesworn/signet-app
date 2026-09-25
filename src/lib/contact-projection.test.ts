import { describe, it, expect } from 'vitest';
import {
  projectContact, buildContactProjection, buildRevocationProjection, hashProjection, scopedIdIndex,
} from './contact-projection';
import {
  CAPABILITIES, buildProjection, parseProjection, MAX_DISPLAY_NAME, MAX_METHOD_VALUE, MAX_ROLE_LEN, MAX_WIRE_BYTES,
  projectionByteLength, scopedContactId,
} from '@forgesworn/signet-contacts/wire';
import type { Capability, ContactProjectionV2 } from '@forgesworn/signet-contacts/wire';
import { CAP_NAME as APP_CAP_NAME, CAP_ROLE as APP_CAP_ROLE, CAP_METHOD_VALUE as APP_CAP_METHOD_VALUE } from './contacts-v2-reducer';
import type { EffectiveContact } from '../types';

// I4(d): the app's own field caps, imported directly from
// `contacts-v2-reducer.ts` (rather than mirrored as separate literals), must
// never exceed the SDK's wire caps. If the app ever accepted a longer field
// than the SDK, `sanitizeWireText` would silently truncate it going out —
// legal, but worth pinning so the two constant sets are never allowed to
// drift the other way (app cap bigger than the SDK's) without a test
// failing here first.

const GRANT = 'f'.repeat(32);
const OWNER = '1'.repeat(64);
const DEVICE = '2'.repeat(32);
const FRONTIER = { maxClock: 42, opCount: 137, publishedAt: 1_700_000_000, deviceId: DEVICE };
const ALL: Capability[] = [...CAPABILITIES];

function effective(over: Partial<EffectiveContact> = {}): EffectiveContact {
  return {
    directoryId: 'owner', contactId: 'a'.repeat(32), type: 'person', displayName: 'Ada',
    tier: 'kith', roles: ['coach'],
    identities: [{
      itemId: '1'.repeat(32), pubkey: 'c'.repeat(64), provenance: 'direct', verification: 'proven',
      addedAt: 1, direct: { ownerPubkey: OWNER, sharedSecret: 'ab'.repeat(32), verifiedAt: 1 },
    }],
    contactMethods: [
      { itemId: '2'.repeat(32), kind: 'email', value: 'ada@example.com', verification: 'unverified', sharingPolicy: 'grantable', addedAt: 1 },
      { itemId: '3'.repeat(32), kind: 'phone', value: '+441234567890', verification: 'proven', sharingPolicy: 'private', addedAt: 1 },
    ],
    accessGrants: [], lifecycle: 'active', createdAt: 1, updatedAt: 1,
    createdByActorRole: 'owner', createdByOperationId: '0'.repeat(32),
    vouches: [], ceilings: [], blocks: [], notes: 'PRIVATE NOTE',
    effectiveTier: 'kith', tierSource: 'direct', blocked: false, blockedBy: [],
    ...over,
  } as EffectiveContact;
}

const caps = (...c: Capability[]) => new Set<Capability>(c);

// I3: a second guardian pubkey, distinct from OWNER/GRANT/the contact's own
// identity pubkey, plus unique operation/vouch ids and a distinctive reason
// string, so the "never appears" assertions below cannot pass by accident
// (e.g. because the forbidden value happens to equal something legitimately
// emitted elsewhere in the fixture).
const GUARDIAN_2 = '9'.repeat(64);
const VOUCH_ID = 'aa'.repeat(16);
const VOUCH_OP = 'bb'.repeat(16);
// Not 'cc'/'dd' repeats — the fixture's own identity pubkey is 'c'.repeat(64)
// (32 c's is a substring of it), so a same-character filler there would
// pass the "never contains" assertion by accident.
const CEILING_OP = '77'.repeat(16);
const BLOCK_OP = '88'.repeat(16);
const CREATED_BY_OP = 'ee'.repeat(16);
const VOUCH_ROLE = 'guardian-vouch-role-marker';
const BLOCK_REASON = 'because the vetting failed marker';

/** I3: every provenance/evidence array populated, plus block state, under
 *  the same shape `effective()` already exercises for identities/methods. */
function fullyPopulated(): EffectiveContact {
  return effective({
    blocked: true, blockedBy: [OWNER, GUARDIAN_2], effectiveTier: 'none', tierSource: 'guardian-limited',
    vouches: [{
      vouchId: VOUCH_ID, guardianPubkey: GUARDIAN_2, tier: 'kin', role: VOUCH_ROLE,
      createdAt: 1, operationId: VOUCH_OP,
    }],
    ceilings: [{ guardianPubkey: GUARDIAN_2, maxTier: 'kith', createdAt: 1, operationId: CEILING_OP }],
    blocks: [{
      blockedBy: GUARDIAN_2, scope: { kind: 'contact' }, blockedAt: 1,
      reason: BLOCK_REASON, operationId: BLOCK_OP,
    }],
    createdByActorRole: 'guardian', createdByOperationId: CREATED_BY_OP,
  });
}

describe('projectContact — capability gating', () => {
  it('at full scope emits every permitted field', () => {
    const p = projectContact(effective(), GRANT, caps(...ALL), {})!;
    expect(p.contactId).toBe(scopedContactId(GRANT, 'a'.repeat(32)));
    expect(p.displayName).toBe('Ada');
    expect(p.roles).toEqual(['coach']);
    expect(p.identities).toEqual([{ pubkey: 'c'.repeat(64), verification: 'proven' }]);
    expect(p.contactMethods).toEqual([{ kind: 'email', value: 'ada@example.com', verification: 'unverified' }]);
    expect(p.effectiveTier).toBe('kith');
    expect(p.tierSource).toBe('direct');
    expect(p.blocked).toBe(false);
  });

  it('never emits the ECDH secret, the note, the raw contact id or the item ids', () => {
    const json = JSON.stringify(projectContact(effective(), GRANT, caps(...ALL), {}));
    expect(json).not.toContain('ab'.repeat(32));
    expect(json).not.toContain('PRIVATE NOTE');
    expect(json).not.toContain('"' + 'a'.repeat(32) + '"');
    expect(json).not.toContain('1'.repeat(32));
    expect(json).not.toContain('2'.repeat(32));
  });

  it('never emits an avatar, because v2 has no avatar capability (R-12)', () => {
    const json = JSON.stringify(projectContact(effective(), GRANT, caps(...ALL), {}));
    expect(json).not.toContain('avatar');
  });

  it('never emits vouch/ceiling/block provenance, actor pubkeys, operation ids or block reasons, even on a fully populated record (I3)', () => {
    const json = JSON.stringify(projectContact(fullyPopulated(), GRANT, caps(...ALL), {}));
    for (const forbidden of [GUARDIAN_2, VOUCH_ID, VOUCH_OP, CEILING_OP, BLOCK_OP, CREATED_BY_OP, VOUCH_ROLE, BLOCK_REASON]) {
      expect(json).not.toContain(forbidden);
    }
  });

  it('emits only allowlisted keys on a contact and on a projection header, even on a fully populated record (I3)', () => {
    const p = projectContact(fullyPopulated(), GRANT, caps(...ALL), {})!;
    expect(Object.keys(p).sort()).toEqual(
      ['blocked', 'contactId', 'contactMethods', 'displayName', 'effectiveTier', 'identities', 'roles', 'tierSource'].sort(),
    );
    const projection = buildContactProjection({
      grantId: GRANT, capabilities: ALL, contacts: [fullyPopulated()],
      frontier: FRONTIER, appLabels: {}, issuedAt: 1_700_000_000, maxStalenessSeconds: 21600,
    });
    expect(Object.keys(projection).sort()).toEqual(
      ['v', 'grantId', 'scopes', 'frontier', 'issuedAt', 'expiresAt', 'contacts'].sort(),
    );
  });

  it('omits roles without read:roles', () => {
    expect(projectContact(effective(), GRANT, caps('signet.contacts.read:directory'), {})!.roles).toBeUndefined();
  });

  it('omits contact methods without a method permission', () => {
    expect(projectContact(effective(), GRANT, caps('signet.contacts.read:directory'), {})!.contactMethods).toBeUndefined();
  });

  it('emits only grantable methods, never private ones', () => {
    const p = projectContact(effective(), GRANT, caps('signet.contacts.read:directory', 'signet.contacts.read:method:email'), {})!;
    expect(p.contactMethods).toHaveLength(1);
    expect(JSON.stringify(p)).not.toContain('+441234567890');
  });

  it('drops a method whose value sanitises to nothing, rather than emitting one the parser would drop (R-6)', () => {
    const contact = effective({
      contactMethods: [
        { itemId: '2'.repeat(32), kind: 'email', value: '​​', verification: 'unverified', sharingPolicy: 'grantable', addedAt: 1 },
        { itemId: '3'.repeat(32), kind: 'email', value: 'ok@example.com', verification: 'unverified', sharingPolicy: 'grantable', addedAt: 1 },
      ],
    });
    const p = projectContact(contact, GRANT, caps('signet.contacts.read:directory', 'signet.contacts.read:method:email'), {})!;
    expect(p.contactMethods).toEqual([{ kind: 'email', value: 'ok@example.com' }]);
  });

  it('caps an over-length method value rather than dropping the contact', () => {
    const contact = effective({
      contactMethods: [{
        itemId: '2'.repeat(32), kind: 'other', value: 'x'.repeat(400),
        verification: 'unverified', sharingPolicy: 'grantable', addedAt: 1,
      }],
    });
    const p = projectContact(contact, GRANT, caps('signet.contacts.read:directory', 'signet.contacts.read:method:other'), {})!;
    expect(p.contactMethods?.[0]?.value).toHaveLength(320);
  });

  it('includes contact keys without disclosing their linkage metadata', () => {
    const contact = effective({
      identities: [
        { itemId: '1'.repeat(32), pubkey: 'c'.repeat(64), provenance: 'direct', verification: 'proven', addedAt: 1 },
        { itemId: '4'.repeat(32), pubkey: 'd'.repeat(64), provenance: 'key-link', verification: 'proven', addedAt: 1 },
        { itemId: '5'.repeat(32), pubkey: 'e'.repeat(64), provenance: 'key-link', verification: 'unverified', addedAt: 1 },
      ],
    });
    const projected = projectContact(contact, GRANT, caps(...ALL), {})!;
    expect(projected.linkedPubkeys).toBeUndefined();
    expect(projected.identities?.map(i => i.pubkey)).toEqual(['c'.repeat(64), 'd'.repeat(64), 'e'.repeat(64)]);
  });

  it('normalises public keys and drops malformed keys', () => {
    const contact = effective({
      identities: [
        { itemId: '1'.repeat(32), pubkey: 'C'.repeat(64), provenance: 'direct', verification: 'proven', addedAt: 1 },
        { itemId: '2'.repeat(32), pubkey: 'zz'.repeat(32), provenance: 'direct', verification: 'proven', addedAt: 1 },
        { itemId: '3'.repeat(32), pubkey: 'c'.repeat(63), provenance: 'direct', verification: 'proven', addedAt: 1 },
        { itemId: '4'.repeat(32), pubkey: 'D'.repeat(64), provenance: 'key-link', verification: 'proven', addedAt: 1 },
      ],
    });
    const p = projectContact(contact, GRANT, caps(...ALL), {})!;
    // Proven key rotations keep their usable public key, but no linkage metadata.
    expect(p.identities).toEqual([
      { pubkey: 'c'.repeat(64), verification: 'proven' },
      { pubkey: 'd'.repeat(64), verification: 'proven' },
    ]);
    expect(p.linkedPubkeys).toBeUndefined();
  });

  it('applies an app label over the display name, for that grant only', () => {
    const scoped = scopedContactId(GRANT, 'a'.repeat(32));
    const p = projectContact(effective(), GRANT, caps('signet.contacts.read:directory'), { [scoped]: 'Coach' })!;
    expect(p.displayName).toBe('Coach');
  });

  it('sanitises and caps a hostile display name and label through the wire sanitiser', () => {
    const scoped = scopedContactId(GRANT, 'a'.repeat(32));
    expect(projectContact(effective({ displayName: '  A‮db  ' }), GRANT, caps('signet.contacts.read:directory'), {})!.displayName).toBe('Adb');
    expect(projectContact(effective(), GRANT, caps('signet.contacts.read:directory'), { [scoped]: 'x'.repeat(300) })!.displayName).toHaveLength(100);
  });

  it('reaches a sanitisation fixed point so a slice-induced trailing space never causes a round-trip throw (I4a)', () => {
    // `sanitizeWireText` trims THEN slices. Trimmed, this string has no
    // leading/trailing whitespace, so a single pass leaves it unchanged
    // until the slice — and MAX_DISPLAY_NAME (100) lands the cut exactly on
    // the space at index 99, which a single pass never re-trims.
    const boundary = 'A'.repeat(MAX_DISPLAY_NAME - 1) + ' ' + 'B'.repeat(50);
    const p = projectContact(effective({ displayName: boundary }), GRANT, caps('signet.contacts.read:directory'), {})!;
    expect(p.displayName).toBe('A'.repeat(MAX_DISPLAY_NAME - 1));
    expect(p.displayName?.endsWith(' ')).toBe(false);

    // Same hazard for a role and a grantable method value, at their own caps.
    const roleBoundary = 'r'.repeat(MAX_ROLE_LEN - 1) + ' ' + 's'.repeat(10);
    const withRole = projectContact(
      effective({ roles: [roleBoundary] }), GRANT, caps('signet.contacts.read:directory', 'signet.contacts.read:roles'), {},
    )!;
    expect(withRole.roles).toEqual(['r'.repeat(MAX_ROLE_LEN - 1)]);

    const methodBoundary = 'm'.repeat(MAX_METHOD_VALUE - 1) + ' ' + 'n'.repeat(50);
    const withMethod = projectContact(
      effective({
        contactMethods: [{
          itemId: '2'.repeat(32), kind: 'other', value: methodBoundary,
          verification: 'unverified', sharingPolicy: 'grantable', addedAt: 1,
        }],
      }),
      GRANT, caps('signet.contacts.read:directory', 'signet.contacts.read:method:other'), {},
    )!;
    expect(withMethod.contactMethods?.[0]?.value).toBe('m'.repeat(MAX_METHOD_VALUE - 1));
  });

  it('never accepts an app-side field cap wider than the SDK wire cap it feeds (I4d)', () => {
    // Guards against `contacts-v2-reducer.ts`'s private caps drifting ABOVE
    // the SDK's — see the module-level comment on APP_CAP_*. A cap wider
    // than the SDK's would mean data this app considers valid gets silently
    // truncated by `sanitizeWireText` on its way out, which is legal but a
    // silent surprise worth catching here rather than downstream.
    expect(APP_CAP_NAME).toBeLessThanOrEqual(MAX_DISPLAY_NAME);
    expect(APP_CAP_ROLE).toBeLessThanOrEqual(MAX_ROLE_LEN);
    expect(APP_CAP_METHOD_VALUE).toBeLessThanOrEqual(MAX_METHOD_VALUE);
  });

  it('never throws building+serialising a projection whose fields sit right on the SDK cap boundary after a space (I4a/I4d)', async () => {
    const { buildProjection, parseProjection } = await import('@forgesworn/signet-contacts/wire');
    const boundary = 'A'.repeat(MAX_DISPLAY_NAME - 1) + ' ' + 'B'.repeat(50);
    const p = buildContactProjection({
      grantId: GRANT, capabilities: ALL,
      contacts: [effective({ displayName: boundary })],
      frontier: FRONTIER, appLabels: {}, issuedAt: 1_700_000_000, maxStalenessSeconds: 21600,
    });
    expect(() => buildProjection(p)).not.toThrow();
    expect(parseProjection(buildProjection(p))).toEqual(p);
  });
});

describe('projectContact — block and lifecycle rules', () => {
  const blocked = effective({ blocked: true, blockedBy: [OWNER], effectiveTier: 'none', tierSource: 'guardian-limited' });

  it('omits a blocked contact entirely when blocks.read was not granted', () => {
    expect(projectContact(blocked, GRANT, caps('signet.contacts.read:directory'), {})).toBeNull();
  });

  it('emits a blocked contact with blocks.read + read:directory', () => {
    const p = projectContact(blocked, GRANT, caps('signet.contacts.read:directory', 'signet.contacts.blocks.read'), {})!;
    expect(p.blocked).toBe(true);
    expect(p.displayName).toBe('Ada');
  });

  it('with blocks.read alone emits blocked contacts only, stripped of name, roles and methods', () => {
    const only = caps('signet.contacts.blocks.read');
    expect(projectContact(effective(), GRANT, only, {})).toBeNull();
    const p = projectContact(blocked, GRANT, only, {})!;
    expect(p.blocked).toBe(true);
    expect(p.identities).toHaveLength(1);
    expect(p.displayName).toBeUndefined();
    expect(p.roles).toBeUndefined();
    expect(p.contactMethods).toBeUndefined();
  });

  it('omits a removed, rejected or archived contact that is not blocked', () => {
    for (const over of [{ lifecycle: 'removed' as const }, { lifecycle: 'rejected' as const }, { archived: true }]) {
      expect(projectContact(effective(over), GRANT, caps(...ALL), {})).toBeNull();
    }
  });

  it('still emits a removed contact that is blocked, so the filter survives removal', () => {
    const p = projectContact(effective({ lifecycle: 'removed', blocked: true }), GRANT, caps(...ALL), {});
    expect(p?.blocked).toBe(true);
  });

  it('omits a pending or suggested contact', () => {
    expect(projectContact(effective({ lifecycle: 'pending' }), GRANT, caps(...ALL), {})).toBeNull();
    expect(projectContact(effective({ lifecycle: 'suggested' }), GRANT, caps(...ALL), {})).toBeNull();
  });
});

describe('buildContactProjection', () => {
  const input = {
    grantId: GRANT, capabilities: ALL,
    contacts: [effective(), effective({ contactId: 'b'.repeat(32), displayName: 'Bo', lifecycle: 'removed' as const })],
    frontier: FRONTIER,
    appLabels: {}, issuedAt: 1_700_000_000, maxStalenessSeconds: 21600,
  };

  it('sets expiresAt from the staleness window and sorts contacts by scoped id', () => {
    const p = buildContactProjection({
      ...input,
      contacts: [effective({ contactId: '9'.repeat(32) }), effective({ contactId: '8'.repeat(32) })],
    });
    expect(p.expiresAt).toBe(1_700_000_000 + 21600);
    const ids = p.contacts.map((c) => c.contactId);
    expect([...ids].sort()).toEqual(ids);
  });

  it('carries the frontier through, publisher and all (C13)', () => {
    expect(buildContactProjection(input).frontier).toEqual(FRONTIER);
  });

  it('drops contacts the capability rules exclude', () => {
    expect(buildContactProjection(input).contacts).toHaveLength(1);
  });

  it('normalises scopes and never emits an unrequested capability', () => {
    const p = buildContactProjection({ ...input, capabilities: ['signet.contacts.read:roles', 'signet.contacts.read:directory'] });
    expect(p.scopes).toEqual(['signet.contacts.read:directory', 'signet.contacts.read:roles']);
  });

  it('is not truncated when it fits', () => {
    expect(buildContactProjection(input).truncated).toBeUndefined();
  });

  it('drops the least recently updated contacts to fit, and says so (R-5)', () => {
    // ~700 heavy contacts is well past 65532 bytes. `updatedAt` ascending, so
    // the oldest are the ones that should go.
    const many = Array.from({ length: 700 }, (_, i) => effective({
      contactId: i.toString(16).padStart(32, '0'),
      displayName: 'N'.repeat(100),
      roles: ['r'.repeat(40), 's'.repeat(40)],
      updatedAt: i + 1,
    }));
    const p = buildContactProjection({ ...input, contacts: many });
    expect(p.truncated).toBe(true);
    expect(p.contacts.length).toBeLessThan(700);
    expect(projectionByteLength(p)).toBeLessThanOrEqual(MAX_WIRE_BYTES);
    // The survivors are the most recently updated — id 699 (updatedAt 700) in,
    // id 0 (updatedAt 1) out.
    const kept = new Set(p.contacts.map((c) => c.contactId));
    expect(kept.has(scopedContactId(GRANT, (699).toString(16).padStart(32, '0')))).toBe(true);
    expect(kept.has(scopedContactId(GRANT, (0).toString(16).padStart(32, '0')))).toBe(false);
  });

  it('drops every app-created contact before any user-created one (R-28c)', () => {
    // The directory log is SHARED: one app's volume must never push the
    // owner's own contacts out of a DIFFERENT app's projection. The
    // app-created records here are also the MOST recently updated, so
    // recency alone would keep them and drop the owner's.
    const owned = Array.from({ length: 400 }, (_, i) => effective({
      contactId: `0${i.toString(16).padStart(31, '0')}`,
      displayName: 'N'.repeat(100), roles: ['r'.repeat(40), 's'.repeat(40)],
      updatedAt: i + 1, createdByActorRole: 'owner',
    }));
    const appMade = Array.from({ length: 400 }, (_, i) => effective({
      contactId: `1${i.toString(16).padStart(31, '0')}`,
      displayName: 'N'.repeat(100), roles: ['r'.repeat(40), 's'.repeat(40)],
      updatedAt: 100_000 + i, createdByActorRole: 'app',
    }));
    const p = buildContactProjection({ ...input, contacts: [...owned, ...appMade] });
    expect(p.truncated).toBe(true);

    const kept = new Set(p.contacts.map((c) => c.contactId));
    const appScoped = appMade.map((c) => scopedContactId(GRANT, c.contactId));
    const ownedScoped = owned.map((c) => scopedContactId(GRANT, c.contactId));
    // Not one app-created record survives while owner records are still being
    // dropped — and here the cut falls inside the owner group.
    expect(appScoped.filter((id) => kept.has(id))).toEqual([]);
    expect(ownedScoped.filter((id) => kept.has(id)).length).toBeGreaterThan(0);
    // The owner survivors are still the most recently updated of their group.
    expect(kept.has(scopedContactId(GRANT, owned[399]!.contactId))).toBe(true);
    expect(kept.has(scopedContactId(GRANT, owned[0]!.contactId))).toBe(false);
  });

  it('keeps app-created contacts when everything fits — the order is a drop order, not a filter', () => {
    const p = buildContactProjection({
      ...input,
      contacts: [
        effective({ contactId: 'a'.repeat(32), createdByActorRole: 'app', updatedAt: 1 }),
        effective({ contactId: 'b'.repeat(32), createdByActorRole: 'owner', updatedAt: 2 }),
      ],
    });
    expect(p.truncated).toBeUndefined();
    expect(p.contacts).toHaveLength(2);
  });

  it('drops to the EXACT fit — one more contact would not fit (I2)', () => {
    const many = Array.from({ length: 700 }, (_, i) => effective({
      contactId: i.toString(16).padStart(32, '0'),
      displayName: 'N'.repeat(100),
      roles: ['r'.repeat(40), 's'.repeat(40)],
      updatedAt: i + 1,
    }));
    const p = buildContactProjection({ ...input, contacts: many });
    expect(p.truncated).toBe(true);
    expect(projectionByteLength(p)).toBeLessThanOrEqual(MAX_WIRE_BYTES);
    // Every contact in `many` is the same shape/size, so appending a clone
    // of one already kept (under a fresh, unused scoped id) stands in
    // exactly for "the next candidate the binary search rejected" — proving
    // the found cut is the LARGEST one that fits, not merely "a" fit.
    const oneMore: ContactProjectionV2 = {
      ...p,
      contacts: [...p.contacts, { ...p.contacts[0], contactId: 'f'.repeat(32) }],
    };
    expect(projectionByteLength(oneMore)).toBeGreaterThan(MAX_WIRE_BYTES);
  });

  it('produces a projection that survives the SDK builder', async () => {
    const { buildProjection, parseProjection } = await import('@forgesworn/signet-contacts/wire');
    const p = buildContactProjection(input);
    expect(parseProjection(buildProjection(p))).toEqual(p);
  });

  it('produces a TRUNCATED projection that still survives the SDK builder', async () => {
    const { buildProjection, parseProjection } = await import('@forgesworn/signet-contacts/wire');
    const many = Array.from({ length: 700 }, (_, i) => effective({
      contactId: i.toString(16).padStart(32, '0'), displayName: 'N'.repeat(100), updatedAt: i + 1,
    }));
    const p = buildContactProjection({ ...input, contacts: many });
    expect(parseProjection(buildProjection(p))).toEqual(p);
  });
});

describe('R-31 — no owner pubkey anywhere on the projection wire', () => {
  it('omits the directory owner’s persona from the body and from the revocation tombstone', () => {
    // It used to be a required wire field. It is stable across every grant on
    // a directory — a one-line join for two colluding apps — and on a
    // dependant directory it is a minor’s long-lived public identity. The SDK
    // never read it for anything.
    const p = buildContactProjection({
      grantId: GRANT, capabilities: ALL, contacts: [fullyPopulated()],
      frontier: FRONTIER, appLabels: {}, issuedAt: 1_700_000_000, maxStalenessSeconds: 21600,
    });
    expect(Object.keys(p)).not.toContain('ownerPubkey');
    expect(JSON.stringify(p)).not.toContain(OWNER);
    const r = buildRevocationProjection(GRANT, ALL, 1_700_000_000, DEVICE);
    expect(Object.keys(r)).not.toContain('ownerPubkey');
    expect(JSON.stringify(r)).not.toContain(OWNER);
  });
});

describe('buildRevocationProjection', () => {
  it('is empty, revoked, and carries a zero frontier stamped with this device', () => {
    const p = buildRevocationProjection(GRANT, ALL, 1_700_000_000, DEVICE);
    expect(p.revoked).toBe(true);
    expect(p.contacts).toEqual([]);
    expect(p.frontier).toEqual({ maxClock: 0, opCount: 0, publishedAt: 1_700_000_000, deviceId: DEVICE });
  });
});

describe('hashProjection', () => {
  // App and SDK key insertion order differs; hashing must use canonical wire
  // order, even though both objects carry exactly the same granted fields.
  const base = buildContactProjection({
    grantId: GRANT, capabilities: ALL,
    contacts: [effective({
      identities: [
        { itemId: '1'.repeat(32), pubkey: 'c'.repeat(64), provenance: 'direct', verification: 'proven', addedAt: 1 },
        { itemId: '4'.repeat(32), pubkey: 'd'.repeat(64), provenance: 'key-link', verification: 'proven', addedAt: 1 },
      ],
    })],
    frontier: FRONTIER, appLabels: {},
    issuedAt: 1_700_000_000, maxStalenessSeconds: 21600,
  });

  it('is stable across a rebuild at a different time', () => {
    const later = {
      ...base,
      issuedAt: base.issuedAt + 500,
      expiresAt: base.expiresAt + 500,
      frontier: { ...base.frontier, publishedAt: base.frontier.publishedAt + 500 },
    };
    // C13 + the dedupe: `publishedAt` moves on EVERY rebuild, so including it
    // would make the hash differ every run and republish the same directory
    // for ever — which is the exact churn the hash exists to prevent.
    expect(hashProjection(later)).toBe(hashProjection(base));
  });

  it('hashes equal to itself after a full SDK build+serialise+parse round trip (I1)', async () => {
    const { buildProjection, parseProjection } = await import('@forgesworn/signet-contacts/wire');
    const { sha256 } = await import('@noble/hashes/sha2.js');
    const { bytesToHex } = await import('@noble/hashes/utils.js');
    const roundTripped = parseProjection(buildProjection(base))!;
    // Same fields, reconstructed in the SDK's canonical property order.
    expect(JSON.stringify(base.contacts)).not.toBe(JSON.stringify(roundTripped.contacts));

    // Proves the fixture is actually discriminating: hashing the RAW app
    // object in its own key order — the pre-fix `hashProjection` approach —
    // gives a DIFFERENT digest than the fixed, SDK-canonicalising one does
    // for this exact projection. If this assertion ever failed, the test
    // below it would be passing by coincidence rather than exercising I1.
    const rawHash = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify({
      grantId: base.grantId,
      scopes: base.scopes,
      frontier: {
        maxClock: base.frontier.maxClock, opCount: base.frontier.opCount, deviceId: base.frontier.deviceId,
      },
      revoked: false,
      truncated: false,
      contacts: base.contacts,
    }))));
    expect(rawHash).not.toBe(hashProjection(base));

    // The actual fix: hashing the SDK-canonical form agrees regardless of
    // which side's key order the caller happened to build from.
    expect(hashProjection(roundTripped)).toBe(hashProjection(base));
  });

  it('changes when a contact, a scope, the revoked flag or the truncated flag changes', () => {
    expect(hashProjection({ ...base, contacts: [] })).not.toBe(hashProjection(base));
    expect(hashProjection({ ...base, scopes: ['signet.contacts.read:directory'] })).not.toBe(hashProjection(base));
    expect(hashProjection({ ...base, revoked: true })).not.toBe(hashProjection(base));
    expect(hashProjection({ ...base, truncated: true })).not.toBe(hashProjection(base));
  });

  it('changes when the frontier’s clock or publisher moves, even if the visible contacts do not', () => {
    expect(hashProjection({ ...base, frontier: { ...base.frontier, maxClock: 43 } })).not.toBe(hashProjection(base));
    expect(hashProjection({ ...base, frontier: { ...base.frontier, deviceId: '7'.repeat(32) } })).not.toBe(hashProjection(base));
  });
});

describe('scopedIdIndex', () => {
  it('maps grant-scoped ids back to real contact ids', () => {
    const index = scopedIdIndex(GRANT, [{ contactId: 'a'.repeat(32) }, { contactId: 'b'.repeat(32) }]);
    expect(index.get(scopedContactId(GRANT, 'a'.repeat(32)))).toBe('a'.repeat(32));
    expect(index.size).toBe(2);
  });
});


describe('field-level disclosure', () => {
  it('serialises only the contact id, name and npub for the default grant', () => {
    const projection = buildContactProjection({
      grantId: GRANT, capabilities: ['signet.contacts.read:directory'], contacts: [effective()],
      frontier: FRONTIER, appLabels: {}, issuedAt: 1_700_000_000, maxStalenessSeconds: 21600,
    });
    expect(parseProjection(buildProjection(projection))?.contacts).toEqual([{
      contactId: scopedContactId(GRANT, 'a'.repeat(32)), displayName: 'Ada',
      identities: [{ pubkey: 'c'.repeat(64) }],
    }]);
  });

  it.each(['phone', 'email', 'website', 'postal-address', 'other'] as const)(
    'a %s grant cannot read any other method kind', (kind) => {
      const kinds = ['phone', 'email', 'website', 'postal-address', 'other'] as const;
      const contact = effective({ contactMethods: kinds.map((k, i) => ({
        itemId: String(i).repeat(32), kind: k, value: `${k} secret`,
        verification: 'proven', sharingPolicy: 'grantable', addedAt: 1,
      })) });
      const p = projectContact(contact, GRANT, caps('signet.contacts.read:directory', `signet.contacts.read:method:${kind}`), {})!;
      expect(p.contactMethods).toEqual([{ kind, value: `${kind} secret` }]);
      expect(p.effectiveTier).toBeUndefined();
      expect(p.identities?.[0]?.verification).toBeUndefined();
    },
  );

  it('does not reinterpret a saved broad methods grant as permission for any method', () => {
    const oldCaps = new Set(['signet.contacts.read:directory', 'signet.contacts.read:methods']) as Set<Capability>;
    expect(projectContact(effective(), GRANT, oldCaps, {})?.contactMethods).toBeUndefined();
  });

  it('checks do not grant method values or tiers, and tiers do not grant checks', () => {
    const checked = projectContact(effective(), GRANT, caps('signet.contacts.read:directory', 'signet.contacts.read:checks'), {})!;
    expect(checked.identities?.[0]?.verification).toBe('proven');
    expect(checked.contactMethods).toBeUndefined();
    expect(checked.effectiveTier).toBeUndefined();
    const tiered = projectContact(effective(), GRANT, caps('signet.contacts.read:directory', 'signet.contacts.read:tier'), {})!;
    expect(tiered.effectiveTier).toBe('kith');
    expect(tiered.identities?.[0]?.verification).toBeUndefined();
  });
});

describe('check-record consent', () => {
  it('requires the new consent and emits only key, method and date', () => {
    const contact = effective({ checks: [{ id: 'a'.repeat(32), identityPubkey: 'c'.repeat(64), ownerIdentityPubkey: OWNER,
      method: 'words', checkedAt: 1700000000000, source: 'website', evidence: 'https://private.example/evidence' }] });
    const oldGrant = projectContact(contact, GRANT, new Set<Capability>(['signet.contacts.read:directory', 'signet.contacts.read:checks']), {})!;
    expect(oldGrant.checks).toBeUndefined();
    const permitted = projectContact(contact, GRANT, new Set<Capability>(['signet.contacts.read:directory', 'signet.contacts.read:check-records']), {})!;
    expect(permitted.checks).toEqual([{ pubkey: 'c'.repeat(64), method: 'words', checkedAt: 1700000000000 }]);
    expect(JSON.stringify(permitted)).not.toContain('private.example');
    expect(JSON.stringify(permitted)).not.toContain(OWNER);
  });
});

describe('private contact history', () => {
  it('never exports origin method, invite names, captions or app attribution under any capability', () => {
    const origin = { id: 'e'.repeat(32), ownerIdentityPubkey: OWNER, method: 'accepted-request' as const, addedAt: 12345,
      inviteId: 'b'.repeat(32), inviteName: 'Private conference name', caption: 'Private stored caption', appName: 'Private app attribution' };
    const output = JSON.stringify(projectContact(effective({ origins: [origin] }), GRANT, new Set(ALL), {}));
    expect(output).not.toContain('origins');
    for (const value of [origin.inviteName, origin.caption, origin.appName, origin.inviteId]) expect(output).not.toContain(value);
  });
});
