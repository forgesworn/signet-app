import { describe, it, expect } from 'vitest';
import {
  detailSections, validateMethodDraft, normaliseRole, addRole, removeRole,
  normaliseNote, normaliseBlockReason, METHOD_KINDS, METHOD_KIND_LABELS,
  ROLES_CAP, ROLE_MAX, METHOD_VALUE_MAX, NOTE_MAX, BLOCK_REASON_MAX,
} from './contacts-v2-detail';
import type { ActorRights } from './contacts-v2-rights';
import type { EffectiveContact } from '../types';

function rights(over: Partial<ActorRights> = {}): ActorRights {
  return {
    canRename: true, canSetTier: true, canEditRoles: true, canEditMethods: true,
    canEditNote: true, canAddIdentity: true, canBlock: true, canUnblock: false,
    unblockBlockedReason: null, canRemove: true, canArchive: true,
    canVouch: false, canSetCeiling: false, ...over,
  };
}

function contact(over: Partial<EffectiveContact> = {}): EffectiveContact {
  return {
    directoryId: 'owner', contactId: 'c1', type: 'person', displayName: 'Dave',
    tier: 'kin', roles: [], identities: [], contactMethods: [], accessGrants: [],
    lifecycle: 'active', createdAt: 1, updatedAt: 2,
    createdByActorRole: 'owner', createdByOperationId: 'op-1',
    vouches: [], ceilings: [], blocks: [],
    effectiveTier: 'kin', tierSource: 'direct', blocked: false, blockedBy: [],
    ...over,
  };
}

describe('detailSections', () => {
  it('shows the core sections for an editable contact', () => {
    expect(detailSections(contact(), rights(), { hasSharedSecret: false, hasKenEntry: false }))
      .toEqual(['identities', 'methods', 'roles', 'tier', 'note', 'block', 'remove']);
  });

  it('adds the legacy verification and ken sections when a legacy row matches', () => {
    const out = detailSections(contact(), rights(), { hasSharedSecret: true, hasKenEntry: true });
    expect(out).toContain('legacy-verification');
    expect(out).toContain('legacy-ken');
  });

  it('drops sections the actor has no right to', () => {
    const out = detailSections(
      contact(),
      rights({ canSetTier: false, canEditNote: false, canRemove: false }),
      { hasSharedSecret: false, hasKenEntry: false },
    );
    expect(out).not.toContain('tier');
    expect(out).not.toContain('note');
    expect(out).not.toContain('remove');
    expect(out).toContain('block');
  });

  it('keeps the block section visible while blocked so Unblock can be explained', () => {
    const out = detailSections(
      contact({ blocked: true, blockedBy: ['2'.repeat(64)] }),
      rights({ canBlock: false, canUnblock: false, unblockBlockedReason: 'A guardian applied this block' }),
      { hasSharedSecret: false, hasKenEntry: false },
    );
    expect(out).toContain('block');
  });
});

describe('contact-method validation', () => {
  it('labels every supported kind', () => {
    expect(METHOD_KINDS).toEqual(['phone', 'email', 'website', 'postal-address', 'other']);
    expect(METHOD_KIND_LABELS['postal-address']).toBe('Postal address');
  });

  it('accepts a phone and returns a private, unverified method', () => {
    const out = validateMethodDraft({ kind: 'phone', label: 'Mobile', value: ' +44 7700 900123 ' });
    expect(out).toEqual({
      ok: true,
      value: {
        kind: 'phone', label: 'Mobile', value: '+44 7700 900123',
        verification: 'unverified', sharingPolicy: 'private',
      },
    });
  });

  it('rejects an empty value', () => {
    expect(validateMethodDraft({ kind: 'email', label: '', value: '   ' }))
      .toEqual({ ok: false, error: 'Enter a value.' });
  });

  it('rejects a malformed email and website', () => {
    expect(validateMethodDraft({ kind: 'email', label: '', value: 'nope' }).ok).toBe(false);
    expect(validateMethodDraft({ kind: 'website', label: '', value: 'javascript:alert(1)' }).ok).toBe(false);
    expect(validateMethodDraft({ kind: 'website', label: '', value: 'https://example.com' }).ok).toBe(true);
  });

  it('caps the value and drops an empty label', () => {
    const out = validateMethodDraft({ kind: 'other', label: '', value: 'x'.repeat(METHOD_VALUE_MAX + 40) });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.value).toHaveLength(METHOD_VALUE_MAX);
      expect(out.value.label).toBeUndefined();
    }
  });
});

describe('roles and free text', () => {
  it('normalises, caps and de-duplicates a role', () => {
    expect(normaliseRole('  Uncle Dave​ ')).toBe('Uncle Dave');
    expect(normaliseRole('r'.repeat(ROLE_MAX + 10))).toHaveLength(ROLE_MAX);
    expect(addRole(['mum'], 'MUM')).toEqual(['mum']);
    expect(addRole(['mum'], 'accountant')).toEqual(['mum', 'accountant']);
    expect(addRole([], '   ')).toEqual([]);
  });

  it('refuses to exceed the roles cap', () => {
    const full = Array.from({ length: ROLES_CAP }, (_, i) => `role-${i}`);
    expect(addRole(full, 'one-more')).toEqual(full);
  });

  it('removes a role case-insensitively', () => {
    expect(removeRole(['mum', 'GP'], 'gp')).toEqual(['mum']);
  });

  it('caps notes and block reasons, and treats an empty reason as absent', () => {
    expect(normaliseNote('n'.repeat(NOTE_MAX + 5))).toHaveLength(NOTE_MAX);
    expect(normaliseBlockReason('  ')).toBeUndefined();
    expect(normaliseBlockReason('r'.repeat(BLOCK_REASON_MAX + 5))).toHaveLength(BLOCK_REASON_MAX);
  });

  it('keeps a newline in a note while still stripping a control character', () => {
    expect(normaliseNote('Met at\nschool gate')).toBe('Met at\nschool gate');
  });
});
