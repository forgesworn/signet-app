import { describe, it, expect } from 'vitest';
import { isPrivateOrInternalHost } from './safe-url';
import { safeImageOrLinkUrl } from './public-profile-publish';

describe('isPrivateOrInternalHost (SSRF guard — security audit 2026-06-15)', () => {
  it('blocks loopback / localhost', () => {
    expect(isPrivateOrInternalHost('localhost')).toBe(true);
    expect(isPrivateOrInternalHost('app.localhost')).toBe(true);
    expect(isPrivateOrInternalHost('127.0.0.1')).toBe(true);
    expect(isPrivateOrInternalHost('127.5.4.3')).toBe(true);
    expect(isPrivateOrInternalHost('::1')).toBe(true);
  });
  it('blocks RFC1918 private ranges', () => {
    expect(isPrivateOrInternalHost('10.0.0.1')).toBe(true);
    expect(isPrivateOrInternalHost('192.168.1.1')).toBe(true);
    expect(isPrivateOrInternalHost('172.16.0.1')).toBe(true);
    expect(isPrivateOrInternalHost('172.31.255.255')).toBe(true);
  });
  it('allows 172.32 (outside the /12)', () => {
    expect(isPrivateOrInternalHost('172.32.0.1')).toBe(false);
  });
  it('blocks link-local + cloud metadata (169.254.169.254)', () => {
    expect(isPrivateOrInternalHost('169.254.169.254')).toBe(true);
    expect(isPrivateOrInternalHost('169.254.0.1')).toBe(true);
  });
  it('blocks CGNAT 100.64/10', () => {
    expect(isPrivateOrInternalHost('100.64.0.1')).toBe(true);
    expect(isPrivateOrInternalHost('100.127.255.255')).toBe(true);
    expect(isPrivateOrInternalHost('100.128.0.1')).toBe(false);
  });
  it('blocks IPv6 unique-local + link-local', () => {
    expect(isPrivateOrInternalHost('fc00::1')).toBe(true);
    expect(isPrivateOrInternalHost('fd12:3456::1')).toBe(true);
    expect(isPrivateOrInternalHost('fe80::1')).toBe(true);
    expect(isPrivateOrInternalHost('[::1]')).toBe(true); // bracketed form
  });
  it('blocks alternate IP encodings (decimal / hex / octal)', () => {
    expect(isPrivateOrInternalHost('2130706433')).toBe(true);   // 127.0.0.1 decimal
    expect(isPrivateOrInternalHost('0x7f000001')).toBe(true);   // 127.0.0.1 hex
    expect(isPrivateOrInternalHost('017700000001')).toBe(true); // 127.0.0.1 octal
    expect(isPrivateOrInternalHost('0x7f.0.0.1')).toBe(true);
  });
  it('allows public hostnames + public IPs', () => {
    expect(isPrivateOrInternalHost('blossom.example.com')).toBe(false);
    expect(isPrivateOrInternalHost('cdn.nostr.build')).toBe(false);
    expect(isPrivateOrInternalHost('8.8.8.8')).toBe(false);
    expect(isPrivateOrInternalHost('1.1.1.1')).toBe(false);
  });
  it('blocks empty / malformed', () => {
    expect(isPrivateOrInternalHost('')).toBe(true);
    expect(isPrivateOrInternalHost('999.999.999.999')).toBe(true);
  });
  it('blocks FQDN-root trailing-dot loopback (re-review 2026-06-15)', () => {
    expect(isPrivateOrInternalHost('localhost.')).toBe(true);
    expect(isPrivateOrInternalHost('app.localhost.')).toBe(true);
    expect(isPrivateOrInternalHost('127.0.0.1.')).toBe(true);
  });
  it('blocks IPv4-mapped IPv6 in BOTH dotted and URL-normalized hex forms (re-review 2026-06-15)', () => {
    // dotted form (raw input)
    expect(isPrivateOrInternalHost('::ffff:169.254.169.254')).toBe(true);
    expect(isPrivateOrInternalHost('::ffff:127.0.0.1')).toBe(true);
    // hex form (what new URL().hostname actually produces)
    expect(isPrivateOrInternalHost('::ffff:a9fe:a9fe')).toBe(true); // 169.254.169.254
    expect(isPrivateOrInternalHost('::ffff:7f00:1')).toBe(true);    // 127.0.0.1
    expect(isPrivateOrInternalHost('::ffff:a00:1')).toBe(true);     // 10.0.0.1
    // IPv4-compatible (deprecated) form
    expect(isPrivateOrInternalHost('::7f00:1')).toBe(true);         // 127.0.0.1
    // a mapped PUBLIC address is still allowed
    expect(isPrivateOrInternalHost('::ffff:808:808')).toBe(false);  // 8.8.8.8
  });
});

describe('safeImageOrLinkUrl applies the SSRF guard on the https path', () => {
  it('rejects https URLs pointing at internal hosts', () => {
    expect(safeImageOrLinkUrl('https://169.254.169.254/avatar')).toBeNull();
    expect(safeImageOrLinkUrl('https://10.0.0.5/x')).toBeNull();
    expect(safeImageOrLinkUrl('https://[::1]/x')).toBeNull();
    expect(safeImageOrLinkUrl('https://localhost/x')).toBeNull();
  });
  it('rejects v4-mapped IPv6 internal hosts AFTER URL normalization (re-review 2026-06-15)', () => {
    // new URL() normalizes these to [::ffff:a9fe:a9fe] etc — the regression the
    // re-review caught. Going through safeImageOrLinkUrl exercises the real path.
    expect(safeImageOrLinkUrl('https://[::ffff:169.254.169.254]/x')).toBeNull();
    expect(safeImageOrLinkUrl('https://[::ffff:10.0.0.1]/x')).toBeNull();
    expect(safeImageOrLinkUrl('https://[::ffff:127.0.0.1]/x')).toBeNull();
    expect(safeImageOrLinkUrl('https://localhost./x')).toBeNull();
  });
  it('still rejects non-https / dangerous schemes', () => {
    expect(safeImageOrLinkUrl('javascript:alert(1)')).toBeNull();
    expect(safeImageOrLinkUrl('data:text/html,x')).toBeNull();
    expect(safeImageOrLinkUrl('file:///etc/passwd')).toBeNull();
    expect(safeImageOrLinkUrl('http://evil.com/x')).toBeNull(); // plain http non-loopback
  });
  it('preserves the http://localhost dev exception', () => {
    expect(safeImageOrLinkUrl('http://localhost:3000/x')?.href).toBe('http://localhost:3000/x');
    expect(safeImageOrLinkUrl('http://127.0.0.1:8080/x')?.href).toBe('http://127.0.0.1:8080/x');
  });
  it('allows legitimate public https avatar/profile URLs', () => {
    expect(safeImageOrLinkUrl('https://cdn.nostr.build/abc.jpg')?.protocol).toBe('https:');
    expect(safeImageOrLinkUrl('https://blossom.example.com/hash')?.protocol).toBe('https:');
  });
});
