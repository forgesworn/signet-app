// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PersonaAdvanced } from './PersonaAdvanced';
import type { DependantIdentity, SignetIdentity } from '../types';

const identity: SignetIdentity = {
  id: 'a'.repeat(64), primaryKeypair: 'natural-person', mnemonic: '', isChild: false, createdAt: 0,
  naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: 'Alex' },
  persona: { publicKey: 'b'.repeat(64), privateKey: '', displayName: 'Alex' },
};

function dep(): DependantIdentity {
  return {
    id: 'c'.repeat(64), guardianPubkey: '1'.repeat(64), displayName: 'Sam',
    naturalPerson: { publicKey: 'c'.repeat(64), privateKey: '', displayName: 'Sam' },
    persona: { publicKey: 'd'.repeat(64), privateKey: '', displayName: 'Sam' },
    derivationPath: 'dependant-0', createdAt: 1, autonomyStage: 'full-control',
    // primaryKeypair 'persona' -> resolveDependantCardSlot resolves to the
    // persona slot, so `slotTarget="persona"` below is the dep's ACTING
    // slot and DepSettingsBlock (dep-level settings) renders on this page.
    primaryKeypair: 'persona',
  } as DependantIdentity;
}

function renderPage(overrides: Record<string, unknown> = {}) {
  const onRemoveDependant = vi.fn(async () => {});
  render(
    <PersonaAdvanced
      slotTarget="persona"
      depPubkey={dep().id}
      identity={identity}
      dependants={[dep()]}
      onPublishProfile={vi.fn(async () => ({ ok: true }))}
      onDisablePublicProfile={vi.fn(async () => {})}
      onRemoveDependant={onRemoveDependant}
      contactsLoading={false}
      onBack={() => {}}
      {...overrides}
    />,
  );
  return { onRemoveDependant };
}

describe('PersonaAdvanced remove-dependant (T2)', () => {
  it('disables Remove until a contacts choice is made', () => {
    renderPage();
    expect(screen.getByRole('button', { name: 'Remove Sam' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete contacts' }));
    expect(screen.getByRole('button', { name: 'Remove Sam' })).not.toBeDisabled();
  });

  it('keeps Remove disabled while the family contacts log is still loading, even with a choice made', () => {
    renderPage({ contactsLoading: true });
    fireEvent.click(screen.getByRole('button', { name: 'Delete contacts' }));
    expect(screen.getByRole('button', { name: 'Remove Sam' })).toBeDisabled();
  });

  it('re-enables Remove once loading finishes, given a choice was already made', () => {
    const { rerender } = render(
      <PersonaAdvanced
        slotTarget="persona"
        depPubkey={dep().id}
        identity={identity}
        dependants={[dep()]}
        onPublishProfile={vi.fn(async () => ({ ok: true }))}
        onDisablePublicProfile={vi.fn(async () => {})}
        onRemoveDependant={vi.fn(async () => {})}
        contactsLoading
        onBack={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Archive contacts' }));
    expect(screen.getByRole('button', { name: 'Remove Sam' })).toBeDisabled();

    rerender(
      <PersonaAdvanced
        slotTarget="persona"
        depPubkey={dep().id}
        identity={identity}
        dependants={[dep()]}
        onPublishProfile={vi.fn(async () => ({ ok: true }))}
        onDisablePublicProfile={vi.fn(async () => {})}
        onRemoveDependant={vi.fn(async () => {})}
        contactsLoading={false}
        onBack={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Remove Sam' })).not.toBeDisabled();
  });
});

describe('PersonaAdvanced stop sharing picture', () => {
  const withKey = () => ({ ...dep(), persona: { ...dep().persona, contactAvatarKey: 'k'.repeat(64) } });
  it('is hidden without a contact key, and without the handler', () => {
    renderPage({ onStopContactAvatarShare: vi.fn(async () => {}) });
    expect(screen.queryByRole('button', { name: 'Stop sharing my picture with contacts' })).toBeNull();
    renderPage({ dependants: [withKey()] });
    expect(screen.queryByRole('button', { name: 'Stop sharing my picture with contacts' })).toBeNull();
  });
  it('calls the handler for a dependant slot, with a busy state', async () => {
    let finish!: () => void;
    const stop = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    renderPage({ dependants: [withKey()], onStopContactAvatarShare: stop });
    fireEvent.click(screen.getByRole('button', { name: 'Stop sharing my picture with contacts' }));
    expect(stop).toHaveBeenCalledWith('persona', dep().id);
    expect(screen.getByRole('button', { name: 'Stopping…' })).toBeDisabled();
    finish();
    await screen.findByRole('button', { name: 'Stop sharing my picture with contacts' });
  });
  it('shows an inline error when stopping fails, and for an owner slot', async () => {
    const ownerWithKey = { ...identity, persona: { ...identity.persona, contactAvatarKey: 'k'.repeat(64) } };
    const stop = vi.fn(async () => { throw new Error('x'); });
    render(<PersonaAdvanced slotTarget="persona" identity={ownerWithKey} dependants={[]}
      onPublishProfile={vi.fn(async () => ({ ok: true }))} onDisablePublicProfile={vi.fn(async () => {})}
      onStopContactAvatarShare={stop} onBack={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop sharing my picture with contacts' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Could not stop sharing. Try again.');
    expect(stop).toHaveBeenCalledWith('persona', undefined);
  });
});
