import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.stubEnv('VITE_SRA_API_KEY', '');
vi.stubEnv('VITE_SRA_MIRROR_URL', '');

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { SRAResolver } from './sra';

const resolver = new SRAResolver();

function sraResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: '123456',
    name: 'Smith & Partners LLP',
    status: 'Authorised',
    address: { postcode: 'EC1A 1BB', town: 'London' },
    website: 'https://www.smithandpartners.example/',
    ...overrides,
  };
}

function okFetch(body: object): ReturnType<typeof mockFetch> {
  return { ok: true, text: async () => JSON.stringify(body) };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

describe('SRAResolver', () => {
  it('resolves a valid SRA firm to RegulatedEntityRecord', async () => {
    vi.stubEnv('VITE_SRA_API_KEY', 'testkey');
    mockFetch.mockResolvedValueOnce(okFetch(sraResponse()));
    const record = await resolver.resolve('123456');
    expect(record?.name).toBe('Smith & Partners LLP');
    expect(record?.status).toBe('Active');
    expect(record?.identifier).toBe('123456');
    expect(record?.identifierKind).toBe('SRA-FirmNumber');
    expect(record?.professionKind).toBe('solicitor-firm');
    expect(record?.jurisdiction).toBe('england-wales');
    expect(record?.website).toBe('smithandpartners.example');
  });

  it('maps non-Authorised status to Inactive', async () => {
    vi.stubEnv('VITE_SRA_API_KEY', 'testkey');
    mockFetch.mockResolvedValueOnce(okFetch(sraResponse({ status: 'Revoked' })));
    const record = await resolver.resolve('123456');
    expect(record?.status).toBe('Inactive');
  });

  it('returns null on 404', async () => {
    vi.stubEnv('VITE_SRA_API_KEY', 'testkey');
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    const record = await resolver.resolve('NOTFOUND');
    expect(record).toBeNull();
  });

  it('throws on 500 for caller retry', async () => {
    vi.stubEnv('VITE_SRA_API_KEY', 'testkey');
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(resolver.resolve('123456')).rejects.toThrow();
  });

  it('matches 5-7 digit SRA firm numbers', () => {
    expect(resolver.matches('12345')).toBe(true);
    expect(resolver.matches('123456')).toBe(true);   // 6-digit SRA firm number
    expect(resolver.matches('1234567')).toBe(true);
    expect(resolver.matches('RXL')).toBe(false);     // CQC ID
  });

  it('sends Ocp-Apim-Subscription-Key header when VITE_SRA_API_KEY is set', async () => {
    vi.stubEnv('VITE_SRA_API_KEY', 'testkey');
    mockFetch.mockResolvedValueOnce(okFetch(sraResponse()));
    await resolver.resolve('123456');
    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((opts?.headers as Record<string, string>)?.['Ocp-Apim-Subscription-Key']).toBe('testkey');
  });

  it('falls back to mirror URL when no API key and mirror is configured', async () => {
    vi.stubEnv('VITE_SRA_MIRROR_URL', 'https://mirror.signet.app/sra');
    mockFetch.mockResolvedValueOnce(okFetch(sraResponse()));
    await resolver.resolve('123456');
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('mirror.signet.app/sra');
  });

  it('throws when response exceeds 256 KB size cap', async () => {
    vi.stubEnv('VITE_SRA_API_KEY', 'testkey');
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'x'.repeat(256 * 1024 + 1) });
    await expect(resolver.resolve('123456')).rejects.toThrow(/exceeds size limit/);
  });
});
