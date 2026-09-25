// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RequireRealIdentity } from './RequireRealIdentity';

describe('RequireRealIdentity', () => {
  it('shows the caller-supplied reason', () => {
    render(<RequireRealIdentity reason="Venue entry shows your legal name at the door." onActivate={() => {}} onCancel={() => {}} />);
    expect(screen.getByText('Venue entry shows your legal name at the door.')).toBeDefined();
  });

  it('calls onActivate from the primary button', () => {
    const onActivate = vi.fn();
    render(<RequireRealIdentity reason="r" onActivate={onActivate} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Activate my real identity' }));
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel from the ghost button', () => {
    const onCancel = vi.fn();
    render(<RequireRealIdentity reason="r" onActivate={() => {}} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('never says Guest, provisional or burner', () => {
    const { container } = render(<RequireRealIdentity reason="r" onActivate={() => {}} onCancel={() => {}} />);
    expect(container.textContent).not.toMatch(/guest|provisional|burner/i);
  });
});
