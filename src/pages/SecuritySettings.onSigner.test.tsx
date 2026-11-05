// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SecuritySettings } from './SecuritySettings';
import { BACKUP_WORDS_ON_SIGNER, NO_BACKUP_WORDS_CHILD, NO_BACKUP_WORDS_IMPORTED } from '../lib/local-key-only-copy';
import type { SignetIdentity } from '../types';

// The reveal + Shamir affordances both derive from the mnemonic. After the
// Heartwood migration this device has none, so `mnemonicOnSigner` must replace
// them rather than leave a button that stalls on "Unlocking..." (§11.1.7).
const identity = {
  id: 'a'.repeat(64),
  mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  encrypted: false,
  naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: 'Owner' },
  persona: { publicKey: 'b'.repeat(64), privateKey: '', displayName: 'Persona' },
  createdAt: Date.now(),
} as unknown as SignetIdentity;

function renderPage(mnemonicOnSigner: boolean, over: Partial<SignetIdentity> = {}) {
  render(
    <SecuritySettings
      identity={{ ...identity, ...over }}
      securityTier="standard"
      onSetSecurityTier={vi.fn()}
      onRequestAuth={vi.fn()}
      onRequestFreshAuth={vi.fn()}
      blurIdentityNames={false}
      onSetBlurIdentityNames={vi.fn()}
      requireNpConfirmation={true}
      onSetRequireNpConfirmation={vi.fn()}
      preferPersonaForSignIns={false}
      onSetPreferPersonaForSignIns={vi.fn()}
      preferredPersonaPubkey={undefined}
      onSetPreferredPersonaPubkey={vi.fn()}
      onNavigateShamir={vi.fn()}
      mnemonicOnSigner={mnemonicOnSigner}
    />
  );
}

describe('SecuritySettings — on-signer backup gate', () => {
  afterEach(cleanup);

  it('offers the reveal and Shamir affordances on a local-key install', () => {
    renderPage(false);
    expect(screen.getByText('View my recovery words')).toBeDefined();
    expect(screen.getByText('Manage Shamir Backup')).toBeDefined();
    expect(screen.getByText(/19 words\. Write them down in order/)).toBeDefined();
    expect(screen.queryByText(BACKUP_WORDS_ON_SIGNER)).toBeNull();
  });

  it('replaces reveal + "19 words" copy + Shamir with the on-signer line', () => {
    renderPage(true);
    expect(screen.getByText(BACKUP_WORDS_ON_SIGNER)).toBeDefined();
    expect(screen.queryByText('View my recovery words')).toBeNull();
    expect(screen.queryByText(/19 words\. Write them down in order/)).toBeNull();
    expect(screen.queryByText('Manage Shamir Backup')).toBeNull();
  });
});

describe('SecuritySettings with no recovery words on this install', () => {
  afterEach(cleanup);

  it('an nsec import is told why, and is not offered a reveal that would stall', () => {
    renderPage(false, { mnemonic: '' });
    expect(screen.getByText(NO_BACKUP_WORDS_IMPORTED)).toBeDefined();
    expect(screen.queryByText('View my recovery words')).toBeNull();
    expect(screen.queryByText(/19 words\. Write them down in order/)).toBeNull();
  });

  it('a paired child hears that the guardian holds the backup', () => {
    renderPage(false, { mnemonic: '', isChild: true });
    expect(screen.getByText(NO_BACKUP_WORDS_CHILD)).toBeDefined();
    expect(screen.queryByText('View my recovery words')).toBeNull();
  });

  it('a still-encrypted record is not mistaken for one with no words', () => {
    renderPage(false, { mnemonic: '', encrypted: true });
    expect(screen.getByText('View my recovery words')).toBeDefined();
    expect(screen.queryByText(NO_BACKUP_WORDS_IMPORTED)).toBeNull();
  });

  it('the on-signer line wins over both', () => {
    renderPage(true, { mnemonic: '' });
    expect(screen.getByText(BACKUP_WORDS_ON_SIGNER)).toBeDefined();
    expect(screen.queryByText(NO_BACKUP_WORDS_IMPORTED)).toBeNull();
  });
});
