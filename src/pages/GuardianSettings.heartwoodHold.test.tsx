// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { DependantIdentity } from '../types';
import { GuardianSettings } from './GuardianSettings';
import { HEARTWOOD_HOLD_TO_FINISH } from '../lib/local-key-only-copy';

const dep = {
  id: 'c'.repeat(64), guardianPubkey: '1'.repeat(64), displayName: 'Sam',
  naturalPerson: { publicKey: 'c'.repeat(64), privateKey: '', displayName: 'Sam' },
  persona: { publicKey: 'd'.repeat(64), privateKey: '', displayName: 'Sam' },
  derivationPath: 'dependant-0', createdAt: 1, autonomyStage: 'request-approve', primaryKeypair: 'persona',
} as DependantIdentity;

afterEach(() => cleanup());

async function addPersona(addPersonaHeartwoodHold: boolean) {
  let finish!: () => void;
  render(
    <GuardianSettings activeDependant={dep} onSwitchDependantPrimary={() => {}} requestAuth={async () => null} ownerTier="standard"
      onUpdatePhoto={() => {}} currentContactPolicy="kin-only" onUpdateContactPolicy={() => {}} currentDefaultChildCeiling="ken"
      onUpdateDefaultChildCeiling={() => {}} viewer="guardian" guardianHasMnemonic
      onAddDependantPersona={() => new Promise<void>(r => { finish = r; })} addPersonaHeartwoodHold={addPersonaHeartwoodHold} />,
  );
  fireEvent.click(screen.getByRole('button', { name: '+ Add persona' }));
  fireEvent.change(screen.getByPlaceholderText('Persona name'), { target: { value: 'Gamer' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  return () => act(async () => { finish(); });
}

describe('GuardianSettings — Heartwood hold hint on Add persona', () => {
  it('shows under "Adding..." while the Heartwood derives the persona', async () => {
    const done = await addPersona(true);
    expect(screen.getByRole('button', { name: 'Adding...' })).toBeInTheDocument();
    expect(screen.getByText(HEARTWOOD_HOLD_TO_FINISH)).toBeInTheDocument();
    await done();
    expect(screen.queryByText(HEARTWOOD_HOLD_TO_FINISH)).toBeNull();
  });

  it('is not shown when the keys are local', async () => {
    const done = await addPersona(false);
    expect(screen.getByRole('button', { name: 'Adding...' })).toBeInTheDocument();
    expect(screen.queryByText(HEARTWOOD_HOLD_TO_FINISH)).toBeNull();
    await done();
  });
});
