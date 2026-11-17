// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('../lib/dependant-status-sync', async (original) => ({
  ...await original<typeof import('../lib/dependant-status-sync')>(),
  publishDependantStatus: vi.fn(),
}));

import { publishDependantStatus } from '../lib/dependant-status-sync';
import { useDependantStatusPublisher } from './useDependantStatusPublisher';
import type { DependantIdentity } from '../types';

const mPublish = vi.mocked(publishDependantStatus);
const RELAY = 'wss://guardian.example', RAIL = 'wss://rail.example';
const dep = (over: Partial<DependantIdentity> = {}) => ({
  id: '1'.repeat(64), autonomyStage: 'request-approve',
  bunkerEndpoint: { publicKey: '9'.repeat(64), privateKey: '11'.repeat(32), authorizedClientPubkey: 'd'.repeat(64) },
  ...over,
}) as DependantIdentity;
const directDevice = { mode: 'heartwood-direct' as const, slotLabel: 'x', secretFingerprint: 'ab', slotIndex: 1, clientPubkey: 'd'.repeat(64),
  boundPersona: 'b'.repeat(64), pairedAt: 1, railRelay: RAIL };

beforeEach(() => { mPublish.mockReset(); mPublish.mockResolvedValue(true); });

it('A56: a direct dependant\'s status also goes to the pairing\'s rail relay', async () => {
  renderHook(() => useDependantStatusPublisher({ dependants: [dep({ childDevice: directDevice })], relayUrl: RELAY, encryptionKey: 'k' }));
  await waitFor(() => expect(mPublish).toHaveBeenCalledTimes(1), { timeout: 3000 });
  expect(mPublish.mock.calls[0][2]).toEqual([RELAY, RAIL]);
});

it('legacy dependant: the guardian relay only, as before', async () => {
  renderHook(() => useDependantStatusPublisher({ dependants: [dep()], relayUrl: RELAY, encryptionKey: 'k' }));
  await waitFor(() => expect(mPublish).toHaveBeenCalledTimes(1), { timeout: 3000 });
  expect(mPublish.mock.calls[0][2]).toEqual([RELAY]);
});
