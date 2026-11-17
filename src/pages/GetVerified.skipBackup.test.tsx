// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { GetVerified } from './GetVerified';
import { toRecoveryWords } from '../lib/recovery-words';

vi.mock('../hooks/useCamera', () => ({
  useCamera: () => ({ hasPermission: true, error: null, requestPermission: vi.fn() }),
}));
vi.mock('../components/QRScanner', () => ({ QRScanner: () => null }));

afterEach(cleanup);

// Words that cannot occur in the page's own copy.
const MNEMONIC = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';

function words(): string[] {
  return toRecoveryWords(MNEMONIC).split(' ');
}

describe('GetVerified skipBackup (child mode: the identity is the guardian\'s)', () => {
  it('control: without it, Enter my details shows the recovery words', () => {
    render(<GetVerified identity={{ mnemonic: MNEMONIC, backedUp: false }} onMarkBackedUp={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Enter my details' }));
    expect(screen.getByText('Before you verify')).toBeTruthy();
    expect(screen.getAllByText('wrong').length).toBeGreaterThan(0);
  });

  it('with it, no recovery word is rendered on any phase reachable from the start', () => {
    const onMarkBackedUp = vi.fn();
    const { container } = render(
      <GetVerified identity={{ mnemonic: MNEMONIC, backedUp: false }} onMarkBackedUp={onMarkBackedUp} skipBackup />,
    );
    const text = () => container.textContent ?? '';
    const noWords = () => {
      for (const w of new Set(words())) expect(text()).not.toMatch(new RegExp(`\\b${w}\\b`));
      expect(text()).not.toContain('Before you verify');
    };
    noWords(); // education
    fireEvent.click(screen.getByRole('button', { name: 'Enter my details' }));
    noWords(); // would have been the backup phase
    // Walk every button on the next phase that moves to another phase.
    for (const b of screen.queryAllByRole('button')) {
      fireEvent.click(b);
      noWords();
    }
    expect(onMarkBackedUp).not.toHaveBeenCalled();
  });
});
