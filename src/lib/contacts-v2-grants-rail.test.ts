import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  grantsRailTag, toWireGrant, parseGrantsPayload, mergeGrantRegistry,
  isRegistryRicherThan, publishGrantsV2, fetchGrantsV2, GRANTS_RAIL_KIND,
} from './contacts-v2-grants-rail';
import { tagFor } from './contacts-v2-sync';
import { openVaultPayload } from './vault-envelope';
import * as syncRelays from './sync-relays';
import { LocalSigningBackend } from './signing-backend';
import { getSyncSeen, setSyncSeen } from './sync-seen';
import { MAX_APP_NAME, MAX_CAPABILITIES } from '@forgesworn/signet-contacts/wire';
import { CONTACT_GRANT_V2_CAP } from '../types';
import type { AppGrantV2, AppLabelEntry } from '../types';

const OWNER_SK = 'd'.repeat(63) + '1';
const owner = () => new LocalSigningBackend(OWNER_SK);
const RELAYS = ['wss://r.example'];

function grant(over: Partial<AppGrantV2> = {}): AppGrantV2 {
  return {
    grantId: 'f'.repeat(32), directoryId: 'owner', appPubkey: 'a'.repeat(64),
    createdAt: 100, updatedAt: 100, appName: 'Flock',
    capabilities: ['signet.contacts.read:directory'],
    railPubkey: 'b'.repeat(64), railPrivateKey: 'c'.repeat(64), relay: 'wss://r.example',
    maxStalenessSeconds: 21600, appLabels: {}, seenOperationIds: [], ...over,
  };
}

/** R-17: `appLabels` is `Record<string, AppLabelEntry>`, not a bare string map. */
function labelEntry(label: string, updatedAt = 1): AppLabelEntry {
  return { label, updatedAt };
}

/**
 * R-26 (Task 28, item 9): `mergeGrantRegistry` now returns
 * `{ grants, skippedRemote }`. Most cases below only care about the grants,
 * so they go through this; the cap-on-adopt cases call the real function and
 * assert `skippedRemote` themselves.
 */
const mergedGrants = (...args: Parameters<typeof mergeGrantRegistry>) => mergeGrantRegistry(...args).grants;

/** Real `fetchNewestFromRelays` return shape (I6) — `{ event, reachableRelays }`. */
function mockFetch(result: { event: unknown; reachableRelays: number }) {
  return vi.spyOn(syncRelays, 'fetchNewestFromRelays').mockResolvedValue(result as never);
}

afterEach(() => { vi.restoreAllMocks(); });

describe('grantsRailTag', () => {
  it('is 32 lowercase hex, deterministic, and domain-separated from the other rails', () => {
    const author = owner().activePublicKeyHex;
    const tag = grantsRailTag(author);
    expect(tag).toMatch(/^[0-9a-f]{32}$/);
    expect(grantsRailTag(author)).toBe(tag);
    expect(tag).not.toBe(tagFor(author, 'checkpoint'));
    expect(tag).not.toBe(tagFor(author, 'outbox'));
    expect(grantsRailTag('e'.repeat(64))).not.toBe(tag);
  });

  it('lowercases the author, like every other tag', () => {
    expect(grantsRailTag('A'.repeat(64))).toBe(grantsRailTag('a'.repeat(64)));
  });
});

describe('toWireGrant', () => {
  it('strips every device-local field, and keeps the rail key', () => {
    const wire = toWireGrant(grant({
      seenOperationIds: ['9'.repeat(32)], lastProjectionHash: 'a'.repeat(64),
      lastProjectionAt: 5, lastPublishState: 'truncated',
    }));
    const json = JSON.stringify(wire);
    expect(json).not.toContain('9'.repeat(32));
    expect(json).not.toContain('lastProjection');
    expect(json).not.toContain('lastPublishState');
    // R-3: the rail key IS on the rail. Without it a second device cannot
    // publish this grant at all, and the whole payload is sealed to the owner.
    expect(wire.railPrivateKey).toBe('c'.repeat(64));
  });

  it('caps app labels so ten grants cannot outgrow one envelope', () => {
    const labels: Record<string, AppLabelEntry> = {};
    for (let i = 0; i < 40; i += 1) labels[i.toString(16).padStart(32, '0')] = labelEntry('x'.repeat(300), i);
    const wire = toWireGrant(grant({ appLabels: labels }));
    expect(Object.keys(wire.appLabels)).toHaveLength(16);
    expect(Object.values(wire.appLabels)[0]?.label).toHaveLength(100);
  });

  // I2: WireGrantV2 is a Pick<> allow-list — proven at the runtime seal, not
  // just at the type level, so a stray/bogus property on the live object
  // (or a device-local field) cannot reach the wire even if the type were
  // ever loosened.
  it('I2: is an allow-list — a bogus extra property never reaches the wire', async () => {
    const bogus = {
      ...grant({
        seenOperationIds: ['9'.repeat(32)], lastProjectionHash: 'a'.repeat(64),
        lastProjectionAt: 5, lastPublishState: 'truncated',
      }),
      unexpectedSecret: 'do-not-ship-me',
    } as AppGrantV2;
    let published: { content: string } | null = null;
    vi.spyOn(syncRelays, 'publishToRelays').mockImplementation(async (event) => {
      published = { content: event.content };
      return true;
    });
    const backend = owner();
    const outcome = await publishGrantsV2({ grants: [bogus], now: 5, backend, relayUrls: RELAYS });
    expect(outcome).toBe('published');
    const plaintext = await openVaultPayload(published!.content, backend, backend.activePublicKeyHex, { legacyFallback: false });
    expect(plaintext).not.toContain('unexpectedSecret');
    expect(plaintext).not.toContain('do-not-ship-me');
    expect(plaintext).not.toContain('9'.repeat(32));
    expect(plaintext).not.toContain('lastProjection');
    expect(plaintext).not.toContain('lastPublishState');
  });

  // I1: a pre-R-17 row may have no `appLabels` field at all in memory.
  it('I1: tolerates a row with appLabels undefined', () => {
    const wire = toWireGrant({ ...grant(), appLabels: undefined as unknown as Record<string, AppLabelEntry> });
    expect(wire.appLabels).toEqual({});
  });
});

describe('parseGrantsPayload', () => {
  it('round-trips a well-formed payload', () => {
    const payload = JSON.stringify({ v: 2, kind: 'grants', createdAt: 5, grants: [toWireGrant(grant())] });
    expect(parseGrantsPayload(payload)?.grants).toHaveLength(1);
  });

  it('returns null for a broken envelope and drops an individually bad grant', () => {
    expect(parseGrantsPayload('{')).toBeNull();
    expect(parseGrantsPayload('[]')).toBeNull();
    expect(parseGrantsPayload(JSON.stringify({ v: 1, kind: 'grants', createdAt: 1, grants: [] }))).toBeNull();
    expect(parseGrantsPayload(JSON.stringify({ v: 2, kind: 'outbox', createdAt: 1, grants: [] }))).toBeNull();
    const mixed = JSON.stringify({
      v: 2, kind: 'grants', createdAt: 5,
      grants: [toWireGrant(grant()), { grantId: 'nope' }],
    });
    expect(parseGrantsPayload(mixed)?.grants).toHaveLength(1);
  });

  it('drops a grant with a malformed directoryId', () => {
    const payload = JSON.stringify({
      v: 2, kind: 'grants', createdAt: 5,
      grants: [{ ...toWireGrant(grant()), directoryId: 'not-a-real-directory' }],
    });
    expect(parseGrantsPayload(payload)?.grants).toHaveLength(0);
  });

  it('caps the number of ACTIVE grants read at CONTACT_GRANT_V2_CAP, but not revoked rows', () => {
    const activeMany = Array.from({ length: 40 }, (_, i) => toWireGrant(grant({ grantId: i.toString(16).padStart(32, '0') })));
    const payloadActive = JSON.stringify({ v: 2, kind: 'grants', createdAt: 5, grants: activeMany });
    expect(parseGrantsPayload(payloadActive)!.grants.length).toBeLessThanOrEqual(CONTACT_GRANT_V2_CAP);

    // C2: revoked rows are NOT capped at the same limit — only active grants are.
    const revokedMany = Array.from({ length: 40 }, (_, i) => toWireGrant(grant({
      grantId: (i + 100).toString(16).padStart(32, '0'), revokedAt: 1000 + i,
    })));
    const payloadRevoked = JSON.stringify({ v: 2, kind: 'grants', createdAt: 5, grants: revokedMany });
    expect(parseGrantsPayload(payloadRevoked)!.grants.length).toBe(40);
  });

  it('M2: drops a grant whose relay exceeds the length cap', () => {
    const payload = JSON.stringify({
      v: 2, kind: 'grants', createdAt: 1,
      grants: [{ ...toWireGrant(grant()), relay: `wss://${'a'.repeat(300)}.example` }],
    });
    expect(parseGrantsPayload(payload)?.grants).toHaveLength(0);
  });

  it('M1: label cap keeps highest-updatedAt entries, not wire/JSON key order', () => {
    const labels: Record<string, AppLabelEntry> = {};
    // Inserted in ASCENDING updatedAt order — if the parser capped by
    // iteration order it would keep the WRONG (oldest) 16 entries.
    for (let i = 0; i < 20; i += 1) labels[i.toString(16).padStart(32, '0')] = labelEntry(`v${i}`, i);
    const payload = JSON.stringify({
      v: 2, kind: 'grants', createdAt: 1,
      grants: [{ ...toWireGrant(grant()), appLabels: labels }],
    });
    const kept = parseGrantsPayload(payload)?.grants[0]?.appLabels ?? {};
    expect(Object.keys(kept)).toHaveLength(16);
    expect(kept[(0).toString(16).padStart(32, '0')]).toBeUndefined();
    expect(kept[(3).toString(16).padStart(32, '0')]).toBeUndefined();
    expect(kept[(19).toString(16).padStart(32, '0')]).toBeDefined();
    expect(kept[(4).toString(16).padStart(32, '0')]).toBeDefined();
  });

  it('M4: rejects hostile payloads without throwing', () => {
    expect(() => parseGrantsPayload('null')).not.toThrow();
    expect(parseGrantsPayload('null')).toBeNull();
    expect(() => parseGrantsPayload(JSON.stringify(['a', 'b']))).not.toThrow();
    expect(parseGrantsPayload(JSON.stringify(['a', 'b']))).toBeNull();

    // A `__proto__`-keyed grant, as it would arrive over the wire (a genuine
    // OWN property from JSON.parse, not prototype trickery) — must not
    // pollute Object.prototype and must not crash the parser.
    const wireGrantJson = JSON.stringify(toWireGrant(grant()));
    const hostileGrantJson = `{"__proto__":{"polluted":true},${wireGrantJson.slice(1)}`;
    const raw = `{"v":2,"kind":"grants","createdAt":1,"grants":[${hostileGrantJson}]}`;
    expect(() => parseGrantsPayload(raw)).not.toThrow();
    expect(parseGrantsPayload(raw)?.grants).toHaveLength(1);
    expect((Object.prototype as unknown as { polluted?: boolean }).polluted).toBeUndefined();

    const huge = JSON.stringify({ v: 2, kind: 'grants', createdAt: 1, grants: [{ grantId: 'x'.repeat(1_000_000) }] });
    expect(() => parseGrantsPayload(huge)).not.toThrow();
    expect(parseGrantsPayload(huge)?.grants).toHaveLength(0);
  });
});

describe('mergeGrantRegistry', () => {
  it('unions grants unknown to either side', () => {
    const merged = mergedGrants([grant()], [toWireGrant(grant({ grantId: 'e'.repeat(32) }))]);
    expect(merged.map((g) => g.grantId).sort()).toEqual(['e'.repeat(32), 'f'.repeat(32)].sort());
  });

  it('takes the newer record by updatedAt, not createdAt', () => {
    const merged = mergedGrants(
      [grant({ appName: 'Old', updatedAt: 100 })],
      [toWireGrant(grant({ appName: 'New', updatedAt: 200 }))],
    );
    expect(merged[0]?.appName).toBe('New');
  });

  it('keeps the local record when updatedAt ties', () => {
    expect(mergedGrants([grant({ appName: 'Local' })], [toWireGrant(grant({ appName: 'Remote' }))])[0]?.appName)
      .toBe('Local');
  });

  it('never un-revokes, and keeps the EARLIEST revocation', () => {
    expect(mergedGrants([grant({ updatedAt: 300 })], [toWireGrant(grant({ revokedAt: 150 }))])[0]?.revokedAt)
      .toBe(150);
    expect(mergedGrants([grant({ revokedAt: 200 })], [toWireGrant(grant({ revokedAt: 150 }))])[0]?.revokedAt)
      .toBe(150);
  });

  it('merges app labels rather than letting one side drop the other’s', () => {
    const merged = mergedGrants(
      [grant({ appLabels: { [`${'a'.repeat(32)}`]: labelEntry('Local', 10) } })],
      [toWireGrant(grant({ updatedAt: 200, appLabels: { [`${'b'.repeat(32)}`]: labelEntry('Remote', 20) } }))],
    );
    expect(merged[0]?.appLabels).toEqual({
      [`${'a'.repeat(32)}`]: labelEntry('Local', 10),
      [`${'b'.repeat(32)}`]: labelEntry('Remote', 20),
    });
  });

  it('M4: caps merged app labels at 16, highest-updatedAt first', () => {
    const localLabels: Record<string, AppLabelEntry> = {};
    for (let i = 0; i < 10; i += 1) localLabels[`a${i}`.padStart(32, '0')] = labelEntry(`local${i}`, i);
    const remoteLabels: Record<string, AppLabelEntry> = {};
    for (let i = 0; i < 10; i += 1) remoteLabels[`b${i}`.padStart(32, '0')] = labelEntry(`remote${i}`, 100 + i);
    const merged = mergedGrants(
      [grant({ appLabels: localLabels })],
      [toWireGrant(grant({ updatedAt: 100, appLabels: remoteLabels }))],
    );
    expect(Object.keys(merged[0]?.appLabels ?? {})).toHaveLength(16);
    // All 10 remote (higher updatedAt) survive; only 6 of the 10 local do.
    for (let i = 0; i < 10; i += 1) expect(merged[0]?.appLabels[`b${i}`.padStart(32, '0')]).toBeDefined();
  });

  it('keeps this device’s own replay memory and publish state, which the wire never carries', () => {
    const merged = mergedGrants(
      [grant({ seenOperationIds: ['9'.repeat(32)], lastProjectionHash: 'a'.repeat(64), lastPublishState: 'ok' })],
      [toWireGrant(grant({ updatedAt: 200, appName: 'New' }))],
    );
    expect(merged[0]?.appName).toBe('New');
    // A second device's replay window is its own — it has not seen our
    // proposals, and inheriting an empty one would let a replay through.
    expect(merged[0]?.seenOperationIds).toEqual(['9'.repeat(32)]);
    expect(merged[0]?.lastProjectionHash).toBe('a'.repeat(64));
    expect(merged[0]?.lastPublishState).toBe('ok');
  });

  it('drops a remote record with no rail private key rather than storing an unpublishable grant', () => {
    expect(mergedGrants([], [{ ...toWireGrant(grant()), railPrivateKey: '' }])).toEqual([]);
  });

  it('I4: takes railPubkey and railPrivateKey from the SAME side, never mixed', () => {
    // Remote "wins" on updatedAt but its rail key is empty — both fields
    // must fall back to local TOGETHER, never local's private key paired
    // with remote's declared pubkey.
    const merged = mergedGrants(
      [grant({ railPubkey: 'b'.repeat(64), railPrivateKey: 'c'.repeat(64) })],
      [toWireGrant(grant({ updatedAt: 200, railPubkey: 'd'.repeat(64), railPrivateKey: '' }))],
    );
    expect(merged[0]?.railPubkey).toBe('b'.repeat(64));
    expect(merged[0]?.railPrivateKey).toBe('c'.repeat(64));
  });

  it('I4: normal case takes both rail fields from the winner', () => {
    const merged = mergedGrants(
      [grant({ railPubkey: 'b'.repeat(64), railPrivateKey: 'c'.repeat(64) })],
      [toWireGrant(grant({ updatedAt: 200, railPubkey: 'd'.repeat(64), railPrivateKey: 'e'.repeat(64) }))],
    );
    expect(merged[0]?.railPubkey).toBe('d'.repeat(64));
    expect(merged[0]?.railPrivateKey).toBe('e'.repeat(64));
  });

  describe('I5/R-21: revoked-remote-only rows are never adopted', () => {
    it('a revoked remote-only grant is not adopted', () => {
      expect(mergedGrants([], [toWireGrant(grant({ revokedAt: 500 }))])).toEqual([]);
    });

    it('an active remote-only grant IS adopted', () => {
      const merged = mergedGrants([], [toWireGrant(grant())]);
      expect(merged).toHaveLength(1);
      expect(merged[0]?.grantId).toBe('f'.repeat(32));
    });

    it('local active + remote revoked (same grant) ⇒ revoked', () => {
      const merged = mergedGrants(
        [grant({ updatedAt: 100 })],
        [toWireGrant(grant({ updatedAt: 100, revokedAt: 150 }))],
      );
      expect(merged[0]?.revokedAt).toBe(150);
    });

    it('local revoked + remote newer-active (same grant) ⇒ stays revoked', () => {
      const merged = mergedGrants(
        [grant({ updatedAt: 100, revokedAt: 120 })],
        [toWireGrant(grant({ updatedAt: 200 }))],
      );
      expect(merged[0]?.revokedAt).toBe(120);
    });
  });

  it('M3: a revoked row never counts against the active cap', () => {
    const localGrants = Array.from({ length: 10 }, (_, i) => grant({ grantId: i.toString(16).padStart(32, '0'), updatedAt: i }));
    const revoked = grant({ grantId: 'ff'.padStart(32, '0'), revokedAt: 999 });
    const merged = mergedGrants([...localGrants, revoked], []);
    expect(merged).toHaveLength(11);
    expect(merged.some((g) => g.grantId === 'ff'.padStart(32, '0'))).toBe(true);
  });

  describe('R-23/R-26: the cap is enforced on adoption, never by deleting a local row', () => {
    const localId = (i: number) => i.toString(16).padStart(32, '0');
    const remoteId = (i: number) => (i + 100).toString(16).padStart(32, '0');

    it('R-23: keeps every local ACTIVE grant even when the remote payload is full of newer ones', () => {
      // Twelve local actives (all older) against twelve remote-only actives
      // (all newer). The old post-merge cap deleted the ten oldest LOCAL rows
      // — destroying their only copy of a rail private key — to make room.
      const localGrants = Array.from({ length: 12 }, (_, i) => grant({ grantId: localId(i), updatedAt: i }));
      const remoteGrants = Array.from({ length: 12 }, (_, i) => toWireGrant(grant({ grantId: remoteId(i), updatedAt: 1000 + i })));

      const { grants, skippedRemote } = mergeGrantRegistry(localGrants, remoteGrants);

      for (let i = 0; i < 12; i += 1) {
        expect(grants.some((g) => g.grantId === localId(i))).toBe(true);
      }
      // Already past the cap on local rows alone, so nothing remote is adopted
      // and every one of the twelve is reported rather than dropped in silence.
      expect(grants).toHaveLength(12);
      expect(skippedRemote).toBe(12);
    });

    it('R-26: adopts remote-only actives most-recently-updated first, only up to the cap', () => {
      // Eight local actives leaves room for exactly two more.
      const localGrants = Array.from({ length: 8 }, (_, i) => grant({ grantId: localId(i), updatedAt: i }));
      const remoteGrants = Array.from({ length: 5 }, (_, i) => toWireGrant(grant({ grantId: remoteId(i), updatedAt: 1000 + i })));

      const { grants, skippedRemote } = mergeGrantRegistry(localGrants, remoteGrants);

      expect(grants).toHaveLength(CONTACT_GRANT_V2_CAP);
      expect(skippedRemote).toBe(3);
      // The two adopted are the NEWEST two (remote indices 4 and 3), not the
      // first two the array happened to carry.
      expect(grants.some((g) => g.grantId === remoteId(4))).toBe(true);
      expect(grants.some((g) => g.grantId === remoteId(3))).toBe(true);
      for (const i of [0, 1, 2]) expect(grants.some((g) => g.grantId === remoteId(i))).toBe(false);
    });

    it('does not count a refused revoked remote-only row, or one with no usable rail key, as skipped', () => {
      const localGrants = Array.from({ length: 10 }, (_, i) => grant({ grantId: localId(i), updatedAt: i }));
      const { grants, skippedRemote } = mergeGrantRegistry(localGrants, [
        toWireGrant(grant({ grantId: remoteId(0), revokedAt: 500 })),
        { ...toWireGrant(grant({ grantId: remoteId(1) })), railPrivateKey: '' },
      ]);
      expect(grants).toHaveLength(10);
      // Neither was turned away by the cap: one is a revocation this device
      // deliberately never adopts (R-21), the other could never publish.
      expect(skippedRemote).toBe(0);
    });

    it('the wire build still carries at most CONTACT_GRANT_V2_CAP active grants', async () => {
      let published: { content: string } | null = null;
      vi.spyOn(syncRelays, 'publishToRelays').mockImplementation(async (event) => {
        published = { content: event.content };
        return true;
      });
      const backend = owner();
      // Twelve local actives — legitimately held after an R-23 merge, and
      // more than the rail may publish.
      const grants = Array.from({ length: 12 }, (_, i) => grant({ grantId: localId(i), updatedAt: 100 + i }));
      expect(await publishGrantsV2({ grants, now: 5, backend, relayUrls: RELAYS })).toBe('published');

      const plaintext = await openVaultPayload(published!.content, backend, backend.activePublicKeyHex, { legacyFallback: false });
      const parsed = parseGrantsPayload(plaintext!);
      expect(parsed?.grants).toHaveLength(CONTACT_GRANT_V2_CAP);
      // Most recently updated first: the two oldest are the ones left off.
      expect(parsed?.grants.some((g) => g.grantId === localId(0))).toBe(false);
      expect(parsed?.grants.some((g) => g.grantId === localId(1))).toBe(false);
      expect(parsed?.grants.some((g) => g.grantId === localId(11))).toBe(true);
    });
  });
});

describe('isRegistryRicherThan (R-25)', () => {
  it('is false when the merged registry matches the remote payload exactly', () => {
    expect(isRegistryRicherThan([grant()], [toWireGrant(grant())])).toBe(false);
  });

  it('is false when the remote carries a revoked row this device never adopted (R-21)', () => {
    // The merged registry is DIFFERENT from the remote one — the remote has a
    // row we deliberately refused — but it is not RICHER, so republishing
    // would overwrite the relay's record with a poorer one and flap.
    const remote = [toWireGrant(grant()), toWireGrant(grant({ grantId: 'e'.repeat(32), revokedAt: 500 }))];
    expect(isRegistryRicherThan([grant()], remote)).toBe(false);
  });

  it('is true for a grant the remote lacks', () => {
    expect(isRegistryRicherThan([grant(), grant({ grantId: 'e'.repeat(32) })], [toWireGrant(grant())])).toBe(true);
  });

  it('is true for a newer updatedAt', () => {
    expect(isRegistryRicherThan([grant({ updatedAt: 200 })], [toWireGrant(grant({ updatedAt: 100 }))])).toBe(true);
  });

  it('is true for a revocation the remote lacks, or dates later', () => {
    expect(isRegistryRicherThan([grant({ revokedAt: 500 })], [toWireGrant(grant())])).toBe(true);
    expect(isRegistryRicherThan([grant({ revokedAt: 400 })], [toWireGrant(grant({ revokedAt: 500 }))])).toBe(true);
    expect(isRegistryRicherThan([grant({ revokedAt: 500 })], [toWireGrant(grant({ revokedAt: 400 }))])).toBe(false);
  });

  it('is true for an app label the remote lacks or holds an older version of', () => {
    const key = 'a'.repeat(32);
    expect(isRegistryRicherThan(
      [grant({ appLabels: { [key]: labelEntry('Coach', 20) } })],
      [toWireGrant(grant())],
    )).toBe(true);
    expect(isRegistryRicherThan(
      [grant({ appLabels: { [key]: labelEntry('Coach', 20) } })],
      [toWireGrant(grant({ appLabels: { [key]: labelEntry('Old', 10) } }))],
    )).toBe(true);
    expect(isRegistryRicherThan(
      [grant({ appLabels: { [key]: labelEntry('Coach', 20) } })],
      [toWireGrant(grant({ appLabels: { [key]: labelEntry('Coach', 20) } }))],
    )).toBe(false);
  });
});

describe('publishGrantsV2 / fetchGrantsV2', () => {
  it('seals to self under the grants tag and reads back what it wrote', async () => {
    let published: { content: string; tags: string[][] } | null = null;
    vi.spyOn(syncRelays, 'publishToRelays').mockImplementation(async (event) => {
      published = { content: event.content, tags: event.tags };
      return true;
    });
    const backend = owner();
    expect(await publishGrantsV2({ grants: [grant()], now: 5, backend, relayUrls: RELAYS })).toBe('published');
    expect(published!.tags).toEqual([['d', grantsRailTag(backend.activePublicKeyHex)]]);
    const plaintext = await openVaultPayload(
      published!.content, backend, backend.activePublicKeyHex, { legacyFallback: false },
    );
    expect(parseGrantsPayload(plaintext!)?.grants[0]?.grantId).toBe('f'.repeat(32));

    mockFetch({
      event: { kind: GRANTS_RAIL_KIND, pubkey: backend.activePublicKeyHex, content: published!.content, tags: published!.tags, created_at: 5, id: '0'.repeat(64), sig: '1'.repeat(128) },
      reachableRelays: 1,
    });
    const read = await fetchGrantsV2({ authorPubkey: backend.activePublicKeyHex, backend, relayUrls: RELAYS });
    expect(read.payload?.grants).toHaveLength(1);
    expect(read.remoteState).toBe('present');
  });

  it('returns "empty" for an information-free registry, and never publishes', async () => {
    const publish = vi.spyOn(syncRelays, 'publishToRelays').mockResolvedValue(true);
    expect(await publishGrantsV2({ grants: [], now: 5, backend: owner(), relayUrls: RELAYS })).toBe('empty');
    expect(publish).not.toHaveBeenCalled();
  });

  it('returns "failed" without a usable relay', async () => {
    const publish = vi.spyOn(syncRelays, 'publishToRelays').mockResolvedValue(true);
    expect(await publishGrantsV2({ grants: [grant()], now: 5, backend: owner(), relayUrls: ['http://nope'] })).toBe('failed');
    expect(publish).not.toHaveBeenCalled();
  });

  it('M4: created_at is strictly monotonic across two publishes in the same second', async () => {
    vi.spyOn(syncRelays, 'publishToRelays').mockResolvedValue(true);
    const backend = owner();
    const seen: number[] = [];
    const realSign = backend.signEvent.bind(backend);
    vi.spyOn(backend, 'signEvent').mockImplementation(async (event) => {
      seen.push(event.created_at);
      return realSign(event);
    });
    await publishGrantsV2({ grants: [grant()], now: 5, backend, relayUrls: RELAYS });
    await publishGrantsV2({ grants: [grant()], now: 5, backend, relayUrls: RELAYS });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBeGreaterThan(seen[0]);
  });

  it('I3: a millisecond-scale or fractional `now` falls back to the real clock rather than poisoning the counter', async () => {
    vi.spyOn(syncRelays, 'publishToRelays').mockResolvedValue(true);
    const backend = owner();
    const seen: number[] = [];
    const realSign = backend.signEvent.bind(backend);
    vi.spyOn(backend, 'signEvent').mockImplementation(async (event) => {
      seen.push(event.created_at);
      return realSign(event);
    });
    const nowSeconds = Math.floor(Date.now() / 1000);
    await publishGrantsV2({ grants: [grant()], now: Date.now(), backend, relayUrls: RELAYS }); // ms-scale
    await publishGrantsV2({ grants: [grant()], now: 5.5, backend, relayUrls: RELAYS }); // fractional
    expect(seen[0]).toBeGreaterThanOrEqual(nowSeconds);
    expect(seen[0]).toBeLessThan(1e11);
    expect(seen[1]).toBeGreaterThan(seen[0]);
  });

  describe('C2/R-20: byte-fitted bounds', () => {
    function bigGrant(i: number, over: Partial<AppGrantV2> = {}): AppGrantV2 {
      const appLabels: Record<string, AppLabelEntry> = {};
      for (let j = 0; j < 16; j += 1) {
        appLabels[(i * 16 + j).toString(16).padStart(32, '0')] = labelEntry('字'.repeat(100), 1000 + j);
      }
      return grant({
        grantId: i.toString(16).padStart(32, '0'),
        directoryId: `dependant:${'d'.repeat(64)}`,
        appName: '字'.repeat(64),
        capabilities: [
          'signet.contacts.read:directory', 'signet.contacts.read:method:email', 'signet.contacts.read:roles',
          'signet.contacts.blocks.read', 'signet.contacts.propose:add-ken', 'signet.contacts.propose:rename-app-label',
        ],
        updatedAt: 100 + i,
        appLabels,
        ...over,
      });
    }

    it('drops labels (lowest-updatedAt-first) until 10 maxed-out active grants fit, and outcome is "published"', async () => {
      let published: { content: string } | null = null;
      vi.spyOn(syncRelays, 'publishToRelays').mockImplementation(async (event) => {
        published = { content: event.content };
        return true;
      });
      const backend = owner();
      const grants = Array.from({ length: 10 }, (_, i) => bigGrant(i));
      const outcome = await publishGrantsV2({ grants, now: 5, backend, relayUrls: RELAYS });
      expect(outcome).toBe('published');

      const plaintext = await openVaultPayload(published!.content, backend, backend.activePublicKeyHex, { legacyFallback: false });
      const parsed = parseGrantsPayload(plaintext!);
      expect(parsed?.grants).toHaveLength(10);
      const totalLabels = (parsed?.grants ?? []).reduce((n, g) => n + Object.keys(g.appLabels).length, 0);
      // 10 grants x 16 labels = 160 originally; some MUST have been dropped
      // to fit one envelope, but every active grant itself survives.
      expect(totalLabels).toBeLessThan(160);
      const ids = new Set(parsed?.grants.map((g) => g.grantId));
      for (let i = 0; i < 10; i += 1) expect(ids.has(i.toString(16).padStart(32, '0'))).toBe(true);
    });

    it('drops revoked rows (oldest-first) before ever touching an active grant — and drops exactly the oldest', async () => {
      let published: { content: string } | null = null;
      vi.spyOn(syncRelays, 'publishToRelays').mockImplementation(async (event) => {
        published = { content: event.content };
        return true;
      });
      const backend = owner();
      // Item 6: the bulk comes from maxed-out `appLabels`, NOT from an
      // oversized `relay` — since item 5 the build path drops an over-long
      // relay outright, so the original fixture would have proven nothing
      // about drop ORDER. Every relay here is well inside `MAX_RELAY_LEN`.
      const active = [grant({ grantId: '0'.repeat(32) })];
      const revoked = Array.from({ length: 12 }, (_, i) => bigGrant(i + 1, { revokedAt: 1000 + i }));
      const outcome = await publishGrantsV2({ grants: [...active, ...revoked], now: 5, backend, relayUrls: RELAYS });
      expect(outcome).toBe('published');

      const plaintext = await openVaultPayload(published!.content, backend, backend.activePublicKeyHex, { legacyFallback: false });
      const parsed = parseGrantsPayload(plaintext!);
      // The one active grant ALWAYS survives.
      expect(parsed?.grants.some((g) => g.grantId === '0'.repeat(32))).toBe(true);

      const survivors = (parsed?.grants ?? [])
        .filter((g) => g.revokedAt !== undefined)
        .map((g) => g.revokedAt as number)
        .sort((a, b) => a - b);
      // Some had to go, but not all of them — otherwise the assertion below
      // would hold vacuously.
      expect(survivors.length).toBeGreaterThan(0);
      expect(survivors.length).toBeLessThan(12);
      // WHICH ones survived: exactly the most recently revoked, in a
      // contiguous block from the newest end. Oldest-first means the survivors
      // are the top `survivors.length` of [1000..1011], nothing else.
      const expected = Array.from({ length: 12 }, (_, i) => 1000 + i).slice(-survivors.length);
      expect(survivors).toEqual(expected);
    });

    it('item 5: drops a grant whose relay exceeds MAX_RELAY_LEN from the wire rather than publishing an unreadable row', async () => {
      let published: { content: string } | null = null;
      vi.spyOn(syncRelays, 'publishToRelays').mockImplementation(async (event) => {
        published = { content: event.content };
        return true;
      });
      const backend = owner();
      // `parseWireGrant` already refuses an over-long relay on READ (M2), so
      // publishing one produces a registry that every reader — including this
      // device after its next restart — silently discards that row from. A
      // deterministic drop at build time is the honest version of the same
      // bound.
      const outcome = await publishGrantsV2({
        grants: [
          grant({ grantId: '0'.repeat(32) }),
          grant({ grantId: '1'.repeat(32), relay: `wss://${'x'.repeat(300)}.example` }),
        ],
        now: 5,
        backend,
        relayUrls: RELAYS,
      });
      expect(outcome).toBe('published');

      const plaintext = await openVaultPayload(published!.content, backend, backend.activePublicKeyHex, { legacyFallback: false });
      expect(parseGrantsPayload(plaintext!)?.grants.map((g) => g.grantId)).toEqual(['0'.repeat(32)]);
    });

    it('item 5: a registry of nothing BUT over-long relays is "empty", never a published husk', async () => {
      const publish = vi.spyOn(syncRelays, 'publishToRelays').mockResolvedValue(true);
      const outcome = await publishGrantsV2({
        grants: [grant({ relay: `wss://${'x'.repeat(300)}.example` })],
        now: 5,
        backend: owner(),
        relayUrls: RELAYS,
      });
      expect(outcome).toBe('empty');
      expect(publish).not.toHaveBeenCalled();
    });

    it('R-27: the largest legitimate registry never reaches "too-large" — it drops labels and publishes', async () => {
      // Replaces the old active-only-overflow test, which manufactured its
      // overflow from an 8000-character `appName`. Since R-27 that is bounded
      // to `MAX_APP_NAME` on BUILD, so the fixture no longer overflows
      // anything — and, more to the point, there is no longer any legitimate
      // way to reach `'too-large'` at all. This proves that positively rather
      // than deleting the coverage: every bound at once, `CONTACT_GRANT_V2_CAP`
      // grants of it, and the label-drop pass still lands on `'published'`.
      let published: { content: string } | null = null;
      vi.spyOn(syncRelays, 'publishToRelays').mockImplementation(async (event) => {
        published = { content: event.content };
        return true;
      });
      const backend = owner();
      const grants = Array.from({ length: CONTACT_GRANT_V2_CAP }, (_, i) => bigGrant(i, {
        // Every remaining bound, maxed simultaneously: a relay exactly at
        // `MAX_RELAY_LEN` (256), and every capability the SDK defines.
        // `bigGrant` already supplies a `MAX_APP_NAME` CJK `appName`, a
        // longest-form `dependant:<64 hex>` directory id and 16 labels of 100
        // CJK characters each.
        relay: `wss://${'x'.repeat(256 - 'wss://'.length - '.example'.length)}.example`,
      }));
      expect(grants[0].relay).toHaveLength(256);

      const outcome = await publishGrantsV2({ grants, now: 5, backend, relayUrls: RELAYS });
      expect(outcome).toBe('published');

      // Everything the owner would lose by not publishing is on the wire: all
      // ten grants, each with its rail key. Only labels — the one thing the
      // shrink order is allowed to sacrifice — were trimmed.
      const plaintext = await openVaultPayload(published!.content, backend, backend.activePublicKeyHex, { legacyFallback: false });
      const parsed = parseGrantsPayload(plaintext!);
      expect(parsed?.grants).toHaveLength(CONTACT_GRANT_V2_CAP);
      for (const g of parsed?.grants ?? []) expect(g.railPrivateKey).toBe('c'.repeat(64));
      const totalLabels = (parsed?.grants ?? []).reduce((n, g) => n + Object.keys(g.appLabels).length, 0);
      expect(totalLabels).toBeLessThan(CONTACT_GRANT_V2_CAP * 16);
    });
  });

  describe('R-27: every read-side bound is applied on build too', () => {
    it('truncates appName to MAX_APP_NAME rather than publishing a row the parser drops', async () => {
      const wire = toWireGrant(grant({ appName: 'x'.repeat(500) }));
      expect(wire.appName).toHaveLength(MAX_APP_NAME);
      // The published row survives its own parser — which is the whole point.
      const payload = JSON.stringify({ v: 2, kind: 'grants', createdAt: 5, grants: [wire] });
      expect(parseGrantsPayload(payload)?.grants).toHaveLength(1);
    });

    it('normalises and caps capabilities, dropping duplicates and anything unrecognised', () => {
      const wire = toWireGrant(grant({
        capabilities: [
          'signet.contacts.read:directory',
          'signet.contacts.read:directory',
          'signet.contacts.read:roles',
          'not-a-capability',
        ] as unknown as AppGrantV2['capabilities'],
      }));
      expect(wire.capabilities).toEqual(['signet.contacts.read:directory', 'signet.contacts.read:roles']);
      expect(wire.capabilities.length).toBeLessThanOrEqual(MAX_CAPABILITIES);
    });

    it('tolerates a row with capabilities undefined, the way it tolerates absent appLabels', () => {
      const wire = toWireGrant({ ...grant(), capabilities: undefined as unknown as AppGrantV2['capabilities'] });
      expect(wire.capabilities).toEqual([]);
    });

    it('a built wire grant always round-trips through the parser unchanged', () => {
      // The R-27 invariant stated directly: build then parse is the identity,
      // so nothing this rail publishes can be silently dropped on read.
      const wire = toWireGrant(grant({
        appName: '字'.repeat(300),
        capabilities: ['signet.contacts.read:roles', 'signet.contacts.read:directory'],
      }));
      const payload = JSON.stringify({ v: 2, kind: 'grants', createdAt: 5, grants: [wire] });
      expect(parseGrantsPayload(payload)?.grants[0]).toEqual(wire);
    });
  });

  describe('C1/Phase D R9: fetch classification', () => {
    it('a found-but-undecryptable event is "present" with a null payload, never "missing-after-seen", and still records syncSeen', async () => {
      const backend = new LocalSigningBackend('2'.repeat(63) + '1');
      const dTag = grantsRailTag(backend.activePublicKeyHex);
      mockFetch({
        event: {
          kind: GRANTS_RAIL_KIND, pubkey: backend.activePublicKeyHex, content: 'not-a-valid-envelope',
          tags: [['d', dTag]], created_at: 5, id: '2'.repeat(64), sig: '3'.repeat(128),
        },
        reachableRelays: 1,
      });
      const read = await fetchGrantsV2({ authorPubkey: backend.activePublicKeyHex, backend, relayUrls: RELAYS });
      expect(read.payload).toBeNull();
      expect(read.remoteState).toBe('present');
      // Item 6: an unreadable-but-PRESENT event is still evidence a backup
      // exists. Recording it is what lets a LATER genuinely-missing fetch say
      // `missing-after-seen` instead of `never-seen` — without this write the
      // "your backup has gone" signal would never fire for a device that only
      // ever saw the registry through a failed decrypt.
      expect(await getSyncSeen(backend.activePublicKeyHex, dTag)).toEqual({ eventId: '2'.repeat(64), createdAt: 5 });
    });

    it('reports unreachable rather than empty when the pool cannot answer', async () => {
      mockFetch({ event: null, reachableRelays: 0 });
      const read = await fetchGrantsV2({ authorPubkey: owner().activePublicKeyHex, backend: owner(), relayUrls: RELAYS });
      expect(read.payload).toBeNull();
      expect(read.remoteState).toBe('unreachable');
    });

    it('reports never-seen when the pool is reachable but nothing has ever been recorded for this tag', async () => {
      const backend = new LocalSigningBackend('e'.repeat(63) + '1');
      mockFetch({ event: null, reachableRelays: 1 });
      const read = await fetchGrantsV2({ authorPubkey: backend.activePublicKeyHex, backend, relayUrls: RELAYS });
      expect(read.payload).toBeNull();
      expect(read.remoteState).toBe('never-seen');
    });

    it('reports missing-after-seen when a prior fetch recorded this tag and it is now gone', async () => {
      const backend = new LocalSigningBackend('a'.repeat(63) + '2');
      const dTag = grantsRailTag(backend.activePublicKeyHex);
      await setSyncSeen(backend.activePublicKeyHex, dTag, { eventId: '4'.repeat(64), createdAt: 1 });
      mockFetch({ event: null, reachableRelays: 1 });
      const read = await fetchGrantsV2({ authorPubkey: backend.activePublicKeyHex, backend, relayUrls: RELAYS });
      expect(read.payload).toBeNull();
      expect(read.remoteState).toBe('missing-after-seen');
    });

    it('rejects an event whose d tag does not match the one queried for (a misbehaving relay)', async () => {
      const backend = new LocalSigningBackend('b'.repeat(63) + '3');
      mockFetch({
        event: {
          kind: GRANTS_RAIL_KIND, pubkey: backend.activePublicKeyHex, content: 'irrelevant',
          tags: [['d', 'f'.repeat(32)]], created_at: 5, id: '5'.repeat(64), sig: '6'.repeat(128),
        },
        reachableRelays: 1,
      });
      const read = await fetchGrantsV2({ authorPubkey: backend.activePublicKeyHex, backend, relayUrls: RELAYS });
      expect(read.payload).toBeNull();
      expect(read.remoteState).toBe('never-seen');
    });

    it('M4: records syncSeen on a successful read', async () => {
      let published: { content: string; tags: string[][] } | null = null;
      vi.spyOn(syncRelays, 'publishToRelays').mockImplementation(async (event) => {
        published = { content: event.content, tags: event.tags };
        return true;
      });
      const backend = new LocalSigningBackend('c'.repeat(63) + '4');
      await publishGrantsV2({ grants: [grant()], now: 5, backend, relayUrls: RELAYS });
      const dTag = grantsRailTag(backend.activePublicKeyHex);
      mockFetch({
        event: { kind: GRANTS_RAIL_KIND, pubkey: backend.activePublicKeyHex, content: published!.content, tags: published!.tags, created_at: 9, id: '7'.repeat(64), sig: '8'.repeat(128) },
        reachableRelays: 1,
      });
      await fetchGrantsV2({ authorPubkey: backend.activePublicKeyHex, backend, relayUrls: RELAYS });
      expect(await getSyncSeen(backend.activePublicKeyHex, dTag)).toEqual({ eventId: '7'.repeat(64), createdAt: 9 });
    });
  });
});

it('preserves one identity through the private grant rail and rejects re-scoping while honouring revocation', () => {
  const local = grant({ ownerIdentityPubkey: '1'.repeat(64) });
  const wire = toWireGrant(local);
  expect(wire.ownerIdentityPubkey).toBe('1'.repeat(64));
  const merged = mergeGrantRegistry([local], [{ ...wire, ownerIdentityPubkey: '2'.repeat(64), updatedAt: 200, revokedAt: 150 }]);
  expect(merged.grants[0].ownerIdentityPubkey).toBe('1'.repeat(64));
  expect(merged.grants[0].revokedAt).toBe(150);
});

it('backs up the per-app auto-accept switch and resolves equal-clock disagreement to manual acceptance', () => {
  const disabled = grant({ autoAcceptInvites: false, updatedAt: 101 });
  const wire = toWireGrant(disabled);
  expect(wire.autoAcceptInvites).toBe(false);
  expect(isRegistryRicherThan([disabled], [toWireGrant(grant({ autoAcceptInvites: true, updatedAt: 101 }))])).toBe(true);
  const parsed = parseGrantsPayload(JSON.stringify({ v: 2, kind: 'grants', createdAt: 101, grants: [wire] }));
  expect(parsed?.grants[0].autoAcceptInvites).toBe(false);
  const enabled = grant({ autoAcceptInvites: true, updatedAt: 101 });
  expect(mergedGrants([enabled], [wire])[0].autoAcceptInvites).toBe(false);
  expect(mergedGrants([disabled], [toWireGrant(enabled)])[0].autoAcceptInvites).toBe(false);
});
