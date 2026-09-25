// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { SignetIdentity } from '../types';
import { Personas } from './Personas';

const identity: SignetIdentity = {
  id: 'a'.repeat(64), primaryKeypair: 'natural-person', mnemonic: '', isChild: false, createdAt: 0,
  naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: 'Alex' },
  persona: { publicKey: 'b'.repeat(64), privateKey: '', displayName: 'Alex' },
  extraPersonas: [
    { publicKey: 'c'.repeat(64), privateKey: '', displayName: 'Imported', derivationName: '', imported: true },
    { publicKey: 'd'.repeat(64), privateKey: '', displayName: 'Hidden', derivationName: 'persona-2', hidden: true },
  ],
  professionalPersona: { publicKey: 'e'.repeat(64), privateKey: '', displayName: 'Professional Alex' },
};

describe('Personas identity management', () => {
  it('distinguishes duplicate names by npub and opens the intended imported identity', () => {
    const onOpenPersona = vi.fn();
    const onManagePersona = vi.fn();
    render(<Personas identity={identity} onAddPersona={vi.fn()} onSwitchPrimary={vi.fn()} onOpenPersona={onOpenPersona} onManagePersona={onManagePersona} />);
    expect(screen.getAllByRole('button', { name: 'Copy npub' })).toHaveLength(5);
    const open = screen.getAllByRole('button', { name: 'Open identity' });
    // Hidden and professional identities are managed without falling back to the real-name card.
    expect(open).toHaveLength(3);
    fireEvent.click(open[2]);
    expect(onOpenPersona).toHaveBeenCalledWith('c'.repeat(64));
    fireEvent.click(screen.getAllByRole('button', { name: 'Manage identity' })[3]);
    expect(onManagePersona).toHaveBeenCalledWith('d'.repeat(64));
    expect(screen.getByText('Hidden from your cards and sign-in choices.')).toBeDefined();
  });

  it('lets paired children copy addresses without exposing owner management actions', () => {
    render(<Personas identity={identity} pairedChildView onAddPersona={vi.fn()} onSwitchPrimary={vi.fn()} onOpenPersona={vi.fn()} onManagePersona={vi.fn()} />);
    expect(screen.getAllByRole('button', { name: 'Copy npub' })).toHaveLength(5);
    expect(screen.queryByRole('button', { name: 'Open identity' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Manage identity' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Import an existing Nostr account' })).toBeNull();
  });
});
