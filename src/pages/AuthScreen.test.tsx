// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  authenticateBiometric: vi.fn(async (): Promise<string | null> => null),
  authenticatePIN: vi.fn(async (): Promise<string | null> => null),
  getAuthMethod: vi.fn(() => 'biometric' as const),
  hasPinFallback: vi.fn(() => true),
}));
vi.mock('../lib/auth', () => mocks);

import { AuthScreen } from './AuthScreen';

describe('AuthScreen, biometric', () => {
  beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });

  it('a failed prompt offers to try again, and trying again unlocks', async () => {
    const onUnlock = vi.fn();
    render(<AuthScreen onUnlock={onUnlock} />);
    const retry = await screen.findByRole('button', { name: 'Try again' });
    mocks.authenticateBiometric.mockResolvedValueOnce('k'.repeat(64));
    fireEvent.click(retry);
    await waitFor(() => expect(onUnlock).toHaveBeenCalledWith('k'.repeat(64)));
  });

  it('with no PIN behind it, does not offer a PIN that cannot open it', async () => {
    mocks.hasPinFallback.mockReturnValue(false);
    render(<AuthScreen onUnlock={vi.fn()} />);
    await screen.findByRole('button', { name: 'Try again' });
    expect(screen.queryByRole('button', { name: 'Use PIN instead' })).toBeNull();
    expect(screen.getByText('Biometric authentication failed. Try again.')).toBeTruthy();
  });

  it('with a PIN behind it, still offers it', async () => {
    mocks.hasPinFallback.mockReturnValue(true);
    render(<AuthScreen onUnlock={vi.fn()} />);
    await screen.findByRole('button', { name: 'Try again' });
    expect(screen.getByRole('button', { name: 'Use PIN instead' })).toBeTruthy();
  });
});
