// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { KeepInviteConfirm } from './KeepInviteConfirm';

afterEach(cleanup);

describe('KeepInviteConfirm', () => {
  it('asks in plain words with the Keep and game names, and has two buttons', () => {
    const onOpen = vi.fn(), onLater = vi.fn();
    render(<KeepInviteConfirm keepName="Kitchen Keep" gameName="Twang Thang" onOpen={onOpen} onLater={onLater} />);
    expect(screen.getByRole('dialog', { name: 'Open your Keep?' })).toBeInTheDocument();
    expect(screen.getByText('A game asked to open Kitchen Keep so you can invite someone to play Twang Thang.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onLater).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open Keep' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('renders the names as text', () => {
    render(<KeepInviteConfirm keepName="<b>x</b>" gameName="G" onOpen={vi.fn()} onLater={vi.fn()} />);
    expect(screen.getByRole('dialog').querySelector('b')).toBeNull();
  });
});
