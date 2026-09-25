// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BackupCard } from './BackupCard';

describe('BackupCard', () => {
  it('shows the spec copy', () => {
    render(<BackupCard onBackup={() => {}} onDismiss={() => {}} />);
    expect(screen.getByText(/only way back in on a new phone/i)).toBeDefined();
  });

  it('calls onBackup', () => {
    const onBackup = vi.fn();
    render(<BackupCard onBackup={onBackup} onDismiss={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Write them down' }));
    expect(onBackup).toHaveBeenCalledTimes(1);
  });

  it('calls onDismiss', () => {
    const onDismiss = vi.fn();
    render(<BackupCard onBackup={() => {}} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('never says Guest, provisional or burner', () => {
    const { container } = render(<BackupCard onBackup={() => {}} onDismiss={() => {}} />);
    expect(container.textContent).not.toMatch(/guest|provisional|burner/i);
  });
});
