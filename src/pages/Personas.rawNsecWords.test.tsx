// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { nip19 } from 'nostr-tools';
import { hexToBytes } from '@noble/hashes/utils.js';
import type { SignetIdentity } from '../types';
import { Personas } from './Personas';
import { NSEC_INPUT_ERROR_COPY, RESTORE_ERROR_COPY } from '../lib/recovery-words';

const identity: SignetIdentity = {
  id: 'a'.repeat(64), primaryKeypair: 'persona', mnemonic: '', isChild: false, createdAt: 0,
  naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: '' },
  persona: { publicKey: 'b'.repeat(64), privateKey: '', displayName: 'Alex' },
};

// The published NIP-06 test key and the raw-nsec words Sapwood produces for it.
const TEST_KEY = '7f7ff03d123792d6ac594bfa67bf6d0c0ab55b6b1fdb6249303fe861f1ccba9a';
const TEST_PUB = '17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917';
const TEST_WORDS =
  'edge obtain logic quote enemy riot armed legal zebra aunt caught junior hero ramp city whip digital swap blossom prize pumpkin property window girl end avocado speak business town tuna frog';
const SIGNET_WORDS =
  'edge obtain doll auto level leave morning abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TREE_NSEC_WORDS = ['edge', 'obtain', 'seed', 'afford', 'today', 'police', 'pyramid', ...Array<string>(23).fill('abandon'), 'diesel'].join(' ');

function openAndFill(input: string) {
  const onImport = vi.fn(async () => ({ added: true as const, pubkey: TEST_PUB }));
  const lookup = vi.fn(async () => null);
  render(<Personas identity={identity} onAddPersona={vi.fn()} onSwitchPrimary={vi.fn()} onImportNostrAccount={onImport as never} onLookupExistingProfile={lookup} />);
  fireEvent.click(screen.getByRole('button', { name: 'Import an existing Nostr account' }));
  fireEvent.change(screen.getByPlaceholderText('nsec1...'), { target: { value: input } });
  fireEvent.change(screen.getByPlaceholderText('What should we call this persona?'), { target: { value: 'Old Nostr' } });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Import' }));
  return { onImport, lookup };
}

describe('Personas — import a Nostr account from its 31 recovery words', () => {
  afterEach(cleanup);

  it('imports the same key an nsec would, through the same path', async () => {
    const { onImport, lookup } = openAndFill(TEST_WORDS);
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    expect(lookup).toHaveBeenCalledWith(TEST_PUB);
    expect(onImport).toHaveBeenCalledWith(nip19.nsecEncode(hexToBytes(TEST_KEY)), 'Old Nostr', undefined);
  });

  it('refuses a whole-Signet sequence and points elsewhere', async () => {
    const { onImport } = openAndFill(SIGNET_WORDS);
    expect(await screen.findByText(NSEC_INPUT_ERROR_COPY['whole-signet'])).toBeDefined();
    expect(onImport).not.toHaveBeenCalled();
  });

  it('refuses a tree-root nsec backup by name', async () => {
    const { onImport } = openAndFill(TREE_NSEC_WORDS);
    expect(await screen.findByText(RESTORE_ERROR_COPY['tree-root-nsec'])).toBeDefined();
    expect(onImport).not.toHaveBeenCalled();
  });

  it('refuses something that is neither', async () => {
    const { onImport } = openAndFill('npub1notakey');
    expect(await screen.findByText(NSEC_INPUT_ERROR_COPY['not-nsec'])).toBeDefined();
    expect(onImport).not.toHaveBeenCalled();
  });
});
