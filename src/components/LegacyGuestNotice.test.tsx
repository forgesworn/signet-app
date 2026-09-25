// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LegacyGuestNotice } from './LegacyGuestNotice';

describe('LegacyGuestNotice', () => {
  it('explains that the unprotected tier is retired and offers one action', () => {
    render(<LegacyGuestNotice onSecure={() => {}} />);
    expect(screen.getByText(/have been retired/i)).toBeDefined();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('promises the identity and its activity are kept', () => {
    render(<LegacyGuestNotice onSecure={() => {}} />);
    expect(screen.getByText(/keep your name and everything you've done/i)).toBeDefined();
  });

  it('calls onSecure', () => {
    const onSecure = vi.fn();
    render(<LegacyGuestNotice onSecure={onSecure} />);
    fireEvent.click(screen.getByRole('button', { name: 'Secure my Signet' }));
    expect(onSecure).toHaveBeenCalledTimes(1);
  });
});
