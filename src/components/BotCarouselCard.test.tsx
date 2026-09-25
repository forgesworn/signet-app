// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { BotCarouselCard } from './BotCarouselCard';
vi.mock('./QRCode', () => ({ QRCode: ({ data }: { data: string }) => <code data-testid="bot-qr">{data}</code> }));
it('shares only the labelled bot key, never its private owner link or an inherited trust badge', () => {
  const bot = { publicKey: 'b'.repeat(64), ownerPersona: 'c'.repeat(64), label: 'Helper', source: 'derived' as const,
    derivationName: 'bot-0', hidden: false, createdAt: 1, updatedAt: 1 };
  const { rerender } = render(<BotCarouselCard bot={bot} col={1} onOpen={vi.fn()} onHide={async () => {}} />);
  expect(screen.getByRole('heading', { name: 'Helper · Bot' })).toBeTruthy();
  const qr = screen.getByTestId('bot-qr').textContent!;
  expect(qr).toContain(bot.publicKey);
  expect(qr).not.toContain(bot.ownerPersona);
  expect(qr).not.toContain('ownership');
  rerender(<BotCarouselCard bot={bot} col={4} onOpen={vi.fn()} onHide={async () => {}} />);
  expect(screen.getByText('Camera signing for bots is not available yet.')).toBeTruthy();
});
