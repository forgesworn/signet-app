// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BackupCard } from './BackupCard';

const DEFAULT_COPY = {
  title: 'Write down your recovery words',
  body: "They're the only way back in on a new phone.",
};

describe('BackupCard', () => {
  it('shows the copy it is given', () => {
    render(<BackupCard onBackup={() => {}} onDismiss={() => {}} {...DEFAULT_COPY} />);
    expect(screen.getByText(/only way back in on a new phone/i)).toBeDefined();
  });

  it('renders a dependant-aware body', () => {
    render(
      <BackupCard
        onBackup={() => {}}
        onDismiss={() => {}}
        title="Write down your recovery words"
        body="They're the only way back in — for you and for Lily."
      />
    );
    expect(screen.getByText(/for you and for Lily/)).toBeDefined();
  });

  it('calls onBackup', () => {
    const onBackup = vi.fn();
    render(<BackupCard onBackup={onBackup} onDismiss={() => {}} {...DEFAULT_COPY} />);
    fireEvent.click(screen.getByRole('button', { name: 'Write them down' }));
    expect(onBackup).toHaveBeenCalledTimes(1);
  });

  it('calls onDismiss', () => {
    const onDismiss = vi.fn();
    render(<BackupCard onBackup={() => {}} onDismiss={onDismiss} {...DEFAULT_COPY} />);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('never says Guest, provisional or burner', () => {
    const { container } = render(<BackupCard onBackup={() => {}} onDismiss={() => {}} {...DEFAULT_COPY} />);
    expect(container.textContent).not.toMatch(/guest|provisional|burner/i);
  });
});
