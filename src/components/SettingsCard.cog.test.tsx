// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { SettingsCard } from './SettingsCard';
import type { CarouselRow } from '../types';

/**
 * The Advanced cog on a dependant's card opens persona-advanced, which holds
 * the guardian's controls for the dependant (autonomy, rules, unpair, Remove).
 * In child mode the phone is the dependant's hands, so it must not be offered.
 */
const dependantRow = {
  type: 'dependant',
  dependant: {
    id: 'dep-1',
    guardianPubkey: '0'.repeat(64),
    displayName: 'Lily',
    naturalPerson: { publicKey: '0'.repeat(64), privateKey: '', displayName: 'Lily' },
    persona: { publicKey: '1'.repeat(64), privateKey: '', displayName: 'Lily' },
    derivationPath: 'dependant-0',
    createdAt: 0,
    autonomyStage: 'full-control',
    primaryKeypair: 'natural-person',
  },
} as unknown as CarouselRow;

const resolved = {
  displayName: 'Lily', displayNameIsSet: true, publicKey: '0'.repeat(64), type: 'Dependant', isDependant: true, dependantId: 'dep-1',
} as never;

function renderCard(extra: { childMode: boolean; isPairedChild?: boolean; row?: CarouselRow }) {
  return render(
    <SettingsCard
      {...({
        resolved,
        row: extra.row ?? dependantRow,
        childMode: extra.childMode,
        isPairedChild: extra.isPairedChild ?? false,
        onNavigateDeepPage: vi.fn(),
        dependantsCount: 1,
      } as never)}
    />,
  );
}

afterEach(cleanup);

describe('SettingsCard Advanced cog on a dependant row', () => {
  it('is hidden in child mode', () => {
    const { container } = renderCard({ childMode: true });
    expect(container.querySelector('.gear-fab')).toBeNull();
  });

  it('is still shown to the guardian outside child mode', () => {
    const { container } = renderCard({ childMode: false });
    expect(container.querySelector('.gear-fab')).not.toBeNull();
  });

  it('stays hidden on the paired-child surface', () => {
    const { container } = renderCard({ childMode: false, isPairedChild: true });
    expect(container.querySelector('.gear-fab')).toBeNull();
  });
});
