// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { OnboardingApp } from './OnboardingApp';

// The app is hosted in a phone frame on a wide window, so a step's height must
// come from the frame (`--app-vh`), not from the window: `80vh` on a tall
// desktop window centres the step below the fold.

function renderOnboarding() {
  render(<OnboardingApp onCreate={vi.fn()} onImport={vi.fn()} onImportLiteMnemonic={vi.fn()} onImportNsec={vi.fn()}
    onConnectHeartwood={vi.fn()} onConnectNip07={vi.fn()} onStartChildPair={vi.fn()} />);
}

describe('OnboardingApp step height', () => {
  afterEach(cleanup);

  it('sizes the welcome step against the frame, not the window', () => {
    renderOnboarding();
    const style = screen.getByRole('main').getAttribute('style') ?? '';
    expect(style).toContain('--app-vh');
    expect(style).not.toMatch(/\b80vh\b/);
  });

  it('sizes the create step against the frame, not the window', () => {
    renderOnboarding();
    fireEvent.click(screen.getByRole('button', { name: 'Create my Signet' }));
    const style = screen.getByRole('main').getAttribute('style') ?? '';
    expect(style).toContain('--app-vh');
    expect(style).not.toMatch(/\b80vh\b/);
  });
});
