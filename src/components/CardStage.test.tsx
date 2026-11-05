// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { CardStage } from './CardStage';
import { getCardBackdrop } from '../lib/db';
import { resetCardBackdropCacheForTests } from '../hooks/useCardBackdrop';

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
  resetCardBackdropCacheForTests();
  URL.createObjectURL = vi.fn(() => 'blob:backdrop');
  URL.revokeObjectURL = vi.fn();
});

describe('CardStage', () => {
  it('renders the card inside a plain stage when the identity has no backdrop', async () => {
    mockGet.mockResolvedValue(null);
    const { container } = render(<CardStage pubkey={'cc'.repeat(32)}><div>card</div></CardStage>);
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(screen.getByText('card')).toBeDefined();
    expect(container.querySelector('.card-stage')).not.toBeNull();
    expect(container.querySelector('.card-stage.has-backdrop')).toBeNull();
    expect(container.querySelector('.card-backdrop')).toBeNull();
  });

  it('paints the stored backdrop and scrim behind the card', async () => {
    mockGet.mockResolvedValue(new Blob(['img'], { type: 'image/png' }));
    const { container } = render(<CardStage pubkey={'dd'.repeat(32)}><div>card</div></CardStage>);
    await waitFor(() => expect(container.querySelector('.card-backdrop')).not.toBeNull());
    expect(container.querySelector('.card-stage.has-backdrop')).not.toBeNull();
    expect(container.querySelector('.card-backdrop-scrim')).not.toBeNull();
    expect(screen.getByText('card')).toBeDefined();
  });

  it('keeps the card mounted while the backdrop arrives', async () => {
    mockGet.mockResolvedValue(new Blob(['img'], { type: 'image/png' }));
    const { container } = render(<CardStage pubkey={'ee'.repeat(32)}><div>card</div></CardStage>);
    const before = screen.getByText('card');
    await waitFor(() => expect(container.querySelector('.card-backdrop')).not.toBeNull());
    expect(screen.getByText('card')).toBe(before);
  });

  it('paints a cached backdrop on the first render of a second stage', async () => {
    mockGet.mockResolvedValue(new Blob(['img'], { type: 'image/png' }));
    const first = render(<CardStage pubkey={'ff'.repeat(32)}><div>one</div></CardStage>);
    await waitFor(() => expect(first.container.querySelector('.card-backdrop')).not.toBeNull());
    const second = render(<CardStage pubkey={'ff'.repeat(32)}><div>two</div></CardStage>);
    expect(second.container.querySelector('.card-backdrop')).not.toBeNull();
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('blurs the backdrop under the blur-names preference, since it may be a photo of the same person', async () => {
    mockGet.mockResolvedValue(new Blob(['img'], { type: 'image/png' }));
    const { container } = render(<CardStage pubkey={'ab'.repeat(32)} blur><div>card</div></CardStage>);
    await waitFor(() => expect(container.querySelector('.card-backdrop')).not.toBeNull());
    expect((container.querySelector('.card-backdrop') as HTMLElement).style.filter).toContain('blur');
  });

  it('leaves the backdrop sharp when the preference is off', async () => {
    mockGet.mockResolvedValue(new Blob(['img'], { type: 'image/png' }));
    const { container } = render(<CardStage pubkey={'ac'.repeat(32)}><div>card</div></CardStage>);
    await waitFor(() => expect(container.querySelector('.card-backdrop')).not.toBeNull());
    expect((container.querySelector('.card-backdrop') as HTMLElement).style.filter).toBe('');
  });
});
