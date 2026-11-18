// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ChildModeGuardianRefusal } from './ChildModeGuardianRefusal';

afterEach(cleanup);

describe('ChildModeGuardianRefusal', () => {
  it('says child mode is on and offers only Decline', () => {
    render(<ChildModeGuardianRefusal child="RunKid" onDecline={vi.fn()} />);
    expect(screen.getByText('Child mode is on')).toBeTruthy();
    expect(screen.getByText("This needs the guardian, not RunKid. Exit child mode with the guardian's PIN, then try again.")).toBeTruthy();
    expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual(['Decline']);
  });

  it('Decline answers once', () => {
    const onDecline = vi.fn();
    render(<ChildModeGuardianRefusal child="RunKid" onDecline={onDecline} />);
    const decline = screen.getByRole('button', { name: 'Decline' }) as HTMLButtonElement;
    fireEvent.click(decline);
    fireEvent.click(decline);
    expect(onDecline).toHaveBeenCalledTimes(1);
  });
});
