import { describe, it, expect } from 'vitest';
import { planNewContact, EMPTY_NEW_CONTACT_DRAFT } from './contacts-v2-new-contact';

describe('planNewContact', () => {
  it('starts empty as a Ken person', () => {
    expect(EMPTY_NEW_CONTACT_DRAFT).toEqual({
      displayName: '', type: 'person', tier: 'ken', phone: '', email: '',
    });
  });

  it('requires a name', () => {
    expect(planNewContact({ ...EMPTY_NEW_CONTACT_DRAFT, displayName: '  ' }))
      .toEqual({ ok: false, error: 'Enter a name.' });
  });

  it('builds a keyless contact with no methods', () => {
    const plan = planNewContact({ ...EMPTY_NEW_CONTACT_DRAFT, displayName: ' Corner Shop ', type: 'organisation', tier: 'ken' });
    expect(plan).toEqual({
      ok: true,
      contact: { type: 'organisation', displayName: 'Corner Shop', tier: 'ken', lifecycle: 'active' },
      methods: [],
    });
  });

  it('attaches a phone and an email as private unverified methods', () => {
    const plan = planNewContact({
      displayName: 'Dave', type: 'person', tier: 'kin',
      phone: '07700 900123', email: 'dave@example.com',
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.methods).toEqual([
      { kind: 'phone', value: '07700 900123', verification: 'unverified', sharingPolicy: 'private' },
      { kind: 'email', value: 'dave@example.com', verification: 'unverified', sharingPolicy: 'private' },
    ]);
  });

  it('rejects a malformed email rather than dropping it silently', () => {
    expect(planNewContact({ ...EMPTY_NEW_CONTACT_DRAFT, displayName: 'Dave', email: 'nope' }).ok).toBe(false);
  });

  it('caps the display name at 100 characters', () => {
    const plan = planNewContact({ ...EMPTY_NEW_CONTACT_DRAFT, displayName: 'n'.repeat(140) });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.contact.displayName).toHaveLength(100);
  });

  it('adds a typed NIP-05 address as a private unverified "NIP-05" method, canonical', () => {
    const plan = planNewContact({ ...EMPTY_NEW_CONTACT_DRAFT, displayName: 'Dave', phone: '07700 900123' }, ' Example.COM ');
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.methods).toEqual([
      { kind: 'phone', value: '07700 900123', verification: 'unverified', sharingPolicy: 'private' },
      { kind: 'other', label: 'NIP-05', value: '_@example.com', verification: 'unverified', sharingPolicy: 'private' },
    ]);
  });

  it('rejects a malformed NIP-05 address rather than dropping it', () => {
    expect(planNewContact({ ...EMPTY_NEW_CONTACT_DRAFT, displayName: 'Dave' }, 'a+b@example.com').ok).toBe(false);
    expect(planNewContact({ ...EMPTY_NEW_CONTACT_DRAFT, displayName: 'Dave' }, 'nope').ok).toBe(false);
  });
});
