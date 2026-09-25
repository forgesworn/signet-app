// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// The whole auth module is stubbed: this file is about which screen SetupAuth
// opens on, not about WebAuthn/Keystore behaviour.
vi.mock('../lib/auth', () => ({
  isBiometricAvailable: vi.fn().mockResolvedValue(false),
  setupBiometric: vi.fn(),
  setupPIN: vi.fn(),
  endGraceWithPin: vi.fn(),
  endGraceWithBiometric: vi.fn(),
}));

import { SetupAuth } from './SetupAuth';

describe('SetupAuth', () => {
  it('opens on the intro for ordinary first-run setup', () => {
    render(<SetupAuth encryptionKey={'a'.repeat(64)} onComplete={() => {}} />);
    expect(screen.getByText('Protect your Signet')).toBeDefined();
  });

  it('skips the intro in legacy-guest mode — the notice already made the pitch', () => {
    render(<SetupAuth encryptionKey={'a'.repeat(64)} mode="legacy-guest" onComplete={() => {}} />);
    expect(screen.getByText('How do you want to unlock?')).toBeDefined();
  });
});
