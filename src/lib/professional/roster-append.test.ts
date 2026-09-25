// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { buildRosterAppendEvent } from './roster-append';
import { PRO_ROSTER } from './kinds';

const LEAD_ANCHOR = {
  registry: 'GIAS' as const,
  identifier: '100000',
  professionKind: 'school' as const,
  entityName: 'Springfield School',
  canonicalDomain: 'springfield-school.example',
  jurisdiction: 'england-wales' as const,
  leadPubkey: 'a'.repeat(64),
};

const EXISTING_MEMBERS = [
  { pubkey: 'b'.repeat(64), role: 'form-tutor' },
];

const NEW_STAFF_PUBKEY = 'c'.repeat(64);

describe('buildRosterAppendEvent', () => {
  it('returns a kind-30202 roster event template', () => {
    const tmpl = buildRosterAppendEvent(LEAD_ANCHOR, EXISTING_MEMBERS, NEW_STAFF_PUBKEY);
    expect(tmpl.kind).toBe(PRO_ROSTER);
  });

  it('includes the new staff pubkey in the member list', () => {
    const tmpl = buildRosterAppendEvent(LEAD_ANCHOR, EXISTING_MEMBERS, NEW_STAFF_PUBKEY);
    const pTags = tmpl.tags.filter(t => t[0] === 'p');
    const pubkeys = pTags.map(t => t[1]);
    expect(pubkeys).toContain(NEW_STAFF_PUBKEY);
  });

  it('preserves all existing member pubkeys', () => {
    const tmpl = buildRosterAppendEvent(LEAD_ANCHOR, EXISTING_MEMBERS, NEW_STAFF_PUBKEY);
    const pTags = tmpl.tags.filter(t => t[0] === 'p');
    const pubkeys = pTags.map(t => t[1]);
    expect(pubkeys).toContain('b'.repeat(64));
  });

  it('does not duplicate a pubkey if already in the roster', () => {
    const tmpl = buildRosterAppendEvent(
      LEAD_ANCHOR,
      EXISTING_MEMBERS,
      'b'.repeat(64), // already in roster
    );
    const pTags = tmpl.tags.filter(t => t[0] === 'p');
    const pubkeys = pTags.map(t => t[1]);
    const occurrences = pubkeys.filter(pk => pk === 'b'.repeat(64)).length;
    expect(occurrences).toBe(1);
  });

  it('includes d tag with registry:identifier', () => {
    const tmpl = buildRosterAppendEvent(LEAD_ANCHOR, EXISTING_MEMBERS, NEW_STAFF_PUBKEY);
    const dTag = tmpl.tags.find(t => t[0] === 'd');
    expect(dTag).toBeDefined();
    expect(dTag![1]).toBe('GIAS:100000');
  });

  it('new member with no role gets an empty-string role token', () => {
    const tmpl = buildRosterAppendEvent(LEAD_ANCHOR, EXISTING_MEMBERS, NEW_STAFF_PUBKEY);
    const pTags = tmpl.tags.filter(t => t[0] === 'p');
    const newMemberTag = pTags.find(t => t[1] === NEW_STAFF_PUBKEY);
    expect(newMemberTag).toBeDefined();
    // role is the third element; allowed to be empty string
    expect(typeof newMemberTag![2]).toBe('string');
  });

  it('new member with explicit role label includes it', () => {
    const tmpl = buildRosterAppendEvent(
      LEAD_ANCHOR,
      EXISTING_MEMBERS,
      NEW_STAFF_PUBKEY,
      'class-teacher',
    );
    const pTags = tmpl.tags.filter(t => t[0] === 'p');
    const newMemberTag = pTags.find(t => t[1] === NEW_STAFF_PUBKEY);
    expect(newMemberTag![2]).toBe('class-teacher');
  });

  it('has a recent created_at timestamp', () => {
    const before = Math.floor(Date.now() / 1000) - 2;
    const tmpl = buildRosterAppendEvent(LEAD_ANCHOR, EXISTING_MEMBERS, NEW_STAFF_PUBKEY);
    expect(tmpl.created_at).toBeGreaterThanOrEqual(before);
    expect(tmpl.created_at).toBeLessThanOrEqual(before + 10);
  });

  it('preserves all existing members when appending — [existing1, existing2] + new = 3 members', () => {
    // Regression guard: the App.tsx fix ensures buildRosterAppendEvent receives the full
    // existing roster fetched from relay, so this append must never drop prior staff.
    const existing1 = 'd'.repeat(64);
    const existing2 = 'e'.repeat(64);
    const newStaff = 'f'.repeat(64);
    const twoMemberRoster = [
      { pubkey: existing1, role: 'form-tutor' },
      { pubkey: existing2, role: 'class-teacher' },
    ];
    const tmpl = buildRosterAppendEvent(LEAD_ANCHOR, twoMemberRoster, newStaff, 'nqt');
    const pTags = tmpl.tags.filter(t => t[0] === 'p');
    const pubkeys = pTags.map(t => t[1]);
    expect(pubkeys).toHaveLength(3);
    expect(pubkeys).toContain(existing1);
    expect(pubkeys).toContain(existing2);
    expect(pubkeys).toContain(newStaff);
  });
});
