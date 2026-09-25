import { describe, it, expect } from 'vitest';
import { barTabsFor, isBarHiddenPage, activeTabForPage, isOrphanedApprovalPage } from './app-nav';

describe('barTabsFor', () => {
  it('owner gets 4 tabs including bunker', () => {
    const tabs = barTabsFor({ isDependantContext: false });
    expect(tabs.map(t => t.id)).toEqual(['home', 'contacts', 'bunker', 'settings']);
  });
  it('dependant gets 3 tabs without bunker', () => {
    const tabs = barTabsFor({ isDependantContext: true });
    expect(tabs.map(t => t.id)).toEqual(['home', 'contacts', 'settings']);
    expect(tabs.some(t => t.id === 'bunker')).toBe(false);
  });
});

describe('isBarHiddenPage', () => {
  it('hides the bar on approval/scan/venue surfaces', () => {
    expect(isBarHiddenPage('approve-auth')).toBe(true);
    expect(isBarHiddenPage('relay-auth-ack')).toBe(true);
    expect(isBarHiddenPage('venue-entry')).toBe(true);
  });
  it('hides the bar on ceremony/pairing/import focus surfaces', () => {
    expect(isBarHiddenPage('transition-ceremony')).toBe(true);
    expect(isBarHiddenPage('pair-dependant-device')).toBe(true);
    expect(isBarHiddenPage('pair-dependant-app')).toBe(true);
    expect(isBarHiddenPage('paired-child-repair')).toBe(true);
    expect(isBarHiddenPage('import-dependant')).toBe(true);
  });
  it('shows the bar on normal pages', () => {
    expect(isBarHiddenPage('home')).toBe(false);
    expect(isBarHiddenPage('contacts')).toBe(false);
    expect(isBarHiddenPage('settings')).toBe(false);
  });
});

describe('activeTabForPage', () => {
  it('maps pages to their owning tab', () => {
    expect(activeTabForPage('home')).toBe('home');
    expect(activeTabForPage('contact-detail')).toBe('contacts');
    expect(activeTabForPage('ken-detail')).toBe('contacts');
    expect(activeTabForPage('ken-add')).toBe('contacts');
    expect(activeTabForPage('settings-security')).toBe('settings');
  });
  it('maps Settings sub-pages and deep pages reached from Settings to the settings tab', () => {
    expect(activeTabForPage('connections')).toBe('settings');
    expect(activeTabForPage('badge-embed')).toBe('settings');
    expect(activeTabForPage('shamir')).toBe('settings');
    expect(activeTabForPage('identity-bridge')).toBe('settings');
    expect(activeTabForPage('roster')).toBe('settings');
    expect(activeTabForPage('persona-advanced')).toBe('settings');
    expect(activeTabForPage('edit-public-profile')).toBe('settings');
    expect(activeTabForPage('activate-real-identity')).toBe('settings');
    expect(activeTabForPage('manage-carousel')).toBe('settings');
    expect(activeTabForPage('pro-onboarding')).toBe('settings');
    expect(activeTabForPage('pro-dashboard')).toBe('settings');
    expect(activeTabForPage('sub-role-pro-dashboard')).toBe('settings');
    expect(activeTabForPage('self-cert-issue')).toBe('settings');
    expect(activeTabForPage('pro-attest')).toBe('settings');
    expect(activeTabForPage('lead-add-staff')).toBe('settings');
    expect(activeTabForPage('lead-manage-delegates')).toBe('settings');
    expect(activeTabForPage('activity')).toBe('settings');
  });
  it('returns null for deep pages owned by no tab', () => {
    expect(activeTabForPage('get-verified')).toBeNull();
  });
});

describe('isOrphanedApprovalPage', () => {
  it('flags approve-auth once its request is gone (the nav-less fall-through)', () => {
    expect(isOrphanedApprovalPage('approve-auth', { hasAuthRequest: false, hasRelayAuthAck: false })).toBe(true);
    expect(isBarHiddenPage('approve-auth')).toBe(true);
  });
  it('leaves approve-auth alone while a request is pending', () => {
    expect(isOrphanedApprovalPage('approve-auth', { hasAuthRequest: true, hasRelayAuthAck: false })).toBe(false);
  });
  it('flags relay-auth-ack without ack state', () => {
    expect(isOrphanedApprovalPage('relay-auth-ack', { hasAuthRequest: false, hasRelayAuthAck: false })).toBe(true);
    expect(isOrphanedApprovalPage('relay-auth-ack', { hasAuthRequest: false, hasRelayAuthAck: true })).toBe(false);
  });
  it('never flags ordinary pages', () => {
    expect(isOrphanedApprovalPage('home', { hasAuthRequest: false, hasRelayAuthAck: false })).toBe(false);
  });
});
