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

describe('AuthScreen, contextual authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.hasPinFallback.mockReturnValue(true);
  });

  it('keeps the action and dependant visible when biometrics fail and PIN is chosen', async () => {
    const onUnlock = vi.fn();
    render(<AuthScreen onUnlock={onUnlock} purposeContext={{
      purpose: 'guardian-approve-dep-action', depName: 'Alice',
      actionDescription: 'connect an app', siteName: 'Example app',
    }} />);
    await screen.findByRole('button', { name: 'Try again' });
    expect(screen.getByRole('heading', { name: 'Approve as guardian' })).toBeTruthy();
    expect(screen.getByText('Alice').tagName).toBe('STRONG');
    expect(screen.getByText('Example app').tagName).toBe('STRONG');
    fireEvent.click(screen.getByRole('button', { name: 'Use PIN instead' }));
    expect(screen.getByRole('heading', { name: 'Approve as guardian' })).toBeTruthy();
    expect(onUnlock).not.toHaveBeenCalled();
    mocks.authenticatePIN.mockResolvedValueOnce('k'.repeat(64));
    for (const digit of '123456') fireEvent.click(screen.getByRole('button', { name: digit }));
    await waitFor(() => expect(onUnlock).toHaveBeenCalledWith('k'.repeat(64)));
  });

  it('renders untrusted app labels as text, and cancellation never unlocks', async () => {
    const onUnlock = vi.fn(), onCancel = vi.fn();
    const appName = '<img src=x onerror=alert(1)>';
    const { container } = render(<AuthScreen onUnlock={onUnlock} onCancel={onCancel} purposeContext={{
      purpose: 'review-request', request: 'sign-in', siteName: appName,
    }} />);
    await screen.findByRole('button', { name: 'Try again' });
    expect(screen.getByRole('heading', { name: 'Review sign-in request' })).toBeTruthy();
    expect(screen.getByText(appName).tagName).toBe('STRONG');
    expect(container.querySelector('img')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onUnlock).not.toHaveBeenCalled();
  });
});
