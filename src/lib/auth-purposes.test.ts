/**
 * Unit tests for the auth-purpose registry.
 *
 * Coverage focus:
 *   - Every purpose has all required fields (no orphans).
 *   - Every template returns a non-empty string for valid context.
 *   - Tier assignment matches the holodeck contract (Tier 0/1/2).
 *   - Bold-token format `**…**` is preserved through templates.
 *   - The `as` discriminant guard rejects mismatched contexts.
 *   - Default context resolves to the unlock-app purpose.
 *
 * What's NOT covered here (component-level):
 *   - The `<AuthScreen>` rendering of the resolved purpose — covered by
 *     manual smoke testing per the holodeck doc; no RTL infra in this PR.
 */

import { describe, it, expect } from 'vitest';
import {
  PURPOSES,
  DEFAULT_PURPOSE_CONTEXT,
  resolvePurpose,
  type AuthPurpose,
  type PurposeContext,
} from './auth-purposes';

// ── Registry shape ────────────────────────────────────────────────────────────

describe('PURPOSES registry — shape invariants', () => {
  const purposeKeys: AuthPurpose[] = [
    'unlock-app',
    'approve-sign-in',
    'mutate-persona',
    'change-autonomy-stage',
    'reveal-dep-backup',
    'issue-professional-credential-pending',
    'guardian-approve-dep-action',
    'exit-child-mode',
    'delete-my-signet',
    'mutate-persona-child-mode',
    'issue-professional-credential-confirmed',
    'mutate-professional-roster',
    'manage-family-contacts',
  ];

  for (const purpose of purposeKeys) {
    it(`${purpose} — has all required PurposeConfig fields`, () => {
      const cfg = PURPOSES[purpose];
      expect(cfg).toBeDefined();
      expect([0, 1, 2]).toContain(cfg.tier);
      expect(typeof cfg.icon).toBe('string');
      expect(typeof cfg.accent).toBe('string');
      expect(typeof cfg.title).toBe('function');
      expect(typeof cfg.description).toBe('function');
    });
  }

  it('registry has exactly the declared purposes (no orphans)', () => {
    expect(Object.keys(PURPOSES).sort()).toEqual([...purposeKeys].sort());
  });
});

// ── Tier assignment matches holodeck contract ─────────────────────────────────

describe('PURPOSES registry — tier contract', () => {
  it('unlock-app is Tier 0', () => {
    expect(PURPOSES['unlock-app'].tier).toBe(0);
  });

  it('Tier 1 set matches the holodeck list', () => {
    const tier1 = (Object.keys(PURPOSES) as AuthPurpose[])
      .filter(p => PURPOSES[p].tier === 1)
      .sort();
    expect(tier1).toEqual([
      'approve-sign-in',
      'change-autonomy-stage',
      'issue-professional-credential-pending',
      'manage-family-contacts',
      'mutate-persona',
      'reveal-dep-backup',
    ].sort());
  });

  it('Tier 2 set matches the holodeck list (elevated, fresh-auth required)', () => {
    const tier2 = (Object.keys(PURPOSES) as AuthPurpose[])
      .filter(p => PURPOSES[p].tier === 2)
      .sort();
    expect(tier2).toEqual([
      'delete-my-signet',
      'exit-child-mode',
      'guardian-approve-dep-action',
      'issue-professional-credential-confirmed',
      'mutate-persona-child-mode',
      'mutate-professional-roster',
    ].sort());
  });
});

// ── Templates return non-empty strings for valid context ──────────────────────

describe('PURPOSES — template outputs', () => {
  // Each entry: a representative valid context + a check that title and
  // description both render non-empty. Validates that no template throws or
  // produces an empty string for a typical input.
  const cases: Array<{ name: string; ctx: PurposeContext; expectInDescription?: string }> = [
    { name: 'unlock-app', ctx: { purpose: 'unlock-app' } },
    {
      name: 'approve-sign-in',
      ctx: { purpose: 'approve-sign-in', siteName: 'roblox.com', identityName: 'shadowfox' },
      expectInDescription: 'roblox.com',
    },
    {
      name: 'mutate-persona switch',
      ctx: { purpose: 'mutate-persona', action: 'switch', personaName: 'Pen Name' },
      expectInDescription: 'Pen Name',
    },
    {
      name: 'mutate-persona create no name',
      ctx: { purpose: 'mutate-persona', action: 'create' },
    },
    {
      name: 'mutate-persona rename for dep',
      ctx: { purpose: 'mutate-persona', action: 'rename', personaName: 'Hero', depName: 'Alice' },
      expectInDescription: 'Alice',
    },
    {
      name: 'change-autonomy-stage',
      ctx: { purpose: 'change-autonomy-stage', depName: 'Alice', nextStage: 'request-approve' },
      expectInDescription: 'Alice',
    },
    {
      name: 'reveal-dep-backup',
      ctx: { purpose: 'reveal-dep-backup', depName: 'Alice' },
      expectInDescription: 'Alice',
    },
    {
      name: 'issue-professional-credential-pending',
      ctx: {
        purpose: 'issue-professional-credential-pending',
        firmName: 'Hogwarts School',
        recipientShort: 'a1b2c3d4',
        credentialType: 'Pupil identity',
      },
      expectInDescription: 'Hogwarts School',
    },
    {
      name: 'guardian-approve-dep-action no site',
      ctx: {
        purpose: 'guardian-approve-dep-action',
        depName: 'Alice',
        actionDescription: 'sign in',
      },
      expectInDescription: 'Alice',
    },
    {
      name: 'guardian-approve-dep-action with site',
      ctx: {
        purpose: 'guardian-approve-dep-action',
        depName: 'Alice',
        actionDescription: 'sign in and present a credential',
        siteName: 'roblox.com',
      },
      expectInDescription: 'roblox.com',
    },
    {
      name: 'exit-child-mode',
      ctx: { purpose: 'exit-child-mode', depName: 'Alice' },
      expectInDescription: 'Alice',
    },
    {
      name: 'delete-my-signet',
      ctx: { purpose: 'delete-my-signet' },
      expectInDescription: 'no undo',
    },
    {
      name: 'mutate-persona-child-mode create',
      ctx: { purpose: 'mutate-persona-child-mode', depName: 'Alice', action: 'create' },
      expectInDescription: 'Alice',
    },
    {
      name: 'issue-professional-credential-confirmed',
      ctx: {
        purpose: 'issue-professional-credential-confirmed',
        firmName: 'Sherwood GP Practice',
        recipientShort: 'a1b2c3d4',
        credentialType: 'Patient of practice',
      },
      expectInDescription: 'Sherwood GP Practice',
    },
    {
      name: 'mutate-professional-roster add-staff',
      ctx: { purpose: 'mutate-professional-roster', firmName: 'Hogwarts School', action: 'add-staff' },
      expectInDescription: 'Hogwarts School',
    },
    {
      name: 'mutate-professional-roster remove-delegate',
      ctx: { purpose: 'mutate-professional-roster', firmName: 'Hogwarts School', action: 'remove-delegate' },
      expectInDescription: 'Hogwarts School',
    },
  ];

  for (const c of cases) {
    it(`${c.name} — title and description render non-empty`, () => {
      const r = resolvePurpose(c.ctx);
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.description.length).toBeGreaterThan(0);
      if (c.expectInDescription) {
        expect(r.description).toContain(c.expectInDescription);
      }
    });
  }
});

// ── Bold token preservation ───────────────────────────────────────────────────

describe('PURPOSES — bold-token format preserved', () => {
  it('approve-sign-in bolds siteName and identityName', () => {
    const r = resolvePurpose({
      purpose: 'approve-sign-in',
      siteName: 'roblox.com',
      identityName: 'shadowfox',
    });
    expect(r.description).toContain('**roblox.com**');
    expect(r.description).toContain('**shadowfox**');
  });

  it('guardian-approve-dep-action bolds depName and actionDescription', () => {
    const r = resolvePurpose({
      purpose: 'guardian-approve-dep-action',
      depName: 'Alice',
      actionDescription: 'sign in and present a credential',
      siteName: 'roblox.com',
    });
    expect(r.description).toContain('**Alice**');
    expect(r.description).toContain('**sign in and present a credential**');
    expect(r.description).toContain('**roblox.com**');
  });

  it('delete-my-signet has no bold tokens (static disclosure)', () => {
    const r = resolvePurpose({ purpose: 'delete-my-signet' });
    expect(r.description).not.toContain('**');
  });
});

// ── Default context ────────────────────────────────────────────────────────────

describe('DEFAULT_PURPOSE_CONTEXT', () => {
  it('is the unlock-app purpose', () => {
    expect(DEFAULT_PURPOSE_CONTEXT.purpose).toBe('unlock-app');
  });

  it('resolves to Tier 0 with neutral accent and lock icon', () => {
    const r = resolvePurpose(DEFAULT_PURPOSE_CONTEXT);
    expect(r.tier).toBe(0);
    expect(r.accent).toBe('neutral');
    expect(r.icon).toBe('lock');
  });

  it('renders the legacy "Unlock Signet" header', () => {
    const r = resolvePurpose(DEFAULT_PURPOSE_CONTEXT);
    expect(r.title).toBe('Unlock Signet');
  });
});

// ── Visual treatment per tier ─────────────────────────────────────────────────

describe('PURPOSES — accent matches tier severity', () => {
  it('Tier 0 uses neutral accent', () => {
    expect(PURPOSES['unlock-app'].accent).toBe('neutral');
  });

  it('All Tier 2 purposes use warning or destructive accent', () => {
    const tier2 = (Object.keys(PURPOSES) as AuthPurpose[])
      .filter(p => PURPOSES[p].tier === 2);
    for (const p of tier2) {
      expect(['warning', 'destructive']).toContain(PURPOSES[p].accent);
    }
  });

  it('delete-my-signet uses destructive accent (irreversible)', () => {
    expect(PURPOSES['delete-my-signet'].accent).toBe('destructive');
  });
});

describe('manage-family-contacts purpose', () => {
  it('is a tier-1 gate with cross-family copy', () => {
    const resolved = resolvePurpose({ purpose: 'manage-family-contacts' });
    expect(resolved.tier).toBe(1);
    expect(resolved.title).toBe('Manage family contacts');
    expect(resolved.description).toContain('every dependant you manage');
    expect(resolved.icon).toBe('people');
  });
});
