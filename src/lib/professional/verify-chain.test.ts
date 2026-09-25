import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

// Hoisted mocks — must precede the module under test.
vi.mock('../db', () => ({
  getProRegistryRecord: vi.fn(),
  setProRegistryRecord: vi.fn(),
  getProSignetJson: vi.fn(),
  setProSignetJson: vi.fn(),
  invalidateProRegistryRecord: vi.fn(),
  invalidateProSignetJson: vi.fn(),
}));

vi.mock('./resolver', () => ({
  resolveIdentifier: vi.fn(),
}));

vi.mock('./signet-json', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./signet-json')>();
  return { ...orig, fetchProSignetJson: vi.fn() };
});

// C3: verifyProChain now fetches kind-30204 revocations via relay-service.
// Default to "no revocations found" so the existing chain tests (which
// predate the revocation check) keep exercising the SAME behaviour as
// before; the dedicated revocation describe block below overrides this.
vi.mock('../relay-service', () => ({
  fetchEvents: vi.fn().mockResolvedValue([]),
}));

import {
  getProRegistryRecord,
  getProSignetJson,
  invalidateProRegistryRecord,
  invalidateProSignetJson,
} from '../db';
import { resolveIdentifier } from './resolver';
import { fetchEvents } from '../relay-service';
import { verifyProChain, resolveListedFlag } from './verify-chain';
import type { RegulatedEntityRecord } from './types';
import type { ProSignetJson } from './signet-json';
import type { NostrEvent } from 'signet-protocol';

const TTL_MS = 24 * 60 * 60 * 1000;
const freshIso = () => new Date(Date.now() - TTL_MS + 60_000).toISOString();

const baseRecord: RegulatedEntityRecord = {
  professionKind: 'gp-practice',
  jurisdiction: 'england',
  registry: 'CQC',
  identifier: 'RXL',
  identifierKind: 'CQC-ProviderID',
  name: 'Springfield Practice',
  status: 'Active',
  website: 'springfield.gp.nhs.uk',
  inferredCandidateWebsite: null,
  postcode: 'SP1 1AA',
  locality: 'Springfield',
  tags: [],
  fetchedAt: freshIso(),
};

const baseJson: ProSignetJson = {
  schemaVersion: 1,
  kind: 'gp-practice',
  name: 'Springfield Practice',
  identifier: { kind: 'CQC-ProviderID', value: 'RXL' },
  jurisdiction: 'england',
  leadPubkeys: ['aabbcc0011223344aabbcc0011223344aabbcc0011223344aabbcc0011223344'],
  leadPubkey: 'aabbcc0011223344aabbcc0011223344aabbcc0011223344aabbcc0011223344',
  relays: ['wss://relay.forgesworn.dev'],
  entities: null,
  fetchedAt: freshIso(),
  _fetchedFromHost: 'springfield.gp.nhs.uk',
};

// A minimal valid Nostr roster event stub.
function makeRosterEvent(leadPubkey: string, memberPubkeys: string[], delegatePubkeys: string[] = []): NostrEvent {
  return {
    id: 'e'.repeat(64),
    pubkey: leadPubkey,
    created_at: Math.floor(Date.now() / 1000) - 60,
    kind: 30202,
    tags: [
      ...memberPubkeys.map(pk => ['p', pk, 'gp']),
      ...delegatePubkeys.map(pk => ['delegate', pk]),
    ],
    content: '',
    sig: 'f'.repeat(128),
  } as unknown as NostrEvent;
}

// Stub verifyEvent to always return true in tests; invalid-sig path tested separately.
vi.mock('signet-protocol', async (importOriginal) => {
  const orig = await importOriginal<typeof import('signet-protocol')>();
  return { ...orig, verifyEvent: vi.fn().mockResolvedValue(true) };
});

import { verifyEvent } from 'signet-protocol';

function setupHappyPath() {
  (getProRegistryRecord as Mock).mockResolvedValue({ record: baseRecord, cachedAt: Date.now() });
  (getProSignetJson as Mock).mockResolvedValue({ json: baseJson, cachedAt: Date.now() });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('verifyProChain', () => {
  const memberPubkey = '1234560000000000000000000000000000000000000000000000000000000001';
  const rosterEvent = makeRosterEvent(baseJson.leadPubkey, [memberPubkey]);
  const fakeCred = {
    id: 'aa'.repeat(32),
    pubkey: memberPubkey,
    kind: 29999,
    content: '',
    tags: [['identifier', 'RXL'], ['profession', 'gp-practice'], ['jurisdiction', 'england']],
    created_at: Math.floor(Date.now() / 1000),
    sig: 'cc'.repeat(64),
  } as unknown as NostrEvent;

  it('returns ok:true on the happy path', async () => {
    setupHappyPath();
    const result = await verifyProChain(fakeCred, rosterEvent, 'gp-practice', 'england');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.firmName).toBe('Springfield Practice');
      expect(result.profession).toBe('gp-practice');
      expect(result.jurisdiction).toBe('england');
    }
  });

  it('returns ok:false with reason registry-not-found when resolver finds nothing', async () => {
    (getProRegistryRecord as Mock).mockResolvedValue(null);
    (resolveIdentifier as Mock).mockResolvedValue(null);
    const result = await verifyProChain(fakeCred, rosterEvent, 'gp-practice', 'england');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('registry-not-found');
  });

  it('returns ok:false with reason status-inactive when registry status is not Active', async () => {
    (getProRegistryRecord as Mock).mockResolvedValue({
      record: { ...baseRecord, status: 'Deregistered' },
      cachedAt: Date.now(),
    });
    const result = await verifyProChain(fakeCred, rosterEvent, 'gp-practice', 'england');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('status-inactive');
  });

  it('returns ok:false with reason signet-json-mismatch when identifier does not match registry', async () => {
    (getProRegistryRecord as Mock).mockResolvedValue({ record: baseRecord, cachedAt: Date.now() });
    (getProSignetJson as Mock).mockResolvedValue({
      json: { ...baseJson, identifier: { kind: 'CQC-ProviderID', value: 'WRONG' } },
      cachedAt: Date.now(),
    });
    const result = await verifyProChain(fakeCred, rosterEvent, 'gp-practice', 'england');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('signet-json-mismatch');
  });

  it('returns ok:false with reason signer-not-in-roster when member pubkey absent', async () => {
    setupHappyPath();
    const wrongRoster = makeRosterEvent(baseJson.leadPubkey, ['0000000000000000000000000000000000000000000000000000000000000099']);
    const result = await verifyProChain(fakeCred, wrongRoster, 'gp-practice', 'england');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('signer-not-in-roster');
  });

  it('returns ok:false with reason signature-invalid when credential sig fails', async () => {
    setupHappyPath();
    (verifyEvent as Mock).mockResolvedValueOnce(false);
    const result = await verifyProChain(fakeCred, rosterEvent, 'gp-practice', 'england');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('signature-invalid');
  });

  it('invalidates both caches and returns ok:false on signet-json domain mismatch', async () => {
    (getProRegistryRecord as Mock).mockResolvedValue({
      record: { ...baseRecord, website: 'different-domain.co.uk' },
      cachedAt: Date.now(),
    });
    (getProSignetJson as Mock).mockResolvedValue({
      json: { ...baseJson, _fetchedFromHost: 'springfield.gp.nhs.uk' },
      cachedAt: Date.now(),
    });
    const result = await verifyProChain(fakeCred, rosterEvent, 'gp-practice', 'england');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('domain-mismatch');
    expect(invalidateProRegistryRecord).toHaveBeenCalled();
    expect(invalidateProSignetJson).toHaveBeenCalled();
  });

  // Multi-lead + delegate authority union tests (spec §3.5.1)

  it('signed by lead-B in a co-lead setup — verifyProChain returns ok:true', async () => {
    const LEAD_B = 'b'.repeat(64);
    const multiLeadJson: ProSignetJson = {
      ...baseJson,
      leadPubkeys: [baseJson.leadPubkey, LEAD_B],
      leadPubkey: baseJson.leadPubkey,
    };
    (getProRegistryRecord as Mock).mockResolvedValue({ record: baseRecord, cachedAt: Date.now() });
    (getProSignetJson as Mock).mockResolvedValue({ json: multiLeadJson, cachedAt: Date.now() });
    // Roster is signed by lead-B (the second lead).
    const rosterSignedByLeadB = makeRosterEvent(LEAD_B, [memberPubkey]);
    const result = await verifyProChain(fakeCred, rosterSignedByLeadB, 'gp-practice', 'england');
    expect(result.ok).toBe(true);
  });

  it('signed by a current delegate — verifyProChain returns ok:true', async () => {
    const DELEGATE_D = 'd'.repeat(64);
    // baseJson has a single lead; the roster lists DELEGATE_D as a delegate.
    // verifyProChain must accept a roster signed by DELEGATE_D.
    (getProRegistryRecord as Mock).mockResolvedValue({ record: baseRecord, cachedAt: Date.now() });
    (getProSignetJson as Mock).mockResolvedValue({ json: baseJson, cachedAt: Date.now() });
    // The roster is signed by DELEGATE_D and includes DELEGATE_D as a delegate tag.
    const rosterSignedByDelegate = makeRosterEvent(DELEGATE_D, [memberPubkey], [DELEGATE_D]);
    // For the authority union check: the roster carries ['delegate', DELEGATE_D],
    // so DELEGATE_D is in authority_union = leads ∪ delegates.
    // But wait — the authority union for verifyProChain is built from the single rosterEvent.
    // For DELEGATE_D to be in the union, the rosterEvent must carry DELEGATE_D in delegate tags.
    // The check in verifyProChain uses the same rosterEvent, so the delegate tag IS present.
    const result = await verifyProChain(fakeCred, rosterSignedByDelegate, 'gp-practice', 'england');
    expect(result.ok).toBe(true);
  });

  it('signed by a non-authority pubkey — verifyProChain returns signet-json-mismatch', async () => {
    const STRANGER = 's'.repeat(64);
    setupHappyPath();
    // Roster is signed by STRANGER who is not a lead or delegate.
    const rosterSignedByStranger = makeRosterEvent(STRANGER, [memberPubkey]);
    const result = await verifyProChain(fakeCred, rosterSignedByStranger, 'gp-practice', 'england');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('signet-json-mismatch');
  });

  it('signed by a removed delegate (absent from ALL leads latest rosters) — verifyProChain returns signet-json-mismatch', async () => {
    const REMOVED_DELEGATE = 'r'.repeat(64);
    setupHappyPath();
    // Roster is signed by REMOVED_DELEGATE but has no delegate tags for them.
    const rosterWithRemovedDelegate = makeRosterEvent(REMOVED_DELEGATE, [memberPubkey], []);
    const result = await verifyProChain(fakeCred, rosterWithRemovedDelegate, 'gp-practice', 'england');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('signet-json-mismatch');
  });

  // C3: kind-30204 revocation enforcement (2026-07-02 audit finding)

  describe('kind-30204 revocation', () => {
    const DTAG = `${baseRecord.registry}:${baseRecord.identifier}`;

    function revocationEvent(overrides: Partial<{ pubkey: string; tags: string[][] }> = {}): NostrEvent {
      return {
        id: 'f'.repeat(64),
        pubkey: baseJson.leadPubkey,
        created_at: Math.floor(Date.now() / 1000),
        kind: 30204,
        tags: [['d', DTAG], ['profession', 'gp-practice']],
        content: '',
        sig: '9'.repeat(128),
        ...overrides,
      } as unknown as NostrEvent;
    }

    it('a roster that verifies OK becomes NOT-ok once a matching full role-anchor revocation is present', async () => {
      setupHappyPath();
      (fetchEvents as Mock).mockResolvedValue([revocationEvent()]); // no `p` tag — full revocation
      const result = await verifyProChain(fakeCred, rosterEvent, 'gp-practice', 'england');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('revoked');
    });

    it('rejects when a fast sub-role revocation targets this exact member', async () => {
      setupHappyPath();
      (fetchEvents as Mock).mockResolvedValue([
        revocationEvent({ tags: [['d', DTAG], ['p', memberPubkey], ['role', 'gp']] }),
      ]);
      const result = await verifyProChain(fakeCred, rosterEvent, 'gp-practice', 'england');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('revoked');
    });

    it('does NOT reject when a fast sub-role revocation targets a DIFFERENT member', async () => {
      setupHappyPath();
      const someoneElse = '7'.repeat(64);
      (fetchEvents as Mock).mockResolvedValue([
        revocationEvent({ tags: [['d', DTAG], ['p', someoneElse], ['role', 'gp']] }),
      ]);
      const result = await verifyProChain(fakeCred, rosterEvent, 'gp-practice', 'england');
      expect(result.ok).toBe(true);
    });

    it('ignores a revocation event for a different d-tag (different firm)', async () => {
      setupHappyPath();
      (fetchEvents as Mock).mockResolvedValue([
        revocationEvent({ tags: [['d', 'CQC:SOME-OTHER-FIRM'], ['profession', 'gp-practice']] }),
      ]);
      const result = await verifyProChain(fakeCred, rosterEvent, 'gp-practice', 'england');
      expect(result.ok).toBe(true);
    });

    it('ignores a revocation not signed by a current lead (spoofed authors)', async () => {
      setupHappyPath();
      const attacker = '6'.repeat(64);
      (fetchEvents as Mock).mockResolvedValue([revocationEvent({ pubkey: attacker })]);
      const result = await verifyProChain(fakeCred, rosterEvent, 'gp-practice', 'england');
      expect(result.ok).toBe(true);
    });

    it('ignores a revocation with an invalid signature', async () => {
      setupHappyPath();
      (fetchEvents as Mock).mockResolvedValue([revocationEvent()]);
      // First verifyEvent call is the revocation check (inside checkRevocation);
      // queuing a single false there and leaving the default (true) in place
      // for the credential's own verifyEvent call at step (f).
      (verifyEvent as Mock).mockResolvedValueOnce(false);
      const result = await verifyProChain(fakeCred, rosterEvent, 'gp-practice', 'england');
      expect(result.ok).toBe(true);
    });

    it('fails closed with chain-error when the revocation fetch is unreachable', async () => {
      setupHappyPath();
      (fetchEvents as Mock).mockRejectedValue(new Error('relay unreachable'));
      const result = await verifyProChain(fakeCred, rosterEvent, 'gp-practice', 'england');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('chain-error');
    });
  });
});

// M4: directory opt-out — resolveListedFlag defaults to false (opt-out)
// unless the firm's own kind-30203 event explicitly says `listed: true`.
describe('resolveListedFlag (M4)', () => {
  const REGISTRY = 'CQC';
  const IDENTIFIER = 'RXL';
  const DTAG = `${REGISTRY}:${IDENTIFIER}`;
  const LEAD = baseJson.leadPubkey;

  function directoryAddEvent(overrides: Partial<{ pubkey: string; tags: string[][]; created_at: number }> = {}): NostrEvent {
    return {
      id: 'd'.repeat(64),
      pubkey: LEAD,
      created_at: Math.floor(Date.now() / 1000),
      kind: 30203,
      tags: [['d', DTAG], ['listed', 'true']],
      content: '',
      sig: '5'.repeat(128),
      ...overrides,
    } as unknown as NostrEvent;
  }

  it('defaults to false (opt-out) when no kind-30203 event exists', async () => {
    (fetchEvents as Mock).mockResolvedValue([]);
    const listed = await resolveListedFlag(REGISTRY, IDENTIFIER, [LEAD]);
    expect(listed).toBe(false);
  });

  it('returns true when the lead has explicitly opted in (listed: true)', async () => {
    (fetchEvents as Mock).mockResolvedValue([directoryAddEvent()]);
    const listed = await resolveListedFlag(REGISTRY, IDENTIFIER, [LEAD]);
    expect(listed).toBe(true);
  });

  it('returns false when the lead has explicitly opted out (listed: false)', async () => {
    (fetchEvents as Mock).mockResolvedValue([
      directoryAddEvent({ tags: [['d', DTAG], ['listed', 'false']] }),
    ]);
    const listed = await resolveListedFlag(REGISTRY, IDENTIFIER, [LEAD]);
    expect(listed).toBe(false);
  });

  it('defaults to false when the listed tag is missing entirely', async () => {
    (fetchEvents as Mock).mockResolvedValue([directoryAddEvent({ tags: [['d', DTAG]] })]);
    const listed = await resolveListedFlag(REGISTRY, IDENTIFIER, [LEAD]);
    expect(listed).toBe(false);
  });

  it('ignores a directory-add event not authored by a current lead', async () => {
    const attacker = '4'.repeat(64);
    (fetchEvents as Mock).mockResolvedValue([directoryAddEvent({ pubkey: attacker })]);
    const listed = await resolveListedFlag(REGISTRY, IDENTIFIER, [LEAD]);
    expect(listed).toBe(false);
  });

  it('ignores an event for a different d-tag', async () => {
    (fetchEvents as Mock).mockResolvedValue([
      directoryAddEvent({ tags: [['d', 'CQC:OTHER'], ['listed', 'true']] }),
    ]);
    const listed = await resolveListedFlag(REGISTRY, IDENTIFIER, [LEAD]);
    expect(listed).toBe(false);
  });

  it('fails closed to false on fetch failure', async () => {
    (fetchEvents as Mock).mockRejectedValue(new Error('relay unreachable'));
    const listed = await resolveListedFlag(REGISTRY, IDENTIFIER, [LEAD]);
    expect(listed).toBe(false);
  });

  it('picks the latest event by created_at when multiple are returned', async () => {
    (fetchEvents as Mock).mockResolvedValue([
      directoryAddEvent({ created_at: 1000, tags: [['d', DTAG], ['listed', 'true']] }),
      directoryAddEvent({ created_at: 2000, tags: [['d', DTAG], ['listed', 'false']] }),
    ]);
    const listed = await resolveListedFlag(REGISTRY, IDENTIFIER, [LEAD]);
    expect(listed).toBe(false); // the later (created_at: 2000) event opted out
  });
});
