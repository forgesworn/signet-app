// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { nip19 } from 'nostr-tools';
import { generateSecretKey } from 'nostr-tools/pure';
import type { SignetIdentity } from '../types';
import { Personas } from './Personas';

const identity: SignetIdentity = {
  id: 'a'.repeat(64), primaryKeypair: 'persona', mnemonic: '', isChild: false, createdAt: 0,
  naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: '' },
  persona: { publicKey: 'b'.repeat(64), privateKey: '', displayName: 'Alex' },
};
const nsec = nip19.nsecEncode(generateSecretKey());
const NEW_KEY = 'c'.repeat(64);

async function importAccount(props: { followsHandlersFor?: (pubkey: string, name: string) => unknown }) {
  const onImport = vi.fn(async () => ({ added: true as const, pubkey: NEW_KEY }));
  render(<Personas identity={identity} onAddPersona={vi.fn()} onSwitchPrimary={vi.fn()}
    onImportNostrAccount={onImport as never} onLookupExistingProfile={async () => null}
    followsHandlersFor={props.followsHandlersFor as never} />);
  fireEvent.click(screen.getByRole('button', { name: 'Import an existing Nostr account' }));
  fireEvent.change(screen.getByPlaceholderText('nsec1...'), { target: { value: nsec } });
  fireEvent.change(screen.getByPlaceholderText('What should we call this persona?'), { target: { value: 'Typed name' } });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Import' }));
  await waitFor(() => expect(onImport).toHaveBeenCalled());
}

describe('Personas — offer to import the follows after an nsec import', () => {
  it('offers it for the new persona, runs the same flow on Import, and goes away on Not now', async () => {
    const onImportFollows = vi.fn(async () => ({
      status: 'done' as const, total: 4, createdAt: 1, added: 4, linked: 0, unchanged: 0, skippedRemoved: 0, covered: 4, trimmedNotice: null, unfollowed: [], unfollowedKept: 0,
    }));
    const followsHandlersFor = vi.fn(() => ({ onImportFollows, onUnlinkFollows: vi.fn() }));
    await importAccount({ followsHandlersFor });
    await screen.findByText('Import who this account follows?');
    expect(followsHandlersFor).toHaveBeenCalledWith(NEW_KEY, 'Typed name');
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByText(/Added 4/);
    expect(onImportFollows).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('Import who this account follows?')).toBeNull();
  });

  it('"Not now" dismisses it without importing', async () => {
    const onImportFollows = vi.fn();
    await importAccount({ followsHandlersFor: () => ({ onImportFollows, onUnlinkFollows: vi.fn() }) });
    await screen.findByText('Import who this account follows?');
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByText('Import who this account follows?')).toBeNull();
    expect(onImportFollows).not.toHaveBeenCalled();
  });

  it('makes no offer when the host withholds the handlers (dependant scope, paired-child install)', async () => {
    await importAccount({ followsHandlersFor: () => undefined });
    await new Promise(r => setTimeout(r, 50));
    expect(screen.queryByText('Import who this account follows?')).toBeNull();
  });

  it('makes no offer when the prop is absent', async () => {
    await importAccount({});
    await new Promise(r => setTimeout(r, 50));
    expect(screen.queryByText('Import who this account follows?')).toBeNull();
  });
});
