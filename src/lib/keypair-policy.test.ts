import { describe, it, expect } from 'vitest';
import { resolvePolicy, classifyEmptyState, shouldOverrideIncomingDefault } from './keypair-policy';
import type { KeypairOption } from './keypair-policy';
import type { ConsumerHint, OriginPolicy } from '../types';

const NP: KeypairOption = { key: 'natural-person', token: 'natural-person', label: 'Alice', pubkey: 'np-pub' };
const PERS: KeypairOption = { key: 'persona', token: 'persona', label: 'Shade', pubkey: 'pers-pub' };
const EX1: KeypairOption = { key: 'ex1pub', token: 'extra-persona', label: 'Gamer', pubkey: 'ex1pub' };
const EX2: KeypairOption = { key: 'ex2pub', token: 'extra-persona', label: 'Forum', pubkey: 'ex2pub' };

const ALL: KeypairOption[] = [NP, PERS, EX1, EX2];
const GUARDS = { requireNpConfirmation: true };
const GUARDS_OFF = { requireNpConfirmation: false };

describe('resolvePolicy', () => {
  it('no hint → returns all options in original order', () => {
    const result = resolvePolicy({ options: ALL, consumerHint: null, appGuardrails: GUARDS });
    expect(result.ranked.map(o => o.key)).toEqual(['natural-person', 'persona', 'ex1pub', 'ex2pub']);
    expect(result.hidden).toEqual([]);
    expect(result.defaultKey).toBe('natural-person');
    expect(result.caption).toBeNull();
    expect(result.requireNpConfirmation).toBe(true);
  });

  it('hint with empty allow array → returns all options, shows reason if present', () => {
    const hint: ConsumerHint = { allow: [], reason: 'Pick anything' };
    const result = resolvePolicy({ options: ALL, consumerHint: hint, appGuardrails: GUARDS });
    expect(result.ranked).toHaveLength(4);
    expect(result.hidden).toEqual([]);
    expect(result.caption).toBe('Pick anything');
  });

  it('accept=persona hides NP, keeps persona + extras-are-hidden (only listed tokens allowed)', () => {
    const hint: ConsumerHint = { allow: ['persona'] };
    const result = resolvePolicy({ options: ALL, consumerHint: hint, appGuardrails: GUARDS });
    expect(result.ranked.map(o => o.key)).toEqual(['persona']);
    expect(result.hidden.map(o => o.key)).toEqual(['natural-person', 'ex1pub', 'ex2pub']);
    expect(result.defaultKey).toBe('persona');
    expect(result.caption).toBe('This site asked for a persona');
  });

  it('accept=persona,extra-persona hides only NP', () => {
    const hint: ConsumerHint = { allow: ['persona', 'extra-persona'] };
    const result = resolvePolicy({ options: ALL, consumerHint: hint, appGuardrails: GUARDS });
    expect(result.ranked.map(o => o.key)).toEqual(['persona', 'ex1pub', 'ex2pub']);
    expect(result.hidden.map(o => o.key)).toEqual(['natural-person']);
  });

  it('order in allow controls default — persona first', () => {
    const hint: ConsumerHint = { allow: ['persona', 'extra-persona'] };
    const result = resolvePolicy({ options: ALL, consumerHint: hint, appGuardrails: GUARDS });
    expect(result.defaultKey).toBe('persona');
  });

  it('order in allow controls default — extra-persona first', () => {
    const hint: ConsumerHint = { allow: ['extra-persona', 'persona'] };
    const result = resolvePolicy({ options: ALL, consumerHint: hint, appGuardrails: GUARDS });
    expect(result.ranked.map(o => o.token)).toEqual(['extra-persona', 'extra-persona', 'persona']);
    expect(result.defaultKey).toBe('ex1pub');
  });

  it('explicit prefer= promotes matching token to front', () => {
    const hint: ConsumerHint = { allow: ['persona', 'extra-persona'], prefer: 'extra-persona' };
    const result = resolvePolicy({ options: ALL, consumerHint: hint, appGuardrails: GUARDS });
    expect(result.defaultKey).toBe('ex1pub');
  });

  it('prefer= outside allowlist is ignored', () => {
    const hint: ConsumerHint = { allow: ['persona'], prefer: 'natural-person' };
    const result = resolvePolicy({ options: ALL, consumerHint: hint, appGuardrails: GUARDS });
    expect(result.defaultKey).toBe('persona');
  });

  it('accept filter leaves empty ranked when user has no matching option', () => {
    const hint: ConsumerHint = { allow: ['persona'] };
    const result = resolvePolicy({ options: [NP], consumerHint: hint, appGuardrails: GUARDS });
    expect(result.ranked).toEqual([]);
    expect(result.hidden.map(o => o.key)).toEqual(['natural-person']);
    expect(result.defaultKey).toBeNull();
  });

  it('accept_reason overrides the default caption', () => {
    const hint: ConsumerHint = { allow: ['persona'], reason: 'AxeNStax uses persona identities for player privacy' };
    const result = resolvePolicy({ options: ALL, consumerHint: hint, appGuardrails: GUARDS });
    expect(result.caption).toBe('AxeNStax uses persona identities for player privacy');
  });

  it('app guardrail pass-through — disabled', () => {
    const result = resolvePolicy({ options: ALL, consumerHint: null, appGuardrails: GUARDS_OFF });
    expect(result.requireNpConfirmation).toBe(false);
  });

  it('hint with only reason (no allow) returns all options', () => {
    const hint: ConsumerHint = { allow: [], reason: 'Hi' };
    const result = resolvePolicy({ options: ALL, consumerHint: hint, appGuardrails: GUARDS });
    expect(result.ranked).toHaveLength(4);
    expect(result.hidden).toEqual([]);
  });

  it('accept=natural-person only — hostile case — yields NP as sole option', () => {
    const hint: ConsumerHint = { allow: ['natural-person'] };
    const result = resolvePolicy({ options: ALL, consumerHint: hint, appGuardrails: GUARDS });
    expect(result.ranked.map(o => o.key)).toEqual(['natural-person']);
    expect(result.caption).toBe('This site asked for your real-name identity');
    expect(result.requireNpConfirmation).toBe(true);
  });
});

describe('resolvePolicy — origin memory', () => {
  const mem = (overrides: Partial<OriginPolicy> = {}): OriginPolicy => ({
    origin: 'https://example.com',
    lastKeypair: 'persona',
    lastUsed: 1000,
    pinned: false,
    userOverrode: false,
    ...overrides,
  });

  it('pinned origin → promotes pinned keypair regardless of consumer hint', () => {
    const hint: ConsumerHint = { allow: ['persona'] };
    const result = resolvePolicy({
      options: ALL,
      consumerHint: hint,
      appGuardrails: GUARDS,
      originMemory: mem({ lastKeypair: 'natural-person', pinned: true }),
    });
    expect(result.defaultKey).toBe('natural-person');
    expect(result.ranked[0].key).toBe('natural-person');
    expect(result.caption).toContain('pinned');
  });

  it('unpinned origin memory → pre-selects last keypair when no hint', () => {
    const result = resolvePolicy({
      options: ALL,
      consumerHint: null,
      appGuardrails: GUARDS,
      originMemory: mem({ lastKeypair: 'ex1pub' }),
    });
    expect(result.defaultKey).toBe('ex1pub');
    expect(result.ranked[0].key).toBe('ex1pub');
  });

  it('origin memory + consumer hint → memory nudges within allowlist', () => {
    const hint: ConsumerHint = { allow: ['persona', 'extra-persona'] };
    const result = resolvePolicy({
      options: ALL,
      consumerHint: hint,
      appGuardrails: GUARDS,
      originMemory: mem({ lastKeypair: 'ex1pub' }),
    });
    // Memory promotes ex1pub, but it must still be in the allowlist.
    expect(result.defaultKey).toBe('ex1pub');
  });

  it('origin memory ignored when remembered keypair is filtered out', () => {
    const hint: ConsumerHint = { allow: ['persona'] };
    const result = resolvePolicy({
      options: ALL,
      consumerHint: hint,
      appGuardrails: GUARDS,
      originMemory: mem({ lastKeypair: 'natural-person' }),
    });
    expect(result.defaultKey).toBe('persona');
  });

  it('pinned keypair no longer exists → falls through to normal flow', () => {
    const result = resolvePolicy({
      options: ALL,
      consumerHint: null,
      appGuardrails: GUARDS,
      originMemory: mem({ lastKeypair: 'deleted-pub', pinned: true }),
    });
    expect(result.defaultKey).toBe('natural-person');
    expect(result.caption).toBeNull();
  });

  it('consumer prefer= beats origin memory', () => {
    const hint: ConsumerHint = { allow: ['persona', 'extra-persona'], prefer: 'persona' };
    const result = resolvePolicy({
      options: ALL,
      consumerHint: hint,
      appGuardrails: GUARDS,
      originMemory: mem({ lastKeypair: 'ex1pub' }),
    });
    expect(result.defaultKey).toBe('persona');
  });
});

describe('resolvePolicy — user defaults', () => {
  it('preferPersona with no hint → persona default', () => {
    const result = resolvePolicy({
      options: ALL,
      consumerHint: null,
      appGuardrails: GUARDS,
      userDefaults: { preferPersonaForSignIns: true },
    });
    expect(result.defaultKey).toBe('persona');
  });

  it('preferPersona does NOT override consumer hint', () => {
    const hint: ConsumerHint = { allow: ['natural-person'] };
    const result = resolvePolicy({
      options: ALL,
      consumerHint: hint,
      appGuardrails: GUARDS,
      userDefaults: { preferPersonaForSignIns: true },
    });
    expect(result.defaultKey).toBe('natural-person');
  });

  it('origin memory beats preferPersona when both present and no hint', () => {
    const result = resolvePolicy({
      options: ALL,
      consumerHint: null,
      appGuardrails: GUARDS,
      userDefaults: { preferPersonaForSignIns: true },
      originMemory: {
        origin: 'https://example.com',
        lastKeypair: 'ex1pub',
        lastUsed: 1000,
        pinned: false,
        userOverrode: false,
      },
    });
    expect(result.defaultKey).toBe('ex1pub');
  });

  it('preferPersona with no persona configured → falls back to first option', () => {
    const result = resolvePolicy({
      options: [NP, EX1],
      consumerHint: null,
      appGuardrails: GUARDS,
      userDefaults: { preferPersonaForSignIns: true },
    });
    expect(result.defaultKey).toBe('natural-person');
  });
});

describe('resolvePolicy — preferred persona', () => {
  it('preferredPersonaPubkey promotes the named extra persona', () => {
    const result = resolvePolicy({
      options: ALL,
      consumerHint: null,
      appGuardrails: GUARDS,
      userDefaults: { preferPersonaForSignIns: true, preferredPersonaPubkey: 'ex2pub' },
    });
    expect(result.defaultKey).toBe('ex2pub');
    expect(result.ranked[0].key).toBe('ex2pub');
  });

  it('preferredPersonaPubkey can pin the built-in persona explicitly', () => {
    const result = resolvePolicy({
      options: ALL,
      consumerHint: null,
      appGuardrails: GUARDS,
      userDefaults: { preferPersonaForSignIns: true, preferredPersonaPubkey: 'pers-pub' },
    });
    expect(result.defaultKey).toBe('persona');
  });

  it('stale preferredPersonaPubkey (deleted persona) falls back to the built-in persona', () => {
    const result = resolvePolicy({
      options: ALL,
      consumerHint: null,
      appGuardrails: GUARDS,
      userDefaults: { preferPersonaForSignIns: true, preferredPersonaPubkey: 'gone-pub' },
    });
    expect(result.defaultKey).toBe('persona');
  });

  it('stale preferredPersonaPubkey with no built-in persona falls back to NP', () => {
    const result = resolvePolicy({
      options: [NP, EX1],
      consumerHint: null,
      appGuardrails: GUARDS,
      userDefaults: { preferPersonaForSignIns: true, preferredPersonaPubkey: 'gone-pub' },
    });
    expect(result.defaultKey).toBe('natural-person');
  });

  it('preferredPersonaPubkey is ignored when a consumer hint constrains', () => {
    const hint: ConsumerHint = { allow: ['natural-person'] };
    const result = resolvePolicy({
      options: ALL,
      consumerHint: hint,
      appGuardrails: GUARDS,
      userDefaults: { preferPersonaForSignIns: true, preferredPersonaPubkey: 'ex2pub' },
    });
    expect(result.defaultKey).toBe('natural-person');
  });

  it('preferredPersonaPubkey is ignored when preferPersona is off', () => {
    const result = resolvePolicy({
      options: ALL,
      consumerHint: null,
      appGuardrails: GUARDS,
      userDefaults: { preferPersonaForSignIns: false, preferredPersonaPubkey: 'ex2pub' },
    });
    expect(result.defaultKey).toBe('natural-person');
  });

  it('an NP pubkey in preferredPersonaPubkey is not honoured (persona-family only)', () => {
    const result = resolvePolicy({
      options: ALL,
      consumerHint: null,
      appGuardrails: GUARDS,
      userDefaults: { preferPersonaForSignIns: true, preferredPersonaPubkey: 'np-pub' },
    });
    // np-pub is not persona-family, so it falls back to the built-in persona.
    expect(result.defaultKey).toBe('persona');
  });
});

describe('shouldOverrideIncomingDefault (carousel NP default vs persona preference)', () => {
  it('overrides an incidental guardian-NP default when the resolver prefers a persona', () => {
    expect(shouldOverrideIncomingDefault({
      incomingSource: 'guardian',
      incomingKey: 'natural-person',
      resolverDefaultKey: 'persona',
      hasConsumerHint: false,
    })).toBe(true);
  });

  it('does NOT override when the resolver also defaults to NP', () => {
    expect(shouldOverrideIncomingDefault({
      incomingSource: 'guardian',
      incomingKey: 'natural-person',
      resolverDefaultKey: 'natural-person',
      hasConsumerHint: false,
    })).toBe(false);
  });

  it('does NOT override a deliberate persona active row', () => {
    expect(shouldOverrideIncomingDefault({
      incomingSource: 'guardian',
      incomingKey: 'ex1pub',
      resolverDefaultKey: 'persona',
      hasConsumerHint: false,
    })).toBe(false);
  });

  it('does NOT override when a consumer hint is constraining the picker', () => {
    expect(shouldOverrideIncomingDefault({
      incomingSource: 'guardian',
      incomingKey: 'natural-person',
      resolverDefaultKey: 'persona',
      hasConsumerHint: true,
    })).toBe(false);
  });

  it('does NOT override a dependant-sourced selection', () => {
    expect(shouldOverrideIncomingDefault({
      incomingSource: 'dependant',
      incomingKey: 'natural-person',
      resolverDefaultKey: 'persona',
      hasConsumerHint: false,
    })).toBe(false);
  });

  it('does NOT override when the resolver has no default key', () => {
    expect(shouldOverrideIncomingDefault({
      incomingSource: 'guardian',
      incomingKey: 'natural-person',
      resolverDefaultKey: null,
      hasConsumerHint: false,
    })).toBe(false);
  });
});

describe('classifyEmptyState', () => {
  it('accept=persona with no persona configured → no-persona-configured', () => {
    const hint: ConsumerHint = { allow: ['persona'] };
    expect(classifyEmptyState(hint, false, false, true)).toBe('no-persona-configured');
  });

  it('accept=extra-persona with no extras → no-extra-persona', () => {
    const hint: ConsumerHint = { allow: ['extra-persona'] };
    expect(classifyEmptyState(hint, true, false, true)).toBe('no-extra-persona');
  });

  it('accept=persona with NP only and no persona → no-persona-configured', () => {
    const hint: ConsumerHint = { allow: ['persona'] };
    expect(classifyEmptyState(hint, false, false, true)).toBe('no-persona-configured');
  });

  it('accept=persona,extra-persona (bunker-style NP-only) → np-hidden', () => {
    const hint: ConsumerHint = { allow: ['persona', 'extra-persona'] };
    expect(classifyEmptyState(hint, false, false, true)).toBe('no-persona-configured');
  });

  it('no hint → generic', () => {
    expect(classifyEmptyState(null, false, false, true)).toBe('generic');
  });
});

describe('classifyEmptyState — dormant real identity', () => {
  it('reports np-dormant when the consumer asked for the real identity and it is not activated', () => {
    const hint: ConsumerHint = { allow: ['natural-person'] };
    expect(classifyEmptyState(hint, true, false, false, true)).toBe('np-dormant');
  });

  it('np-dormant wins over the other empty states', () => {
    const hint: ConsumerHint = { allow: ['natural-person', 'persona'] };
    expect(classifyEmptyState(hint, false, false, false, true)).toBe('np-dormant');
  });

  it('does not report np-dormant when the consumer did not ask for the real identity', () => {
    const hint: ConsumerHint = { allow: ['persona'] };
    expect(classifyEmptyState(hint, false, false, false, true)).toBe('no-persona-configured');
  });

  it('the dormant flag defaults off so existing callers are unchanged', () => {
    const hint: ConsumerHint = { allow: ['persona'] };
    expect(classifyEmptyState(hint, false, false, true)).toBe('no-persona-configured');
  });
});
