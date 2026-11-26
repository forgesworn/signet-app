// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import type { CarouselRow } from '../types';
import { resolveActiveIdentity } from '../lib/carousel-utils';

// The row is mocked so the test can read exactly which pubkey it was handed.
vi.mock('./CardBackdropRow', () => ({
  CardBackdropRow: ({ pubkey }: { pubkey: string }) => <div data-testid="backdrop-row" data-pubkey={pubkey} />,
}));

import { SettingsCard } from './SettingsCard';

const NP = '0'.repeat(64);
const PERSONA = '1'.repeat(64);
const EXTRA = '2'.repeat(64);

const dependant = (primaryKeypair: string) => ({
  id: 'dep-1', guardianPubkey: '9'.repeat(64), displayName: 'Lily',
  naturalPerson: { publicKey: NP, privateKey: '', displayName: 'Lily' },
  persona: { publicKey: PERSONA, privateKey: '', displayName: 'Lilypad' },
  extraPersonas: [{ publicKey: EXTRA, privateKey: '', displayName: 'Gamer', derivationName: 'persona-2' }],
  derivationPath: 'dependant-0', createdAt: 0, autonomyStage: 'full-control', primaryKeypair,
  naturalPersonActive: true,
});

const identity = {
  id: 'me', primaryKeypair: 'persona', mnemonic: '', isChild: false, createdAt: 0, naturalPersonActive: true,
  naturalPerson: { publicKey: NP, privateKey: '', displayName: 'Alex' },
  persona: { publicKey: PERSONA, privateKey: '', displayName: 'Sky' },
  extraPersonas: [{ publicKey: EXTRA, privateKey: '', displayName: 'Gamer', derivationName: 'persona-2' }],
};

const rowsByName: Record<string, CarouselRow> = {
  'dependant (acting NP)': { type: 'dependant', dependant: dependant('natural-person') },
  'dependant (acting persona)': { type: 'dependant', dependant: dependant('persona') },
  'dependant (acting extra)': { type: 'dependant', dependant: dependant(EXTRA) },
  'dependant-persona': { type: 'dependant-persona', dependant: dependant('persona') },
  'dependant-extra-persona': { type: 'dependant-extra-persona', dependant: dependant('persona'), personaIndex: 0 },
  persona: { type: 'persona', identity },
  'extra-persona': { type: 'extra-persona', identity, personaIndex: 0 },
  'natural-person': { type: 'natural-person', identity },
} as unknown as Record<string, CarouselRow>;

function renderCard(row: CarouselRow, extra: { childMode: boolean; isPairedChild?: boolean; childSignerKind?: ComponentProps<typeof SettingsCard>['childSignerKind'] }) {
  const props = {
    resolved: resolveActiveIdentity(row), row, childMode: extra.childMode, isPairedChild: extra.isPairedChild ?? false, childSignerKind: extra.childSignerKind,
    onNavigateDeepPage: vi.fn(), dependantsCount: 1,
  } as unknown as ComponentProps<typeof SettingsCard>;
  return render(<SettingsCard {...props} />);
}

afterEach(cleanup);

describe('Card backdrop row in the settings column', () => {
  describe.each(Object.keys(rowsByName))('%s', name => {
    const row = rowsByName[name];
    const dependantRow = name.startsWith('dependant');

    // On the guardian's phone, a dependant is one card (`dependant`); its persona rows only exist in child mode.
    const guardianPhone = name.startsWith('dependant-') ? false : true;
    if (guardianPhone) {
      it('offers the row on the guardian\'s phone, writing the key the card paints', () => {
        renderCard(row, { childMode: false });
        expect(screen.getByTestId('backdrop-row').getAttribute('data-pubkey')).toBe(resolveActiveIdentity(row).publicKey);
      });
    }

    if (dependantRow) {
      it('offers the row in child mode, writing the key the card paints', () => {
        renderCard(row, { childMode: true });
        expect(screen.getByTestId('backdrop-row').getAttribute('data-pubkey')).toBe(resolveActiveIdentity(row).publicKey);
      });
    } else {
      it('offers the row on a child\'s own phone, writing the key the card paints', () => {
        renderCard(row, { childMode: false, isPairedChild: true });
        expect(screen.getByTestId('backdrop-row').getAttribute('data-pubkey')).toBe(resolveActiveIdentity(row).publicKey);
      });
    }
  });

  it('is withheld when the slot has no key yet', () => {
    const bare = { ...dependant('persona'), persona: { publicKey: '', privateKey: '', displayName: '' }, naturalPerson: { publicKey: '', privateKey: '', displayName: 'Lily' } };
    renderCard({ type: 'dependant', dependant: bare } as unknown as CarouselRow, { childMode: false });
    expect(screen.queryByTestId('backdrop-row')).toBeNull();
  });
});

describe('Card backdrop row on a child\'s phone that has been unpaired', () => {
  it.each(Object.keys(rowsByName).filter(n => !n.startsWith('dependant')))('%s hides the row, as the identity card does', name => {
    renderCard(rowsByName[name], { childMode: false, isPairedChild: true, childSignerKind: 'unpaired' });
    expect(screen.queryByTestId('backdrop-row')).toBeNull();
  });

  it('keeps the row while the child is still paired', () => {
    renderCard(rowsByName.persona, { childMode: false, isPairedChild: true, childSignerKind: 'heartwood' });
    expect(screen.getByTestId('backdrop-row')).toBeTruthy();
  });
});
