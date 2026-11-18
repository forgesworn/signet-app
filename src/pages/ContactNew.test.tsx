// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('@forgesworn/kenspeckle/ken', () => ({ pinKenFromNip05: vi.fn() }));
vi.mock('../lib/nostr-follows', async () => {
  const actual = await vi.importActual<typeof import('../lib/nostr-follows')>('../lib/nostr-follows');
  return { ...actual, fetchKind0Profiles: vi.fn() };
});

import { pinKenFromNip05 } from '@forgesworn/kenspeckle/ken';
import { fetchKind0Profiles } from '../lib/nostr-follows';
import { ConfirmMergeRefusedError } from '../lib/contacts-v2-key-holders';
import { ContactNew } from './ContactNew';

const mockResolve = vi.mocked(pinKenFromNip05);
const mockProfiles = vi.mocked(fetchKind0Profiles);
const KEY = 'c'.repeat(64);
const OWNER = 'a'.repeat(64);
const RELAYS = ['wss://lookup.example'];
const PREF = 'signet.nip05LookupProfileName';

beforeEach(() => {
  localStorage.clear();
  mockResolve.mockReset();
  mockProfiles.mockReset();
  mockResolve.mockResolvedValue({ pubkey: KEY } as never);
  mockProfiles.mockResolvedValue(new Map());
});
afterEach(() => cleanup());

function lookUp(address: string) {
  fireEvent.change(screen.getByLabelText('NIP-05 address (optional)'), { target: { value: address } });
  fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
}
const nameBox = () => screen.getByLabelText('Name') as HTMLInputElement;

function renderPage(onCreate: (...args: never[]) => Promise<void>, extra: Partial<React.ComponentProps<typeof ContactNew>> = {}) {
  const onDone = vi.fn();
  render(<ContactNew subjectName={null} onCreate={onCreate as never} onDone={onDone}
    ownerPubkeyHex={OWNER} profileRelays={RELAYS} {...extra} />);
  return { onDone };
}

describe('ContactNew', () => {
  it('T3/I4: shows the generic copy, never the raw error message, when onCreate rejects', async () => {
    const onCreate = vi.fn(async () => { throw new Error('contacts: cannot add — contacts scope not ready'); });
    const { onDone } = renderPage(onCreate);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Dave' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save contact' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save this contact.');
    expect(screen.queryByText(/contacts scope not ready/)).toBeNull();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('saves and calls onDone when onCreate resolves', async () => {
    const onCreate = vi.fn(async () => {});
    const { onDone } = renderPage(onCreate);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Dave' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save contact' }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onCreate).toHaveBeenCalled();
  });

  it('rejects an empty name locally, before ever calling onCreate', () => {
    const onCreate = vi.fn(async () => {});
    renderPage(onCreate);
    fireEvent.click(screen.getByRole('button', { name: 'Save contact' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a name.');
    expect(onCreate).not.toHaveBeenCalled();
  });

  describe('NIP-05 lookup', () => {
    it('fills the key and the profile name (checkbox on by default)', async () => {
      mockProfiles.mockResolvedValue(new Map([[KEY, { displayName: 'Alice Archer', pictureUrl: 'https://x.example/p.png' }]]));
      renderPage(vi.fn(async () => {}));
      expect((screen.getByLabelText('Get their name from their Nostr profile') as HTMLInputElement).checked).toBe(true);
      lookUp('alice@example.com');
      await waitFor(() => expect(nameBox().value).toBe('Alice Archer'));
      expect(screen.getByText(/Found/)).toHaveTextContent('npub1');
      expect(mockResolve).toHaveBeenCalledWith('alice@example.com', OWNER, globalThis.fetch);
      expect(mockProfiles).toHaveBeenCalledWith([KEY], RELAYS);
    });

    it('uses the address name when the checkbox is off, and never asks a relay', async () => {
      renderPage(vi.fn(async () => {}));
      fireEvent.click(screen.getByLabelText('Get their name from their Nostr profile'));
      lookUp('alice@example.com');
      await waitFor(() => expect(nameBox().value).toBe('alice'));
      expect(mockProfiles).not.toHaveBeenCalled();
    });

    it('uses the domain for a bare domain, and hands the resolver _@domain', async () => {
      renderPage(vi.fn(async () => {}));
      fireEvent.click(screen.getByLabelText('Get their name from their Nostr profile'));
      lookUp('Example.com');
      await waitFor(() => expect(nameBox().value).toBe('example.com'));
      expect(mockResolve.mock.calls[0][0]).toBe('_@example.com');
    });

    it('falls back silently to the address name on a profile miss or error', async () => {
      renderPage(vi.fn(async () => {}));
      mockProfiles.mockRejectedValue(new Error('relay exploded'));
      lookUp('alice@example.com');
      await waitFor(() => expect(screen.getByText(/Found/)).toBeDefined());
      await waitFor(() => expect(mockProfiles).toHaveBeenCalled());
      expect(nameBox().value).toBe('alice');
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('never overwrites a name the person typed', async () => {
      mockProfiles.mockResolvedValue(new Map([[KEY, { displayName: 'Alice Archer' }]]));
      renderPage(vi.fn(async () => {}));
      fireEvent.change(nameBox(), { target: { value: 'Ally' } });
      lookUp('alice@example.com');
      await waitFor(() => expect(mockProfiles).toHaveBeenCalled());
      await waitFor(() => expect(screen.getByText(/Found/)).toBeDefined());
      expect(nameBox().value).toBe('Ally');
    });

    it('replaces its own earlier fill when the address is looked up again', async () => {
      renderPage(vi.fn(async () => {}));
      fireEvent.click(screen.getByLabelText('Get their name from their Nostr profile'));
      lookUp('alice@example.com');
      await waitFor(() => expect(nameBox().value).toBe('alice'));
      lookUp('bob@example.com');
      await waitFor(() => expect(nameBox().value).toBe('bob'));
    });

    it('remembers the checkbox on this device', () => {
      const first = render(<ContactNew subjectName={null} onCreate={vi.fn()} onDone={vi.fn()} />);
      fireEvent.click(screen.getByLabelText('Get their name from their Nostr profile'));
      expect(localStorage.getItem(PREF)).toBe('0');
      first.unmount();
      render(<ContactNew subjectName={null} onCreate={vi.fn()} onDone={vi.fn()} />);
      expect((screen.getByLabelText('Get their name from their Nostr profile') as HTMLInputElement).checked).toBe(false);
    });

    it('defaults the checkbox on when storage is unreadable', () => {
      const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
      try {
        render(<ContactNew subjectName={null} onCreate={vi.fn()} onDone={vi.fn()} />);
        expect((screen.getByLabelText('Get their name from their Nostr profile') as HTMLInputElement).checked).toBe(true);
      } finally { spy.mockRestore(); }
    });

    it('shows humanised copy when the resolver fails, never the raw message', async () => {
      mockResolve.mockRejectedValue(new Error('ken: nip05 lookup failed (HTTP 404)'));
      renderPage(vi.fn(async () => {}));
      lookUp('alice@example.com');
      await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
      expect(screen.getByRole('alert')).toHaveTextContent('Could not reach that address right now.');
      expect(screen.queryByText(/ken: nip05/)).toBeNull();
    });

    it('refuses a malformed address without calling the resolver', async () => {
      renderPage(vi.fn(async () => {}));
      lookUp('a+b@example.com');
      expect(screen.getByRole('alert')).toHaveTextContent('Enter a NIP-05 address');
      expect(mockResolve).not.toHaveBeenCalled();
    });

    it('editing the address clears the found key; Clear does too', async () => {
      renderPage(vi.fn(async () => {}));
      lookUp('alice@example.com');
      await waitFor(() => expect(screen.getByText(/Found/)).toBeDefined());
      fireEvent.change(screen.getByLabelText('NIP-05 address (optional)'), { target: { value: 'alice@example.org' } });
      expect(screen.queryByText(/Found/)).toBeNull();
      lookUp('alice@example.org');
      await waitFor(() => expect(screen.getByText(/Found/)).toBeDefined());
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
      expect(screen.queryByText(/Found/)).toBeNull();
    });

    it('offers Open, not Save, when the key is already a contact', async () => {
      const onOpenContact = vi.fn();
      const onCreate = vi.fn(async () => {});
      renderPage(onCreate, {
        findExistingContact: (pk) => pk === KEY ? { contactId: 'cid-1', displayName: 'Alice Archer', state: 'active' } : null,
        onOpenContact,
      });
      lookUp('alice@example.com');
      await waitFor(() => expect(screen.getByText(/Already in your contacts as Alice Archer/)).toBeDefined());
      expect(screen.queryByRole('button', { name: 'Save contact' })).toBeNull();
      expect(mockProfiles).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      expect(onOpenContact).toHaveBeenCalledWith('cid-1');
      expect(onCreate).not.toHaveBeenCalled();
    });

    it('saves the key and the canonical address through onCreate', async () => {
      const onCreate = vi.fn(async () => {});
      const { onDone } = renderPage(onCreate);
      fireEvent.click(screen.getByLabelText('Get their name from their Nostr profile'));
      lookUp('Example.com');
      await waitFor(() => expect(nameBox().value).toBe('example.com'));
      fireEvent.click(screen.getByRole('button', { name: 'Save contact' }));
      await waitFor(() => expect(onDone).toHaveBeenCalled());
      const [contact, methods, key] = onCreate.mock.calls[0] as unknown as [{ displayName: string }, unknown[], unknown];
      expect(contact.displayName).toBe('example.com');
      expect(methods).toEqual([{ kind: 'other', label: 'NIP-05', value: '_@example.com', verification: 'unverified', sharingPolicy: 'private' }]);
      expect(key).toEqual({ pubkey: KEY, nip05: '_@example.com' });
    });

    it('Save with a typed address and no lookup yet looks it up first, then saves with the key and profile name', async () => {
      mockProfiles.mockResolvedValue(new Map([[KEY, { displayName: 'Alice Archer' }]]));
      const onCreate = vi.fn(async () => {});
      const { onDone } = renderPage(onCreate);
      fireEvent.change(screen.getByLabelText('NIP-05 address (optional)'), { target: { value: 'alice@example.com' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save contact' }));
      await waitFor(() => expect(onDone).toHaveBeenCalled());
      const [contact, methods, key] = onCreate.mock.calls[0] as unknown as [{ displayName: string }, unknown[], unknown];
      expect(contact.displayName).toBe('Alice Archer');
      expect(methods).toHaveLength(1);
      expect(key).toEqual({ pubkey: KEY, nip05: 'alice@example.com' });
    });

    it('Save with an address whose lookup fails shows the humanised error and saves nothing', async () => {
      mockResolve.mockRejectedValue(new Error('ken: nip05 lookup failed (HTTP 404)'));
      const onCreate = vi.fn(async () => {});
      const { onDone } = renderPage(onCreate);
      fireEvent.change(nameBox(), { target: { value: 'Alice' } });
      fireEvent.change(screen.getByLabelText('NIP-05 address (optional)'), { target: { value: 'alice@example.com' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save contact' }));
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not reach that address right now.'));
      expect(onCreate).not.toHaveBeenCalled();
      expect(onDone).not.toHaveBeenCalled();
      // Clearing the field saves without it.
      fireEvent.change(screen.getByLabelText('NIP-05 address (optional)'), { target: { value: '' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save contact' }));
      await waitFor(() => expect(onDone).toHaveBeenCalled());
      const [, methods, key] = onCreate.mock.calls[0] as unknown as [unknown, unknown[], unknown];
      expect(methods).toEqual([]);
      expect(key).toBeUndefined();
    });

    it('Save with an address that is already a contact creates nothing', async () => {
      const onCreate = vi.fn(async () => {});
      renderPage(onCreate, { findExistingContact: () => ({ contactId: 'cid-1', displayName: 'Alice Archer', state: 'active' }) });
      fireEvent.change(nameBox(), { target: { value: 'Alice' } });
      fireEvent.change(screen.getByLabelText('NIP-05 address (optional)'), { target: { value: 'alice@example.com' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save contact' }));
      await waitFor(() => expect(screen.getByText(/Already in your contacts as Alice Archer/)).toBeDefined());
      expect(onCreate).not.toHaveBeenCalled();
    });

    it('Save is disabled while a lookup is in flight', async () => {
      let release: (v: { pubkey: string }) => void = () => {};
      mockResolve.mockReturnValue(new Promise(r => { release = r as never; }) as never);
      renderPage(vi.fn(async () => {}));
      fireEvent.change(nameBox(), { target: { value: 'Alice' } });
      lookUp('alice@example.com');
      await waitFor(() => expect((screen.getByRole('button', { name: 'Save contact' }) as HTMLButtonElement).disabled).toBe(true));
      release({ pubkey: KEY });
      await waitFor(() => expect((screen.getByRole('button', { name: 'Save contact' }) as HTMLButtonElement).disabled).toBe(false));
    });

    it('shows a deleted or archived holder as theirs, with no Open and no Save', async () => {
      for (const state of ['deleted', 'archived'] as const) {
        const onCreate = vi.fn(async () => {});
        renderPage(onCreate, { findExistingContact: () => ({ contactId: 'cid-1', displayName: 'Bob', state }), onOpenContact: vi.fn() });
        lookUp('bob@example.com');
        await waitFor(() => expect(screen.getByText(new RegExp(`That key belongs to Bob, a contact you ${state}`))).toBeDefined());
        expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Save contact' })).toBeNull();
        cleanup();
      }
    });

    it('a save the write refuses (a key a deleted contact holds) shows whose it is and offers no second try', async () => {
      const onCreate = vi.fn(async () => {
        throw new ConfirmMergeRefusedError({ contactId: 'cid-9', displayName: 'Bob', state: 'deleted' });
      });
      const { onDone } = renderPage(onCreate);
      fireEvent.change(nameBox(), { target: { value: 'Bob' } });
      lookUp('bob@example.com');
      await waitFor(() => expect(screen.getByText(/Found/)).toBeDefined());
      fireEvent.click(screen.getByRole('button', { name: 'Save contact' }));
      await waitFor(() => expect(screen.getByText(/That key belongs to Bob, a contact you deleted/)).toBeDefined());
      expect(screen.queryByText('Could not save this contact.')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Save contact' })).toBeNull();
      expect(onDone).not.toHaveBeenCalled();
    });

    it('refuses a key that is one of the person\'s own, whichever identity it is', async () => {
      const other = 'd'.repeat(64);
      mockResolve.mockResolvedValue({ pubkey: other } as never);
      renderPage(vi.fn(async () => {}), { ownKeys: [OWNER, other] });
      lookUp('me@example.com');
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("That's your own key."));
      expect(screen.getByRole('alert').textContent).not.toMatch(/ken/i);
      expect(screen.queryByText(/Found/)).toBeNull();
    });

    it('Clear during the profile fetch drops the key and the late name never lands', async () => {
      let release: (m: Map<string, { displayName: string }>) => void = () => {};
      mockProfiles.mockReturnValue(new Promise(r => { release = r as never; }) as never);
      renderPage(vi.fn(async () => {}));
      lookUp('alice@example.com');
      await waitFor(() => expect(screen.getByText(/Found/)).toBeDefined());
      await waitFor(() => expect(mockProfiles).toHaveBeenCalled());
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
      release(new Map([[KEY, { displayName: 'Late Name' }]]));
      await new Promise(r => setTimeout(r, 20));
      expect(nameBox().value).toBe('alice');
      expect(screen.queryByText(/Found/)).toBeNull();
    });

    it('unticking the box during the profile fetch keeps the address name', async () => {
      let release: (m: Map<string, { displayName: string }>) => void = () => {};
      mockProfiles.mockReturnValue(new Promise(r => { release = r as never; }) as never);
      renderPage(vi.fn(async () => {}));
      lookUp('alice@example.com');
      await waitFor(() => expect(mockProfiles).toHaveBeenCalled());
      fireEvent.click(screen.getByLabelText('Get their name from their Nostr profile'));
      release(new Map([[KEY, { displayName: 'Late Name' }]]));
      await new Promise(r => setTimeout(r, 20));
      expect(nameBox().value).toBe('alice');
    });

    it('leaving the page while the address resolves starts no relay query', async () => {
      let release: (v: { pubkey: string }) => void = () => {};
      mockResolve.mockReturnValue(new Promise(r => { release = r as never; }) as never);
      renderPage(vi.fn(async () => {}));
      lookUp('alice@example.com');
      cleanup();
      release({ pubkey: KEY });
      await new Promise(r => setTimeout(r, 20));
      expect(mockProfiles).not.toHaveBeenCalled();
    });

    it('cleans a hostile or over-long profile name before it fills the Name field', async () => {
      const hostile = '\u202Eevil' + 'x'.repeat(300);
      mockProfiles.mockResolvedValue(new Map([[KEY, { displayName: hostile }]]));
      renderPage(vi.fn(async () => {}));
      lookUp('alice@example.com');
      await waitFor(() => expect(nameBox().value).not.toBe('alice'));
      expect(nameBox().value).not.toContain('\u202E');
      expect(nameBox().value.length).toBeLessThanOrEqual(100);
    });

    it('takes only the name from the profile: no picture is shown or requested', async () => {
      mockProfiles.mockResolvedValue(new Map([[KEY, { displayName: 'Alice', pictureUrl: 'https://evil.example/face.png' }]]));
      renderPage(vi.fn(async () => {}));
      lookUp('alice@example.com');
      await waitFor(() => expect(nameBox().value).toBe('Alice'));
      expect(document.querySelector('img')).toBeNull();
      expect(document.body.innerHTML).not.toContain('evil.example');
    });
  });
});
