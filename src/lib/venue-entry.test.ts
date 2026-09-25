import { describe, it, expect } from 'vitest';
import { buildVenueEntryPayload } from './venue-entry';
import type { SigningBackend } from './signing-backend';
import type { NostrEvent } from 'signet-protocol';

const mockPubkey = 'a'.repeat(64);

function mockBackend(): SigningBackend {
  return {
    type: 'local',
    activePublicKeyHex: mockPubkey,
    signEvent: async (event) => ({
      ...event,
      id: 'b'.repeat(64),
      sig: 'c'.repeat(128),
    }) as NostrEvent,
    nip44Encrypt: async () => '',
    destroy: () => {},
  };
}

describe('buildVenueEntryPayload', () => {
  it('produces kind 21235 event', async () => {
    const event = await buildVenueEntryPayload(mockBackend(), mockPubkey);
    expect(event.kind).toBe(21235);
  });

  it('includes signet-venue-entry tag', async () => {
    const event = await buildVenueEntryPayload(mockBackend(), mockPubkey);
    expect(event.tags).toContainEqual(['t', 'signet-venue-entry']);
  });

  it('uses the backend pubkey', async () => {
    const event = await buildVenueEntryPayload(mockBackend(), mockPubkey);
    expect(event.pubkey).toBe(mockPubkey);
  });

  it('has empty content', async () => {
    const event = await buildVenueEntryPayload(mockBackend(), mockPubkey);
    expect(event.content).toBe('');
  });

  it('has a recent created_at timestamp', async () => {
    const before = Math.floor(Date.now() / 1000) - 2;
    const event = await buildVenueEntryPayload(mockBackend(), mockPubkey);
    const after = Math.floor(Date.now() / 1000) + 2;
    expect(event.created_at).toBeGreaterThanOrEqual(before);
    expect(event.created_at).toBeLessThanOrEqual(after);
  });

  it('includes photo hash tag when provided', async () => {
    const event = await buildVenueEntryPayload(mockBackend(), mockPubkey, 'abc123hash');
    expect(event.tags).toContainEqual(['x', 'abc123hash']);
  });

  it('does not include photo hash tag when not provided', async () => {
    const event = await buildVenueEntryPayload(mockBackend(), mockPubkey);
    expect(event.tags.find(t => t[0] === 'x')).toBeUndefined();
  });

  it('includes blossom URL when both photo hash and URL provided', async () => {
    const event = await buildVenueEntryPayload(mockBackend(), mockPubkey, 'abc123hash', 'https://blossom.example.com/abc');
    expect(event.tags).toContainEqual(['blossom', 'https://blossom.example.com/abc']);
  });

  it('does not include blossom URL without photo hash', async () => {
    const event = await buildVenueEntryPayload(mockBackend(), mockPubkey, undefined, 'https://blossom.example.com/abc');
    expect(event.tags.find(t => t[0] === 'blossom')).toBeUndefined();
  });

  it('rejects blossom URL with invalid scheme', async () => {
    const event = await buildVenueEntryPayload(mockBackend(), mockPubkey, 'abc123hash', 'ftp://blossom.example.com/abc');
    expect(event.tags.find(t => t[0] === 'blossom')).toBeUndefined();
  });

  it('allows http://localhost blossom URL', async () => {
    const event = await buildVenueEntryPayload(mockBackend(), mockPubkey, 'abc123hash', 'http://localhost:3000/abc');
    expect(event.tags).toContainEqual(['blossom', 'http://localhost:3000/abc']);
  });
});

describe('buildVenueEntryPayload — Natural Person key guard', () => {
  it('throws when the backend pubkey does not match the expected NP pubkey', async () => {
    const otherPubkey = 'f'.repeat(64);
    await expect(buildVenueEntryPayload(mockBackend(), otherPubkey)).rejects.toThrow(
      'Venue entry must be signed by the Natural Person key',
    );
  });

  it('throws when expectedNpPubkeyHex is empty', async () => {
    await expect(buildVenueEntryPayload(mockBackend(), '')).rejects.toThrow(
      'Venue entry must be signed by the Natural Person key',
    );
  });

  it('accepts a case-insensitive match', async () => {
    const event = await buildVenueEntryPayload(mockBackend(), mockPubkey.toUpperCase());
    expect(event.pubkey).toBe(mockPubkey);
  });
});
