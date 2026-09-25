import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { giasResolver } from './gias';

const SAMPLE_GIAS_RESPONSE = {
  urn: '100000',
  establishmentName: 'Springfield School',
  typeOfEstablishment: { name: 'Academy converter' },
  establishmentStatus: { name: 'Open' },
  website: 'https://www.springfield-school.example',
  postcode: 'ZZ1 1ZZ',
  town: 'Springfield',
  phaseOfEducation: { name: 'Secondary' },
};

function okResponse(body: object): Response {
  return {
    ok: true,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('giasResolver.matches', () => {
  it('matches a 6-digit numeric URN', () => {
    expect(giasResolver.matches('100000')).toBe(true);
  });
  it('rejects a 5-digit number', () => {
    expect(giasResolver.matches('11296')).toBe(false);
  });
  it('rejects a 7-digit number', () => {
    expect(giasResolver.matches('1000001')).toBe(false);
  });
  it('rejects non-numeric strings', () => {
    expect(giasResolver.matches('ABCDEF')).toBe(false);
  });
  it('rejects SRA firm number format', () => {
    expect(giasResolver.matches('636700')).toBe(true); // 6-digit matches — disambiguation at profession-declare level
  });
});

describe('giasResolver.resolve', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a RegulatedEntityRecord for a valid GIAS response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(okResponse(SAMPLE_GIAS_RESPONSE));
    const record = await giasResolver.resolve('100000');
    expect(record).not.toBeNull();
    expect(record!.identifier).toBe('100000');
    expect(record!.identifierKind).toBe('URN');
    expect(record!.name).toBe('Springfield School');
    expect(record!.status).toBe('Open');
    expect(record!.website).toBe('springfield-school.example');
    expect(record!.professionKind).toBe('school');
    expect(record!.registry).toBe('GIAS');
    expect(record!.jurisdiction).toBe('england-wales');
    expect(record!.postcode).toBe('ZZ1 1ZZ');
  });

  it('returns null when GIAS returns 404', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    } as Response);
    const record = await giasResolver.resolve('999999');
    expect(record).toBeNull();
  });

  it('throws on network failure (caller should retry)', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(giasResolver.resolve('100000')).rejects.toThrow('Failed to fetch');
  });

  it('strips https:// and www. from website field', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      okResponse({ ...SAMPLE_GIAS_RESPONSE, website: 'https://www.springfield-school.example' })
    );
    const record = await giasResolver.resolve('100000');
    expect(record!.website).toBe('springfield-school.example');
  });

  it('sets website to null when GIAS response has no website field', async () => {
    const { website: _removed, ...noWebsite } = SAMPLE_GIAS_RESPONSE;
    vi.mocked(fetch).mockResolvedValueOnce(okResponse(noWebsite));
    const record = await giasResolver.resolve('100000');
    expect(record!.website).toBeNull();
  });

  it('maps Closed status to Closed', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      okResponse({ ...SAMPLE_GIAS_RESPONSE, establishmentStatus: { name: 'Closed' } })
    );
    const record = await giasResolver.resolve('100000');
    expect(record!.status).toBe('Closed');
  });

  it('throws when response exceeds 256 KB size cap', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => 'x'.repeat(256 * 1024 + 1),
    } as unknown as Response);
    await expect(giasResolver.resolve('100000')).rejects.toThrow(/exceeds size limit/);
  });
});
