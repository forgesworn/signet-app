import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the DB to avoid IndexedDB in unit test environment
vi.mock('../../lib/db', () => ({
  getDb: vi.fn(),
}));
vi.mock('../professional/role-anchor', () => ({
  buildDirectoryAddEventSigned: vi.fn().mockResolvedValue({ kind: 30203, id: 'mock-ev-id' }),
}));
vi.mock('../relay-service', () => ({
  publishEvent: vi.fn().mockResolvedValue({ ok: true, message: '' }),
}));

import { maybePassiveDirectoryPublish } from './directory-cache';
import { getDb } from '../../lib/db';
import { buildDirectoryAddEventSigned } from './role-anchor';
import { publishEvent } from '../relay-service';

const mockDb = {
  get: vi.fn(),
  put: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  (getDb as ReturnType<typeof vi.fn>).mockResolvedValue(mockDb);
});

const BASE_INPUT = {
  leadPubkey: 'aabbcc' + '0'.repeat(58),
  firmName: 'Springfield Surgery',
  identifier: { kind: 'CQC-ProviderID', value: 'RXL' },
  canonicalUrl: 'https://springfield-surgery.example',
  professionKind: 'gp-practice' as const,
  listedFlag: true,
  verifierPrivkeyHex: '1'.repeat(64),
};

describe('maybePassiveDirectoryPublish', () => {
  it('publishes when firm not yet seen and listed:true', async () => {
    mockDb.get.mockResolvedValue(undefined); // not in cache
    await maybePassiveDirectoryPublish(BASE_INPUT);
    expect(buildDirectoryAddEventSigned).toHaveBeenCalledOnce();
    expect(publishEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 30203 }),
    );
    expect(mockDb.put).toHaveBeenCalledWith(
      'proDirectorySeen',
      expect.objectContaining({ leadPubkey: BASE_INPUT.leadPubkey }),
    );
  });

  it('does NOT publish when firm is already in cache', async () => {
    mockDb.get.mockResolvedValue({ leadPubkey: BASE_INPUT.leadPubkey, seenAt: '2026-01-01' });
    await maybePassiveDirectoryPublish(BASE_INPUT);
    expect(buildDirectoryAddEventSigned).not.toHaveBeenCalled();
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('does NOT publish when lead opted out (listedFlag: false)', async () => {
    mockDb.get.mockResolvedValue(undefined);
    await maybePassiveDirectoryPublish({ ...BASE_INPUT, listedFlag: false });
    expect(buildDirectoryAddEventSigned).not.toHaveBeenCalled();
    expect(publishEvent).not.toHaveBeenCalled();
  });
});
