import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  generateSignetJson,
  fetchAndValidateSignetJson,
  fetchProSignetJson,
  normaliseHost,
  normaliseLeadPubkeys,
  type SignetJsonPayload,
} from './signet-json';

// ── normaliseHost ─────────────────────────────────────────────────────────────

describe('normaliseHost', () => {
  it('strips www.', () => {
    expect(normaliseHost('www.springfield-school.example')).toBe('springfield-school.example');
  });
  it('lowercases', () => {
    expect(normaliseHost('SPRINGFIELD-SCHOOL.EXAMPLE')).toBe('springfield-school.example');
  });
  it('leaves bare host untouched', () => {
    expect(normaliseHost('springfield-school.example')).toBe('springfield-school.example');
  });
  it('strips trailing slash', () => {
    expect(normaliseHost('springfield-school.example/')).toBe('springfield-school.example');
  });
});

// ── generateSignetJson ────────────────────────────────────────────────────────

describe('generateSignetJson', () => {
  it('produces a valid JSON string with expected fields', () => {
    const json = generateSignetJson({
      professionKind: 'school',
      entityName: 'Springfield School',
      identifier: '100000',
      identifierKind: 'URN',
      leadPubkeyNpubs: ['npub1testpubkeytest'],
      canonicalDomain: 'springfield-school.example',
      relays: ['wss://relay.forgesworn.dev'],
      publishedAt: '2026-09-01T00:00:00Z',
    });
    const parsed: SignetJsonPayload = JSON.parse(json);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.kind).toBe('school');
    expect(parsed.identifier.kind).toBe('URN');
    expect(parsed.identifier.value).toBe('100000');
    expect(parsed.headPubkey).toBe('npub1testpubkeytest');
    expect(parsed.relays).toContain('wss://relay.forgesworn.dev');
    expect(parsed.canonicalPage).toContain('springfield-school.example');
  });

  it('sets kind to "gp-practice" for GP profession', () => {
    const json = generateSignetJson({
      professionKind: 'gp-practice',
      entityName: 'Springfield Practice',
      identifier: 'RXL01',
      identifierKind: 'CQC-ProviderID',
      leadPubkeyNpubs: ['npub1testpubkey2'],
      canonicalDomain: 'springfieldpractice.nhs.uk',
      relays: ['wss://relay.forgesworn.dev'],
      publishedAt: '2026-09-01T00:00:00Z',
    });
    const parsed: SignetJsonPayload = JSON.parse(json);
    expect(parsed.kind).toBe('gp-practice');
    expect(parsed.identifier.kind).toBe('CQC-ProviderID');
  });

  it('emits headPubkey (singular) for 1-lead and round-trips through normaliseLeadPubkeys', () => {
    const PUBKEY_A = 'a'.repeat(64);
    const json = generateSignetJson({
      professionKind: 'school',
      entityName: 'Test School',
      identifier: '000001',
      identifierKind: 'URN',
      leadPubkeyNpubs: [PUBKEY_A],
      canonicalDomain: 'test.school.co.uk',
      relays: ['wss://relay.forgesworn.dev'],
      publishedAt: '2026-09-01T00:00:00Z',
    });
    const parsed = JSON.parse(json);
    expect(typeof parsed.headPubkey).toBe('string');
    expect(parsed.headPubkeys).toBeUndefined();
    expect(normaliseLeadPubkeys(parsed)).toEqual([PUBKEY_A]);
  });

  it('emits headPubkeys (array) for 2-lead and round-trips through normaliseLeadPubkeys', () => {
    const PUBKEY_A = 'a'.repeat(64);
    const PUBKEY_B = 'b'.repeat(64);
    const json = generateSignetJson({
      professionKind: 'gp-practice',
      entityName: 'Co-Lead Practice',
      identifier: 'RXL02',
      identifierKind: 'CQC-ProviderID',
      leadPubkeyNpubs: [PUBKEY_A, PUBKEY_B],
      canonicalDomain: 'coleadpractice.nhs.uk',
      relays: ['wss://relay.forgesworn.dev'],
      publishedAt: '2026-09-01T00:00:00Z',
    });
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed.headPubkeys)).toBe(true);
    expect(parsed.headPubkey).toBeUndefined();
    expect(normaliseLeadPubkeys(parsed)).toEqual([PUBKEY_A, PUBKEY_B]);
  });
});

// ── fetchAndValidateSignetJson ────────────────────────────────────────────────

describe('fetchAndValidateSignetJson', () => {
  const validPayload: SignetJsonPayload = {
    schemaVersion: 1,
    kind: 'school',
    entityName: 'Springfield School',
    identifier: { kind: 'URN', value: '100000' },
    headPubkey: 'npub1testpubkeytest',
    relays: ['wss://relay.forgesworn.dev'],
    canonicalPage: 'https://springfield-school.example/safeguarding/e-safety/',
    publishedAt: '2026-09-01T00:00:00Z',
  };

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects http:// URLs', async () => {
    await expect(
      fetchAndValidateSignetJson('http://springfield-school.example', '100000', 'npub1testpubkeytest')
    ).rejects.toThrow(/HTTPS/);
  });

  it('accepts HTTPS:// URLs with uppercase scheme', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify(validPayload),
    } as Response);
    const result = await fetchAndValidateSignetJson(
      'HTTPS://springfield-school.example',
      '100000',
      'npub1testpubkeytest'
    );
    expect(result.identifier.value).toBe('100000');
  });

  it('rejects when response body exceeds 8KB', async () => {
    const big = 'x'.repeat(8193);
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => big,
    } as Response);
    await expect(
      fetchAndValidateSignetJson('https://springfield-school.example', '100000', 'npub1testpubkeytest')
    ).rejects.toThrow(/8KB/);
  });

  it('rejects when headPubkey does not match expectedPubkey', async () => {
    const mismatch = { ...validPayload, headPubkey: 'npub1wrongkey' };
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify(mismatch),
    } as Response);
    await expect(
      fetchAndValidateSignetJson('https://springfield-school.example', '100000', 'npub1testpubkeytest')
    ).rejects.toThrow(/headPubkey/);
  });

  it('rejects when identifier.value does not match expectedIdentifier', async () => {
    const mismatch = { ...validPayload, identifier: { kind: 'URN', value: '999999' } };
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify(mismatch),
    } as Response);
    await expect(
      fetchAndValidateSignetJson('https://springfield-school.example', '100000', 'npub1testpubkeytest')
    ).rejects.toThrow(/identifier/);
  });

  it('returns the parsed payload on success', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify(validPayload),
    } as Response);
    const result = await fetchAndValidateSignetJson(
      'https://springfield-school.example',
      '100000',
      'npub1testpubkeytest'
    );
    expect(result.identifier.value).toBe('100000');
    expect(result.headPubkey).toBe('npub1testpubkeytest');
  });

  it('rejects when schemaVersion is missing', async () => {
    const missing = { ...validPayload, schemaVersion: undefined };
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify(missing),
    } as Response);
    await expect(
      fetchAndValidateSignetJson('https://springfield-school.example', '100000', 'npub1testpubkeytest')
    ).rejects.toThrow(/schema/i);
  });
});

// ── fetchProSignetJson redirect-tracking (audit pass 4) ───────────────────────

describe('fetchProSignetJson _fetchedFromHost tracking', () => {
  const proPayload = {
    schemaVersion: 1,
    kind: 'school',
    entityName: 'Example School',
    identifier: { kind: 'URN', value: '100000' },
    headPubkey: 'npub1testpubkeytest',
    relays: ['wss://relay.example'],
    canonicalPage: 'https://example.com/',
    publishedAt: '2026-05-18T00:00:00Z',
  };

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('records _fetchedFromHost from response.url, not the requested host', async () => {
    // Caller asked for legit.example, but the response was actually served
    // from attacker.example (cross-origin redirect). The fix must record
    // the real response origin so verify-chain can detect the mismatch.
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      url: 'https://attacker.example/.well-known/signet.json',
      text: async () => JSON.stringify(proPayload),
    } as Response);
    const result = await fetchProSignetJson('legit.example');
    expect(result).not.toBeNull();
    expect(result?._fetchedFromHost).toBe('attacker.example');
  });

  it('records _fetchedFromHost matching the requested host on no redirect', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      url: 'https://legit.example/.well-known/signet.json',
      text: async () => JSON.stringify(proPayload),
    } as Response);
    const result = await fetchProSignetJson('legit.example');
    expect(result?._fetchedFromHost).toBe('legit.example');
  });
});
