// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SecuritySettings } from './SecuritySettings';
import { NO_BACKUP_WORDS_IMPORTED } from '../lib/local-key-only-copy';
import { RAW_NSEC_WORDS_CONFIRMED, RAW_NSEC_WORDS_CONFIRM_LABEL, RAW_NSEC_WORDS_INTRO, SHAMIR_NOT_FOR_RAW_NSEC } from '../lib/raw-nsec-backup-copy';
import type { SignetIdentity } from '../types';
import type { PurposeContext } from '../lib/auth-purposes';

type FreshAuth = (ctx?: PurposeContext) => Promise<string | null>;

// The published NIP-06 test key and the raw-nsec words Sapwood produces for it.
const TEST_KEY = '7f7ff03d123792d6ac594bfa67bf6d0c0ab55b6b1fdb6249303fe861f1ccba9a';
const TEST_WORDS =
  'edge obtain logic quote enemy riot armed legal zebra aunt caught junior hero ramp city whip digital swap blossom prize pumpkin property window girl end avocado speak business town tuna frog';

// An identity created from an nsec: no mnemonic, the key in the persona slot,
// nothing in the real-name slot (importFromNsec's shape).
const nsecIdentity = {
  id: '17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917',
  mnemonic: '',
  encrypted: false,
  primaryKeypair: 'persona',
  isChild: false,
  naturalPerson: { publicKey: '', privateKey: '', displayName: '' },
  persona: { publicKey: '17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917', privateKey: TEST_KEY, displayName: 'Nostr me' },
  createdAt: 0,
  backedUp: false,
} as unknown as SignetIdentity;

function renderPage(over: Partial<SignetIdentity> = {}, extra: { onMarkBackedUp?: () => Promise<void>; onRequestFreshAuth?: FreshAuth } = {}) {
  const onRequestFreshAuth = extra.onRequestFreshAuth ?? vi.fn<FreshAuth>(async () => 'unlock-key');
  const onNavigateShamir = vi.fn();
  render(
    <SecuritySettings
      identity={{ ...nsecIdentity, ...over }}
      securityTier="standard"
      onSetSecurityTier={vi.fn()}
      onRequestAuth={vi.fn()}
      onRequestFreshAuth={onRequestFreshAuth}
      blurIdentityNames={false}
      onSetBlurIdentityNames={vi.fn()}
      requireNpConfirmation={true}
      onSetRequireNpConfirmation={vi.fn()}
      preferPersonaForSignIns={false}
      onSetPreferPersonaForSignIns={vi.fn()}
      preferredPersonaPubkey={undefined}
      onSetPreferredPersonaPubkey={vi.fn()}
      onNavigateShamir={onNavigateShamir}
      onMarkBackedUp={extra.onMarkBackedUp}
    />,
  );
  return { onRequestFreshAuth, onNavigateShamir };
}

async function reveal() {
  await act(async () => {
    fireEvent.click(screen.getByText('View my recovery words'));
  });
}

describe('SecuritySettings — recovery words for an identity created from an nsec', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('offers the 31-word reveal instead of saying there are no words', () => {
    renderPage();
    expect(screen.getByText(RAW_NSEC_WORDS_INTRO)).toBeDefined();
    expect(screen.getByText('View my recovery words')).toBeDefined();
    expect(screen.queryByText(NO_BACKUP_WORDS_IMPORTED)).toBeNull();
    expect(screen.queryByText(/19 words\. Write them down in order/)).toBeNull();
  });

  it('asks for fresh auth scoped to one key, then shows 31 words captioned 7 + 24', async () => {
    const { onRequestFreshAuth } = renderPage();
    await reveal();
    expect(onRequestFreshAuth).toHaveBeenCalledWith({ purpose: 'reveal-recovery-words', scope: 'key' });
    const indices = Array.from(document.querySelectorAll('[data-word-index]')).map(el => Number(el.getAttribute('data-word-index')));
    expect(indices).toEqual(Array.from({ length: 31 }, (_, i) => i + 1));
    expect(screen.getByText('Format header — words 1 to 7')).toBeDefined();
    expect(screen.getByText('Your key — words 8 to 31')).toBeDefined();
    const shown = Array.from(document.querySelectorAll('[data-word-index]')).map(el => el.lastElementChild?.textContent);
    expect(shown.join(' ')).toBe(TEST_WORDS);
  });

  it('shows nothing when fresh auth is declined', async () => {
    renderPage({}, { onRequestFreshAuth: vi.fn<FreshAuth>(async () => null) });
    await reveal();
    expect(document.querySelectorAll('[data-word-index]')).toHaveLength(0);
    expect(screen.getByText('View my recovery words')).toBeDefined();
  });

  it('hides the words again after 90 seconds', async () => {
    vi.useFakeTimers();
    renderPage();
    await reveal();
    expect(document.querySelectorAll('[data-word-index]')).toHaveLength(31);
    act(() => { vi.advanceTimersByTime(90_000); });
    expect(document.querySelectorAll('[data-word-index]')).toHaveLength(0);
  });

  it('copies the words and clears the clipboard after 60 seconds', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderPage();
    await reveal();
    fireEvent.click(screen.getByText('Copy to clipboard'));
    expect(writeText).toHaveBeenLastCalledWith(TEST_WORDS);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(writeText).toHaveBeenLastCalledWith('');
  });

  it('lets the user confirm the words are written down, which clears the prompt', async () => {
    const onMarkBackedUp = vi.fn(async () => {});
    renderPage({}, { onMarkBackedUp });
    await reveal();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: RAW_NSEC_WORDS_CONFIRM_LABEL }));
    });
    expect(onMarkBackedUp).toHaveBeenCalledTimes(1);
  });

  it('says it is backed up once it is, with no second confirm', async () => {
    renderPage({ backedUp: true }, { onMarkBackedUp: vi.fn(async () => {}) });
    await reveal();
    expect(screen.getByText(RAW_NSEC_WORDS_CONFIRMED)).toBeDefined();
    expect(screen.queryByRole('button', { name: RAW_NSEC_WORDS_CONFIRM_LABEL })).toBeNull();
  });

  it('says Shamir does not cover an imported key, rather than offering a split', () => {
    const { onNavigateShamir } = renderPage();
    expect(screen.getByText(SHAMIR_NOT_FOR_RAW_NSEC)).toBeDefined();
    expect(screen.queryByText('Manage Shamir Backup')).toBeNull();
    expect(onNavigateShamir).not.toHaveBeenCalled();
  });

  it('a key not held on this device still shows no words', () => {
    renderPage({ persona: { ...nsecIdentity.persona, privateKey: '' } });
    expect(screen.getByText(NO_BACKUP_WORDS_IMPORTED)).toBeDefined();
    expect(screen.queryByText('View my recovery words')).toBeNull();
    expect(screen.queryByText(SHAMIR_NOT_FOR_RAW_NSEC)).toBeNull();
  });

  it('a Signet mnemonic is unchanged: 19 words, no raw-key confirm', async () => {
    renderPage({
      mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      persona: { ...nsecIdentity.persona, privateKey: '1'.repeat(64) },
      naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '2'.repeat(64), displayName: '' },
    }, { onMarkBackedUp: vi.fn(async () => {}) });
    expect(screen.getByText(/19 words\. Write them down in order/)).toBeDefined();
    expect(screen.getByText('Manage Shamir Backup')).toBeDefined();
    await reveal();
    expect(document.querySelectorAll('[data-word-index]')).toHaveLength(19);
    expect(screen.queryByRole('button', { name: RAW_NSEC_WORDS_CONFIRM_LABEL })).toBeNull();
  });
});
