// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ShamirBackup } from './ShamirBackup';
import type { SignetIdentity } from '../types';
import type { PurposeContext } from '../lib/auth-purposes';

type FreshAuth = (ctx: PurposeContext) => Promise<string | null>;

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const identity = {
  id: 'a'.repeat(64),
  mnemonic: MNEMONIC,
  encrypted: false,
  primaryKeypair: 'persona',
  isChild: false,
  naturalPerson: { publicKey: '', privateKey: '', displayName: '' },
  persona: { publicKey: 'b'.repeat(64), privateKey: 'c'.repeat(64), displayName: 'Fox' },
  createdAt: 0,
  backedUp: true,
} as unknown as SignetIdentity;

afterEach(() => cleanup());

describe('ShamirBackup fresh-auth gate', () => {
  it('shows no shares when the fresh unlock is refused', async () => {
    const onRequestFreshAuth = vi.fn<FreshAuth>(async () => null);
    render(<ShamirBackup identity={identity} onRequestFreshAuth={onRequestFreshAuth} />);
    fireEvent.click(screen.getByText('Split my backup'));
    await waitFor(() => expect(onRequestFreshAuth).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Your 3 Shares')).toBeNull();
    expect(screen.queryByText('Share 1 of 3')).toBeNull();
    expect(screen.getByText('Split my backup')).toBeDefined();
  });

  it('treats an empty key as refused', async () => {
    const onRequestFreshAuth = vi.fn<FreshAuth>(async () => '');
    render(<ShamirBackup identity={identity} onRequestFreshAuth={onRequestFreshAuth} />);
    fireEvent.click(screen.getByText('Split my backup'));
    await waitFor(() => expect(onRequestFreshAuth).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Your 3 Shares')).toBeNull();
  });

  it('shows the shares after a fresh unlock, asking for the split purpose', async () => {
    const onRequestFreshAuth = vi.fn<FreshAuth>(async () => 'unlock-key');
    render(<ShamirBackup identity={identity} onRequestFreshAuth={onRequestFreshAuth} />);
    fireEvent.click(screen.getByText('Split my backup'));
    expect(await screen.findByText('Your 3 Shares')).toBeDefined();
    expect(onRequestFreshAuth).toHaveBeenCalledWith({ purpose: 'split-recovery-words' });
    expect(screen.getByText('Share 1 of 3')).toBeDefined();
  });

  it('asks again after Start over', async () => {
    const onRequestFreshAuth = vi.fn<FreshAuth>(async () => 'unlock-key');
    render(<ShamirBackup identity={identity} onRequestFreshAuth={onRequestFreshAuth} />);
    fireEvent.click(screen.getByText('Split my backup'));
    await screen.findByText('Your 3 Shares');
    fireEvent.click(screen.getByText('Start over'));
    fireEvent.click(screen.getByText('Split my backup'));
    await screen.findByText('Your 3 Shares');
    expect(onRequestFreshAuth).toHaveBeenCalledTimes(2);
  });

  it('splits the identity as it is after the unlock, not the locked record captured at the tap', async () => {
    // A locked record holds ciphertext where the mnemonic goes.
    const locked = { ...identity, mnemonic: 'ciphertext-not-a-mnemonic' } as SignetIdentity;
    let resolveAuth: (key: string | null) => void = () => {};
    const onRequestFreshAuth = vi.fn<FreshAuth>(() => new Promise(r => { resolveAuth = r; }));
    const view = render(<ShamirBackup identity={locked} onRequestFreshAuth={onRequestFreshAuth} />);
    fireEvent.click(screen.getByText('Split my backup'));
    await waitFor(() => expect(onRequestFreshAuth).toHaveBeenCalledTimes(1));
    resolveAuth('unlock-key');
    await waitFor(() => expect(screen.getByText('Split my backup')).toBeDefined());
    expect(screen.queryByText('Your 3 Shares')).toBeNull();
    // The unlock lands: the decrypted record arrives and the split runs once.
    view.rerender(<ShamirBackup identity={identity} onRequestFreshAuth={onRequestFreshAuth} />);
    expect(await screen.findByText('Your 3 Shares')).toBeDefined();
    expect(onRequestFreshAuth).toHaveBeenCalledTimes(1);
  });

  it('shows no shares when it has no way to ask for the unlock', async () => {
    const noAsk = undefined as unknown as FreshAuth;
    render(<ShamirBackup identity={identity} onRequestFreshAuth={noAsk} />);
    fireEvent.click(screen.getByText('Split my backup'));
    await new Promise(r => setTimeout(r, 20));
    expect(screen.queryByText('Your 3 Shares')).toBeNull();
  });
});
