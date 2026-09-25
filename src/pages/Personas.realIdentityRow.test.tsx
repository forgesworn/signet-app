// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Personas } from './Personas';
import type { SignetIdentity } from '../types';

/**
 * The Settings → Personas "Real identity" row is the one surface that can start
 * activation — the act that writes a legal name onto a record. A paired-child
 * install runs this page over the kid's own identity, whose natural-person slot
 * is typically unnamed and therefore reads as `dormant`; App withholds both
 * real-identity props there, and this file pins the resulting row as inert.
 */

function identityWith(o: Partial<SignetIdentity>): SignetIdentity {
  return {
    id: 'a'.repeat(64),
    mnemonic: '',
    naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: '' },
    persona: { publicKey: 'b'.repeat(64), privateKey: '', displayName: 'Persona' },
    primaryKeypair: 'persona',
    isChild: false,
    createdAt: 0,
    ...o,
  } as SignetIdentity;
}

function renderPersonas(identity: SignetIdentity, props: Partial<React.ComponentProps<typeof Personas>> = {}) {
  render(
    <Personas
      identity={identity}
      onSwitchPrimary={vi.fn()}
      onAddPersona={vi.fn()}
      {...props}
    />,
  );
}

describe('Personas — real-identity row', () => {
  it('renders nothing actionable when both real-identity props are withheld (paired-child)', () => {
    renderPersonas(identityWith({ naturalPersonActive: false }), { pairedChildView: true });

    const row = screen.getByText(/Real identity — Not set up/).closest('button');
    expect(row).not.toBeNull();
    expect(row).toBeDisabled();
  });

  it('renders nothing actionable for an activated slot when the Advanced prop is withheld', () => {
    renderPersonas(
      identityWith({
        naturalPersonActive: true,
        naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: 'Real Name' },
      }),
      { pairedChildView: true },
    );

    const row = screen.getByText(/Real identity — Real Name/).closest('button');
    expect(row).not.toBeNull();
    expect(row).toBeDisabled();
  });

  it('arms the dormant row when the owner surface supplies the activation handler', () => {
    const onActivateRealIdentity = vi.fn();
    renderPersonas(identityWith({ naturalPersonActive: false }), { onActivateRealIdentity });

    const row = screen.getByText(/Real identity — Not set up/).closest('button');
    expect(row).toBeEnabled();
    row?.click();
    expect(onActivateRealIdentity).toHaveBeenCalledTimes(1);
  });

  it('offers no activation at all when the identity has no real-name key', () => {
    renderPersonas(
      identityWith({ naturalPerson: { publicKey: '', privateKey: '', displayName: '' } }),
      { onActivateRealIdentity: vi.fn() },
    );

    expect(screen.getByText(/Real identity — needs recovery words/)).toBeTruthy();
    expect(screen.queryByText(/Not set up/)).toBeNull();
  });
});
