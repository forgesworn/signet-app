// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ChildSignInRefusal } from './ChildSignInRefusal';

afterEach(cleanup);

describe('ChildSignInRefusal', () => {
  it.each([false, true])('says where the child signs in and offers only Decline (overlay %s)', (overlay) => {
    render(<ChildSignInRefusal child="RunKid" overlay={overlay} onDecline={vi.fn()} />);
    expect(screen.getByText('RunKid signs in on their own phone')).toBeTruthy();
    expect(screen.getByText("This phone can't sign in for RunKid. Use RunKid's own phone.")).toBeTruthy();
    expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual(['Decline']);
    expect(screen.queryByText(/approve|unlock|PIN/i)).toBeNull();
  });

  it('Decline answers once', () => {
    const onDecline = vi.fn();
    render(<ChildSignInRefusal child="RunKid" onDecline={onDecline} />);
    const decline = screen.getByRole('button', { name: 'Decline' }) as HTMLButtonElement;
    fireEvent.click(decline);
    fireEvent.click(decline);
    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(decline.disabled).toBe(true);
  });
});
