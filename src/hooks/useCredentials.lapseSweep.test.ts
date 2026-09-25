// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { sweepLapsedCredentials } from './useCredentials';
import type { StoredCredential } from '../types';

const NOW_UNIX = 1_750_000_000;
const NOW_MS = NOW_UNIX * 1000;

function makeCredential(overrides: Partial<StoredCredential>): StoredCredential {
  return {
    id: 'test-id',
    documentId: 'doc-id',
    keypairType: 'natural-person',
    event: '{}',
    verifierPubkey: 'a'.repeat(64),
    verifiedAt: NOW_UNIX,
    verifierStatus: 'pending',
    ...overrides,
  };
}

describe('sweepLapsedCredentials', () => {
  it('transitions pending credential with elapsed pendingIssuedAt to expired-pending', () => {
    const cred = makeCredential({
      verifierStatus: 'pending',
      pendingIssuedAt: NOW_UNIX - 86400 * 31,
    });
    const result = sweepLapsedCredentials([cred], NOW_MS);
    expect(result[0].verifierStatus).toBe('expired-pending');
  });

  it('leaves pending credential within 30 days as pending', () => {
    const cred = makeCredential({
      verifierStatus: 'pending',
      pendingIssuedAt: NOW_UNIX - 86400 * 5,
    });
    const result = sweepLapsedCredentials([cred], NOW_MS);
    expect(result[0].verifierStatus).toBe('pending');
  });

  it('does not touch confirmed credentials', () => {
    const cred = makeCredential({ verifierStatus: 'confirmed' });
    const result = sweepLapsedCredentials([cred], NOW_MS);
    expect(result[0].verifierStatus).toBe('confirmed');
  });

  it('does not touch already-lapsed credentials', () => {
    const cred = makeCredential({ verifierStatus: 'expired-pending' });
    const result = sweepLapsedCredentials([cred], NOW_MS);
    expect(result[0].verifierStatus).toBe('expired-pending');
  });

  it('leaves pending credential without pendingIssuedAt unchanged', () => {
    const cred = makeCredential({ verifierStatus: 'pending', pendingIssuedAt: undefined });
    const result = sweepLapsedCredentials([cred], NOW_MS);
    expect(result[0].verifierStatus).toBe('pending');
  });
});
