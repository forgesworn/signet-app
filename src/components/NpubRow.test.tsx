// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NpubRow } from './NpubRow';

const pubkey = 'a'.repeat(64);
const npub = 'npub1424242424242424242424242424242424242424242424242424qamrcaj';

describe('NpubRow', () => {
  it('offers the full selectable address if clipboard permission is refused', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('Permission denied')) },
    });
    render(<NpubRow pubkey={pubkey} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy npub' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Select the full npub'));
    expect(screen.getByTitle(npub).textContent).toBe(npub);
    expect(screen.queryByText('Copied!')).toBeNull();
  });

  it('does not retain copy or expansion state when the displayed identity changes', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    const view = render(<NpubRow pubkey={pubkey} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy npub' }));
    await screen.findByText('Copied!');
    fireEvent.click(screen.getByRole('button', { name: 'Show full npub' }));
    view.rerender(<NpubRow pubkey={'b'.repeat(64)} />);
    expect(screen.queryByText('Copied!')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show full npub' })).toBeDefined();
  });
});
