// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';
import { buildPersonaFirstDependant } from '../lib/dependant-record';
import { openChildRulesEvent, CHILD_RULES_WIRE_D_TAG } from '../lib/child-rules-wire';
import { childRuleId } from '../lib/child-rules';
import type { ChildRule } from '../types/child-rules';
import type { DependantIdentity } from '../types';
import type { NostrEvent } from 'signet-protocol';
import { useChildRulesPublisher, CHILD_RULES_PUBLISH_DEBOUNCE_MS } from './useChildRulesPublisher';

const railSk = generateSecretKey(), clientSk = generateSecretKey();
const RAIL = getPublicKey(railSk), CLIENT = getPublicKey(clientSk);
const PERSONA = 'b'.repeat(64);
const RELAY = 'wss://rail.example.com';

function directDep(over: Partial<DependantIdentity> = {}): DependantIdentity {
  return { ...buildPersonaFirstDependant({ guardianPubkey: 'f'.repeat(64), enteredName: 'Lily', derivationPath: 'dependant-0',
    naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '' }, persona: { publicKey: PERSONA, privateKey: '' }, createdAt: 1 }),
    autonomyStage: 'request-approve',
    bunkerEndpoint: { publicKey: RAIL, privateKey: bytesToHex(railSk), createdAt: 1, authorizedClientPubkey: CLIENT },
    childDevice: { mode: 'heartwood-direct', slotLabel: 'l', secretFingerprint: 'ab', slotIndex: 1, clientPubkey: CLIENT, boundPersona: PERSONA, pairedAt: 1 },
    ...over };
}
const rule = (dep: string, over: Partial<ChildRule> = {}): ChildRule => ({ id: childRuleId(dep, '*', 'sign-in', 'site:https://game.example.com'),
  dependantId: dep, persona: '*', scope: 'sign-in', target: 'site:https://game.example.com', decision: 'allow', createdAt: 1, updatedAt: 1, ...over });

let published: { ev: NostrEvent; relays: string[] }[];
const publish = vi.fn(async (ev: NostrEvent, relays: string[]) => { published.push({ ev, relays }); return { ok: true, message: '' }; });
beforeEach(() => { vi.useFakeTimers(); published = []; publish.mockClear(); });
afterEach(() => { vi.useRealTimers(); });
const flush = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

describe('useChildRulesPublisher', () => {
  it('publishes the live rules + ceiling to the child on the rail relay after 1 s', async () => {
    const dep = directDep();
    renderHook(() => useChildRulesPublisher({ enabled: true, dependants: [dep], childRules: [rule(dep.id), rule(dep.id, { id: 'x'.repeat(8), tombstonedAt: 5 })], relayUrl: RELAY, publish }));
    await flush(CHILD_RULES_PUBLISH_DEBOUNCE_MS - 10);
    expect(publish).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(published[0].relays).toEqual([RELAY]);
    expect(published[0].ev.tags).toContainEqual(['d', CHILD_RULES_WIRE_D_TAG]);
    const payload = await openChildRulesEvent(published[0].ev, bytesToHex(clientSk), { railPubkey: RAIL, dependantId: dep.id });
    expect(payload?.rules).toHaveLength(1);
    expect(payload?.stage).toBe('request-approve');
    expect(payload?.ceilingKinds).toContain(22242);
  });

  it('republishes on a rules change, not on an identical re-render', async () => {
    const dep = directDep();
    const { rerender } = renderHook((p: { rules: ChildRule[] }) => useChildRulesPublisher({ enabled: true, dependants: [dep], childRules: p.rules, relayUrl: RELAY, publish }),
      { initialProps: { rules: [rule(dep.id)] } });
    await flush(1100);
    await vi.waitFor(() => expect(published).toHaveLength(1));
    rerender({ rules: [rule(dep.id)] });
    await flush(1100);
    await flush(50);
    expect(published).toHaveLength(1);
    rerender({ rules: [rule(dep.id, { decision: 'deny', updatedAt: 2 })] });
    await flush(1100);
    await vi.waitFor(() => expect(published).toHaveLength(2));
    await flush(1100);
    expect(published).toHaveLength(2); // the identical re-render never sent a third
  });

  it('skips phone-paired dependants and waits while rules load', async () => {
    const dep = directDep();
    const legacy = { ...directDep(), childDevice: undefined };
    const { rerender } = renderHook((p: { rules: ChildRule[] | null }) => useChildRulesPublisher({ enabled: true, dependants: [legacy, dep], childRules: p.rules, relayUrl: RELAY, publish }),
      { initialProps: { rules: null as ChildRule[] | null } });
    await flush(1100);
    expect(publish).not.toHaveBeenCalled();
    rerender({ rules: [] });
    await flush(1100);
    await vi.waitFor(() => expect(published).toHaveLength(1));
  });
});
