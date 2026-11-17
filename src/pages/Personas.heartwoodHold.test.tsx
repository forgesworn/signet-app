// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { SignetIdentity } from '../types';
import { Personas } from './Personas';
import { HEARTWOOD_HOLD_TO_FINISH } from '../lib/local-key-only-copy';

const identity = {
  id: 'a'.repeat(64), primaryKeypair: 'persona', mnemonic: '', isChild: false, createdAt: 0,
  naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: '' },
  persona: { publicKey: 'b'.repeat(64), privateKey: '', displayName: 'Alex' },
} as SignetIdentity;

afterEach(() => cleanup());

async function addPersona(addPersonaHeartwoodHold: boolean) {
  let finish!: () => void;
  render(<Personas identity={identity} onSwitchPrimary={vi.fn()} addPersonaHeartwoodHold={addPersonaHeartwoodHold}
    onAddPersona={() => new Promise<void>(r => { finish = r; })} />);
  fireEvent.click(screen.getByRole('button', { name: '+ Add persona' }));
  expect(screen.queryByText(HEARTWOOD_HOLD_TO_FINISH)).toBeNull();
  fireEvent.change(screen.getByPlaceholderText('Persona name'), { target: { value: 'Gamer' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  return () => act(async () => { finish(); });
}

describe('Personas (Settings) — Heartwood hold hint on Add persona', () => {
  it('shows under "Adding…" while the Heartwood derives the persona, and goes when it is done', async () => {
    const done = await addPersona(true);
    expect(screen.getByRole('button', { name: 'Adding…' })).toBeInTheDocument();
    expect(screen.getByText(HEARTWOOD_HOLD_TO_FINISH)).toBeInTheDocument();
    await done();
    expect(screen.queryByText(HEARTWOOD_HOLD_TO_FINISH)).toBeNull();
  });

  it('is not shown when the keys are local', async () => {
    const done = await addPersona(false);
    expect(screen.getByRole('button', { name: 'Adding…' })).toBeInTheDocument();
    expect(screen.queryByText(HEARTWOOD_HOLD_TO_FINISH)).toBeNull();
    await done();
  });
});
