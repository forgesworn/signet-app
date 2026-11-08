// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { nip19 } from 'nostr-tools';
import { hexToBytes } from '@noble/hashes/utils.js';
import { OnboardingApp } from './OnboardingApp';
import { RESTORE_ERROR_COPY } from '../lib/recovery-words';
import { NSEC_CONFIRM_FROM_WORDS_COPY } from '../lib/raw-nsec-backup-copy';

const lookups = vi.hoisted(() => ({ fetchExistingProfile: vi.fn(async () => null) }));
vi.mock('../lib/existing-profile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/existing-profile')>()),
  fetchExistingProfile: lookups.fetchExistingProfile,
}));

// The published NIP-06 test key and the raw-nsec words Sapwood produces for it.
const TEST_KEY = '7f7ff03d123792d6ac594bfa67bf6d0c0ab55b6b1fdb6249303fe861f1ccba9a';
const TEST_PUB = '17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917';
const TEST_WORDS =
  'edge obtain logic quote enemy riot armed legal zebra aunt caught junior hero ramp city whip digital swap blossom prize pumpkin property window girl end avocado speak business town tuna frog';
// RECOVERY.md "Scalar-one nsec, nsec-tree source": a tree-root nsec backup.
const TREE_NSEC_WORDS = ['edge', 'obtain', 'seed', 'afford', 'today', 'police', 'pyramid', ...Array<string>(23).fill('abandon'), 'diesel'].join(' ');

function openRestoreBox() {
  const onImport = vi.fn(async () => {});
  const onImportNsec = vi.fn(async () => {});
  render(<OnboardingApp onCreate={vi.fn()} onImport={onImport} onImportLiteMnemonic={vi.fn()} onImportWithProfile={vi.fn()} onImportNsec={onImportNsec}
    onConnectHeartwood={vi.fn()} onConnectNip07={vi.fn()} onStartChildPair={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'I already have a Signet' }));
  fireEvent.click(screen.getByRole('button', { name: 'Enter my recovery words' }));
  return { onImport, onImportNsec };
}

describe('OnboardingApp — raw-nsec recovery words in the restore box', () => {
  afterEach(() => {
    cleanup();
    lookups.fetchExistingProfile.mockClear();
  });

  it('routes 31 raw-nsec words to the existing nsec import, persona slot, with a profile lookup', async () => {
    const { onImport, onImportNsec } = openRestoreBox();
    fireEvent.change(screen.getByPlaceholderText('19 words separated by spaces'), { target: { value: TEST_WORDS } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText(NSEC_CONFIRM_FROM_WORDS_COPY)).toBeDefined();
    expect(lookups.fetchExistingProfile).toHaveBeenCalledWith(TEST_PUB, expect.any(Array), undefined, expect.anything());

    fireEvent.change(screen.getByPlaceholderText(/Your name or nickname/), { target: { value: 'Nostr me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import as Persona' }));
    await waitFor(() => expect(onImportNsec).toHaveBeenCalledTimes(1));
    expect(onImportNsec).toHaveBeenCalledWith(nip19.nsecEncode(hexToBytes(TEST_KEY)), 'Nostr me', 'persona', undefined);
    expect(onImport).not.toHaveBeenCalled();
  });

  it('Back from the confirm returns to the words box and never shows the key in the nsec box', async () => {
    openRestoreBox();
    fireEvent.change(screen.getByPlaceholderText('19 words separated by spaces'), { target: { value: TEST_WORDS } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText(NSEC_CONFIRM_FROM_WORDS_COPY);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByPlaceholderText('19 words separated by spaces')).toBeDefined();
    expect(screen.queryByPlaceholderText('nsec1...')).toBeNull();
    expect(document.body.textContent).not.toContain('nsec1');
  });

  it('refuses a tree-root nsec backup with copy that says what it is', async () => {
    const { onImport, onImportNsec } = openRestoreBox();
    fireEvent.change(screen.getByPlaceholderText('19 words separated by spaces'), { target: { value: TREE_NSEC_WORDS } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(RESTORE_ERROR_COPY['tree-root-nsec'])).toBeDefined();
    expect(onImport).not.toHaveBeenCalled();
    expect(onImportNsec).not.toHaveBeenCalled();
  });
});
