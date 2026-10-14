// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PortraitLayout } from './PortraitLayout';

let type: OrientationType;
let coarse: boolean;
let orientation: EventTarget & { type: OrientationType; lock: ReturnType<typeof vi.fn> };

beforeEach(() => {
  type = 'portrait-primary'; coarse = true;
  orientation = Object.assign(new EventTarget(), { get type() { return type; }, lock: vi.fn(async () => { throw new Error('Not supported'); }) });
  Object.defineProperty(orientation, 'type', { get: () => type });
  vi.stubGlobal('screen', { orientation, width: 390, height: 844 });
  vi.stubGlobal('innerWidth', 390);
  vi.stubGlobal('innerHeight', 844);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: coarse })));
});
afterEach(() => vi.unstubAllGlobals());

describe('PortraitLayout', () => {
  it('preserves mounted components and their form values when locking is refused', async () => {
    function Form() {
      const [value, setValue] = useState('');
      return <input aria-label="Persona name" value={value} onChange={e => setValue(e.target.value)} />;
    }
    const { container } = render(<PortraitLayout><Form /></PortraitLayout>);
    const input = screen.getByRole('textbox');
    input.focus();
    fireEvent.change(input, { target: { value: 'Night Owl' } });
    await waitFor(() => expect(orientation.lock).toHaveBeenCalledWith('portrait-primary'));
    type = 'landscape-primary';
    vi.stubGlobal('innerWidth', 844); vi.stubGlobal('innerHeight', 390);
    act(() => { orientation.dispatchEvent(new Event('change')); });
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Turn your device upright');
    expect(document.activeElement).toBe(dialog);
    expect(container.querySelector('.portrait-app')?.hasAttribute('inert')).toBe(true);
    expect(input.isConnected).toBe(true);
    expect(input).toHaveValue('Night Owl');

    type = 'portrait-primary';
    vi.stubGlobal('innerWidth', 390); vi.stubGlobal('innerHeight', 844);
    act(() => { orientation.dispatchEvent(new Event('change')); });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('textbox')).toBe(input);
    expect(input).toHaveValue('Night Owl');
    expect(document.activeElement).toBe(input);
  });

  it('does not treat the software keyboard as device rotation', async () => {
    render(<PortraitLayout><input /></PortraitLayout>);
    vi.stubGlobal('innerHeight', 280);
    fireEvent(window, new Event('resize'));
    await act(async () => {});
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('leaves desktop landscape windows alone', async () => {
    coarse = false; type = 'landscape-primary';
    vi.stubGlobal('innerWidth', 1100); vi.stubGlobal('innerHeight', 850);
    render(<PortraitLayout><p>Desktop app</p></PortraitLayout>);
    await act(async () => {});
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(orientation.lock).not.toHaveBeenCalled();
  });

  it('allows a portrait app window letterboxed on a landscape tablet', async () => {
    type = 'landscape-primary';
    render(<PortraitLayout><p>Portrait app window</p></PortraitLayout>);
    await act(async () => {});
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
