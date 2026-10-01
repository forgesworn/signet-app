// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ExistingProfilePanel } from './ExistingProfilePanel';

describe('ExistingProfilePanel', () => {
  const profile = { displayName: 'Alice', about: 'Line one\nLine two', pictureUrl: 'https://img.example/a.png' };

  it('names the profile, shows the bio, and loads NO picture until "Show picture" is tapped', () => {
    const { container } = render(<ExistingProfilePanel profile={profile} />);
    expect(screen.getByText('This account is already public on Nostr as Alice.')).toBeDefined();
    expect(container.textContent).toContain('Line one');
    expect(container.querySelector('img')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show picture' }));
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://img.example/a.png');
  });

  it('never offers a picture that fails the URL allowlist', () => {
    render(<ExistingProfilePanel profile={{ displayName: 'A', pictureUrl: 'http://insecure.example/p.png' }} />);
    expect(screen.queryByRole('button', { name: 'Show picture' })).toBeNull();
  });

  it('defaults to "Match it in Signet" and explains that keeping it private cannot unpublish it', () => {
    const onChoice = vi.fn();
    render(<ExistingProfilePanel profile={profile} choice="match" onChoice={onChoice} />);
    expect((screen.getByRole('radio', { name: /Match it in Signet/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/Signet can.t take it back off Nostr/)).toBeDefined();
    fireEvent.click(screen.getByRole('radio', { name: /Keep it private in Signet/ }));
    expect(onChoice).toHaveBeenCalledWith('private');
  });
});
