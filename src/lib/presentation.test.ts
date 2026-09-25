import { describe, it, expect } from 'vitest';
import { parseVerifyRequest, buildVerifyResponse, credentialSatisfiesRequest } from './presentation';

const now = Math.floor(Date.now() / 1000);
const validHex32 = 'a'.repeat(32);

function validRequestJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'signet-verify-request',
    requestId: validHex32,
    requiredAgeRange: '18+',
    timestamp: now,
    ...overrides,
  });
}

describe('parseVerifyRequest', () => {
  it('parses valid JSON request', () => {
    const result = parseVerifyRequest(validRequestJson());
    expect(result).not.toBeNull();
    expect(result!.type).toBe('signet-verify-request');
    expect(result!.requestId).toBe(validHex32);
    expect(result!.requiredAgeRange).toBe('18+');
  });

  it('parses base64 with signet:verify: prefix', () => {
    const json = validRequestJson();
    const result = parseVerifyRequest('signet:verify:' + btoa(json));
    expect(result).not.toBeNull();
    expect(result!.requiredAgeRange).toBe('18+');
  });

  it('returns null for invalid JSON', () => {
    expect(parseVerifyRequest('not json')).toBeNull();
  });

  it('returns null for wrong type', () => {
    expect(parseVerifyRequest(validRequestJson({ type: 'other' }))).toBeNull();
  });

  it('returns null for missing requestId', () => {
    const json = JSON.stringify({ type: 'signet-verify-request', requiredAgeRange: '18+', timestamp: now });
    expect(parseVerifyRequest(json)).toBeNull();
  });

  it('returns null for invalid requestId format', () => {
    expect(parseVerifyRequest(validRequestJson({ requestId: 'short' }))).toBeNull();
    expect(parseVerifyRequest(validRequestJson({ requestId: 'g'.repeat(32) }))).toBeNull();
  });

  it('returns null for invalid age range', () => {
    expect(parseVerifyRequest(validRequestJson({ requiredAgeRange: '99+' }))).toBeNull();
  });

  it('accepts all valid age ranges', () => {
    for (const range of ['0-3', '4-7', '8-12', '13-17', '18+']) {
      expect(parseVerifyRequest(validRequestJson({ requiredAgeRange: range }))).not.toBeNull();
    }
  });

  it('returns null for stale timestamp', () => {
    expect(parseVerifyRequest(validRequestJson({ timestamp: now - 600 }))).toBeNull();
  });

  it('returns null for missing timestamp', () => {
    const json = JSON.stringify({ type: 'signet-verify-request', requestId: validHex32, requiredAgeRange: '18+' });
    expect(parseVerifyRequest(json)).toBeNull();
  });

  it('validates callbackUrl scheme', () => {
    expect(parseVerifyRequest(validRequestJson({ callbackUrl: 'https://example.com/cb' }))).not.toBeNull();
    expect(parseVerifyRequest(validRequestJson({ callbackUrl: 'http://example.com/cb' }))).toBeNull();
    expect(parseVerifyRequest(validRequestJson({ callbackUrl: 'http://localhost:3000/cb' }))).not.toBeNull();
  });

  it('validates relayUrl scheme', () => {
    expect(parseVerifyRequest(validRequestJson({ relayUrl: 'wss://relay.example.com' }))).not.toBeNull();
    expect(parseVerifyRequest(validRequestJson({ relayUrl: 'http://relay.example.com' }))).toBeNull();
    expect(parseVerifyRequest(validRequestJson({ relayUrl: 'ws://localhost:7777' }))).not.toBeNull();
  });
});

describe('buildVerifyResponse', () => {
  it('builds a valid response structure', () => {
    const credential = {
      id: 'cred-1', kind: 29999, pubkey: 'a'.repeat(64),
      tags: [['age-range', '18+']], content: '', sig: 'b'.repeat(128), created_at: now,
    };
    const response = buildVerifyResponse('req-1', credential, 'c'.repeat(64));
    expect(response.type).toBe('signet-verify-response');
    expect(response.requestId).toBe('req-1');
    expect(response.credential).toBe(credential);
    expect(response.subjectPubkey).toBe('c'.repeat(64));
  });
});

describe('credentialSatisfiesRequest', () => {
  it('matches exact age range', () => {
    expect(credentialSatisfiesRequest([['age-range', '18+']], '18+')).toBe(true);
  });

  it('does not match different age ranges', () => {
    expect(credentialSatisfiesRequest([['age-range', '13-17']], '18+')).toBe(false);
  });

  it('returns false when no age-range tag', () => {
    expect(credentialSatisfiesRequest([['other', 'value']], '18+')).toBe(false);
  });

  it('returns false for empty tags', () => {
    expect(credentialSatisfiesRequest([], '18+')).toBe(false);
  });
});
