import { describe, it, expect } from 'vitest';
import { parseVerifyRequestFromUrl } from './url-verify';
import type { VerifyRequest } from 'signet-protocol';

function buildRequest(overrides: Partial<VerifyRequest> = {}): VerifyRequest {
  return {
    type: 'signet-verify-request',
    requestId: 'a'.repeat(32),
    requiredAgeRange: '18+',
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function toBase64(obj: unknown): string {
  return btoa(JSON.stringify(obj));
}

describe('parseVerifyRequestFromUrl', () => {
  it('returns null when the search string has no verify param', () => {
    expect(parseVerifyRequestFromUrl('')).toBeNull();
    expect(parseVerifyRequestFromUrl('?foo=bar')).toBeNull();
  });

  it('parses a valid base64 verify request', () => {
    const req = buildRequest();
    const search = '?verify=' + toBase64(req);
    const parsed = parseVerifyRequestFromUrl(search);
    expect(parsed).not.toBeNull();
    expect(parsed!.requestId).toBe(req.requestId);
    expect(parsed!.requiredAgeRange).toBe('18+');
  });

  it('parses a raw JSON verify request as a fallback', () => {
    const req = buildRequest();
    const search = '?verify=' + encodeURIComponent(JSON.stringify(req));
    const parsed = parseVerifyRequestFromUrl(search);
    expect(parsed).not.toBeNull();
    expect(parsed!.requestId).toBe(req.requestId);
  });

  it('returns null for a verify request with invalid embedded callbackUrl scheme', () => {
    const req = buildRequest({ callbackUrl: 'javascript:alert(1)' });
    const search = '?verify=' + toBase64(req);
    expect(parseVerifyRequestFromUrl(search)).toBeNull();
  });

  it('returns null for an expired verify request', () => {
    const req = buildRequest({ timestamp: 1 });
    const search = '?verify=' + toBase64(req);
    expect(parseVerifyRequestFromUrl(search)).toBeNull();
  });

  it('returns null for a verify param that is neither base64 nor raw JSON', () => {
    expect(parseVerifyRequestFromUrl('?verify=%%%')).toBeNull();
  });
});

describe('buildVerifyCallbackUrl', () => {
  it('appends verified=1 and a base64-encoded response param', async () => {
    const { buildVerifyCallbackUrl } = await import('./url-verify');
    const response = {
      type: 'signet-verify-response' as const,
      requestId: 'a'.repeat(32),
      credential: {
        id: 'cred',
        kind: 30470,
        pubkey: '00'.repeat(32),
        tags: [['age-range', '18+']],
        content: '',
        sig: 'sig',
        created_at: 1000,
      },
      subjectPubkey: '00'.repeat(32),
    };
    const url = buildVerifyCallbackUrl('https://example.com/return', response);
    const parsed = new URL(url);
    expect(parsed.searchParams.get('verified')).toBe('1');
    const rawResponse = parsed.searchParams.get('response');
    expect(rawResponse).toBeTruthy();
    const decoded = JSON.parse(atob(rawResponse!));
    expect(decoded.requestId).toBe(response.requestId);
    expect(decoded.subjectPubkey).toBe(response.subjectPubkey);
  });

  it('preserves existing query params on the callback URL', async () => {
    const { buildVerifyCallbackUrl } = await import('./url-verify');
    const response = {
      type: 'signet-verify-response' as const,
      requestId: 'a'.repeat(32),
      credential: {
        id: 'cred',
        kind: 30470,
        pubkey: '00'.repeat(32),
        tags: [],
        content: '',
        sig: '',
        created_at: 0,
      },
      subjectPubkey: '00'.repeat(32),
    };
    const url = buildVerifyCallbackUrl('https://example.com/return?session=abc', response);
    const parsed = new URL(url);
    expect(parsed.searchParams.get('session')).toBe('abc');
    expect(parsed.searchParams.get('verified')).toBe('1');
  });
});

describe('buildVerifyDeniedUrl', () => {
  it('appends verified=0 to the callback URL', async () => {
    const { buildVerifyDeniedUrl } = await import('./url-verify');
    const url = buildVerifyDeniedUrl('https://example.com/return');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('verified')).toBe('0');
  });
});
