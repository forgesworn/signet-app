import { describe, it, expect } from 'vitest';
import { checkAutonomy, resolvePolicy, isOriginScopedScope, type Policy } from './autonomy-gate';
import type { Scope } from './scope-inference';
import type { AutonomyStage } from '../types';

describe('checkAutonomy', () => {
  it('full-control requires guardian PIN on the same device', () => {
    // Previously this returned `block` with "ask your guardian" — but on the
    // guardian's own phone the guardian *is* present, so we soften to
    // require-pin. The bunker-scoped `resolvePolicy('full-control', ...)`
    // below now uses ask-every for every scope (cross-device approval)
    // — the request rides the existing bunker queue + modal.
    expect(checkAutonomy('full-control').kind).toBe('require-pin');
  });

  it('request-approve requires PIN', () => {
    expect(checkAutonomy('request-approve').kind).toBe('require-pin');
  });

  it('autonomous-alerts allows', () => {
    expect(checkAutonomy('autonomous-alerts').kind).toBe('allow');
  });

  it('autonomous-logging allows', () => {
    expect(checkAutonomy('autonomous-logging').kind).toBe('allow');
  });

  it('full-autonomy allows', () => {
    expect(checkAutonomy('full-autonomy').kind).toBe('allow');
  });
});

describe('resolvePolicy — interaction matrix (2026-04-22 spec)', () => {
  // Sanity: every (scope, stage) cell yields a valid Policy value. Catches
  // accidental gaps if the matrix is edited in future.
  const ALL_SCOPES: Scope[] = [
    'sign-in', 'venue-entry', 'post-public', 'dm-private', 'upload-photo',
    'react-zap-reply', 'pair-device', 'mutate-identity',
  ];
  const ALL_STAGES: AutonomyStage[] = [
    'full-control', 'request-approve', 'autonomous-alerts',
    'autonomous-logging', 'full-autonomy',
  ];
  const ALL_POLICIES: Policy[] = [
    'blocked', 'ask-origin', 'ask-every', 'auto-alert', 'auto-log', 'auto',
  ];

  it('every (scope, stage) cell yields a valid Policy', () => {
    for (const scope of ALL_SCOPES) {
      for (const stage of ALL_STAGES) {
        expect(ALL_POLICIES).toContain(resolvePolicy(stage, scope));
      }
    }
  });

  // Matrix spot-checks from the spec table — each row's shape differs.

  it('sign-in: ask-every → ask-origin → auto-alert → auto-log → auto', () => {
    expect(resolvePolicy('full-control', 'sign-in')).toBe('ask-every');
    expect(resolvePolicy('request-approve', 'sign-in')).toBe('ask-origin');
    expect(resolvePolicy('autonomous-alerts', 'sign-in')).toBe('auto-alert');
    expect(resolvePolicy('autonomous-logging', 'sign-in')).toBe('auto-log');
    expect(resolvePolicy('full-autonomy', 'sign-in')).toBe('auto');
  });

  it('venue-entry: ask-every at full-control, auto everywhere else', () => {
    expect(resolvePolicy('full-control', 'venue-entry')).toBe('ask-every');
    expect(resolvePolicy('request-approve', 'venue-entry')).toBe('auto');
    expect(resolvePolicy('autonomous-alerts', 'venue-entry')).toBe('auto');
    expect(resolvePolicy('autonomous-logging', 'venue-entry')).toBe('auto');
    expect(resolvePolicy('full-autonomy', 'venue-entry')).toBe('auto');
  });

  it('pair-device: ASK-EVERY at every stage below full-autonomy (holodeck OQ2)', () => {
    expect(resolvePolicy('full-control', 'pair-device')).toBe('ask-every');
    expect(resolvePolicy('request-approve', 'pair-device')).toBe('ask-every');
    expect(resolvePolicy('autonomous-alerts', 'pair-device')).toBe('ask-every');
    expect(resolvePolicy('autonomous-logging', 'pair-device')).toBe('ask-every');
    expect(resolvePolicy('full-autonomy', 'pair-device')).toBe('auto');
  });

  it('full-control routes EVERY scope through guardian approval', () => {
    // Regression: previously every full-control cell was 'blocked', which
    // hard-refused the dependant's request with no path forward. Now
    // each scope becomes ask-every — the request enters the existing
    // bunker approval queue and surfaces as a guardian modal next time the
    // guardian opens the app. No allow-always grants persist at full-control
    // (keeping it stricter than request-approve, which uses ask-origin for
    // sign-in/dm/photo/react).
    const ALL_SCOPES_FOR_FULL_CONTROL: Scope[] = [
      'sign-in', 'venue-entry', 'post-public', 'dm-private', 'upload-photo',
      'react-zap-reply', 'pair-device', 'mutate-identity',
    ];
    for (const scope of ALL_SCOPES_FOR_FULL_CONTROL) {
      expect(resolvePolicy('full-control', scope)).toBe('ask-every');
    }
  });

  it('post-public: ASK-EVERY at request-approve (no origin to scope to)', () => {
    expect(resolvePolicy('request-approve', 'post-public')).toBe('ask-every');
  });

  it('dm-private: ASK-ORIGIN at request-approve (keyed on recipient pubkey)', () => {
    expect(resolvePolicy('request-approve', 'dm-private')).toBe('ask-origin');
  });

  it('mutate-identity: ASK-EVERY at request-approve (no natural origin)', () => {
    expect(resolvePolicy('request-approve', 'mutate-identity')).toBe('ask-every');
  });

  it('null scope (unclassified kind): ASK-EVERY except at full-autonomy', () => {
    expect(resolvePolicy('full-control', null)).toBe('ask-every');
    expect(resolvePolicy('request-approve', null)).toBe('ask-every');
    expect(resolvePolicy('autonomous-alerts', null)).toBe('ask-every');
    expect(resolvePolicy('autonomous-logging', null)).toBe('ask-every');
    expect(resolvePolicy('full-autonomy', null)).toBe('auto');
  });
});

describe('isOriginScopedScope', () => {
  it('returns true for scopes keyed on a per-(origin|counterparty) grant', () => {
    expect(isOriginScopedScope('sign-in')).toBe(true);
    expect(isOriginScopedScope('dm-private')).toBe(true);
    expect(isOriginScopedScope('upload-photo')).toBe(true);
    expect(isOriginScopedScope('react-zap-reply')).toBe(true);
  });

  it('returns false for scopes that are ASK-EVERY / auto-only', () => {
    expect(isOriginScopedScope('venue-entry')).toBe(false);
    expect(isOriginScopedScope('post-public')).toBe(false);
    expect(isOriginScopedScope('pair-device')).toBe(false);
    expect(isOriginScopedScope('mutate-identity')).toBe(false);
  });
});
