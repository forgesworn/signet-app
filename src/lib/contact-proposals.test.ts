import { describe, it, expect } from 'vitest';
import { validateProposal, validateProposalBatch, rememberOperationIds } from './contact-proposals';
import { scopedContactId } from '@forgesworn/signet-contacts/wire';
import { MAX_PROPOSALS_PER_BATCH, MAX_STALENESS_SECONDS } from '@forgesworn/signet-contacts/wire';
import type { Capability, ContactProposalV1 } from '@forgesworn/signet-contacts/wire';
import { SEEN_OPERATION_ID_CAP } from '../types';

const GRANT = 'f'.repeat(32);
const SCOPED = scopedContactId(GRANT, 'contact-ada');
const NOW = 1_700_000_000;
const RENAME_UPDATED_AT = 1_700_000_000_000;
const BOTH: Capability[] = ['signet.contacts.propose:add-ken', 'signet.contacts.propose:rename-app-label'];

function ctx(over: Partial<Parameters<typeof validateProposal>[1]> = {}) {
  return {
    grantId: GRANT, capabilities: BOTH,
    seenOperationIds: new Set<string>(), knownScopedIds: new Set([SCOPED]), now: NOW, ...over,
  };
}
function addKen(over: Partial<ContactProposalV1> = {}): ContactProposalV1 {
  return {
    v: 1, grantId: GRANT, operationId: '9'.repeat(32), action: 'add-ken',
    value: { pubkey: 'c'.repeat(64), displayName: 'Ada' }, createdAt: NOW - 10, ...over,
  };
}
function rename(over: Partial<ContactProposalV1> = {}): ContactProposalV1 {
  return {
    v: 1, grantId: GRANT, operationId: '8'.repeat(32), action: 'rename-app-label',
    value: { contactId: SCOPED, label: 'Coach', updatedAt: RENAME_UPDATED_AT }, createdAt: NOW - 10, ...over,
  };
}
function hexId(n: number): string {
  return n.toString(16).padStart(32, '0');
}

describe('validateProposal', () => {
  it('accepts a well-formed add-ken', () => {
    expect(validateProposal(addKen(), ctx())).toEqual({
      kind: 'add-ken', operationId: '9'.repeat(32), pubkey: 'c'.repeat(64), displayName: 'Ada',
    });
  });

  it('accepts a well-formed rename against a known scoped id', () => {
    expect(validateProposal(rename(), ctx())).toEqual({
      kind: 'rename-app-label', operationId: '8'.repeat(32), scopedContactId: SCOPED, label: 'Coach',
      updatedAt: RENAME_UPDATED_AT,
    });
  });

  it('rejects a proposal bound to another grant', () => {
    expect(validateProposal(addKen({ grantId: '0'.repeat(32) }), ctx()))
      .toEqual({ kind: 'rejected', operationId: '9'.repeat(32), reason: 'wrong-grant' });
  });

  it('rejects a replayed operationId', () => {
    const seen = ctx({ seenOperationIds: new Set(['9'.repeat(32)]) });
    expect(validateProposal(addKen(), seen)).toEqual({ kind: 'rejected', operationId: '9'.repeat(32), reason: 'replay' });
  });

  it('rejects an action the grant does not cover', () => {
    expect(validateProposal(addKen(), ctx({ capabilities: ['signet.contacts.propose:rename-app-label'] })).reason)
      .toBe('capability-missing');
    expect(validateProposal(rename(), ctx({ capabilities: ['signet.contacts.propose:add-ken'] })).reason)
      .toBe('capability-missing');
  });

  it('rejects an unknown action distinctly from a missing capability', () => {
    const bogus = { ...addKen(), action: 'delete-everything' } as unknown as ContactProposalV1;
    expect(validateProposal(bogus, ctx())).toMatchObject({ kind: 'rejected', reason: 'unknown-action' });
  });

  it('rejects a rename for a contact this grant has never projected', () => {
    expect(validateProposal(rename(), ctx({ knownScopedIds: new Set() })).reason).toBe('unknown-contact');
  });

  it('rejects a malformed operation id, pubkey, empty name and empty label', () => {
    expect(validateProposal(addKen({ operationId: 'short' }), ctx()).reason).toBe('bad-operation-id');
    expect(validateProposal(addKen({ value: { pubkey: 'nope', displayName: 'Ada' } }), ctx()).reason).toBe('invalid-value');
    expect(validateProposal(addKen({ value: { pubkey: 'c'.repeat(64), displayName: '   ' } }), ctx()).reason).toBe('invalid-value');
    expect(validateProposal(rename({ value: { contactId: SCOPED, label: '‮', updatedAt: RENAME_UPDATED_AT } }), ctx()).reason).toBe('invalid-value');
  });

  it('rejects a rename with a missing, malformed or future-dated updatedAt', () => {
    const noUpdatedAt = { ...rename().value, updatedAt: undefined };
    expect(validateProposal(rename({ value: noUpdatedAt as never }), ctx()).reason).toBe('invalid-value');
    expect(validateProposal(rename({ value: { contactId: SCOPED, label: 'Coach', updatedAt: -1 } }), ctx()).reason).toBe('invalid-value');
    expect(validateProposal(rename({ value: { contactId: SCOPED, label: 'Coach', updatedAt: 1.5 } }), ctx()).reason).toBe('invalid-value');
    // M2: updatedAt is ms epoch, now/skew are seconds — well past NOW*1000 + skew(ms).
    expect(validateProposal(rename({ value: { contactId: SCOPED, label: 'Coach', updatedAt: NOW * 1000 + 10_000_000 } }), ctx()).reason)
      .toBe('invalid-value');
  });

  it('rejects a malformed createdAt (NaN, negative, fractional)', () => {
    expect(validateProposal(addKen({ createdAt: Number.NaN }), ctx()).reason).toBe('invalid-value');
    expect(validateProposal(addKen({ createdAt: -5 }), ctx()).reason).toBe('invalid-value');
    expect(validateProposal(addKen({ createdAt: NOW - 1.5 }), ctx()).reason).toBe('invalid-value');
  });

  it('rejects a future-dated proposal beyond the clock-skew window', () => {
    expect(validateProposal(addKen({ createdAt: NOW + 600 }), ctx()).reason).toBe('future-dated');
    expect(validateProposal(addKen({ createdAt: NOW + 60 }), ctx()).kind).toBe('add-ken');
  });

  describe('R-16 max-age', () => {
    it('accepts a proposal exactly at the default max-age boundary', () => {
      expect(validateProposal(addKen({ createdAt: NOW - MAX_STALENESS_SECONDS }), ctx()).kind).toBe('add-ken');
    });

    it('rejects a proposal one second past the default max-age boundary, with a distinct reason', () => {
      expect(validateProposal(addKen({ createdAt: NOW - MAX_STALENESS_SECONDS - 1 }), ctx()))
        .toMatchObject({ kind: 'rejected', reason: 'stale' });
    });

    it('still rejects a future-dated proposal when maxAgeSeconds is supplied', () => {
      expect(validateProposal(addKen({ createdAt: NOW + 600 }), ctx({ maxAgeSeconds: 10 })).reason).toBe('future-dated');
    });

    it('honours a caller-supplied maxAgeSeconds instead of the default', () => {
      expect(validateProposal(addKen({ createdAt: NOW - 100 }), ctx({ maxAgeSeconds: 200 })).kind).toBe('add-ken');
      expect(validateProposal(addKen({ createdAt: NOW - 201 }), ctx({ maxAgeSeconds: 200 })))
        .toMatchObject({ kind: 'rejected', reason: 'stale' });
    });
  });

  it('sanitises and caps a hostile display name and label', () => {
    const out = validateProposal(addKen({ value: { pubkey: 'c'.repeat(64), displayName: '  A‮db  ' } }), ctx());
    expect(out).toMatchObject({ kind: 'add-ken', displayName: 'Adb' });
    const long = validateProposal(rename({ value: { contactId: SCOPED, label: 'x'.repeat(300), updatedAt: RENAME_UPDATED_AT } }), ctx());
    expect(long.kind === 'rename-app-label' && long.label).toHaveLength(100);
  });

  describe('M6 hostile input never throws', () => {
    function assertRejectedNoThrow(raw: unknown) {
      let result: ReturnType<typeof validateProposal> | undefined;
      expect(() => {
        result = validateProposal(raw as ContactProposalV1, ctx());
      }).not.toThrow();
      expect(result?.kind).toBe('rejected');
    }

    it('rejects null', () => assertRejectedNoThrow(null));
    it('rejects an array', () => assertRejectedNoThrow(['not', 'a', 'proposal']));
    it('rejects a proposal whose value is null', () => assertRejectedNoThrow({ ...addKen(), value: null }));
    it('rejects a 1 MB string in place of the whole proposal', () => assertRejectedNoThrow('x'.repeat(1_000_000)));
    it('rejects a __proto__/constructor-keyed action as unknown-action, not a capability bypass', () => {
      expect(validateProposal({ ...addKen(), action: '__proto__' } as unknown as ContactProposalV1, ctx()))
        .toMatchObject({ kind: 'rejected', reason: 'unknown-action' });
      expect(validateProposal({ ...addKen(), action: 'constructor' } as unknown as ContactProposalV1, ctx()))
        .toMatchObject({ kind: 'rejected', reason: 'unknown-action' });
    });
    it('rejects a rename-app-label proposal with no value at all', () => assertRejectedNoThrow({ ...rename(), value: undefined }));
  });
});

describe('validateProposalBatch', () => {
  it('validates each proposal independently', () => {
    const outcomes = validateProposalBatch({ v: 1, proposals: [addKen(), rename({ value: { contactId: '0'.repeat(32), label: 'x', updatedAt: RENAME_UPDATED_AT } })] }, ctx());
    expect(outcomes[0]?.kind).toBe('add-ken');
    expect(outcomes[1]).toMatchObject({ kind: 'rejected', reason: 'unknown-contact' });
  });

  it('rejects a duplicate operationId WITHIN one batch', () => {
    const outcomes = validateProposalBatch({ v: 1, proposals: [addKen(), addKen()] }, ctx());
    expect(outcomes[0]?.kind).toBe('add-ken');
    expect(outcomes[1]).toMatchObject({ kind: 'rejected', reason: 'replay' });
  });

  it('rejects an over-cap batch outright, one rejection per input proposal, before validating any of them', () => {
    const proposals = Array.from({ length: MAX_PROPOSALS_PER_BATCH + 1 }, (_, i) => addKen({ operationId: hexId(i) }));
    const outcomes = validateProposalBatch({ v: 1, proposals }, ctx());
    expect(outcomes).toHaveLength(MAX_PROPOSALS_PER_BATCH + 1);
    outcomes.forEach((outcome, i) => {
      expect(outcome).toEqual({ kind: 'rejected', operationId: hexId(i), reason: 'batch-too-large' });
    });
  });

  it('accepts a batch exactly at the cap', () => {
    const proposals = Array.from({ length: MAX_PROPOSALS_PER_BATCH }, (_, i) => addKen({ operationId: hexId(i) }));
    const outcomes = validateProposalBatch({ v: 1, proposals }, ctx());
    expect(outcomes).toHaveLength(MAX_PROPOSALS_PER_BATCH);
    expect(outcomes.every((o) => o.kind === 'add-ken')).toBe(true);
  });
});

describe('rememberOperationIds', () => {
  it('appends, dedupes and keeps the newest within the cap', () => {
    expect(rememberOperationIds([hexId(1)], [hexId(2), hexId(1)])).toEqual([hexId(1), hexId(2)]);
    const full = Array.from({ length: SEEN_OPERATION_ID_CAP }, (_, i) => hexId(i));
    const trimmed = rememberOperationIds(full, [hexId(999_999)]);
    expect(trimmed).toHaveLength(SEEN_OPERATION_ID_CAP);
    expect(trimmed.at(-1)).toBe(hexId(999_999));
    expect(trimmed).not.toContain(hexId(0));
  });

  it('drops anything that is not a well-formed 32-hex id, on both sides', () => {
    expect(rememberOperationIds(['not-hex', hexId(1)], ['also-not-hex', hexId(2)])).toEqual([hexId(1), hexId(2)]);
    expect(rememberOperationIds([], ['short', 'G'.repeat(32), hexId(3)])).toEqual([hexId(3)]);
  });
});
