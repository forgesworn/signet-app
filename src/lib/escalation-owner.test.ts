import { describe, expect, it } from 'vitest';
import { escalationNotificationText, escalationOwner, escalationSectionTitle } from './escalation-owner';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

const dependants = [{ displayName: 'Sam', publicKeys: [A] }];
const own = [{ displayName: 'Alex', publicKey: B }];

describe('escalationOwner', () => {
  it('names a family member by any of their keys, ignoring case', () => {
    expect(escalationOwner(A.toUpperCase(), dependants, own)).toEqual({ kind: 'family', name: 'Sam' });
  });

  it('recognises the owner\'s own identity', () => {
    expect(escalationOwner(B, dependants, own)).toEqual({ kind: 'self', name: 'Alex' });
  });

  it('prefers family when a key is listed as both', () => {
    expect(escalationOwner(A, dependants, [{ displayName: 'Alex', publicKey: A }]).kind).toBe('family');
  });

  it('leaves an unrecognised key unknown, never "you"', () => {
    expect(escalationOwner(C, dependants, own)).toEqual({ kind: 'unknown' });
  });

  it('ignores empty keys on either side', () => {
    expect(escalationOwner('', dependants, own)).toEqual({ kind: 'unknown' });
    expect(escalationOwner(C, [{ displayName: 'X', publicKeys: [''] }], [{ displayName: 'Y', publicKey: '' }]))
      .toEqual({ kind: 'unknown' });
  });
});

describe('escalationNotificationText', () => {
  it('keeps the family wording for a dependant', () => {
    expect(escalationNotificationText({ kind: 'family', name: 'Sam' }, 'x').title).toBe('Sam is waiting for a sign-in approval');
  });

  it('does not call the owner\'s own app a family sign-in', () => {
    const text = escalationNotificationText({ kind: 'self', name: 'Alex' }, 'x');
    expect(text.title).toBe('An app wants to sign as Alex');
    expect(text.title).not.toMatch(/sign-in/);
  });

  it('uses the fallback name when the identity is unknown', () => {
    expect(escalationNotificationText({ kind: 'unknown' }, 'npub1abc').title).toMatch(/npub1abc/);
  });
});

describe('escalationSectionTitle', () => {
  it('stays "Family asks" when every ask is a family one, or there are none', () => {
    expect(escalationSectionTitle([{ kind: 'family', name: 'Sam' }])).toBe('Family asks');
    expect(escalationSectionTitle([])).toBe('Family asks');
  });

  it('becomes neutral once an own or unknown ask is in the list', () => {
    expect(escalationSectionTitle([{ kind: 'family', name: 'Sam' }, { kind: 'self', name: 'Alex' }])).toBe('Waiting for approval');
    expect(escalationSectionTitle([{ kind: 'unknown' }])).toBe('Waiting for approval');
  });
});
