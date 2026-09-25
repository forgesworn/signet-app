import { describe, it, expect } from 'vitest';
import { parseStoredCredentialEvent, pickCredential, pickCredentialForSubject } from './pick-credential';
import type { StoredCredential } from '../types';
import type { VerifyRequest } from 'signet-protocol';

interface CredOpts {
  id?: string;
  keypairType?: 'natural-person' | 'persona' | 'professional';
  ageRange?: string;
  tier?: string;
  expiresAt?: number;
  revokedAt?: number;
  verifiedAt?: number;
  zkAge?: boolean;
  rangeProof?: unknown;
  pubkey?: string;
}

function makeCredential(opts: CredOpts = {}): StoredCredential {
  const tags: string[][] = [];
  if (opts.ageRange) tags.push(['age-range', opts.ageRange]);
  if (opts.tier) tags.push(['tier', opts.tier]);
  if (opts.zkAge) tags.push(['zk-age', '1']);
  const content = opts.rangeProof !== undefined
    ? JSON.stringify({ rangeProof: opts.rangeProof })
    : '';
  const event = {
    id: opts.id ?? 'cred-default',
    kind: 30470,
    pubkey: opts.pubkey ?? '00'.repeat(32),
    tags,
    content,
    sig: 'sig',
    created_at: opts.verifiedAt ?? 1000,
  };
  return {
    id: event.id,
    documentId: 'doc-1',
    keypairType: opts.keypairType ?? 'persona',
    event: JSON.stringify(event),
    verifierPubkey: 'verifier',
    verifiedAt: opts.verifiedAt ?? 1000,
    verifierStatus: 'confirmed',
    expiresAt: opts.expiresAt,
    revokedAt: opts.revokedAt,
  };
}

function makeRequest(ageRange: string = '18+'): VerifyRequest {
  return {
    type: 'signet-verify-request',
    requestId: 'a'.repeat(32),
    requiredAgeRange: ageRange,
    timestamp: Math.floor(Date.now() / 1000),
  };
}

const NOW = 2000;

describe('pickCredential', () => {
  it('returns null for an empty credential list', () => {
    expect(pickCredential([], makeRequest(), NOW)).toBeNull();
  });

  it('returns null when no credential age-range matches the request', () => {
    const creds = [makeCredential({ ageRange: '13-17' })];
    expect(pickCredential(creds, makeRequest('18+'), NOW)).toBeNull();
  });

  it('returns a legacy credential (no zk-age tag) whose age-range matches', () => {
    const cred = makeCredential({ ageRange: '18+' });
    expect(pickCredential([cred], makeRequest('18+'), NOW)).toBe(cred);
  });

  it('rejects a credential that has zk-age tag but malformed rangeProof content', () => {
    const cred = makeCredential({ ageRange: '18+', zkAge: true, rangeProof: 'not-a-proof-object' });
    expect(pickCredential([cred], makeRequest('18+'), NOW)).toBeNull();
  });

  it('returns null when the stored event JSON is unparseable', () => {
    const cred = makeCredential({ ageRange: '18+' });
    cred.event = '{not-json';
    expect(pickCredential([cred], makeRequest('18+'), NOW)).toBeNull();
  });

  it('filters out credentials whose expiresAt is in the past', () => {
    const cred = makeCredential({ ageRange: '18+', expiresAt: 1500 });
    expect(pickCredential([cred], makeRequest('18+'), NOW)).toBeNull();
  });

  it('keeps credentials whose expiresAt is in the future', () => {
    const cred = makeCredential({ ageRange: '18+', expiresAt: 3000 });
    expect(pickCredential([cred], makeRequest('18+'), NOW)).toBe(cred);
  });

  it('keeps credentials with no expiresAt set', () => {
    const cred = makeCredential({ ageRange: '18+' });
    expect(pickCredential([cred], makeRequest('18+'), NOW)).toBe(cred);
  });

  it('filters out credentials where revokedAt is set, regardless of value', () => {
    const cred = makeCredential({ ageRange: '18+', revokedAt: 1 });
    expect(pickCredential([cred], makeRequest('18+'), NOW)).toBeNull();
  });

  it('prefers persona over natural-person when both satisfy the request', () => {
    const np = makeCredential({ id: 'np', keypairType: 'natural-person', ageRange: '18+' });
    const persona = makeCredential({ id: 'persona', keypairType: 'persona', ageRange: '18+' });
    expect(pickCredential([np, persona], makeRequest('18+'), NOW)).toBe(persona);
    expect(pickCredential([persona, np], makeRequest('18+'), NOW)).toBe(persona);
  });

  it('prefers higher tier when keypair type is equal', () => {
    const tier1 = makeCredential({ id: 't1', keypairType: 'persona', ageRange: '18+', tier: '1' });
    const tier3 = makeCredential({ id: 't3', keypairType: 'persona', ageRange: '18+', tier: '3' });
    expect(pickCredential([tier1, tier3], makeRequest('18+'), NOW)).toBe(tier3);
    expect(pickCredential([tier3, tier1], makeRequest('18+'), NOW)).toBe(tier3);
  });

  it('treats a missing tier tag as tier 0 (lowest)', () => {
    const noTier = makeCredential({ id: 'none', keypairType: 'persona', ageRange: '18+' });
    const tier1 = makeCredential({ id: 't1', keypairType: 'persona', ageRange: '18+', tier: '1' });
    expect(pickCredential([noTier, tier1], makeRequest('18+'), NOW)).toBe(tier1);
  });

  it('prefers newer verifiedAt when keypair type and tier are equal', () => {
    const older = makeCredential({ id: 'older', keypairType: 'persona', ageRange: '18+', tier: '3', verifiedAt: 1000 });
    const newer = makeCredential({ id: 'newer', keypairType: 'persona', ageRange: '18+', tier: '3', verifiedAt: 1500 });
    expect(pickCredential([older, newer], makeRequest('18+'), NOW)).toBe(newer);
    expect(pickCredential([newer, older], makeRequest('18+'), NOW)).toBe(newer);
  });
});

describe('pickCredentialForSubject', () => {
  const guardianPersonaPubkey = '11'.repeat(32);
  const dependantPubkey = '22'.repeat(32);
  const extraPersonaPubkey = '33'.repeat(32);

  it('returns only a credential whose event pubkey matches the signing subject', () => {
    const guardianPersona = makeCredential({
      id: 'guardian-persona',
      keypairType: 'persona',
      ageRange: '18+',
      pubkey: guardianPersonaPubkey,
    });
    const dependant = makeCredential({
      id: 'dependant',
      keypairType: 'persona',
      ageRange: '18+',
      pubkey: dependantPubkey,
    });

    expect(pickCredentialForSubject(
      [guardianPersona, dependant],
      makeRequest('18+'),
      dependantPubkey,
      NOW,
    )).toBe(dependant);
  });

  it('does not fall back to the guardian persona credential for a dependant subject', () => {
    const guardianPersona = makeCredential({
      id: 'guardian-persona',
      keypairType: 'persona',
      ageRange: '18+',
      pubkey: guardianPersonaPubkey,
    });

    expect(pickCredentialForSubject(
      [guardianPersona],
      makeRequest('18+'),
      dependantPubkey,
      NOW,
    )).toBeNull();
  });

  it('does not fall back to credentials[0] for an extra persona subject with no credential', () => {
    const firstCred = makeCredential({
      id: 'first',
      keypairType: 'natural-person',
      ageRange: '18+',
      pubkey: guardianPersonaPubkey,
    });

    expect(pickCredentialForSubject(
      [firstCred],
      makeRequest('18+'),
      extraPersonaPubkey,
      NOW,
    )).toBeNull();
  });

  it('filters subject-matching credentials by requested age range', () => {
    const childCred = makeCredential({
      id: 'child',
      keypairType: 'persona',
      ageRange: '13-17',
      pubkey: guardianPersonaPubkey,
    });

    expect(pickCredentialForSubject(
      [childCred],
      makeRequest('18+'),
      guardianPersonaPubkey,
      NOW,
    )).toBeNull();
  });

  it('parses the credential event shape used in AuthResponse', () => {
    const cred = makeCredential({
      id: 'cred-event',
      keypairType: 'persona',
      ageRange: '18+',
      pubkey: guardianPersonaPubkey,
      verifiedAt: 1234,
    });

    expect(parseStoredCredentialEvent(cred)).toMatchObject({
      id: 'cred-event',
      kind: 30470,
      pubkey: guardianPersonaPubkey,
      created_at: 1234,
    });
  });
});
