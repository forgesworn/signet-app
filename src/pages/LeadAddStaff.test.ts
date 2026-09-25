// @vitest-environment jsdom
/**
 * M6 (2026-07-02 audit): `fetchLatestRosterMembers` is the compare-and-swap
 * guard `handleDoubleConfirm` calls immediately before publish, so a
 * concurrent roster change made while the lead sat on the scan/preview/
 * confirm screens is merged rather than silently clobbered. Exercised
 * directly here — it's a plain async function with no React state.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { AnchorContext } from '../lib/professional/role-anchor';

vi.mock('../lib/relay-service', () => ({
  fetchEvents: vi.fn(),
  publishEvent: vi.fn(),
}));

// `verifiedAuthoredEvent` (event-verify.ts) checks signatures via
// nostr-tools/pure, not signet-protocol — mock that module, matching
// audit-fetch.test.ts's pattern for the same helper.
vi.mock('nostr-tools/pure', async (importOriginal) => {
  const orig = await importOriginal<typeof import('nostr-tools/pure')>();
  return { ...orig, verifyEvent: vi.fn(() => true) };
});

import { fetchEvents } from '../lib/relay-service';
import { verifyEvent } from 'nostr-tools/pure';
import { fetchLatestRosterMembers } from './LeadAddStaff';

const LEAD = 'a'.repeat(64);
const EXISTING_MEMBER = 'b'.repeat(64);
const CONCURRENTLY_ADDED = 'c'.repeat(64);

const anchorContext: AnchorContext = {
  registry: 'CQC',
  identifier: 'RXL',
  professionKind: 'gp-practice',
  entityName: 'Springfield Practice',
  canonicalDomain: 'springfield.gp.nhs.uk',
  jurisdiction: 'england',
  leadPubkey: LEAD,
};

function rosterEvent(memberPubkeys: string[], overrides: Partial<{ pubkey: string }> = {}) {
  return {
    id: 'e'.repeat(64),
    pubkey: LEAD,
    created_at: Math.floor(Date.now() / 1000),
    kind: 30202,
    tags: memberPubkeys.map(pk => ['p', pk, 'gp']),
    content: '',
    sig: 'f'.repeat(128),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (verifyEvent as unknown as Mock).mockReturnValue(true);
});

describe('fetchLatestRosterMembers (M6 compare-and-swap guard)', () => {
  it('returns the fresh member list, reflecting a concurrent append made after the snapshot was taken', async () => {
    // The snapshot the page loaded with only had EXISTING_MEMBER; a
    // concurrent device has since appended CONCURRENTLY_ADDED. The guard
    // must surface BOTH, not just the snapshot's stale single member.
    (fetchEvents as Mock).mockResolvedValue([rosterEvent([EXISTING_MEMBER, CONCURRENTLY_ADDED])]);
    const members = await fetchLatestRosterMembers(anchorContext, LEAD);
    expect(members?.map(m => m.pubkey)).toEqual([EXISTING_MEMBER, CONCURRENTLY_ADDED]);
  });

  it('returns an empty array (not null) when no roster has ever been published', async () => {
    (fetchEvents as Mock).mockResolvedValue([]);
    const members = await fetchLatestRosterMembers(anchorContext, LEAD);
    expect(members).toEqual([]);
  });

  it('returns null (not an empty roster) when the relay fetch fails, so callers fall back to the snapshot', async () => {
    (fetchEvents as Mock).mockRejectedValue(new Error('relay unreachable'));
    const members = await fetchLatestRosterMembers(anchorContext, LEAD);
    expect(members).toBeNull();
  });

  it('returns null when the fetched roster is not authentically signed by the lead (spoofed)', async () => {
    const attacker = 'd'.repeat(64);
    (fetchEvents as Mock).mockResolvedValue([rosterEvent([EXISTING_MEMBER], { pubkey: attacker })]);
    const members = await fetchLatestRosterMembers(anchorContext, LEAD);
    expect(members).toBeNull();
  });

  it('returns null when the signature verification fails', async () => {
    (fetchEvents as Mock).mockResolvedValue([rosterEvent([EXISTING_MEMBER])]);
    (verifyEvent as unknown as Mock).mockReturnValue(false);
    const members = await fetchLatestRosterMembers(anchorContext, LEAD);
    expect(members).toBeNull();
  });

  it('parses role and scope tags', async () => {
    (fetchEvents as Mock).mockResolvedValue([{
      ...rosterEvent([]),
      tags: [['p', EXISTING_MEMBER, 'gp', 'branch-a']],
    }]);
    const members = await fetchLatestRosterMembers(anchorContext, LEAD);
    expect(members).toEqual([{ pubkey: EXISTING_MEMBER, role: 'gp', scope: 'branch-a' }]);
  });
});
