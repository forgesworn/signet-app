import { describe, it, expect } from 'vitest';
import { parseCallback, buildCallbackRedirect } from './nostrconnect-callback';

describe('parseCallback', () => {
  describe('scheme validation', () => {
    it('accepts https://', () => {
      expect(parseCallback('https://matchpass.app/paired')).toBe('https://matchpass.app/paired');
    });

    it('accepts http://localhost', () => {
      expect(parseCallback('http://localhost:3000/cb')).toBe('http://localhost:3000/cb');
    });

    it('accepts http://127.0.0.1', () => {
      expect(parseCallback('http://127.0.0.1:3000/cb')).toBe('http://127.0.0.1:3000/cb');
    });

    it('rejects http://<non-loopback-host>', () => {
      expect(parseCallback('http://matchpass.app/paired')).toBeNull();
    });

    it('rejects http://192.168.1.50 (private IP)', () => {
      expect(parseCallback('http://192.168.1.50/cb')).toBeNull();
    });

    it('rejects custom schemes', () => {
      expect(parseCallback('matchpass://paired')).toBeNull();
    });

    it('rejects javascript:', () => {
      expect(parseCallback('javascript:alert(1)')).toBeNull();
    });

    it('rejects data: URLs', () => {
      expect(parseCallback('data:text/html,<script>alert(1)</script>')).toBeNull();
    });

    it('rejects file://', () => {
      expect(parseCallback('file:///etc/passwd')).toBeNull();
    });
  });

  describe('null / empty input', () => {
    it('returns null for null', () => {
      expect(parseCallback(null)).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(parseCallback('')).toBeNull();
    });

    it('returns null for garbage', () => {
      expect(parseCallback('not a url')).toBeNull();
    });
  });

  describe('origin-match (anti-phishing) when appUrl is declared', () => {
    it('accepts callback on same origin as appUrl', () => {
      expect(parseCallback('https://matchpass.app/paired', 'https://matchpass.app'))
        .toBe('https://matchpass.app/paired');
    });

    it('accepts callback with different path on same origin', () => {
      expect(parseCallback('https://matchpass.app/auth/cb', 'https://matchpass.app/pair'))
        .toBe('https://matchpass.app/auth/cb');
    });

    it('accepts callback with different port ... wait, different ports are different origins', () => {
      // Same host, different port = different origin. Should reject.
      expect(parseCallback('https://matchpass.app:8443/cb', 'https://matchpass.app/pair'))
        .toBeNull();
    });

    it('rejects callback on subdomain when appUrl is apex', () => {
      expect(parseCallback('https://attacker.matchpass.app/cb', 'https://matchpass.app'))
        .toBeNull();
    });

    it('rejects callback on different host', () => {
      expect(parseCallback('https://evil.com/stolen', 'https://matchpass.app'))
        .toBeNull();
    });

    it('rejects callback on http when appUrl is https', () => {
      expect(parseCallback('http://localhost:3000/cb', 'https://matchpass.app'))
        .toBeNull();
    });

    it('handles malformed appUrl by rejecting', () => {
      expect(parseCallback('https://matchpass.app/cb', 'not a url'))
        .toBeNull();
    });
  });

  describe('no appUrl — any valid-scheme callback accepted', () => {
    it('accepts callback when no appUrl is provided', () => {
      expect(parseCallback('https://matchpass.app/paired'))
        .toBe('https://matchpass.app/paired');
    });

    it('accepts localhost callback when no appUrl is provided', () => {
      expect(parseCallback('http://localhost:5173/cb'))
        .toBe('http://localhost:5173/cb');
    });
  });

  describe('userinfo (phishing-UX) rejection', () => {
    it('rejects https:// callback containing username', () => {
      expect(parseCallback('https://attacker@matchpass.app/cb'))
        .toBeNull();
    });

    it('rejects https:// callback containing username + password', () => {
      expect(parseCallback('https://user:pass@matchpass.app/cb'))
        .toBeNull();
    });

    it('rejects even when appUrl origin matches (credentials still strip)', () => {
      expect(parseCallback('https://u:p@matchpass.app/cb', 'https://matchpass.app'))
        .toBeNull();
    });
  });
});

describe('buildCallbackRedirect', () => {
  it('appends ?status=approved to a clean URL', () => {
    const url = buildCallbackRedirect('https://matchpass.app/paired', 'approved');
    expect(new URL(url).searchParams.get('status')).toBe('approved');
  });

  it('appends ?status=denied to a clean URL', () => {
    const url = buildCallbackRedirect('https://matchpass.app/paired', 'denied');
    expect(new URL(url).searchParams.get('status')).toBe('denied');
  });

  it('preserves existing query params', () => {
    const url = buildCallbackRedirect('https://matchpass.app/cb?ref=home', 'approved');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('ref')).toBe('home');
    expect(parsed.searchParams.get('status')).toBe('approved');
  });

  it('replaces a pre-existing status param', () => {
    const url = buildCallbackRedirect('https://matchpass.app/cb?status=stale', 'approved');
    expect(new URL(url).searchParams.getAll('status')).toEqual(['approved']);
  });
});
