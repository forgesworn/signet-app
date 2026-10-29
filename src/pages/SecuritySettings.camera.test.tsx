// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SecuritySettings } from './SecuritySettings';
import type { SignetIdentity } from '../types';

const identity = {
  id: 'a'.repeat(64),
  mnemonic: '',
  encrypted: false,
  naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: 'Owner' },
  persona: { publicKey: 'b'.repeat(64), privateKey: '', displayName: 'Persona' },
  createdAt: Date.now(),
} as unknown as SignetIdentity;

function renderPage(over: { scannerAutoStart?: boolean; scannerIdleSeconds?: number } = {}) {
  const onSetScannerAutoStart = vi.fn();
  const onSetScannerIdleSeconds = vi.fn();
  render(
    <SecuritySettings
      identity={identity}
      securityTier="standard"
      onSetSecurityTier={vi.fn()}
      onRequestAuth={vi.fn()}
      onRequestFreshAuth={vi.fn()}
      blurIdentityNames={false}
      onSetBlurIdentityNames={vi.fn()}
      requireNpConfirmation={true}
      onSetRequireNpConfirmation={vi.fn()}
      preferPersonaForSignIns={false}
      onSetPreferPersonaForSignIns={vi.fn()}
      preferredPersonaPubkey={undefined}
      onSetPreferredPersonaPubkey={vi.fn()}
      scannerAutoStart={over.scannerAutoStart ?? true}
      onSetScannerAutoStart={onSetScannerAutoStart}
      scannerIdleSeconds={over.scannerIdleSeconds ?? 20}
      onSetScannerIdleSeconds={onSetScannerIdleSeconds}
      bunkerServerEnabled={false}
      onSetBunkerServerEnabled={vi.fn()}
      bunkerUrl={null}
      onNavigateShamir={vi.fn()}
    />,
  );
  return { onSetScannerAutoStart, onSetScannerIdleSeconds };
}

describe('SecuritySettings — Camera card', () => {
  it('explains the auto-start switch', () => {
    renderPage();
    expect(screen.getByText('Start the camera when I swipe to Scan')).toBeInTheDocument();
    expect(screen.getByText(/the camera only opens when you tap/)).toBeInTheDocument();
  });

  it('turning auto-start off calls the setter with false', () => {
    const { onSetScannerAutoStart } = renderPage({ scannerAutoStart: true });
    fireEvent.click(screen.getByRole('button', { name: 'Turn off camera auto-start' }));
    expect(onSetScannerAutoStart).toHaveBeenCalledWith(false);
  });

  it('turning auto-start on calls the setter with true', () => {
    const { onSetScannerAutoStart } = renderPage({ scannerAutoStart: false });
    fireEvent.click(screen.getByRole('button', { name: 'Turn on camera auto-start' }));
    expect(onSetScannerAutoStart).toHaveBeenCalledWith(true);
  });

  it('shows the four idle choices with the current one selected', () => {
    renderPage({ scannerIdleSeconds: 30 });
    const group = screen.getByRole('radiogroup', { name: 'Turn the camera off after' });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '10 s' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: '20 s' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: '30 s' })).toBeChecked();
    expect(screen.getByRole('radio', { name: '1 min' })).not.toBeChecked();
  });

  it('choosing an idle time calls the setter with seconds', () => {
    const { onSetScannerIdleSeconds } = renderPage({ scannerIdleSeconds: 20 });
    fireEvent.click(screen.getByRole('radio', { name: '1 min' }));
    expect(onSetScannerIdleSeconds).toHaveBeenCalledWith(60);
    fireEvent.click(screen.getByRole('radio', { name: '10 s' }));
    expect(onSetScannerIdleSeconds).toHaveBeenCalledWith(10);
  });
});
