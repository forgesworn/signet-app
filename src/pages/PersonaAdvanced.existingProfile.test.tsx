// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PersonaAdvanced } from './PersonaAdvanced';
import type { SignetIdentity } from '../types';
import type { ExistingProfile } from '../lib/existing-profile';

function identityWith(persona: Partial<SignetIdentity['persona']> = {}): SignetIdentity {
  return {
    id: 'a'.repeat(64), primaryKeypair: 'persona', mnemonic: '', isChild: false, createdAt: 0,
    naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: '' },
    persona: { publicKey: 'b'.repeat(64), privateKey: '', displayName: 'Alex', ...persona },
  };
}

const found = {
  event: { id: 'e'.repeat(64), created_at: 123, content: '{"name":"Bob"}', tags: [], pubkey: 'b'.repeat(64), kind: 0, sig: 's' },
  profile: { displayName: 'Bob', about: 'Hello' },
  base: undefined,
  relay: 'wss://relay.example',
} as unknown as ExistingProfile;

function renderPage(identity: SignetIdentity, extra: Record<string, unknown> = {}) {
  render(
    <PersonaAdvanced
      slotTarget="persona"
      identity={identity}
      dependants={[]}
      onPublishProfile={vi.fn(async () => ({ ok: true }))}
      onDisablePublicProfile={vi.fn(async () => {})}
      onBack={() => {}}
      {...extra}
    />,
  );
}

describe('PersonaAdvanced — check Nostr for an existing profile', () => {
  it('is hidden unless the host passes the lookup (dependant slots, paired-child installs)', () => {
    renderPage(identityWith());
    expect(screen.queryByRole('button', { name: 'Check Nostr for an existing profile' })).toBeNull();
  });

  it('offers the match panel, says matching overwrites the card, and matches without publishing', async () => {
    const onCheck = vi.fn(async () => found);
    const onMatch = vi.fn(async () => {});
    const onPublish = vi.fn(async () => ({ ok: true }));
    renderPage(identityWith(), { onCheckExistingProfile: onCheck, onMatchExistingProfile: onMatch, onPublishProfile: onPublish });
    fireEvent.click(screen.getByRole('button', { name: 'Check Nostr for an existing profile' }));
    await screen.findByText('This account is already public on Nostr as Bob.');
    expect(screen.getByText(/replaces this card.s name, bio and picture/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Match it in Signet' }));
    await waitFor(() => expect(onMatch).toHaveBeenCalledWith(found));
    expect(onPublish).not.toHaveBeenCalled();
  });

  it('says so plainly when nothing is found, or when no relay answered', async () => {
    const onCheck = vi.fn<() => Promise<ExistingProfile | null | 'unreachable'>>().mockResolvedValueOnce(null).mockResolvedValueOnce('unreachable');
    renderPage(identityWith(), { onCheckExistingProfile: onCheck, onMatchExistingProfile: vi.fn() });
    fireEvent.click(screen.getByRole('button', { name: 'Check Nostr for an existing profile' }));
    await screen.findByText('No public profile found on Nostr for this key.');
    fireEvent.click(screen.getByRole('button', { name: 'Check Nostr for an existing profile' }));
    await screen.findByText(/Couldn.t reach Nostr relays to check/);
  });

  it('is not offered once the slot is published', () => {
    renderPage(identityWith({ publicProfile: { enabled: true, lastEventId: 'e'.repeat(64), lastPublishedAt: 1, lastPublishedRelay: 'wss://relay.example' } }), {
      onCheckExistingProfile: vi.fn(), onMatchExistingProfile: vi.fn(),
    });
    expect(screen.queryByRole('button', { name: 'Check Nostr for an existing profile' })).toBeNull();
  });
});

describe('PersonaAdvanced — Disable copy for a profile adopted from Nostr', () => {
  const published = { enabled: true, lastEventId: 'e'.repeat(64), lastPublishedAt: 1, lastPublishedRelay: 'wss://relay.example' };

  it('says it asks the relay host to remove it and copies elsewhere may stay up', () => {
    renderPage(identityWith({
      publicProfile: published,
      publicProfileBase: { eventId: 'e'.repeat(64), createdAt: 1, content: '{}', tags: [], matched: true },
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Disable / retract' }));
    expect(screen.getByText(/This asks relay\.example to remove it\. Copies on other relays may stay up\./)).toBeDefined();
  });

  it('keeps the standard copy for a profile Signet published itself', () => {
    renderPage(identityWith({
      publicProfile: published,
      publicProfileBase: { eventId: 'e'.repeat(64), createdAt: 1, content: '{}', tags: [] },
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Disable / retract' }));
    expect(screen.queryByText(/This asks relay\.example to remove it/)).toBeNull();
    expect(screen.getByText(/Signet will ask Nostr relays to delete this public profile/)).toBeDefined();
  });
});
