import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NostrEvent } from 'signet-protocol';

vi.mock('./relay-service', () => ({
  fetchEvents: vi.fn(),
}));

vi.mock('./signet', () => ({
  derivePubkeysFromMnemonic: vi.fn(),
  deriveExtraPersonaPubkey: vi.fn(),
}));

// Stub verifyEvent so the test fixtures (with fake sigs) don't get rejected.
// A dedicated test below flips this to assert tampered-sig events are dropped.
vi.mock('nostr-tools/pure', async (importOriginal) => {
  const orig = await importOriginal<typeof import('nostr-tools/pure')>();
  return { ...orig, verifyEvent: vi.fn(() => true) };
});

import { fetchEvents } from './relay-service';
import { derivePubkeysFromMnemonic, deriveExtraPersonaPubkey } from './signet';
import { verifyEvent } from 'nostr-tools/pure';
import { fetchRestoreProfile } from './profile-restore';

const mockFetch = vi.mocked(fetchEvents);
const mockDerive = vi.mocked(derivePubkeysFromMnemonic);
const mockDeriveExtra = vi.mocked(deriveExtraPersonaPubkey);
const mockVerify = vi.mocked(verifyEvent);

const NP_PUB = 'a'.repeat(64);
const PERSONA_PUB = 'b'.repeat(64);
const PERSONA_1_PUB = 'c'.repeat(64);

function kind0Event(pubkey: string, content: object, createdAt = 1_700_000_000): NostrEvent {
  return {
    id: 'fake-id-' + pubkey.slice(0, 8),
    pubkey,
    created_at: createdAt,
    kind: 0,
    tags: [],
    content: JSON.stringify(content),
    sig: 'fake-sig',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDerive.mockReturnValue({ naturalPerson: NP_PUB, persona: PERSONA_PUB });
  mockDeriveExtra.mockImplementation((_m, name) =>
    name === 'persona-1' ? PERSONA_1_PUB : 'd'.repeat(64),
  );
  mockVerify.mockReturnValue(true);
});

describe('fetchRestoreProfile', () => {
  it('returns null when relay returns no events', async () => {
    mockFetch.mockResolvedValue([]);
    const result = await fetchRestoreProfile('test-mnemonic');
    expect(result).toBeNull();
  });

  it('returns null when fetchEvents throws', async () => {
    mockFetch.mockRejectedValue(new Error('relay down'));
    const result = await fetchRestoreProfile('test-mnemonic');
    expect(result).toBeNull();
  });

  it('parses NP kind-0 display_name and sets primary to natural-person', async () => {
    mockFetch.mockResolvedValue([
      kind0Event(NP_PUB, { display_name: 'Margaret Smith' }),
    ]);
    const result = await fetchRestoreProfile('test-mnemonic');
    expect(result).not.toBeNull();
    expect(result?.naturalPerson?.displayName).toBe('Margaret Smith');
    expect(result?.persona).toBeNull();
    expect(result?.primaryKeypair).toBe('natural-person');
  });

  it('falls back to `name` when `display_name` absent', async () => {
    mockFetch.mockResolvedValue([
      kind0Event(NP_PUB, { name: 'Margaret' }),
    ]);
    const result = await fetchRestoreProfile('test-mnemonic');
    expect(result?.naturalPerson?.displayName).toBe('Margaret');
  });

  it('prefers display_name over name when both present', async () => {
    mockFetch.mockResolvedValue([
      kind0Event(NP_PUB, { name: 'margaret', display_name: 'Margaret Smith' }),
    ]);
    const result = await fetchRestoreProfile('test-mnemonic');
    expect(result?.naturalPerson?.displayName).toBe('Margaret Smith');
  });

  it('picks the newest kind-0 per pubkey', async () => {
    mockFetch.mockResolvedValue([
      kind0Event(NP_PUB, { name: 'Old' }, 1_700_000_000),
      kind0Event(NP_PUB, { name: 'New' }, 1_700_001_000),
    ]);
    const result = await fetchRestoreProfile('test-mnemonic');
    expect(result?.naturalPerson?.displayName).toBe('New');
  });

  it('returns primary=persona when only persona has a profile', async () => {
    mockFetch.mockResolvedValue([
      kind0Event(PERSONA_PUB, { display_name: 'DarkWolf99' }),
    ]);
    const result = await fetchRestoreProfile('test-mnemonic');
    expect(result?.persona?.displayName).toBe('DarkWolf99');
    expect(result?.naturalPerson).toBeNull();
    expect(result?.primaryKeypair).toBe('persona');
  });

  it('returns extras discovered via persona-1..N probing', async () => {
    mockFetch.mockResolvedValue([
      kind0Event(NP_PUB, { display_name: 'Margaret' }),
      kind0Event(PERSONA_1_PUB, { display_name: 'Club Handle' }),
    ]);
    const result = await fetchRestoreProfile('test-mnemonic');
    expect(result?.extras).toHaveLength(1);
    expect(result?.extras[0].derivationName).toBe('persona-1');
    expect(result?.extras[0].displayName).toBe('Club Handle');
  });

  it('skips kind-0 events with invalid JSON content', async () => {
    const bad = {
      id: 'bad',
      pubkey: NP_PUB,
      created_at: 1_700_000_000,
      kind: 0,
      tags: [],
      content: 'not-json',
      sig: 'x',
    } as NostrEvent;
    mockFetch.mockResolvedValue([bad]);
    const result = await fetchRestoreProfile('test-mnemonic');
    expect(result).toBeNull();
  });

  it('skips kind-0 events whose content lacks name and display_name', async () => {
    mockFetch.mockResolvedValue([
      kind0Event(NP_PUB, { about: 'just an about field' }),
    ]);
    const result = await fetchRestoreProfile('test-mnemonic');
    expect(result).toBeNull();
  });

  it('strips control characters from display names', async () => {
    mockFetch.mockResolvedValue([
      kind0Event(NP_PUB, { display_name: 'Margaret\u0000\u200eSmith' }),
    ]);
    const result = await fetchRestoreProfile('test-mnemonic');
    expect(result?.naturalPerson?.displayName).toBe('MargaretSmith');
  });

  it('caps display name at 100 chars', async () => {
    const long = 'x'.repeat(500);
    mockFetch.mockResolvedValue([
      kind0Event(NP_PUB, { display_name: long }),
    ]);
    const result = await fetchRestoreProfile('test-mnemonic');
    expect(result?.naturalPerson?.displayName.length).toBe(100);
  });

  it('returns null when only malformed names (non-string) are present', async () => {
    mockFetch.mockResolvedValue([
      kind0Event(NP_PUB, { display_name: 12345 }),
    ]);
    const result = await fetchRestoreProfile('test-mnemonic');
    expect(result).toBeNull();
  });

  it('drops kind-0 events whose signature does not verify (sweep-2 medium)', async () => {
    // Forged event: relay claims the event is from NP_PUB but the sig is invalid.
    // Without the verifyEvent check, this would seed displayName + lastEventId
    // on the restored identity from attacker-controlled bytes.
    mockFetch.mockResolvedValue([
      kind0Event(NP_PUB, { display_name: 'AttackerForged' }),
    ]);
    mockVerify.mockReturnValue(false);
    const result = await fetchRestoreProfile('test-mnemonic');
    expect(result).toBeNull();
  });
});
