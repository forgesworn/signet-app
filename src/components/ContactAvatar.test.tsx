// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ContactAvatar } from './ContactAvatar';

const PK = 'ab'.repeat(32);

describe('ContactAvatar badge', () => {
  it('renders their picture as a round badge, 42% of the diameter, ringed 2 px in the card background', () => {
    const { container } = render(<ContactAvatar url="blob:own" badgeUrl="blob:theirs" name="Dave" pubkey={PK} size={72} />);
    const imgs = container.querySelectorAll('img');
    expect(imgs).toHaveLength(2);
    expect(imgs[0].getAttribute('src')).toBe('blob:own');
    const badge = screen.getByTestId('contact-avatar-badge') as HTMLImageElement;
    expect(badge.getAttribute('src')).toBe('blob:theirs');
    expect(badge.style.width).toBe('30px');
    expect(badge.style.height).toBe('30px');
    expect(badge.style.borderRadius).toBe('50%');
    expect(badge.style.border).toContain('2px solid');
    expect(badge.style.border).toContain('var(--bg-card)');
    expect(badge.style.right).toContain('-');
    expect(badge.style.bottom).toContain('-');
  });

  it('has no badge without one, or without a main picture', () => {
    const one = render(<ContactAvatar url="blob:own" name="Dave" pubkey={PK} size={40} />);
    expect(one.container.querySelectorAll('img')).toHaveLength(1);
    one.unmount();
    const none = render(<ContactAvatar url={null} badgeUrl="blob:theirs" name="Dave" pubkey={PK} size={40} />);
    expect(none.container.querySelectorAll('img')).toHaveLength(0);
    expect(none.container.textContent).toBe('D');
  });
});
