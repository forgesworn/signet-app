// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { SettingsCard } from './SettingsCard';
import type { CarouselRow } from '../types';
import { resolveActiveIdentity } from '../lib/carousel-utils';
import { CHILD_SIDE_COPY } from '../lib/child-device-copy';

/**
 * A child's own phone (`isPairedChild`): its personas are plain `persona` rows,
 * not dependant rows. The guardian names them and publishes their profiles.
 */
const identity = {
  id: 'me', primaryKeypair: 'persona', mnemonic: '', isChild: false, createdAt: 0,
  naturalPerson: { publicKey: '', privateKey: '', displayName: '' },
  persona: {
    publicKey: '1'.repeat(64), privateKey: '', displayName: 'Sky',
    publicProfile: { enabled: true, lastPublishedAt: 1_700_000_000 },
  },
};
const row = { type: 'persona', identity } as unknown as CarouselRow;

function renderCard(isPairedChild: boolean) {
  const handlers = {
    onSavePersonaConfig: vi.fn(), onRepublishProfile: vi.fn(), onUploadPersonaPicture: vi.fn(),
    onUpdateOwnPersonaName: vi.fn(), onSetPersonaAvatar: vi.fn(), onClearPersonaAvatar: vi.fn(), onNip05Checked: vi.fn(),
  };
  const props = { resolved: resolveActiveIdentity(row), row, childMode: false, isPairedChild, onNavigateDeepPage: vi.fn(), dependantsCount: 0, ...handlers } as unknown as ComponentProps<typeof SettingsCard>;
  return { handlers, ...render(<SettingsCard {...props} />) };
}

afterEach(cleanup);

describe('SettingsCard on a child\'s own phone', () => {
  it('shows the persona name plain with the guardian-manages line, and no editor', () => {
    renderCard(true);
    expect(screen.getByText('Sky', { selector: '.slot-name-value' })).toBeTruthy();
    expect(screen.getByText(CHILD_SIDE_COPY.namesGuardianManaged)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('shows the public profile fields read only, with the guardian-only line and no save', () => {
    const { container } = renderCard(true);
    expect(screen.getByRole('note').textContent).toBe(CHILD_SIDE_COPY.publicProfileGuardianOnly);
    expect(screen.queryByRole('button', { name: /^save/i })).toBeNull();
    const fields = Array.from(container.querySelectorAll('input:not([type="file"]), textarea')) as HTMLInputElement[];
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) expect(field.disabled || field.readOnly, field.outerHTML).toBe(true);
  });

  it('is unchanged for the guardian: editable name and public fields', () => {
    const { container } = renderCard(false);
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(screen.queryByText(CHILD_SIDE_COPY.namesGuardianManaged)).toBeNull();
    expect(screen.queryByText(CHILD_SIDE_COPY.publicProfileGuardianOnly)).toBeNull();
    expect(container.querySelectorAll('input:not([disabled]), textarea:not([disabled])').length).toBeGreaterThan(0);
  });
});
