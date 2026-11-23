// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { act } from '@testing-library/react';
import { KEEP_INVITE_CONFIRM_ARM_MS, KeepInviteConfirm } from './KeepInviteConfirm';
import { Z } from '../lib/z-index';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
const armed = () => act(() => { vi.advanceTimersByTime(KEEP_INVITE_CONFIRM_ARM_MS); });

describe('KeepInviteConfirm', () => {
  it('asks in plain words with the Keep and game names, and has two buttons', () => {
    const onOpen = vi.fn(), onLater = vi.fn();
    render(<KeepInviteConfirm keepName="Kitchen Keep" gameName="Twang Thang" onOpen={onOpen} onLater={onLater} />);
    expect(screen.getByRole('dialog', { name: 'Open your Keep?' })).toBeInTheDocument();
    expect(screen.getByText('A game asked to open Kitchen Keep so you can invite someone to play Twang Thang.')).toBeInTheDocument();
    armed();
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

  it('ignores presses for the first half second, so a tap on its way to something else cannot confirm it', () => {
    const onOpen = vi.fn(), onLater = vi.fn();
    render(<KeepInviteConfirm keepName="K" gameName="G" onOpen={onOpen} onLater={onLater} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Keep' }));
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    act(() => { vi.advanceTimersByTime(KEEP_INVITE_CONFIRM_ARM_MS - 1); });
    fireEvent.click(screen.getByRole('button', { name: 'Open Keep' }));
    expect(onOpen).not.toHaveBeenCalled();
    expect(onLater).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    fireEvent.click(screen.getByRole('button', { name: 'Open Keep' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('sits at the ordinary dialog layer, below the PIN, approval and signer prompts', () => {
    render(<KeepInviteConfirm keepName="K" gameName="G" onOpen={vi.fn()} onLater={vi.fn()} />);
    const z = Number((screen.getByRole('dialog') as HTMLElement).style.zIndex);
    expect(z).toBe(Z.modal);
    expect(z).toBeLessThan(Z.overlay);
    expect(z).toBeLessThan(Z.panel);
    expect(z).toBeLessThan(Z.auth);
  });
});
