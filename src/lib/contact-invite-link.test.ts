// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { contactInviteLink, contactInviteOrigin, parseContactInviteLink } from './contact-invite-link';
import { routeQR } from './qr-router';
const invite = { v: 1 as const, recipient: 'a'.repeat(64), secret: 'b'.repeat(64), relays: ['wss://relay.example/'] };
it('carries capabilities only in fragments and routes QR invites without fetching their origin', () => {
  const link = contactInviteLink(invite, 'https://mysignet.app');
  expect(new URL(link).search).toBe('');
  expect(parseContactInviteLink(link)).toEqual(invite);
  expect(routeQR(link)).toEqual({ type: 'contact-invite', invite });
  expect(parseContactInviteLink(JSON.stringify(invite))).toEqual(invite);
});
it('rejects expired, ambiguous and oversized invites', () => {
  const link = contactInviteLink({ ...invite, expiresAt: 100 }, 'https://mysignet.app');
  expect(parseContactInviteLink(link, 100)).toBeNull();
  expect(parseContactInviteLink(link + '&contact-invite=other', 99)).toBeNull();
  expect(parseContactInviteLink('a'.repeat(8193))).toBeNull();
});
describe('contactInviteOrigin', () => {
  afterEach(() => { delete (window as { Capacitor?: unknown }).Capacitor; });
  it('uses the real site on the APK, whose own origin is a dead https://localhost', () => {
    (window as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
    expect(contactInviteOrigin()).toBe('https://mysignet.app');
  });
  it('uses the page origin on the web', () => {
    expect(contactInviteOrigin()).toBe(window.location.origin);
  });
});
