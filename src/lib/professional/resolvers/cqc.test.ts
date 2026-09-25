import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.stubEnv('VITE_CQC_PARTNER_CODE', '');

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { CQCResolver } from './cqc';

const resolver = new CQCResolver();

function cqcResponse(overrides: Record<string, unknown> = {}) {
  return {
    providerId: 'RXL',
    name: 'Springfield Practice',
    registrationStatus: 'Registered',
    mainAddress: { postalCode: 'SP1 1AA', town: 'Springfield' },
    website: 'https://www.springfield.gp.nhs.uk/',
    type: 'GP practices',
    ...overrides,
  };
}

function okFetch(body: object): ReturnType<typeof mockFetch> {
  return { ok: true, text: async () => JSON.stringify(body) };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

describe('CQCResolver', () => {
  it('resolves a valid CQC provider to a RegulatedEntityRecord', async () => {
    mockFetch.mockResolvedValueOnce(okFetch(cqcResponse()));
    const record = await resolver.resolve('RXL');
    expect(record).not.toBeNull();
    expect(record?.name).toBe('Springfield Practice');
    expect(record?.status).toBe('Active');
    expect(record?.website).toBe('springfield.gp.nhs.uk');
    expect(record?.identifier).toBe('RXL');
    expect(record?.identifierKind).toBe('CQC-ProviderID');
    expect(record?.professionKind).toBe('gp-practice');
    expect(record?.jurisdiction).toBe('england');
  });

  it('strips www. and trailing slash from website', async () => {
    mockFetch.mockResolvedValueOnce(okFetch(cqcResponse({ website: 'https://www.springfield.gp.nhs.uk/' })));
    const record = await resolver.resolve('RXL');
    expect(record?.website).toBe('springfield.gp.nhs.uk');
  });

  it('returns null when registrationStatus is not Registered', async () => {
    mockFetch.mockResolvedValueOnce(okFetch(cqcResponse({ registrationStatus: 'Cancelled' })));
    const record = await resolver.resolve('RXL');
    expect(record).not.toBeNull();
    expect(record?.status).toBe('Inactive');
  });

  it('returns null when provider is not found (404)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    const record = await resolver.resolve('NOTFOUND');
    expect(record).toBeNull();
  });

  it('throws on transient failure (500) for caller retry', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(resolver.resolve('RXL')).rejects.toThrow();
  });

  it('matches CQC-style provider IDs', () => {
    expect(resolver.matches('RXL')).toBe(true);
    expect(resolver.matches('1-123456789')).toBe(true);  // numeric CQC format
    expect(resolver.matches('100000')).toBe(false);       // GIAS URN — not CQC
  });

  it('does not send partnerCode header when env var is empty', async () => {
    mockFetch.mockResolvedValueOnce(okFetch(cqcResponse()));
    await resolver.resolve('RXL');
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain('partnerCode');
    expect((opts?.headers as Record<string, string> | undefined)?.['partnerCode']).toBeUndefined();
  });

  it('sends partnerCode query param when env var is set', async () => {
    vi.stubEnv('VITE_CQC_PARTNER_CODE', 'SIGNET001');
    mockFetch.mockResolvedValueOnce(okFetch(cqcResponse()));
    await resolver.resolve('RXL');
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('partnerCode=SIGNET001');
  });

  it('throws when response exceeds 256 KB size cap', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'x'.repeat(256 * 1024 + 1) });
    await expect(resolver.resolve('RXL')).rejects.toThrow(/exceeds size limit/);
  });
});
