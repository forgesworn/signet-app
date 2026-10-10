// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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

async function openAndFill(props: { lookup: () => Promise<ExistingProfile | null | 'unreachable'>; onImport: ReturnType<typeof vi.fn>; onOpenPersona?: (target: string) => void }) {
  render(<Personas identity={identity} onAddPersona={vi.fn()} onSwitchPrimary={vi.fn()} onImportNostrAccount={props.onImport as never} onLookupExistingProfile={props.lookup} onOpenPersona={props.onOpenPersona} />);
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
    expect((screen.getByRole('radio', { name: /Match it in My Signet/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('status').textContent).toContain('Your account has not been imported yet');

    fireEvent.click(screen.getByRole('button', { name: 'Confirm import' }));
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    expect(onImport).toHaveBeenCalledWith(nsec, 'Bob', found);
  });

  it('"Keep it private in My Signet" imports without the match', async () => {
    const onImport = vi.fn(async () => ({ added: true as const, pubkey: 'c'.repeat(64) }));
    await openAndFill({ lookup: async () => found, onImport });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByText('This account is already public on Nostr as Bob.');
    fireEvent.click(screen.getByRole('radio', { name: /Keep it private in My Signet/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm import' }));
    await waitFor(() => expect(onImport).toHaveBeenCalledWith(nsec, 'Bob', undefined));
  });

  it('cancels the profile review without saving, and starts a fresh lookup when reopened', async () => {
    const onImport = vi.fn(async () => ({ added: true as const, pubkey: 'c'.repeat(64) }));
    const lookup = vi.fn(async () => found);
    await openAndFill({ lookup, onImport });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByRole('button', { name: 'Confirm import' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onImport).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Import an existing Nostr account' }));
    expect((screen.getByPlaceholderText('nsec1...') as HTMLTextAreaElement).value).toBe('');
    fireEvent.change(screen.getByPlaceholderText('nsec1...'), { target: { value: nsec } });
    fireEvent.change(screen.getByPlaceholderText('What should we call this persona?'), { target: { value: 'Typed name' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByRole('button', { name: 'Confirm import' });
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(onImport).not.toHaveBeenCalled();
  });

  it('confirms a saved import and opens the imported identity only when asked', async () => {
    const onImport = vi.fn(async () => ({ added: true as const, pubkey: 'c'.repeat(64) }));
    const onOpenPersona = vi.fn();
    await openAndFill({ lookup: async () => found, onImport, onOpenPersona });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm import' }));
    const success = await screen.findByText(/Imported Bob\. Your account is saved on this device\./);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onOpenPersona).not.toHaveBeenCalled();
    fireEvent.click(within(success).getByRole('button', { name: 'Open imported identity' }));
    expect(onOpenPersona).toHaveBeenCalledWith('c'.repeat(64));
  });

  it('shows a failed save in the dialog without claiming success', async () => {
    const onImport = vi.fn(async () => { throw new Error('Could not save identity'); });
    await openAndFill({ lookup: async () => found, onImport });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm import' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Could not save identity');
    expect(screen.getByRole('dialog')).toBeDefined();
    expect(screen.queryByText(/Your account is saved/)).toBeNull();
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
