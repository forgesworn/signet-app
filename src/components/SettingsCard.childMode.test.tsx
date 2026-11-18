// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { SettingsCard, CHILD_MODE_PROFILE_NOTE } from './SettingsCard';
import type { CarouselRow } from '../types';
import { resolveActiveIdentity } from '../lib/carousel-utils';

/**
 * Child mode is the dependant holding the guardian's phone. The settings column
 * is read only there: no rename, no avatar, no public-profile save or publish,
 * no picture upload, no NIP-05 check.
 */
const dependant = {
  id: 'dep-1', guardianPubkey: '0'.repeat(64), displayName: 'Lily',
  naturalPerson: { publicKey: '0'.repeat(64), privateKey: '', displayName: 'Lily' },
  persona: { publicKey: '1'.repeat(64), privateKey: '', displayName: 'Lilypad' },
  extraPersonas: [{ publicKey: '2'.repeat(64), privateKey: '', displayName: 'Gamer', derivationName: 'persona-2' }],
  derivationPath: 'dependant-0', createdAt: 0, autonomyStage: 'full-control', primaryKeypair: 'natural-person',
};
const rows = {
  dependant: { type: 'dependant', dependant },
  persona: { type: 'dependant-persona', dependant },
  extra: { type: 'dependant-extra-persona', dependant, personaIndex: 0 },
} as unknown as Record<string, CarouselRow>;

function renderCard(kind: keyof typeof rows, childMode: boolean) {
  const handlers = {
    onSaveDepPersonaConfig: vi.fn(), onRepublishDepProfile: vi.fn(), onUploadDepPersonaPicture: vi.fn(),
    onUpdateDepName: vi.fn(), onUpdateDepPersonaName: vi.fn(), onSetDepPersonaAvatar: vi.fn(),
    onClearDepPersonaAvatar: vi.fn(), onDepNip05Checked: vi.fn(),
  };
  const row = rows[kind];
  const props = { resolved: resolveActiveIdentity(row), row, childMode, isPairedChild: false, onNavigateDeepPage: vi.fn(), dependantsCount: 1, ...handlers } as unknown as ComponentProps<typeof SettingsCard>;
  return { handlers, ...render(<SettingsCard {...props} />) };
}

afterEach(cleanup);

describe.each(['dependant', 'persona', 'extra'] as const)('SettingsCard on the child\'s %s row in child mode', kind => {
  it('offers no name editor, avatar control or profile save', () => {
    const { container } = renderCard(kind, true);
    expect(screen.queryByRole('button', { name: /^(save|publish|set photo|change photo|remove photo|check)/i })).toBeNull();
    expect(screen.queryByText(/^(Name|Default persona name|Persona name)$/)).toBeNull();
    for (const input of Array.from(container.querySelectorAll('input, textarea'))) {
      expect((input as HTMLInputElement).disabled || (input as HTMLInputElement).readOnly, input.outerHTML).toBe(true);
    }
  });

  it('says the guardian changes it, not that it is the child\'s device', () => {
    renderCard(kind, true);
    expect(screen.getByRole('note').textContent).toBe(CHILD_MODE_PROFILE_NOTE);
  });
});

describe('SettingsCard on a guardian viewing the dependant (not child mode)', () => {
  it('still offers the editors', () => {
    const { container } = renderCard('persona', false);
    expect(container.querySelectorAll('input:not([disabled]), textarea:not([disabled])').length).toBeGreaterThan(0);
  });
});
