// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { CardStage } from './CardStage';
import { getCardBackdrop } from '../lib/db';

// fake-indexeddb's structured clone drops Blobs, so the store is mocked here;
// the real IDB roundtrip only runs in browsers (covered by the Playwright flow).
vi.mock('../lib/db', () => ({
  getCardBackdrop: vi.fn(),
  setCardBackdrop: vi.fn(),
  deleteCardBackdrop: vi.fn(),
}));
const mockGet = vi.mocked(getCardBackdrop);

beforeEach(() => {
  vi.resetAllMocks();
  URL.createObjectURL = vi.fn(() => 'blob:backdrop');
  URL.revokeObjectURL = vi.fn();
});

describe('CardStage', () => {
  it('renders the card alone when the identity has no backdrop', async () => {
    mockGet.mockResolvedValue(null);
    const { container } = render(<CardStage pubkey={'cc'.repeat(32)}><div>card</div></CardStage>);
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(screen.getByText('card')).toBeDefined();
    expect(container.querySelector('.card-backdrop')).toBeNull();
  });

  it('paints the stored backdrop and scrim behind the card', async () => {
    mockGet.mockResolvedValue(new Blob(['img'], { type: 'image/png' }));
    const { container } = render(<CardStage pubkey={'dd'.repeat(32)}><div>card</div></CardStage>);
    await waitFor(() => expect(container.querySelector('.card-backdrop')).not.toBeNull());
    expect(container.querySelector('.card-backdrop-scrim')).not.toBeNull();
    expect(screen.getByText('card')).toBeDefined();
  });
});
