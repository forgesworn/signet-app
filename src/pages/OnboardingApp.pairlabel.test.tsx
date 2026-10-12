// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OnboardingApp } from './OnboardingApp';
import { CHILD_DEVICE_COPY, PAIR_WITH_GUARDIAN_LABEL } from '../lib/child-device-copy';

describe('OnboardingApp — child pairing entry', () => {
  it('the welcome button reads "Pair with my guardian\'s phone" and starts child pairing', () => {
    const onStartChildPair = vi.fn();
    render(<OnboardingApp onCreate={vi.fn()} onImport={vi.fn()} onImportLiteMnemonic={vi.fn()} onImportNsec={vi.fn()}
      onConnectHeartwood={vi.fn()} onConnectNip07={vi.fn()} onStartChildPair={onStartChildPair} />);
    fireEvent.click(screen.getByRole('button', { name: 'I already have a Signet' }));
    const button = screen.getByRole('button', { name: "Pair with my guardian's phone" });
    fireEvent.click(button);
    expect(onStartChildPair).toHaveBeenCalled();
    expect(screen.queryByText('I have a pairing code from my guardian')).toBeNull();
  });

  it('the guardian\'s QR instructions name the same label', () => {
    expect(PAIR_WITH_GUARDIAN_LABEL).toBe("Pair with my guardian's phone");
    expect(CHILD_DEVICE_COPY.offerIntro('Lily')).toContain(PAIR_WITH_GUARDIAN_LABEL);
  });
});
