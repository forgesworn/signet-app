import { describe, it, expect, vi } from 'vitest'

// C1/I1 — companion-rail.ts calls db.saveCompanionGrant / db.deleteCompanionGrant
// (via `import * as db from './db'`). Mock the module so the revokeCompanionGrant
// branch tests below don't need a real IndexedDB/fake-indexeddb setup — this
// file otherwise only exercises companion-rail.ts's pure/network-free logic.
vi.mock('./db', () => ({
  saveCompanionGrant: vi.fn(async () => {}),
  deleteCompanionGrant: vi.fn(async () => {}),
}))

// I1 — mock the relay transport so the revokeCompanionGrant *success* branch
// (tombstone publish ok -> kind-5 -> delete) is reachable without a live
// relay. Same pattern as nip46.connect-response.test.ts. The *failure*
// branch test below instead uses an invalid relay URL, which fails
// `isValidRelayUrl` before ever touching this mock.
const relayMock = vi.hoisted(() => ({
  published: [] as Array<{ relayUrl: string; event: unknown }>,
}))
vi.mock('signet-protocol', async () => {
  const actual = await vi.importActual<typeof import('signet-protocol')>('signet-protocol')
  return {
    ...actual,
    RelayClient: class MockRelayClient {
      constructor(private readonly relayUrl: string) {}
      async connect(): Promise<void> {}
      async publish(event: unknown): Promise<{ ok: boolean }> {
        relayMock.published.push({ relayUrl: this.relayUrl, event })
        return { ok: true }
      }
      disconnect(): void {}
    },
  }
})

import { deriveRailKeypair, filterByScope, hashSnapshot, buildSnapshotEvent, revokeCompanionGrant } from './companion-rail'
import * as db from './db'
import { deriveKeypair } from './signet'
import type { KindredEntry } from '@forgesworn/kenspeckle'
import { toGrantView, parseGrantEnvelope, GRANT_CONTACTS_CAP } from '@forgesworn/kenspeckle'
import type { CompanionGrant } from '../types'

// A valid BIP-39 test mnemonic (12 words).
const MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
const APP_A = 'a'.repeat(64)
const APP_B = 'b'.repeat(64)

describe('deriveRailKeypair', () => {
  it('is deterministic for the same (mnemonic, appPubkey)', () => {
    expect(deriveRailKeypair(MNEMONIC, APP_A)).toEqual(deriveRailKeypair(MNEMONIC, APP_A))
  })
  it('differs per app', () => {
    expect(deriveRailKeypair(MNEMONIC, APP_A).publicKey).not.toBe(deriveRailKeypair(MNEMONIC, APP_B).publicKey)
  })
  it('is never the natural-person key', () => {
    const np = deriveKeypair(MNEMONIC, 'natural-person')
    expect(deriveRailKeypair(MNEMONIC, APP_A).publicKey).not.toBe(np.publicKey)
  })
  it('returns 64-hex keys', () => {
    const k = deriveRailKeypair(MNEMONIC, APP_A)
    expect(k.publicKey).toMatch(/^[0-9a-f]{64}$/)
    expect(k.privateKey).toMatch(/^[0-9a-f]{64}$/)
  })
})

const OWNER1 = '1'.repeat(64)
const OWNER2 = '2'.repeat(64)
const entries: KindredEntry[] = [
  { pubkey: 'a'.repeat(64), ownerPubkey: OWNER1, tier: 'kin', addedAt: 1, verifiedAt: 1, sharedSecret: 's', relationship: 'parent', displayName: 'Mum' } as KindredEntry,
  { pubkey: 'b'.repeat(64), ownerPubkey: OWNER1, tier: 'kith', addedAt: 2, verifiedAt: 2, sharedSecret: 's', displayName: 'Sam' } as KindredEntry,
  { pubkey: 'c'.repeat(64), ownerPubkey: OWNER2, tier: 'ken', addedAt: 3, provenance: { source: 'manual', locator: 'x', confirmedAt: 3 } } as KindredEntry,
]

describe('filterByScope', () => {
  it('filters by tier', () => {
    const out = filterByScope(entries, { tiers: ['kin'], personas: 'all' })
    expect(out.map(e => e.tier)).toEqual(['kin'])
  })
  it('filters by persona allowlist', () => {
    const out = filterByScope(entries, { tiers: ['kin', 'kith', 'ken'], personas: [OWNER2] })
    expect(out.map(e => e.ownerPubkey)).toEqual([OWNER2])
  })
  it("'all' personas returns every tier-matching entry", () => {
    expect(filterByScope(entries, { tiers: ['kin', 'kith', 'ken'], personas: 'all' })).toHaveLength(3)
  })

  // kenspeckle 0.2.0's buildGrantEnvelope throws over GRANT_CONTACTS_CAP (5000)
  // contacts rather than trimming — filterByScope must cap deterministically
  // (most-recently-added first, pubkey tiebreak) so the same over-cap scope
  // always yields the same trimmed set on any device.
  describe('over the contacts cap', () => {
    function overCapEntries(n: number): KindredEntry[] {
      const out: KindredEntry[] = []
      for (let i = 0; i < n; i++) {
        out.push({
          pubkey: i.toString(16).padStart(64, '0'),
          ownerPubkey: OWNER1,
          tier: 'ken',
          addedAt: i,
          provenance: { source: 'manual', locator: 'x', confirmedAt: i },
        } as KindredEntry)
      }
      return out
    }

    it('caps the result at GRANT_CONTACTS_CAP', () => {
      const out = filterByScope(overCapEntries(GRANT_CONTACTS_CAP + 250), { tiers: ['ken'], personas: 'all' })
      expect(out).toHaveLength(GRANT_CONTACTS_CAP)
    })

    it('keeps the most-recently-added entries first', () => {
      const all = overCapEntries(GRANT_CONTACTS_CAP + 250)
      const out = filterByScope(all, { tiers: ['ken'], personas: 'all' })
      // addedAt runs 0..GRANT_CONTACTS_CAP+249; the kept set is the top
      // GRANT_CONTACTS_CAP by addedAt, i.e. addedAt >= 250.
      expect(Math.min(...out.map(e => e.addedAt))).toBe(250)
      expect(out.every(e => e.addedAt >= 250)).toBe(true)
    })

    it('is deterministic across repeated calls on the same input', () => {
      const all = overCapEntries(GRANT_CONTACTS_CAP + 10)
      const a = filterByScope(all, { tiers: ['ken'], personas: 'all' }).map(e => e.pubkey)
      const b = filterByScope(all, { tiers: ['ken'], personas: 'all' }).map(e => e.pubkey)
      expect(a).toEqual(b)
    })

    it('does not trim when at or under the cap', () => {
      expect(filterByScope(overCapEntries(GRANT_CONTACTS_CAP), { tiers: ['ken'], personas: 'all' })).toHaveLength(GRANT_CONTACTS_CAP)
    })

    // R5 — the tiebreak must be the same function on every device: plain
    // code-point string comparison (`a < b ? -1 : a > b ? 1 : 0`), never
    // `localeCompare`, whose collation can vary by locale/runtime. Chained
    // ownerPubkey -> tier -> pubkey so a full addedAt tie still resolves
    // deterministically at every level.
    describe('tiebreak ordering (addedAt ties)', () => {
      // A dedicated filler distinct from every tied-set field used below
      // (ownerPubkey OWNER2, addedAt >= 1) so it never contends for the
      // single contested slot at addedAt 0 and the assertions test only
      // the tiebreak in question, not an accidental filler collision.
      function filler(n: number): KindredEntry[] {
        const out: KindredEntry[] = []
        for (let i = 0; i < n; i++) {
          out.push({
            pubkey: (i + 1).toString(16).padStart(64, '0'),
            ownerPubkey: OWNER2,
            tier: 'ken',
            addedAt: i + 1,
            provenance: { source: 'manual', locator: 'x', confirmedAt: i },
          } as KindredEntry)
        }
        return out
      }

      it('breaks an addedAt tie by ownerPubkey, ascending', () => {
        const tied = ['b'.repeat(64), 'a'.repeat(64), 'c'.repeat(64)].map(owner => ({
          pubkey: 'f'.repeat(64), ownerPubkey: owner, tier: 'ken', addedAt: 0,
          provenance: { source: 'manual', locator: 'x', confirmedAt: 0 },
        } as KindredEntry))
        const rest = filler(GRANT_CONTACTS_CAP - 1) // addedAt 1..CAP-1, all guaranteed kept
        const out = filterByScope([...rest, ...tied], { tiers: ['ken'], personas: 'all' })
        expect(out).toHaveLength(GRANT_CONTACTS_CAP)
        // Only one slot is left for the three addedAt-0 entries above — the
        // one with the lexicographically smallest ownerPubkey wins it.
        const survivor = out.find(e => e.addedAt === 0 && e.pubkey === 'f'.repeat(64))
        expect(survivor?.ownerPubkey).toBe('a'.repeat(64))
      })

      it('breaks an addedAt + ownerPubkey tie by tier, ascending code-point order (ken < kin < kith)', () => {
        const tied = (['kith', 'ken', 'kin'] as const).map(tier => ({
          pubkey: 'f'.repeat(64), ownerPubkey: OWNER1, tier, addedAt: 0,
        } as KindredEntry))
        const rest = filler(GRANT_CONTACTS_CAP - 1)
        const out = filterByScope([...rest, ...tied], { tiers: ['kin', 'kith', 'ken'], personas: 'all' })
        const survivor = out.find(e => e.addedAt === 0 && e.ownerPubkey === OWNER1)
        expect(survivor?.tier).toBe('ken')
      })

      it('breaks a full tie (addedAt, ownerPubkey, tier) by pubkey, ascending code-point order', () => {
        const tied = ['b'.repeat(64), 'a'.repeat(64), 'c'.repeat(64)].map(pk => ({
          pubkey: pk, ownerPubkey: OWNER1, tier: 'ken', addedAt: 0,
          provenance: { source: 'manual', locator: 'x', confirmedAt: 0 },
        } as KindredEntry))
        const rest = filler(GRANT_CONTACTS_CAP - 1)
        const out = filterByScope([...rest, ...tied], { tiers: ['ken'], personas: 'all' })
        const survivor = out.find(e => e.addedAt === 0 && e.ownerPubkey === OWNER1)
        expect(survivor?.pubkey).toBe('a'.repeat(64))
      })
    })
  })

  // R1 — kens come from kenspeckle's own parseEntry (via ken-sync.ts), which
  // only requires addedAt to be FINITE, not a non-negative safe integer —
  // the same gap contacts-sync.ts had for verifiedAt. filterByScope is the
  // one path every envelope build goes through (contacts AND kens), so it
  // must sanitise addedAt for both, not just contacts.
  describe('addedAt sanitising (contacts AND kens)', () => {
    function ken(addedAt: number): KindredEntry {
      return {
        pubkey: 'f'.repeat(64), ownerPubkey: OWNER1, tier: 'ken', addedAt,
        provenance: { source: 'manual', locator: 'x', confirmedAt: 1 },
      } as KindredEntry
    }

    it('floors a fractional addedAt on a ken entry rather than dropping it', () => {
      const out = filterByScope([ken(1700000000.5)], { tiers: ['ken'], personas: 'all' })
      expect(out).toHaveLength(1)
      expect(out[0].addedAt).toBe(1700000000)
    })
    it('drops a ken entry whose addedAt is negative', () => {
      expect(filterByScope([ken(-5)], { tiers: ['ken'], personas: 'all' })).toHaveLength(0)
    })
    it('drops a ken entry whose addedAt is Infinity', () => {
      expect(filterByScope([ken(Infinity)], { tiers: ['ken'], personas: 'all' })).toHaveLength(0)
    })
    it('drops a ken entry whose addedAt is NaN', () => {
      expect(filterByScope([ken(NaN)], { tiers: ['ken'], personas: 'all' })).toHaveLength(0)
    })
    it('does not mutate the caller\'s entry object when flooring', () => {
      const k = ken(5.5)
      filterByScope([k], { tiers: ['ken'], personas: 'all' })
      expect(k.addedAt).toBe(5.5)
    })
    it('passes an already-valid ken addedAt through unchanged (same object identity)', () => {
      const k = ken(1000)
      const out = filterByScope([k], { tiers: ['ken'], personas: 'all' })
      expect(out[0]).toBe(k)
    })
  })
})

// R1 — end-to-end, against the REAL kenspeckle library (this file never
// mocks '@forgesworn/kenspeckle'): a fractional-addedAt ken must not make
// buildGrantEnvelope throw and kill the whole snapshot.
describe('a fractional-addedAt ken builds a real envelope (no kenspeckle mock)', () => {
  it('buildSnapshotEvent resolves, and the wire addedAt is floored', async () => {
    const kenEntry = {
      pubkey: 'f'.repeat(64), ownerPubkey: OWNER1, tier: 'ken', addedAt: 1700000000.5,
      provenance: { source: 'manual', locator: 'x', confirmedAt: 1 },
    } as KindredEntry
    const scope = { tiers: ['ken' as const], personas: 'all' as const }
    const views = filterByScope([kenEntry], scope).map(toGrantView)
    const captured: string[] = []
    const fakeBackend = {
      activePublicKeyHex: 'e'.repeat(64),
      async nip44Encrypt(_pk: string, pt: string) { captured.push(pt); return 'CIPHER' },
      async nip44Decrypt() { return '' },
      async signEvent(ev: any) { return { ...ev, id: 'id', sig: 'sig' } },
    } as any
    await expect(buildSnapshotEvent(scope, views, 1700000001, fakeBackend, 'a'.repeat(64))).resolves.toBeDefined()
    const env = parseGrantEnvelope(captured[0])
    expect(env?.contacts).toHaveLength(1)
    expect(env?.contacts[0].addedAt).toBe(1700000000)
  })
})

describe('hashSnapshot', () => {
  it('is stable regardless of contact order', () => {
    const views = entries.map(toGrantView)
    expect(hashSnapshot({ tiers: ['kin'], personas: 'all' }, views))
      .toBe(hashSnapshot({ tiers: ['kin'], personas: 'all' }, [...views].reverse()))
  })
  it('changes when a contact changes', () => {
    const views = entries.map(toGrantView)
    const changed = [{ ...views[0], displayName: 'Mother' }, ...views.slice(1)]
    expect(hashSnapshot({ tiers: ['kin'], personas: 'all' }, views))
      .not.toBe(hashSnapshot({ tiers: ['kin'], personas: 'all' }, changed))
  })
  // C1 — must be a real (sha-256, hex) digest, not the plaintext rolodex
  // JSON: `useCompanionRail` persists the return value as `lastPayloadHash`
  // in IDB, so a plaintext JSON.stringify of the sorted views would breach
  // encrypted-at-rest.
  it('returns a 64-hex sha-256 digest', () => {
    const views = entries.map(toGrantView)
    const hash = hashSnapshot({ tiers: ['kin'], personas: 'all' }, views)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })
  it('does not contain plaintext contact fields', () => {
    const views = entries.map(toGrantView)
    const hash = hashSnapshot({ tiers: ['kin'], personas: 'all' }, views)
    expect(hash).not.toContain('Mum')
    expect(hash).not.toContain('Sam')
    expect(hash).not.toContain(OWNER1)
    expect(hash).not.toContain(entries[0].pubkey)
  })
})

describe('tombstone snapshot', () => {
  it('is a revoked, empty-contacts envelope', async () => {
    const captured: string[] = []
    const fakeBackend = {
      activePublicKeyHex: 'e'.repeat(64),
      async nip44Encrypt(_pk: string, pt: string) { captured.push(pt); return 'CIPHER' },
      async nip44Decrypt() { return '' },
      async signEvent(ev: any) { return { ...ev, id: 'id', sig: 'sig' } },
    } as any
    await buildSnapshotEvent({ tiers: ['kin'], personas: 'all' }, [], 700, fakeBackend, 'a'.repeat(64), { revoked: true })
    const env = parseGrantEnvelope(captured[0])
    expect(env).toMatchObject({ revoked: true, contacts: [] })
  })
})

// I1 — a failed tombstone publish must not silently delete the local grant
// record (that would leave the relay's last real snapshot as the un-revoked
// truth with nothing local left to retry). It must soft-tombstone instead.
describe('revokeCompanionGrant', () => {
  const fakeBackend = {
    activePublicKeyHex: 'e'.repeat(64),
    async nip44Encrypt() { return 'CIPHER' },
    async nip44Decrypt() { return '' },
    async signEvent(ev: any) { return { ...ev, id: 'id', sig: 'sig' } },
  } as any

  const grant: CompanionGrant = {
    appPubkey: 'd'.repeat(64),
    appName: 'App',
    railPubkey: 'e'.repeat(64),
    snapshotRelay: 'not-a-valid-relay-url',
    scope: { tiers: ['kin'], personas: 'all' },
    createdAt: 1000,
    lastEventId: 'prior-event-id',
  }

  it('soft-tombstones (saves with revokedAt) instead of deleting when the tombstone publish fails', async () => {
    vi.mocked(db.saveCompanionGrant).mockClear()
    vi.mocked(db.deleteCompanionGrant).mockClear()

    // An invalid relay URL makes publishTombstone (isValidRelayUrl check)
    // fail without ever touching the network — this is the "stub backend +
    // invalid relay" failure case.
    await revokeCompanionGrant(grant, fakeBackend, 'also-not-a-valid-relay-url')

    expect(db.deleteCompanionGrant).not.toHaveBeenCalled()
    expect(db.saveCompanionGrant).toHaveBeenCalledTimes(1)
    const saved = vi.mocked(db.saveCompanionGrant).mock.calls[0][0]
    expect(saved).toMatchObject({ appPubkey: grant.appPubkey, appName: grant.appName })
    expect(saved.revokedAt).toEqual(expect.any(Number))
  })

  it('publishes kind-5 and deletes the grant when the tombstone publish succeeds', async () => {
    vi.mocked(db.saveCompanionGrant).mockClear()
    vi.mocked(db.deleteCompanionGrant).mockClear()
    relayMock.published = []

    const publishedRelay = 'wss://relay.example.com'
    await revokeCompanionGrant({ ...grant, snapshotRelay: publishedRelay }, fakeBackend, publishedRelay)

    expect(db.saveCompanionGrant).not.toHaveBeenCalled()
    expect(db.deleteCompanionGrant).toHaveBeenCalledTimes(1)
    expect(db.deleteCompanionGrant).toHaveBeenCalledWith(grant.appPubkey)
    // Tombstone snapshot + kind-5 delete, both via the mocked relay.
    expect(relayMock.published.length).toBe(2)
  })
})
