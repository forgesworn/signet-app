// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Nip55ApprovalModal } from './Nip55ApprovalModal';
import type { PendingNip55 } from '../hooks/useNip55Server';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

function approval(over: Partial<PendingNip55> = {}): PendingNip55 {
  return {
    handle: 1, id: 'r1', callerPackage: 'dev.forgesworn.kithmoot', callerLabel: 'Kithmoot', method: 'get_public_key',
    description: 'know which key you are', permissions: [], existing: false, pubkey: A, named: false, ...over,
  };
}

function setup(a: PendingNip55, identities: Array<{ pubkey: string; label: string }>) {
  const onApproveOnce = vi.fn();
  const onApproveAlways = vi.fn();
  const onDeny = vi.fn();
  const props = { approval: a, identities, onApproveOnce, onApproveAlways, onDeny, onDenyAlways: vi.fn() };
  const view = render(<Nip55ApprovalModal {...props} />);
  return { ...view, props, onApproveOnce, onApproveAlways, onDeny };
}

describe('Nip55ApprovalModal', () => {
  it('a default key outside the list yields to the first listed key, never "your key"', () => {
    const { onApproveOnce } = setup(approval({ pubkey: C }), [{ pubkey: A, label: 'Persona' }]);
    expect(screen.queryByText('your key')).toBeNull();
    expect(screen.getByText('Persona')).toBeTruthy();
    fireEvent.click(screen.getByText('Allow once'));
    expect(onApproveOnce).toHaveBeenCalledWith(1, A);
  });

  it('no identities: no "As:" line, Allow is disabled, Deny still works', () => {
    const { onDeny } = setup(approval({ pubkey: C }), []);
    expect(screen.queryByText('As:', { exact: false })).toBeNull();
    expect((screen.getByText('Allow once') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText(/Allow always/) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('Deny'));
    expect(onDeny).toHaveBeenCalledWith(1);
  });

  it('a list that grows from one key to two keeps the default selected and shows the picker', () => {
    const one = [{ pubkey: B, label: 'Extra' }];
    const { rerender, props, onApproveOnce } = setup(approval({ pubkey: null }), one);
    expect(screen.queryByRole('radio')).toBeNull();
    rerender(<Nip55ApprovalModal {...props} approval={approval({ pubkey: B })} identities={[...one, { pubkey: A, label: 'Persona' }]} />);
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios).toHaveLength(2);
    expect(radios.find(r => r.value === B)!.checked).toBe(true);
    fireEvent.click(screen.getByText('Allow once'));
    expect(onApproveOnce).toHaveBeenCalledWith(1, B);
  });

  it('an explicit choice sticks when the list later grows', () => {
    const two = [{ pubkey: A, label: 'Persona' }, { pubkey: B, label: 'Extra' }];
    const { rerender, props, onApproveOnce } = setup(approval({ pubkey: A }), two);
    fireEvent.click((screen.getAllByRole('radio') as HTMLInputElement[]).find(r => r.value === B)!);
    rerender(<Nip55ApprovalModal {...props} identities={[...two, { pubkey: C, label: 'Pro' }]} />);
    expect((screen.getAllByRole('radio') as HTMLInputElement[]).find(r => r.value === B)!.checked).toBe(true);
    fireEvent.click(screen.getByText('Allow once'));
    expect(onApproveOnce).toHaveBeenCalledWith(1, B);
  });

  it('a named key that is listed: no picker even for get_public_key, and exactly that key is approved', () => {
    const two = [{ pubkey: A, label: 'Persona' }, { pubkey: B, label: 'Extra' }];
    const { onApproveOnce } = setup(approval({ pubkey: B, named: true }), two);
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByText('Extra')).toBeTruthy();
    fireEvent.click(screen.getByText('Allow once'));
    expect(onApproveOnce).toHaveBeenCalledWith(1, B);
  });

  it('a named key with no route here is never substituted: Allow is off and the screen says why', () => {
    const { onApproveOnce, onApproveAlways, onDeny } = setup(approval({ method: 'sign_event', pubkey: C, named: true }), [{ pubkey: A, label: 'Persona' }]);
    expect(screen.queryByText('Persona')).toBeNull();
    expect(screen.getByText(/can't answer on this phone/)).toBeTruthy();
    expect((screen.getByText('Allow once') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText(/Allow always/) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('Allow once'));
    expect(onApproveOnce).not.toHaveBeenCalled();
    expect(onApproveAlways).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Deny'));
    expect(onDeny).toHaveBeenCalledWith(1);
  });
});
