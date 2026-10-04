import { describe, it, expect } from 'vitest';
import { nip19 } from 'nostr-tools';
import { planScannedContact } from './scan-add-contact';
import { SCAN_CONTACT_OWN_KEY_COPY, SCAN_CONTACT_WRONG_CARD_COPY } from './contacts-v2-copy';

const THEM = 'a'.repeat(63) + '1';
const ME = 'b'.repeat(63) + '2';
const MY_OTHER = 'c'.repeat(63) + '3';
const args = { ownerIdentityPubkey: ME, ownerLists: [ME, MY_OTHER], ownPubkeys: [ME, MY_OTHER] };

describe('planScannedContact', () => {
  it('reads an npub', () => {
    expect(planScannedContact(nip19.npubEncode(THEM), args)).toEqual({ ok: true, pubkey: THEM, ownerIdentityPubkey: ME });
  });

  it('reads a nostr:-prefixed npub, with surrounding whitespace', () => {
    expect(planScannedContact(`  nostr:${nip19.npubEncode(THEM)}\n`, args)).toMatchObject({ ok: true, pubkey: THEM });
  });

  it('reads an nprofile', () => {
    const nprofile = nip19.nprofileEncode({ pubkey: THEM, relays: ['wss://relay.example'] });
    expect(planScannedContact(nprofile, args)).toMatchObject({ ok: true, pubkey: THEM });
  });

  it('refuses any of the user\'s own keys, not just the current card\'s', () => {
    expect(planScannedContact(nip19.npubEncode(MY_OTHER), args)).toEqual({ ok: false, error: SCAN_CONTACT_OWN_KEY_COPY });
  });

  it('refuses a card that is not one of the scope\'s contact lists', () => {
    const plan = planScannedContact(nip19.npubEncode(THEM), { ...args, ownerIdentityPubkey: 'd'.repeat(64) });
    expect(plan).toEqual({ ok: false, error: SCAN_CONTACT_WRONG_CARD_COPY });
  });

  it('leaves everything that is not a bare Nostr key to the existing routing', () => {
    expect(planScannedContact(JSON.stringify({ type: 'signet-contact', pubkey: THEM, name: 'Sam' }), args)).toBeNull();
    expect(planScannedContact(THEM, args)).toBeNull();
    expect(planScannedContact('https://example.com', args)).toBeNull();
  });
});
