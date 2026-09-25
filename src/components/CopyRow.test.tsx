// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CopyRow } from './CopyRow';

const NPUB = 'npub109j0zfy83v6j3u0pc055v5f0xsxhvx3f48gatfz9l2j6967ky46qmhvaha';

/** jsdom has no clipboard — install a stub and hand back the spy. */
function stubClipboard(impl: () => Promise<void> = () => Promise.resolve()) {
  const writeText = vi.fn(impl);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true,
  });
  return writeText;
}

describe('CopyRow', () => {
  beforeEach(() => {
    stubClipboard();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders the label and the value', () => {
    render(<CopyRow label="npub" value={NPUB} />);
    expect(screen.getByText('npub')).toBeDefined();
    expect(screen.getByText(NPUB)).toBeDefined();
  });

  it('renders the value in the mono utility class', () => {
    render(<CopyRow label="npub" value={NPUB} />);
    expect(screen.getByText(NPUB).className).toContain('mono');
  });

  it('wraps by default and truncates only when asked', () => {
    const { rerender } = render(<CopyRow label="npub" value={NPUB} />);
    expect(screen.getByText(NPUB).className).not.toContain('copy-row-value--truncate');
    expect(screen.getByText(NPUB).getAttribute('title')).toBeNull();

    rerender(<CopyRow label="npub" value={NPUB} truncate />);
    expect(screen.getByText(NPUB).className).toContain('copy-row-value--truncate');
    // Full value stays reachable on hover when it's visually clipped.
    expect(screen.getByText(NPUB).getAttribute('title')).toBe(NPUB);
  });

  it('gives the button an accessible, label-scoped name', () => {
    render(<CopyRow label="Public key" value={NPUB} />);
    expect(screen.getByRole('button', { name: 'Copy Public key' })).toBeDefined();
  });

  it('honours a custom copyLabel', () => {
    render(<CopyRow label="npub" value={NPUB} copyLabel="Copy npub" />);
    expect(screen.getByRole('button', { name: 'Copy npub' }).textContent).toBe('Copy npub');
  });

  it('writes the value to the clipboard and flips to Copied', async () => {
    const writeText = stubClipboard();
    render(<CopyRow label="npub" value={NPUB} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy npub' }));

    expect(writeText).toHaveBeenCalledWith(NPUB);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'npub copied' }).textContent).toBe('Copied ✓');
    });
  });

  // Real timers: the 2s timeout is armed inside the clipboard promise's `then`,
  // so swapping to fake timers after the click would never see it.
  it('reverts to Copy after the 2s window', async () => {
    render(<CopyRow label="npub" value={NPUB} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy npub' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'npub copied' })).toBeDefined());

    await waitFor(
      () => expect(screen.getByRole('button', { name: 'Copy npub' })).toBeDefined(),
      { timeout: 4000 },
    );
  }, 10_000);

  it('stays in the resting state when the clipboard write rejects', async () => {
    stubClipboard(() => Promise.reject(new Error('denied')));
    render(<CopyRow label="npub" value={NPUB} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy npub' }));

    await Promise.resolve();
    expect(screen.getByRole('button', { name: 'Copy npub' }).textContent).toBe('Copy');
  });

  it('does not throw when no clipboard is available', () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true, writable: true });
    render(<CopyRow label="npub" value={NPUB} />);
    expect(() => fireEvent.click(screen.getByRole('button', { name: 'Copy npub' }))).not.toThrow();
  });
});
