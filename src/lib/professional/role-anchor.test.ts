import { describe, it, expect } from 'vitest';
import {
  buildRoleAnchorEvent,
  buildRosterEvent,
  buildDirectoryAddEvent,
  buildRevocationEvent,
  buildRosterUpdate,
  type RosterMember,
  type AnchorContext,
} from './role-anchor';
import { PRO_ROLE_ANCHOR, PRO_ROSTER, PRO_DIRECTORY_ADD, PRO_REVOCATION } from './kinds';

const SAMPLE_ANCHOR = {
  registry: 'GIAS' as const,
  identifier: '100000',
  professionKind: 'school' as const,
  entityName: 'Springfield School',
  canonicalDomain: 'springfield-school.example',
  jurisdiction: 'england-wales' as const,
  leadPubkey: 'a'.repeat(64),
};

describe('buildRoleAnchorEvent', () => {
  it('returns an event template with the correct kind', () => {
    const tmpl = buildRoleAnchorEvent(SAMPLE_ANCHOR);
    expect(tmpl.kind).toBe(PRO_ROLE_ANCHOR);
  });

  it('sets d tag to registry:identifier', () => {
    const tmpl = buildRoleAnchorEvent(SAMPLE_ANCHOR);
    const dTag = tmpl.tags.find(t => t[0] === 'd');
    expect(dTag).toBeDefined();
    expect(dTag![1]).toBe('GIAS:100000');
  });

  it('includes profession-kind tag', () => {
    const tmpl = buildRoleAnchorEvent(SAMPLE_ANCHOR);
    const kindTag = tmpl.tags.find(t => t[0] === 'profession');
    expect(kindTag![1]).toBe('school');
  });

  it('includes canonical-domain tag', () => {
    const tmpl = buildRoleAnchorEvent(SAMPLE_ANCHOR);
    const domainTag = tmpl.tags.find(t => t[0] === 'domain');
    expect(domainTag![1]).toBe('springfield-school.example');
  });

  it('includes a created_at that is a recent unix timestamp', () => {
    const before = Math.floor(Date.now() / 1000) - 2;
    const tmpl = buildRoleAnchorEvent(SAMPLE_ANCHOR);
    expect(tmpl.created_at).toBeGreaterThanOrEqual(before);
    expect(tmpl.created_at).toBeLessThanOrEqual(before + 10);
  });
});

describe('buildRosterEvent', () => {
  const members = [
    { pubkey: 'b'.repeat(64), role: 'form-tutor', scope: '8B' },
    { pubkey: 'c'.repeat(64), role: 'form-tutor', scope: '8A' },
  ];

  it('returns an event template with the correct kind', () => {
    const tmpl = buildRosterEvent(SAMPLE_ANCHOR, members);
    expect(tmpl.kind).toBe(PRO_ROSTER);
  });

  it('sets d tag to registry:identifier', () => {
    const tmpl = buildRosterEvent(SAMPLE_ANCHOR, members);
    const dTag = tmpl.tags.find(t => t[0] === 'd');
    expect(dTag![1]).toBe('GIAS:100000');
  });

  it('emits one p tag per member with role and scope', () => {
    const tmpl = buildRosterEvent(SAMPLE_ANCHOR, members);
    const pTags = tmpl.tags.filter(t => t[0] === 'p');
    expect(pTags).toHaveLength(2);
    // p tag format: ['p', pubkey, role, scope]
    expect(pTags[0][1]).toBe('b'.repeat(64));
    expect(pTags[0][2]).toBe('form-tutor');
    expect(pTags[0][3]).toBe('8B');
  });
});

describe('buildDirectoryAddEvent', () => {
  it('returns an event template with the correct kind', () => {
    const tmpl = buildDirectoryAddEvent(SAMPLE_ANCHOR);
    expect(tmpl.kind).toBe(PRO_DIRECTORY_ADD);
  });

  it('sets d tag to registry:identifier', () => {
    const tmpl = buildDirectoryAddEvent(SAMPLE_ANCHOR);
    const dTag = tmpl.tags.find(t => t[0] === 'd');
    expect(dTag![1]).toBe('GIAS:100000');
  });
});

describe('buildRevocationEvent', () => {
  it('returns an event template with the correct kind', () => {
    const tmpl = buildRevocationEvent(SAMPLE_ANCHOR, 'b'.repeat(64), 'form-tutor');
    expect(tmpl.kind).toBe(PRO_REVOCATION);
  });

  it('includes revoked pubkey as p tag', () => {
    const tmpl = buildRevocationEvent(SAMPLE_ANCHOR, 'b'.repeat(64), 'form-tutor');
    const pTag = tmpl.tags.find(t => t[0] === 'p');
    expect(pTag![1]).toBe('b'.repeat(64));
  });

  it('includes revoked-role as role tag', () => {
    const tmpl = buildRevocationEvent(SAMPLE_ANCHOR, 'b'.repeat(64), 'form-tutor');
    const roleTag = tmpl.tags.find(t => t[0] === 'role');
    expect(roleTag![1]).toBe('form-tutor');
  });
});

describe('buildRosterEvent — delegate tags', () => {
  const ctx: AnchorContext = {
    registry: 'GIAS' as const,
    identifier: '100000',
    professionKind: 'school' as const,
    entityName: 'Springfield School',
    canonicalDomain: 'springfield-school.example',
    jurisdiction: 'england-wales' as const,
    leadPubkey: 'a'.repeat(64),
  };
  const members: RosterMember[] = [{ pubkey: 'm'.repeat(64), role: 'form-tutor' }];

  it('emits no delegate tags when delegates array is empty', () => {
    const tmpl = buildRosterEvent(ctx, members, []);
    const delegateTags = tmpl.tags.filter(t => t[0] === 'delegate');
    expect(delegateTags.length).toBe(0);
  });

  it('emits delegate tags for each delegate pubkey', () => {
    const delegates = ['d'.repeat(64), 'e'.repeat(64)];
    const tmpl = buildRosterEvent(ctx, members, delegates);
    const delegateTags = tmpl.tags.filter(t => t[0] === 'delegate');
    expect(delegateTags.length).toBe(2);
    expect(delegateTags[0][1]).toBe('d'.repeat(64));
    expect(delegateTags[1][1]).toBe('e'.repeat(64));
  });

  it('backward compat: no delegates arg still works (defaults to empty)', () => {
    const tmpl = buildRosterEvent(ctx, members);
    const delegateTags = tmpl.tags.filter(t => t[0] === 'delegate');
    expect(delegateTags.length).toBe(0);
  });
});

describe('buildRosterUpdate', () => {
  const BASE_MEMBERS: RosterMember[] = [{ pubkey: 'm'.repeat(64), role: 'form-tutor' }];
  const CURRENT_DELEGATES = ['d'.repeat(64)];

  it('adds a new delegate not already present', () => {
    const result = buildRosterUpdate({
      currentMembers: BASE_MEMBERS,
      currentDelegates: CURRENT_DELEGATES,
      addDelegate: 'e'.repeat(64),
    });
    expect(result.delegates).toContain('d'.repeat(64));
    expect(result.delegates).toContain('e'.repeat(64));
  });

  it('is a no-op when addDelegate is already present', () => {
    const result = buildRosterUpdate({
      currentMembers: BASE_MEMBERS,
      currentDelegates: CURRENT_DELEGATES,
      addDelegate: 'd'.repeat(64),
    });
    expect(result.delegates.filter(p => p === 'd'.repeat(64)).length).toBe(1);
  });

  it('removes a delegate that was present', () => {
    const result = buildRosterUpdate({
      currentMembers: BASE_MEMBERS,
      currentDelegates: CURRENT_DELEGATES,
      removeDelegate: 'd'.repeat(64),
    });
    expect(result.delegates).not.toContain('d'.repeat(64));
  });

  it('is a no-op when removeDelegate is absent', () => {
    const result = buildRosterUpdate({
      currentMembers: BASE_MEMBERS,
      currentDelegates: CURRENT_DELEGATES,
      removeDelegate: 'z'.repeat(64),
    });
    expect(result.delegates).toEqual(CURRENT_DELEGATES);
  });

  it('preserves existing members unchanged', () => {
    const result = buildRosterUpdate({
      currentMembers: BASE_MEMBERS,
      currentDelegates: CURRENT_DELEGATES,
      addDelegate: 'e'.repeat(64),
    });
    expect(result.members).toEqual(BASE_MEMBERS);
  });
});
