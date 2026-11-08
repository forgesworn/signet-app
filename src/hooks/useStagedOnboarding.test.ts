// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { nip19 } from 'nostr-tools';
import { hexToBytes } from '@noble/hashes/utils.js';
import { useStagedOnboarding, RAW_NSEC_WORDS_NOT_HERE_COPY } from './useStagedOnboarding';
import { RESTORE_ERROR_COPY } from '../lib/recovery-words';

// The published NIP-06 test key and the raw-nsec words Sapwood produces for it.
const TEST_KEY = '7f7ff03d123792d6ac594bfa67bf6d0c0ab55b6b1fdb6249303fe861f1ccba9a';
const TEST_WORDS =
  'edge obtain logic quote enemy riot armed legal zebra aunt caught junior hero ramp city whip digital swap blossom prize pumpkin property window girl end avocado speak business town tuna frog';
const SIGNET_WORDS =
  'edge obtain doll auto level leave morning abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TREE_NSEC_WORDS = ['edge', 'obtain', 'seed', 'afford', 'today', 'police', 'pyramid', ...Array<string>(23).fill('abandon'), 'diesel'].join(' ');

function setup(withNsec = true) {
  const onCreate = vi.fn(async () => {});
  const onImport = vi.fn(async () => {});
  const onImportNsec = vi.fn(async () => {});
  const hook = renderHook(() => useStagedOnboarding({ onCreate, onImport, onImportNsec: withNsec ? onImportNsec : undefined }));
  return { hook, onImport, onImportNsec };
}

async function submit(hook: ReturnType<typeof setup>['hook'], phrase: string, name = 'Moss') {
  act(() => {
    hook.result.current.setPhrase(phrase);
    hook.result.current.setDisplayName(name);
  });
  await act(async () => {
    await hook.result.current.handleImportSubmit();
  });
}

describe('useStagedOnboarding — restore box routing', () => {
  it('routes raw-nsec words to the nsec import, as an nsec', async () => {
    const { hook, onImport, onImportNsec } = setup();
    await submit(hook, TEST_WORDS);
    expect(onImportNsec).toHaveBeenCalledWith(nip19.nsecEncode(hexToBytes(TEST_KEY)), 'Moss');
    expect(onImport).not.toHaveBeenCalled();
    expect(hook.result.current.error).toBeNull();
  });

  it('still routes Signet words to the mnemonic restore', async () => {
    const { hook, onImport, onImportNsec } = setup();
    await submit(hook, SIGNET_WORDS);
    expect(onImport).toHaveBeenCalledWith(SIGNET_WORDS.split(' ').slice(7).join(' '), 'Moss', 'persona', false);
    expect(onImportNsec).not.toHaveBeenCalled();
  });

  it('says where to go when no nsec import is wired', async () => {
    const { hook, onImport } = setup(false);
    await submit(hook, TEST_WORDS);
    expect(hook.result.current.error).toBe(RAW_NSEC_WORDS_NOT_HERE_COPY);
    expect(onImport).not.toHaveBeenCalled();
  });

  it('asks for a name before importing the key', async () => {
    const { hook, onImportNsec } = setup();
    await submit(hook, TEST_WORDS, '  ');
    expect(onImportNsec).not.toHaveBeenCalled();
    expect(hook.result.current.error).toBe('Please give this identity a display name.');
  });

  it('refuses a tree-root nsec backup by name', async () => {
    const { hook, onImport, onImportNsec } = setup();
    await submit(hook, TREE_NSEC_WORDS);
    expect(hook.result.current.error).toBe(RESTORE_ERROR_COPY['tree-root-nsec']);
    expect(onImport).not.toHaveBeenCalled();
    expect(onImportNsec).not.toHaveBeenCalled();
  });
});
