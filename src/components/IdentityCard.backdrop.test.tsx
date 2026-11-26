// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const hook = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock('../hooks/useCardBackdrop', async (orig) => ({
  ...await orig<typeof import('../hooks/useCardBackdrop')>(),
  useCardBackdrop: () => hook.state,
}));

import { IdentityCard } from './IdentityCard';
import { BACKDROP_PRIVACY_COPY } from '../hooks/useCardBackdrop';

const resolved = { displayName: 'Sky Hawk', displayNameIsSet: true, publicKey: 'b'.repeat(64), type: 'Persona', isDependant: false } as never;
const row = {
  type: 'persona',
  identity: { naturalPerson: { publicKey: 'a'.repeat(64), displayName: '' }, persona: { publicKey: 'b'.repeat(64), displayName: 'Sky Hawk' }, primaryKeypair: 'persona' },
} as never;
const set = vi.fn();
const clear = vi.fn();
const base = () => ({ url: 'blob:x', source: 'own', link: null, set, clear });

beforeEach(() => { set.mockReset(); clear.mockReset(); hook.state = base(); });
afterEach(cleanup);

const openMenu = () => fireEvent.click(screen.getByLabelText('Customise card backdrop'));
const pick = () => fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement,
  { target: { files: [new File(['x'], 'p.png', { type: 'image/png' })] } });

describe('IdentityCard backdrop control', () => {
  it('offers Change image and Remove for the device\'s own pick', () => {
    render(<IdentityCard row={row} resolved={resolved} childMode={false} />);
    openMenu();
    expect(screen.getByRole('menuitem', { name: 'Change image' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Remove' })).toBeTruthy();
  });

  it('offers no Remove while the guardian\'s picture is showing', () => {
    hook.state = { ...base(), source: 'guardian' };
    render(<IdentityCard row={row} resolved={resolved} childMode={false} />);
    openMenu();
    expect(screen.getByRole('menuitem', { name: 'Change image' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Remove' })).toBeNull();
  });

  it('offers no Remove on a locked dependant card', () => {
    hook.state = { ...base(), link: { name: 'Lily', sent: true }, removeBlocked: true };
    render(<IdentityCard row={row} resolved={resolved} childMode={false} />);
    openMenu();
    expect(screen.getByRole('menuitem', { name: 'Change image' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Remove' })).toBeNull();
  });

  it('a pick on an own persona confirms with the device-local line', async () => {
    set.mockResolvedValue({ ok: true });
    render(<IdentityCard row={row} resolved={resolved} childMode={false} />);
    pick();
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(BACKDROP_PRIVACY_COPY));
  });

  it('a pick on a dependant card confirms with the sent-to-their-phone line', async () => {
    hook.state = { ...base(), link: { name: 'Lily', sent: true } };
    set.mockResolvedValue({ ok: true, send: { ok: true } });
    render(<IdentityCard row={row} resolved={resolved} childMode={false} />);
    pick();
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/^Sent to Lily's phone, encrypted on the way\./));
  });

  it('a failed send says it was not sent, with the reason', async () => {
    hook.state = { ...base(), link: { name: 'Lily', sent: false } };
    set.mockResolvedValue({ ok: true, send: { ok: false, reason: 'Unlock the app, then choose it again.' } });
    render(<IdentityCard row={row} resolved={resolved} childMode={false} />);
    pick();
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe("Not sent to Lily's phone. Unlock the app, then choose it again."));
  });
});
