// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { nip19 } from 'nostr-tools';
import { generateSecretKey } from 'nostr-tools/pure';
import type { SignetIdentity } from '../types';
import type { ExistingProfile } from '../lib/existing-profile';
import { Personas } from './Personas';

const identity: SignetIdentity = {
  id: 'a'.repeat(64), primaryKeypair: 'persona', mnemonic: '', isChild: false, createdAt: 0,
  naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: '' },
  persona: { publicKey: 'b'.repeat(64), privateKey: '', displayName: 'Alex' },
};
const nsec = nip19.nsecEncode(generateSecretKey());

const found = {
  event: { id: 'e'.repeat(64), created_at: 123, content: '{"name":"Bob"}', tags: [], pubkey: 'f'.repeat(64), kind: 0, sig: 's' },
  profile: { displayName: 'Bob', about: 'Hello from Amethyst' },
  base: undefined,
  relay: 'wss://relay.example',
} as unknown as ExistingProfile;

async function openAndFill(props: { lookup: () => Promise<ExistingProfile | null | 'unreachable'>; onImport: ReturnType<typeof vi.fn> }) {
  render(<Personas identity={identity} onAddPersona={vi.fn()} onSwitchPrimary={vi.fn()} onImportNostrAccount={props.onImport as never} onLookupExistingProfile={props.lookup} />);
  fireEvent.click(screen.getByRole('button', { name: 'Import an existing Nostr account' }));
  fireEvent.change(screen.getByPlaceholderText('nsec1...'), { target: { value: nsec } });
  fireEvent.change(screen.getByPlaceholderText('What should we call this persona?'), { target: { value: 'Typed name' } });
  fireEvent.click(screen.getByRole('checkbox'));
}

describe('Personas — import an existing Nostr account: match an existing profile', () => {
  it('stops at the match panel when the key is already public, prefills the name, then imports with the match', async () => {
    const onImport = vi.fn(async () => ({ added: true as const, pubkey: 'c'.repeat(64) }));
    await openAndFill({ lookup: async () => found, onImport });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByText('This account is already public on Nostr as Bob.');
    expect(onImport).not.toHaveBeenCalled(); // matching never imports behind the user's back
    expect((screen.getByPlaceholderText('What should we call this persona?') as HTMLInputElement).value).toBe('Bob');
    expect((screen.getByRole('radio', { name: /Match it in Signet/ }) as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    expect(onImport).toHaveBeenCalledWith(nsec, 'Bob', found);
  });

  it('"Keep it private in Signet" imports without the match', async () => {
    const onImport = vi.fn(async () => ({ added: true as const, pubkey: 'c'.repeat(64) }));
    await openAndFill({ lookup: async () => found, onImport });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByText('This account is already public on Nostr as Bob.');
    fireEvent.click(screen.getByRole('radio', { name: /Keep it private in Signet/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(onImport).toHaveBeenCalledWith(nsec, 'Bob', undefined));
  });

  it('imports straight through (no match) when nothing is found', async () => {
    const onImport = vi.fn(async () => ({ added: true as const, pubkey: 'c'.repeat(64) }));
    await openAndFill({ lookup: async () => null, onImport });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(onImport).toHaveBeenCalledWith(nsec, 'Typed name', undefined));
  });

  it('imports and leaves a quiet note when no relay could be reached', async () => {
    const onImport = vi.fn(async () => ({ added: true as const, pubkey: 'c'.repeat(64) }));
    await openAndFill({ lookup: async () => 'unreachable', onImport });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(onImport).toHaveBeenCalledWith(nsec, 'Typed name', undefined));
    expect(await screen.findByText(/Couldn.t reach Nostr relays to look for an existing profile/)).toBeDefined();
  });
});
