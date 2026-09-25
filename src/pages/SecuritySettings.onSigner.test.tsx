// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SecuritySettings } from './SecuritySettings';
import { BACKUP_WORDS_ON_SIGNER } from '../lib/local-key-only-copy';
import type { SignetIdentity } from '../types';

// The reveal + Shamir affordances both derive from the mnemonic. After the
// Heartwood migration this device has none, so `mnemonicOnSigner` must replace
// them rather than leave a button that stalls on "Unlocking..." (§11.1.7).
const identity = {
  id: 'a'.repeat(64),
  mnemonic: '',
  encrypted: false,
  naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: 'Owner' },
  persona: { publicKey: 'b'.repeat(64), privateKey: '', displayName: 'Persona' },
  createdAt: Date.now(),
} as unknown as SignetIdentity;

function renderPage(mnemonicOnSigner: boolean) {
  render(
    <SecuritySettings
      identity={identity}
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
      bunkerServerEnabled={false}
      onSetBunkerServerEnabled={vi.fn()}
      bunkerUrl={null}
      onNavigateShamir={vi.fn()}
      mnemonicOnSigner={mnemonicOnSigner}
    />
  );
}

describe('SecuritySettings — on-signer backup gate', () => {
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
