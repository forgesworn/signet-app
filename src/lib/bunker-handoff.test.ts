import { describe, expect, it } from 'vitest';
import type { NostrEvent, UnsignedEvent } from 'signet-protocol';
import type { SigningBackend } from './signing-backend';
import { runtimeBunkerUriForBackend, storedBunkerUriForGuardianNaturalPerson } from './bunker-handoff';
import type { BunkerSigningBackend } from './signing-backend';

const NP_PUBKEY = 'a'.repeat(64);
const OTHER_PUBKEY = 'b'.repeat(64);
const BUNKER_URI = 'bunker://'.concat(NP_PUBKEY, '?relay=wss://relay.example&secret=secret');

function makeBackend(extra?: Record<string, unknown>): SigningBackend {
  return {
    type: 'local',
    activePublicKeyHex: NP_PUBKEY,
    signEvent: async (event: UnsignedEvent): Promise<NostrEvent> => ({
      ...event,
      id: '0'.repeat(64),
      sig: '1'.repeat(128),
    }),
    ...extra,
  } as SigningBackend;
}

describe('runtimeBunkerUriForBackend', () => {
  it('returns a bunker URI exposed by a wrapped runtime backend', () => {
    const backend = makeBackend({ type: 'bunker', bunkerUri: BUNKER_URI });

    expect(runtimeBunkerUriForBackend(backend, null, { signingMode: 'local' })).toBe(BUNKER_URI);
  });

  it('falls back to stored bunker preferences for the active bunker backend', () => {
    const backend = makeBackend({ type: 'bunker', bunkerUri: '' }) as unknown as BunkerSigningBackend;

    expect(runtimeBunkerUriForBackend(
      backend as unknown as SigningBackend,
      backend,
      { signingMode: 'bunker', bunkerUri: BUNKER_URI },
    )).toBe(BUNKER_URI);
  });

  it('refuses a runtime URI bound to a different identity than the backend signs as', () => {
    const masterUri = 'bunker://'.concat(OTHER_PUBKEY, '?relay=wss://relay.example&secret=secret');
    const backend = makeBackend({ type: 'bunker', bunkerUri: masterUri }); // signs as NP_PUBKEY
    expect(runtimeBunkerUriForBackend(backend, null, { signingMode: 'local' })).toBeUndefined();

    const primary = makeBackend({ type: 'bunker', bunkerUri: '' }) as unknown as BunkerSigningBackend;
    expect(runtimeBunkerUriForBackend(
      primary as unknown as SigningBackend,
      primary,
      { signingMode: 'bunker', bunkerUri: masterUri },
    )).toBeUndefined();
  });

  it('lets a pre-connect backend (no pubkey yet) through unchanged', () => {
    const backend = makeBackend({ type: 'bunker', bunkerUri: BUNKER_URI, activePublicKeyHex: '' });
    expect(runtimeBunkerUriForBackend(backend, null, { signingMode: 'local' })).toBe(BUNKER_URI);
  });

  it('does not hand off stored bunker preferences to an unrelated backend', () => {
    const backend = makeBackend();

    expect(runtimeBunkerUriForBackend(
      backend,
      null,
      { signingMode: 'bunker', bunkerUri: BUNKER_URI },
    )).toBeUndefined();
  });
});

describe('storedBunkerUriForGuardianNaturalPerson', () => {
  const identity = {
    id: NP_PUBKEY,
    naturalPerson: { publicKey: NP_PUBKEY },
  };

  it('returns fresh stored bunker URI for guardian natural-person signing', () => {
    expect(storedBunkerUriForGuardianNaturalPerson(
      { source: 'guardian', keypairType: 'natural-person' },
      NP_PUBKEY,
      identity,
      { activeAccountId: NP_PUBKEY, signingMode: 'bunker', bunkerUri: BUNKER_URI },
    )).toBe(BUNKER_URI);
  });

  it('refuses persona and dependant selections', () => {
    expect(storedBunkerUriForGuardianNaturalPerson(
      { source: 'guardian', keypairType: 'persona' },
      NP_PUBKEY,
      identity,
      { activeAccountId: NP_PUBKEY, signingMode: 'bunker', bunkerUri: BUNKER_URI },
    )).toBeUndefined();

    expect(storedBunkerUriForGuardianNaturalPerson(
      { source: 'dependant', keypairType: 'natural-person' },
      NP_PUBKEY,
      identity,
      { activeAccountId: NP_PUBKEY, signingMode: 'bunker', bunkerUri: BUNKER_URI },
    )).toBeUndefined();
  });

  it('refuses stale or mismatched account state', () => {
    expect(storedBunkerUriForGuardianNaturalPerson(
      { source: 'guardian', keypairType: 'natural-person' },
      OTHER_PUBKEY,
      identity,
      { activeAccountId: NP_PUBKEY, signingMode: 'bunker', bunkerUri: BUNKER_URI },
    )).toBeUndefined();

    expect(storedBunkerUriForGuardianNaturalPerson(
      { source: 'guardian', keypairType: 'natural-person' },
      NP_PUBKEY,
      identity,
      { activeAccountId: OTHER_PUBKEY, signingMode: 'bunker', bunkerUri: BUNKER_URI },
    )).toBeUndefined();
  });

  it('refuses a stored URI bound to a DIFFERENT identity than the one that signed (family bunker: master ≠ NP)', () => {
    // Post-migration the stored bunker URI is the family bunker's MASTER
    // pairing; the guardian's NP is a derived persona with another pubkey.
    // Handing that URI to a consumer would let it act as the master (and
    // carry the master pairing secret). An earlier hardware finding.
    const masterUri = 'bunker://'.concat(OTHER_PUBKEY, '?relay=wss://relay.example&secret=secret');
    expect(storedBunkerUriForGuardianNaturalPerson(
      { source: 'guardian', keypairType: 'natural-person' },
      NP_PUBKEY,
      identity,
      { activeAccountId: NP_PUBKEY, signingMode: 'bunker', bunkerUri: masterUri },
    )).toBeUndefined();
  });

  it('accepts a stored URI whose bound pubkey matches case-insensitively', () => {
    const upper = 'bunker://'.concat(NP_PUBKEY.toUpperCase(), '?relay=wss://relay.example&secret=secret');
    expect(storedBunkerUriForGuardianNaturalPerson(
      { source: 'guardian', keypairType: 'natural-person' },
      NP_PUBKEY,
      identity,
      { activeAccountId: NP_PUBKEY, signingMode: 'bunker', bunkerUri: upper },
    )).toBe(upper);
  });

  it('refuses a malformed stored URI', () => {
    expect(storedBunkerUriForGuardianNaturalPerson(
      { source: 'guardian', keypairType: 'natural-person' },
      NP_PUBKEY,
      identity,
      { activeAccountId: NP_PUBKEY, signingMode: 'bunker', bunkerUri: 'bunker://nothex?relay=wss://relay.example' },
    )).toBeUndefined();
  });
});
