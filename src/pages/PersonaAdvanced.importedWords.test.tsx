// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PersonaAdvanced } from './PersonaAdvanced';
import { IMPORTED_KEY_NOT_HERE, IMPORTED_PERSONA_NOTE, IMPORTED_PERSONA_SHOW_WORDS } from '../lib/raw-nsec-backup-copy';
import { toNsecRecoveryWords } from '../lib/recovery-words';
import type { SignetIdentity } from '../types';

// The published NIP-06 test key, imported as an extra persona.
const TEST_KEY = '7f7ff03d123792d6ac594bfa67bf6d0c0ab55b6b1fdb6249303fe861f1ccba9a';
const TEST_PUB = '17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917';

function identityWith(privateKey: string, imported = true): SignetIdentity {
  return {
    id: 'a'.repeat(64), primaryKeypair: 'persona', mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    isChild: false, createdAt: 0,
    naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '1'.repeat(64), displayName: '' },
    persona: { publicKey: 'b'.repeat(64), privateKey: '2'.repeat(64), displayName: 'Alex' },
    extraPersonas: [{ publicKey: TEST_PUB, privateKey, displayName: 'Old Nostr', derivationName: '', imported }],
  } as SignetIdentity;
}

function renderPage(identity: SignetIdentity, onRevealImportedKeyWords?: (pubkey: string, dep?: string) => Promise<string | null>) {
  render(
    <PersonaAdvanced
      slotTarget={TEST_PUB}
      identity={identity}
      dependants={[]}
      onPublishProfile={vi.fn(async () => ({ ok: true }))}
      onDisablePublicProfile={vi.fn(async () => {})}
      onRevealImportedKeyWords={onRevealImportedKeyWords}
      onBack={() => {}}
    />,
  );
}

describe('PersonaAdvanced — an imported extra persona has its own recovery words', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('says the Signet words do not cover it and offers its own', () => {
    renderPage(identityWith(TEST_KEY), vi.fn(async () => null));
    expect(screen.getByText(IMPORTED_PERSONA_NOTE)).toBeDefined();
    expect(screen.getByRole('button', { name: IMPORTED_PERSONA_SHOW_WORDS })).toBeDefined();
  });

  it('shows the 31 words, captioned, only after the caller returns them', async () => {
    const onReveal = vi.fn(async () => toNsecRecoveryWords(TEST_KEY));
    renderPage(identityWith(TEST_KEY), onReveal);
    expect(document.querySelectorAll('[data-word-index]')).toHaveLength(0);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: IMPORTED_PERSONA_SHOW_WORDS }));
    });
    expect(onReveal).toHaveBeenCalledWith(TEST_PUB, undefined);
    expect(document.querySelectorAll('[data-word-index]')).toHaveLength(31);
    expect(screen.getByText('Format header — words 1 to 7')).toBeDefined();
    expect(screen.getByText('Your key — words 8 to 31')).toBeDefined();
  });

  it('shows nothing when the reveal is declined', async () => {
    renderPage(identityWith(TEST_KEY), vi.fn(async () => null));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: IMPORTED_PERSONA_SHOW_WORDS }));
    });
    expect(document.querySelectorAll('[data-word-index]')).toHaveLength(0);
  });

  it('auto-hides after 90 seconds and clears the clipboard after 60', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const words = toNsecRecoveryWords(TEST_KEY);
    renderPage(identityWith(TEST_KEY), vi.fn(async () => words));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: IMPORTED_PERSONA_SHOW_WORDS }));
    });
    fireEvent.click(screen.getByText('Copy to clipboard'));
    expect(writeText).toHaveBeenLastCalledWith(words);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(writeText).toHaveBeenLastCalledWith('');
    expect(document.querySelectorAll('[data-word-index]')).toHaveLength(31);
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(document.querySelectorAll('[data-word-index]')).toHaveLength(0);
  });

  it('a slot whose key is not on this device says so and offers no reveal', () => {
    renderPage(identityWith(''), vi.fn(async () => null));
    expect(screen.getByText(IMPORTED_KEY_NOT_HERE)).toBeDefined();
    expect(screen.queryByRole('button', { name: IMPORTED_PERSONA_SHOW_WORDS })).toBeNull();
  });

  it('a derived extra persona gets no imported-key block', () => {
    renderPage(identityWith(TEST_KEY, false), vi.fn(async () => null));
    expect(screen.queryByText(IMPORTED_PERSONA_NOTE)).toBeNull();
    expect(screen.queryByRole('button', { name: IMPORTED_PERSONA_SHOW_WORDS })).toBeNull();
  });
});
