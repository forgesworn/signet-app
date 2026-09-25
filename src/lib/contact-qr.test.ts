import { describe, it, expect, vi } from 'vitest';
import { buildContactQR, parseContactQR, sanitizeContactName, resolveScannedContactName } from './contact-qr';

const PK = 'a'.repeat(64);
const KEY = 'b'.repeat(64);

describe('buildContactQR / parseContactQR round-trip', () => {
  it('round-trips pubkey + name + avatarKey', () => {
    const raw = buildContactQR({ pubkey: PK, name: 'Alice', avatarKey: KEY });
    const p = parseContactQR(raw);
    expect(p).toEqual({ t: 'signet-contact', v: 1, pubkey: PK, name: 'Alice', avatarKey: KEY });
  });
  it('omits avatarKey when absent', () => {
    const p = parseContactQR(buildContactQR({ pubkey: PK, name: 'Bob' }));
    expect(p?.avatarKey).toBeUndefined();
    expect(p?.name).toBe('Bob');
  });
  it('omits name when blank after sanitize', () => {
    const p = parseContactQR(buildContactQR({ pubkey: PK, name: '   ' }));
    expect(p?.name).toBeUndefined();
  });
  it('lowercases pubkey + avatarKey', () => {
    const p = parseContactQR(buildContactQR({ pubkey: PK.toUpperCase(), avatarKey: KEY.toUpperCase() }));
    expect(p?.pubkey).toBe(PK);
    expect(p?.avatarKey).toBe(KEY);
  });
});

describe('parseContactQR rejection', () => {
  it('rejects non-JSON', () => expect(parseContactQR('not json')).toBeNull());
  it('rejects wrong type tag', () => expect(parseContactQR(JSON.stringify({ t: 'x', v: 1, pubkey: PK }))).toBeNull());
  it('rejects wrong version', () => expect(parseContactQR(JSON.stringify({ t: 'signet-contact', v: 2, pubkey: PK }))).toBeNull());
  it('rejects bad pubkey', () => expect(parseContactQR(JSON.stringify({ t: 'signet-contact', v: 1, pubkey: 'zz' }))).toBeNull());
  it('drops a malformed avatarKey but keeps the contact', () => {
    const p = parseContactQR(JSON.stringify({ t: 'signet-contact', v: 1, pubkey: PK, avatarKey: 'short' }));
    expect(p?.pubkey).toBe(PK);
    expect(p?.avatarKey).toBeUndefined();
  });
});

describe('sanitizeContactName', () => {
  it('strips control/bidi and caps at 100', () => {
    expect(sanitizeContactName('A‮B C')).toBe('AB C');
    expect(sanitizeContactName('x'.repeat(200)).length).toBe(100);
  });
});

describe('resolveScannedContactName', () => {
  it('prefers a fetched kind-0 display name', async () => {
    const fetchProfile = vi.fn().mockResolvedValue({ event: {}, profile: { displayName: 'Kind0 Name' } });
    expect(await resolveScannedContactName(PK, 'wss://r', 'Embedded', fetchProfile)).toBe('Kind0 Name');
  });
  it('falls back to the embedded name when no kind-0', async () => {
    const fetchProfile = vi.fn().mockResolvedValue(null);
    expect(await resolveScannedContactName(PK, 'wss://r', 'Embedded', fetchProfile)).toBe('Embedded');
  });
  it('falls back to embedded name when fetch throws', async () => {
    const fetchProfile = vi.fn().mockRejectedValue(new Error('relay down'));
    expect(await resolveScannedContactName(PK, 'wss://r', 'Embedded', fetchProfile)).toBe('Embedded');
  });
  it('returns empty string when nothing resolves', async () => {
    const fetchProfile = vi.fn().mockResolvedValue(null);
    expect(await resolveScannedContactName(PK, 'wss://r', undefined, fetchProfile)).toBe('');
  });
});
