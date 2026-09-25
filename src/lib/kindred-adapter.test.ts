import { describe, it, expect } from 'vitest';
import type { Contact } from '../types';
import { contactToKindredEntry, sanitiseAddedAt } from './kindred-adapter';

function makeContact(o: Partial<Contact>): Contact {
  return { pubkey: 'a'.repeat(64), ownerPubkey: 'b'.repeat(64), displayName: 'T', sharedSecret: 's', verifiedAt: 1000, ...o };
}

describe('contactToKindredEntry', () => {
  it('maps a contact with a relationship to a KinEntry', () => {
    const e = contactToKindredEntry(makeContact({ relationship: 'parent' }));
    expect(e.tier).toBe('kin');
    expect((e as { relationship?: string }).relationship).toBe('parent');
  });
  it('maps a contact without a relationship to a KithEntry', () => {
    expect(contactToKindredEntry(makeContact({})).tier).toBe('kith');
  });
  it('carries sharedSecret/verifiedAt across and sets addedAt = verifiedAt', () => {
    const e = contactToKindredEntry(makeContact({ sharedSecret: 'sec', verifiedAt: 4242 }));
    expect((e as { sharedSecret?: string }).sharedSecret).toBe('sec');
    expect((e as { verifiedAt?: number }).verifiedAt).toBe(4242);
    expect(e.addedAt).toBe(4242);
  });
  it('maps groupId/label into local annotations', () => {
    const e = contactToKindredEntry(makeContact({ groupId: 'g1', label: 'Gaming' }));
    expect(e.annotations).toEqual({ groupId: 'g1', label: 'Gaming' });
  });
  it('omits annotations when there is no groupId/label', () => {
    expect(contactToKindredEntry(makeContact({})).annotations).toBeUndefined();
  });

  // This is a display/adapter mapping, not the envelope-building path — a
  // contact whose verifiedAt is garbage (NaN, negative, fractional) is
  // still shown to the user (never dropped here). Sanitising/dropping for
  // the wire happens only at companion-rail.ts's filterByScope, via the
  // exported sanitiseAddedAt below.
  it('does NOT sanitise or drop a contact with an invalid verifiedAt — it is still mapped', () => {
    const e = contactToKindredEntry(makeContact({ verifiedAt: -5 }));
    expect(e).not.toBeNull();
    expect(e.addedAt).toBe(-5);
    const e2 = contactToKindredEntry(makeContact({ verifiedAt: NaN }));
    expect(Number.isNaN(e2.addedAt)).toBe(true);
  });
});

// kenspeckle 0.2.0's buildGrantEnvelope throws for the whole envelope on a
// single addedAt that isn't a non-negative safe integer. Both
// contacts-sync.ts (verifiedAt) and kenspeckle's own parseEntry (addedAt,
// via ken-sync.ts) only require the value to be finite, so a synced record
// — contact OR ken — can carry a float, a negative number, or Infinity.
// sanitiseAddedAt is the shared sanitiser companion-rail.ts's filterByScope
// applies to every entry on the way into an envelope.
describe('sanitiseAddedAt', () => {
  it('floors a finite fractional value rather than rejecting it', () => {
    expect(sanitiseAddedAt(1000.7)).toBe(1000);
    expect(Number.isSafeInteger(sanitiseAddedAt(1000.7))).toBe(true);
  });
  it('returns null for a negative value', () => {
    expect(sanitiseAddedAt(-1)).toBeNull();
  });
  it('returns null for NaN', () => {
    expect(sanitiseAddedAt(NaN)).toBeNull();
  });
  it('returns null for Infinity / -Infinity', () => {
    expect(sanitiseAddedAt(Infinity)).toBeNull();
    expect(sanitiseAddedAt(-Infinity)).toBeNull();
  });
  it('returns null when too large to be a safe integer', () => {
    expect(sanitiseAddedAt(Number.MAX_SAFE_INTEGER + 10)).toBeNull();
  });
  it('keeps a value of exactly 0', () => {
    expect(sanitiseAddedAt(0)).toBe(0);
  });
  it('passes an already-valid safe integer through unchanged', () => {
    expect(sanitiseAddedAt(1700000000)).toBe(1700000000);
  });
});
