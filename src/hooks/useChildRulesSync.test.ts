// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../lib/child-rules-sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/child-rules-sync')>();
  return { ...actual, fetchChildRulesSync: vi.fn(), publishChildRulesSync: vi.fn() };
});

import { fetchChildRulesSync, publishChildRulesSync } from '../lib/child-rules-sync';
import { purgeAllUserData } from '../lib/db';
import { createNewIdentity } from '../lib/signet';
import { childRuleId } from '../lib/child-rules';
import type { SignetIdentity } from '../types';
import type { ChildRule } from '../types/child-rules';
import type { DecryptingSigningBackend } from '../lib/signing-backend';
import { useChildRulesSync } from './useChildRulesSync';

const mockFetch = vi.mocked(fetchChildRulesSync);
const mockPublish = vi.mocked(publishChildRulesSync);
const DEP = 'd'.repeat(64), KEY = 'a'.repeat(64), RELAY = 'wss://relay.example.com';

function rule(over: Partial<ChildRule> = {}): ChildRule {
  const target = 'site:https://roblox.com';
  return { id: childRuleId(DEP, '*', 'sign-in', target), dependantId: DEP, persona: '*', scope: 'sign-in',
    target: target as ChildRule['target'], decision: 'allow', createdAt: 100, updatedAt: 100, ...over };
}
let identity: SignetIdentity, backend: DecryptingSigningBackend;
beforeEach(async () => {
  await purgeAllUserData();
  mockFetch.mockReset(); mockPublish.mockReset(); mockPublish.mockResolvedValue(true);
  identity = createNewIdentity('Guardian', 'natural-person', false);
  backend = { type: 'local', activePublicKeyHex: identity.naturalPerson.publicKey, signEvent: vi.fn(), nip44Encrypt: vi.fn(), nip44Decrypt: vi.fn(), destroy: vi.fn() } as unknown as DecryptingSigningBackend;
});
afterEach(() => { vi.useRealTimers(); });
async function flush() { await act(async () => { await vi.advanceTimersByTimeAsync(100); }); }
const hookProps = (rules: ChildRule[], onMerged = vi.fn()) => ({ identity, npBackend: backend, relayUrl: RELAY, encryptionKey: KEY, rules, onMerged });

describe('useChildRulesSync', () => {
  it('does not republish on a warm unlock when remote equals local', async () => {
    const r = rule();
    mockFetch.mockResolvedValue({ rules: [r], createdAt: 1, eventId: 'e'.repeat(64), reachableRelays: 1 });
    vi.useFakeTimers();
    const { rerender } = renderHook((p: { rules: ChildRule[] }) => useChildRulesSync(hookProps(p.rules)), { initialProps: { rules: [r] } });
    await flush();
    rerender({ rules: [{ ...r }] });
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('does not publish after an unreachable fetch', async () => {
    mockFetch.mockResolvedValue('unreachable');
    vi.useFakeTimers();
    const { rerender } = renderHook((p: { rules: ChildRule[] }) => useChildRulesSync(hookProps(p.rules)), { initialProps: { rules: [rule()] } });
    await flush();
    rerender({ rules: [rule({ decision: 'deny', updatedAt: 999 })] });
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('publishes once after a local change', async () => {
    const r = rule();
    mockFetch.mockResolvedValue({ rules: [r], createdAt: 1, eventId: 'e'.repeat(64), reachableRelays: 1 });
    vi.useFakeTimers();
    const { rerender } = renderHook((p: { rules: ChildRule[] }) => useChildRulesSync(hookProps(p.rules)), { initialProps: { rules: [r] } });
    await flush();
    rerender({ rules: [rule({ decision: 'deny', updatedAt: 999 })] });
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  it('calls onMerged with the merged set when remote wins, and publishes when local is richer', async () => {
    const onMerged = vi.fn();
    mockFetch.mockResolvedValue({ rules: [rule({ decision: 'deny', updatedAt: 500 })], createdAt: 1, eventId: 'e'.repeat(64), reachableRelays: 1 });
    vi.useFakeTimers();
    renderHook(() => useChildRulesSync(hookProps([rule()], onMerged)));
    await flush();
    expect(onMerged).toHaveBeenCalledTimes(1);
    expect(onMerged.mock.calls[0][0][0].decision).toBe('deny');

  });

  it('publishes when the local side is richer than the remote', async () => {
    vi.useFakeTimers();
    const other = rule({ scope: 'dm-private', id: childRuleId(DEP, '*', 'dm-private', 'site:https://roblox.com'), updatedAt: 900 });
    mockFetch.mockResolvedValue({ rules: [rule()], createdAt: 2, eventId: 'f'.repeat(64), reachableRelays: 1 });
    renderHook(() => useChildRulesSync(hookProps([rule(), other])));
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });
});
