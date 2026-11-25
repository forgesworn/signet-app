// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Profile } from './Profile';
import { CHILD_SIDE_COPY } from '../lib/child-device-copy';

const identity = {
  id: 'a'.repeat(64), primaryKeypair: 'natural-person' as const, mnemonic: '', isChild: false, createdAt: 0,
  naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: 'Sam' },
  persona: { publicKey: 'c'.repeat(64), privateKey: '', displayName: 'Sky' },
} as any;

afterEach(() => cleanup());

function renderProfile(nameManagedNote?: string) {
  render(
    <Profile identity={identity} onUpdateName={vi.fn()} onUpdatePhoto={vi.fn()} ownBadge={null} knownPlaceCount={0}
      onNavigateKnownPlaces={vi.fn()} onNavigateBadgeEmbed={vi.fn()} onGoToProfessional={vi.fn()} nameManagedNote={nameManagedNote} />,
  );
}

describe('Profile name row', () => {
  it('is read-only with the guardian note when nameManagedNote is set (a child\'s phone)', () => {
    renderProfile(CHILD_SIDE_COPY.namesGuardianManaged);
    expect(screen.getByRole('note').textContent).toBe(CHILD_SIDE_COPY.namesGuardianManaged);
    expect(screen.queryByRole('button', { name: /Sam/ })).toBeNull();
    expect(screen.getByText('Sam')).toBeTruthy();
  });

  it('is an edit button with no note otherwise', () => {
    renderProfile();
    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.getByRole('button', { name: /Sam/ })).toBeTruthy();
  });
});
