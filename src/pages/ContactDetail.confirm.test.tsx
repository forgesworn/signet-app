// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { nip19 } from 'nostr-tools';
import { ContactDetail } from './ContactDetail';
import type { ContactIdentity, EffectiveContact, SignetIdentity } from '../types';
import { resolveActorRights } from '../lib/contacts-v2-rights';
import { detailSections } from '../lib/contacts-v2-detail';
import { ConfirmMergeRefusedError, applyConfirmSteps, type ConfirmOps } from '../lib/contacts-v2-confirm';
import { encodeNpub } from '../lib/signet';
import { hexToBytes } from '@noble/hashes/utils.js';

vi.mock('../hooks/useCamera', () => ({
  useCamera: () => ({ hasPermission: true, error: null, requestPermission: vi.fn() }),
}));
// A scanner stand-in: type what the camera "saw", then press the button.
vi.mock('../components/QRScanner', () => ({
  QRScanner: ({ onScan }: { onScan: (data: string) => void }) => {
    let value = '';
    return (
      <div>
        <input aria-label="scanned data" onChange={e => { value = e.target.value; }} />
        <button onClick={() => onScan(value)}>Simulate scan</button>
      </div>
    );
  },
}));

const ME = '1'.repeat(64);
const OWNER_LIST = '3'.repeat(64);
const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);
const ITEM = '5'.repeat(32);
const npubOf = (hex: string) => encodeNpub(hexToBytes(hex));
const thisYear2Oct = new Date(new Date().getFullYear(), 9, 2, 12).getTime();

afterEach(cleanup);

function identity(): SignetIdentity {
  return {
    id: ME, mnemonic: '',
    naturalPerson: { publicKey: ME, privateKey: '', displayName: 'Real' },
    persona: { publicKey: 'c'.repeat(64), privateKey: '', displayName: 'Anon' },
    primaryKeypair: 'persona', isChild: false, createdAt: 1,
  } as SignetIdentity;
}
const ident = (over: Partial<ContactIdentity> = {}): ContactIdentity => ({
  itemId: ITEM, pubkey: OLD, provenance: 'direct', verification: 'unverified', addedAt: 1, ...over,
});
function contact(over: Partial<EffectiveContact> = {}): EffectiveContact {
  return {
    directoryId: 'owner', contactId: 'c1', type: 'person', displayName: 'Dave',
    tier: 'ken', roles: [], identities: [ident()], contactMethods: [], accessGrants: [],
    lifecycle: 'active', createdAt: 1, updatedAt: 2,
    createdByActorRole: 'owner', createdByOperationId: 'op-1',
    vouches: [], ceilings: [], blocks: [],
    effectiveTier: 'ken', tierSource: 'direct', blocked: false, blockedBy: [],
    ...over,
  };
}

function setup(record: EffectiveContact, extra: Record<string, unknown> = {}) {
  const ops = {
    addIdentity: vi.fn(async () => 'f'.repeat(32)),
    recordCheck: vi.fn(async () => {}),
    updateIdentity: vi.fn(async () => {}),
    removeItem: vi.fn(async () => {}),
    setTier: vi.fn(async () => {}),
  } satisfies ConfirmOps;
  const rights = resolveActorRights(record, { actorRole: 'owner', actorPubkey: ME });
  const legacy = { hasSharedSecret: false, hasKenEntry: false };
  const noop = async () => {};
  const onStartExchange = vi.fn();
  render(<ContactDetail
    contact={record} identity={identity()} rights={rights}
    sections={detailSections(record, rights, legacy)} legacy={legacy} legacyContact={undefined}
    actorPubkey={ME} guardianName={null}
    onRename={noop} onSetTier={noop} onAddRole={noop} onRemoveRole={noop} onAddMethod={noop}
    onRemoveItem={noop} onSetNote={noop} onBlock={noop} onUnblock={noop} onRemove={noop}
    onOpenKenDetail={() => {}}
    checkOwnerIdentityPubkey={OWNER_LIST}
    onApplyConfirmation={steps => applyConfirmSteps(steps, record.contactId, ops, () => 1234)}
    confirmContacts={[record]}
    ownPubkeys={[ME]}
    onStartExchange={onStartExchange}
    {...extra}
  />);
  return { ops, onStartExchange };
}

const flow = () => within(screen.getByRole('group', { name: "Confirm it's them" }));
const open = () => fireEvent.click(screen.getByRole('button', { name: "Confirm it's them" }));
const scan = (data: string) => {
  fireEvent.click(screen.getByRole('button', { name: 'Scan their QR code' }));
  fireEvent.change(screen.getByLabelText('scanned data'), { target: { value: data } });
  fireEvent.click(screen.getByRole('button', { name: 'Simulate scan' }));
};

describe('Confirm it\'s them on ContactDetail', () => {
  it('offers the button on an unconfirmed key only, and says "Not verified" until then', () => {
    setup(contact());
    expect(screen.getByText(/Not verified/)).toBeDefined();
    expect(screen.getByRole('button', { name: "Confirm it's them" })).toBeDefined();
  });

  it('shows the newest check on a confirmed key instead of the button', () => {
    setup(contact({
      identities: [ident({ verification: 'proven' })],
      checks: [
        { id: '1'.repeat(32), identityPubkey: OLD, ownerIdentityPubkey: OWNER_LIST, method: 'words', checkedAt: thisYear2Oct - 86_400_000 * 40 },
        { id: '2'.repeat(32), identityPubkey: OLD, ownerIdentityPubkey: OWNER_LIST, method: 'in-person', checkedAt: thisYear2Oct },
      ],
    }));
    expect(screen.getByText(/Confirmed in person · 2 Oct/)).toBeDefined();
    expect(screen.queryByText(/Not verified/)).toBeNull();
    expect(screen.queryByRole('button', { name: "Confirm it's them" })).toBeNull();
  });

  it('falls back to the stored verification when a confirmed key has no check', () => {
    setup(contact({ identities: [ident({ verification: 'mutual' })] }));
    expect(screen.getByText(/Mutually verified/)).toBeDefined();
  });

  it('hides the button without a handler or a selected identity list', () => {
    setup(contact(), { onApplyConfirmation: undefined });
    expect(screen.queryByRole('button', { name: "Confirm it's them" })).toBeNull();
    cleanup();
    setup(contact(), { checkOwnerIdentityPubkey: undefined });
    expect(screen.queryByRole('button', { name: "Confirm it's them" })).toBeNull();
  });

  it('scan match on a Ken: records the check, lifts to proven, then asks about Kith', async () => {
    const { ops } = setup(contact());
    open();
    scan(npubOf(OLD));
    await screen.findByText(/Move Dave to Kith\?/);
    expect(ops.recordCheck).toHaveBeenCalledWith('c1', { identityPubkey: OLD, method: 'in-person', checkedAt: 1234 });
    expect(ops.updateIdentity).toHaveBeenCalledWith('c1', { itemId: ITEM, verification: 'proven' });
    expect(ops.setTier).not.toHaveBeenCalled();
    fireEvent.click(flow().getByRole('button', { name: 'Kith' }));
    await waitFor(() => expect(ops.setTier).toHaveBeenCalledWith('c1', 'kith'));
  });

  it('Kin and Keep as Ken are the other answers', async () => {
    const { ops } = setup(contact());
    open(); scan(npubOf(OLD));
    fireEvent.click(await within(await screen.findByRole('group', { name: "Confirm it's them" })).findByRole('button', { name: 'Kin' }));
    await waitFor(() => expect(ops.setTier).toHaveBeenCalledWith('c1', 'kin'));
    cleanup();
    const second = setup(contact());
    open(); scan(npubOf(OLD));
    fireEvent.click(await screen.findByRole('button', { name: 'Keep as Ken' }));
    await screen.findByText(/Confirmed\. This is Dave's key\./);
    expect(second.ops.setTier).not.toHaveBeenCalled();
  });

  it('asks nothing about the tier for a Kith or a Kin', async () => {
    for (const tier of ['kith', 'kin'] as const) {
      const { ops } = setup(contact({ tier, effectiveTier: tier }));
      open(); scan(npubOf(OLD));
      await screen.findByText(/Confirmed\. This is Dave's key\./);
      expect(screen.queryByText(/Move Dave to Kith/)).toBeNull();
      expect(ops.setTier).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it('asks about the contact own tier, not a guardian-capped effective one', async () => {
    setup(contact({ tier: 'kith', effectiveTier: 'ken', tierSource: 'guardian-limited' }));
    open(); scan(npubOf(OLD));
    await screen.findByText(/Confirmed\./);
    expect(screen.queryByText(/Move Dave to Kith/)).toBeNull();
  });

  it('accepts nostr:npub and nprofile scans', async () => {
    const { ops } = setup(contact({ tier: 'kith' }));
    open(); scan(`nostr:${nip19.nprofileEncode({ pubkey: OLD, relays: ['wss://r.example'] })}`);
    await screen.findByText(/Confirmed\./);
    expect(ops.recordCheck).toHaveBeenCalledTimes(1);
  });

  it('reports an unreadable scan and writes nothing', async () => {
    const { ops } = setup(contact());
    open(); scan('not a key');
    expect(await screen.findByText(/Could not read a public key/)).toBeDefined();
    expect(ops.recordCheck).not.toHaveBeenCalled();
  });

  describe('mismatch', () => {
    async function mismatch(record = contact()) {
      const r = setup(record);
      open(); scan(npubOf(NEW));
      await screen.findByText("This isn't the key you have for Dave.");
      return r;
    }

    it('Use the new key: adds the scanned key confirmed, checks it, removes the old one', async () => {
      const { ops } = await mismatch();
      expect(ops.addIdentity).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Use the new key' }));
      await screen.findByText('Saved.');
      expect(ops.addIdentity).toHaveBeenCalledWith('c1', { pubkey: NEW, provenance: 'direct', verification: 'proven' }, { refuseMerge: true });
      expect(ops.recordCheck).toHaveBeenCalledWith('c1', { identityPubkey: NEW, method: 'in-person', checkedAt: 1234 });
      expect(ops.removeItem).toHaveBeenCalledWith('c1', ITEM);
    });

    it('Keep both: adds the scanned key and removes nothing', async () => {
      const { ops } = await mismatch();
      fireEvent.click(screen.getByRole('button', { name: 'Keep both' }));
      await screen.findByText('Saved.');
      expect(ops.addIdentity).toHaveBeenCalledWith('c1', { pubkey: NEW, provenance: 'direct', verification: 'proven' }, { refuseMerge: true });
      expect(ops.removeItem).not.toHaveBeenCalled();
    });

    it("The old key isn't theirs: adds the scanned key and removes the old one, with no block option", async () => {
      const { ops } = await mismatch();
      expect(flow().queryByText(/block/i)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: "The old key isn't theirs" }));
      await screen.findByText('Saved.');
      expect(ops.addIdentity).toHaveBeenCalledTimes(1);
      expect(ops.removeItem).toHaveBeenCalledWith('c1', ITEM);
    });

    it('Cancel writes nothing', async () => {
      const { ops } = await mismatch();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      for (const fn of Object.values(ops)) expect(fn).not.toHaveBeenCalled();
    });

    describe('not sure', () => {
      const SURE = { name: "I'm not sure — leave it as it is" };
      const noWrites = (ops: Record<string, ReturnType<typeof vi.fn>>) => {
        for (const fn of Object.values(ops)) expect(fn).not.toHaveBeenCalled();
      };

      it('shows the option and that nothing is sent to them, on a scanned mismatch', async () => {
        await mismatch();
        expect(screen.getByRole('button', SURE)).toBeTruthy();
        expect(screen.getByText("Nothing is sent to them — they can't tell whether it matched or what you choose.")).toBeTruthy();
      });

      it('shows the same on the read-out mismatch', async () => {
        setup(contact());
        open();
        fireEvent.click(screen.getByRole('button', { name: 'Read it out on a call' }));
        fireEvent.click(screen.getByRole('button', { name: "It didn't match" }));
        await screen.findByText("This isn't the key you have for Dave.");
        expect(screen.getByRole('button', SURE)).toBeTruthy();
        expect(screen.getByText(/Nothing is sent to them/)).toBeTruthy();
      });

      it('ticked by default: appends one dated line to the existing note and writes nothing else', async () => {
        const onSetNote = vi.fn(async () => {});
        const { ops } = setup(contact({ notes: 'Met at the fair.' }), { onSetNote });
        open(); scan(npubOf(NEW));
        await screen.findByText("This isn't the key you have for Dave.");
        fireEvent.click(screen.getByRole('button', SURE));
        const box = screen.getByRole('checkbox', { name: 'Add a private note to Dave' }) as HTMLInputElement;
        expect(box.checked).toBe(true);
        fireEvent.click(screen.getByRole('button', { name: 'Done' }));
        await screen.findByText(/Left as it is/);
        expect(onSetNote).toHaveBeenCalledTimes(1);
        const written = (onSetNote.mock.calls[0] as unknown as [string])[0];
        const lines = written.split('\n');
        expect(lines[0]).toBe('Met at the fair.');
        expect(lines).toHaveLength(2);
        expect(lines[1]).toMatch(/^Showed me a different key on \d{1,2} \w+ \d{4} \(npub1.{4,}…\w+\) — not confirmed\.$/);
        noWrites(ops);
      });

      it('read-out path appends the line without a key', async () => {
        const onSetNote = vi.fn(async () => {});
        setup(contact(), { onSetNote });
        open();
        fireEvent.click(screen.getByRole('button', { name: 'Read it out on a call' }));
        fireEvent.click(screen.getByRole('button', { name: "It didn't match" }));
        await screen.findByText("This isn't the key you have for Dave.");
        fireEvent.click(screen.getByRole('button', SURE));
        fireEvent.click(screen.getByRole('button', { name: 'Done' }));
        await screen.findByText(/Left as it is/);
        expect((onSetNote.mock.calls[0] as unknown as [string])[0])
          .toMatch(/^Read out a different key on \d{1,2} \w+ \d{4} — not confirmed\.$/);
      });

      it('unticked writes nothing at all', async () => {
        const onSetNote = vi.fn(async () => {});
        const { ops } = setup(contact({ notes: 'Hi' }), { onSetNote });
        open(); scan(npubOf(NEW));
        await screen.findByText("This isn't the key you have for Dave.");
        fireEvent.click(screen.getByRole('button', SURE));
        fireEvent.click(screen.getByRole('checkbox', { name: 'Add a private note to Dave' }));
        fireEvent.click(screen.getByRole('button', { name: 'Done' }));
        await screen.findByText(/Left as it is/);
        expect(onSetNote).not.toHaveBeenCalled();
        noWrites(ops);
      });

      it('refuses to append past the note cap and keeps the note untouched', async () => {
        const onSetNote = vi.fn(async () => {});
        setup(contact({ notes: 'x'.repeat(1990) }), { onSetNote });
        open(); scan(npubOf(NEW));
        await screen.findByText("This isn't the key you have for Dave.");
        fireEvent.click(screen.getByRole('button', SURE));
        fireEvent.click(screen.getByRole('button', { name: 'Done' }));
        await screen.findByText(/too long to add to/);
        expect(onSetNote).not.toHaveBeenCalled();
      });
    });

    it('a write the queue refuses as a merge names the other contact and offers only Back', async () => {
      const { ops } = await mismatch();
      ops.addIdentity.mockRejectedValueOnce(new ConfirmMergeRefusedError({ contactId: 'c9', displayName: 'Bob', state: 'deleted' }));
      fireEvent.click(screen.getByRole('button', { name: 'Keep both' }));
      expect(await screen.findByText(/That key belongs to Bob, a contact you deleted/)).toBeDefined();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(flow().getAllByRole('button').map(b => b.textContent)).toEqual(['Back']);
      expect(ops.removeItem).not.toHaveBeenCalled();
    });

    it('a failed write shows the error copy and keeps the choices', async () => {
      const { ops } = await mismatch();
      ops.addIdentity.mockRejectedValueOnce(new Error('boom'));
      fireEvent.click(screen.getByRole('button', { name: 'Use the new key' }));
      expect(await screen.findByRole('alert')).toBeDefined();
      expect(screen.getByRole('button', { name: 'Keep both' })).toBeDefined();
    });
  });

  it('names a different contact that already holds the scanned key, and offers nothing', async () => {
    const erin = contact({ contactId: 'c2', displayName: 'Erin', identities: [ident({ itemId: '6'.repeat(32), pubkey: NEW })] });
    const { ops } = setup(contact(), { confirmContacts: [contact(), erin] });
    open(); scan(npubOf(NEW));
    expect(await screen.findByText(/already belongs to Erin/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Use the new key' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Keep both' })).toBeNull();
    for (const fn of Object.values(ops)) expect(fn).not.toHaveBeenCalled();
  });

  it('names a deleted contact that holds the scanned key, and offers only Back', async () => {
    const bob = contact({ contactId: 'c2', displayName: 'Bob', lifecycle: 'removed', identities: [ident({ itemId: '6'.repeat(32), pubkey: NEW })] });
    const { ops } = setup(contact(), { confirmContacts: [contact(), bob] });
    open(); scan(npubOf(NEW));
    expect(await screen.findByText(/That key belongs to Bob, a contact you deleted/)).toBeDefined();
    expect(flow().getAllByRole('button').map(b => b.textContent)).toEqual(['Back']);
    for (const fn of Object.values(ops)) expect(fn).not.toHaveBeenCalled();
  });

  it('names a contact the scanned key was once removed from', async () => {
    const erin = contact({ contactId: 'c2', displayName: 'Erin', identities: [] });
    const keyHolders = vi.fn(() => ['c2']);
    const { ops } = setup(contact(), { confirmContacts: [contact(), erin], confirmKeyHolderIds: keyHolders });
    open(); scan(npubOf(NEW));
    expect(await screen.findByText(/That key was once on Erin/)).toBeDefined();
    expect(keyHolders).toHaveBeenCalledWith(NEW);
    for (const fn of Object.values(ops)) expect(fn).not.toHaveBeenCalled();
  });

  it('says so when the scanned key is one of the user own keys', async () => {
    setup(contact());
    open(); scan(npubOf(ME));
    expect(await screen.findByText(/one of your own keys/)).toBeDefined();
  });

  describe('read it out', () => {
    it('shows the last 16 characters of the npub as four large groups of four', () => {
      setup(contact());
      open();
      fireEvent.click(screen.getByRole('button', { name: 'Read it out on a call' }));
      const groups = screen.getAllByTestId('readout-group').map(g => g.textContent);
      expect(groups).toHaveLength(4);
      expect(groups.every(g => g!.length === 4)).toBe(true);
      expect(groups.join('')).toBe(npubOf(OLD).slice(-16));
    });

    it('It matched records a words check and lifts to proven', async () => {
      const { ops } = setup(contact());
      open();
      fireEvent.click(screen.getByRole('button', { name: 'Read it out on a call' }));
      fireEvent.click(screen.getByRole('button', { name: 'It matched' }));
      await screen.findByText(/Move Dave to Kith\?/);
      expect(ops.recordCheck).toHaveBeenCalledWith('c1', { identityPubkey: OLD, method: 'words', checkedAt: 1234 });
      expect(ops.updateIdentity).toHaveBeenCalledWith('c1', { itemId: ITEM, verification: 'proven' });
    });

    it("It didn't match offers only 'The old key isn't theirs' and Cancel", async () => {
      const { ops } = setup(contact());
      open();
      fireEvent.click(screen.getByRole('button', { name: 'Read it out on a call' }));
      fireEvent.click(screen.getByRole('button', { name: "It didn't match" }));
      await screen.findByText("This isn't the key you have for Dave.");
      expect(screen.queryByRole('button', { name: 'Use the new key' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Keep both' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: "The old key isn't theirs" }));
      await screen.findByText('Saved.');
      expect(ops.removeItem).toHaveBeenCalledWith('c1', ITEM);
      expect(ops.addIdentity).not.toHaveBeenCalled();
    });
  });

  it('states the recognise rule before the options, and again on the scan and read-out screens', () => {
    setup(contact());
    open();
    expect(screen.getByText(/Only confirm someone you recognise — in person, or on a video call/)).toBeTruthy();
    expect(screen.getByText(/If you've never met them, a scan only shows the key this person holds/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Scan their QR code' }));
    expect(screen.getByText('Only confirm someone you recognise.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Read it out on a call' }));
    expect(screen.getByText('Only do this with someone you recognise.')).toBeTruthy();
  });

  it('They have My Signet hands over to the invite exchange unchanged', () => {
    const { onStartExchange, ops } = setup(contact());
    open();
    fireEvent.click(screen.getByRole('button', { name: 'They have My Signet' }));
    expect(onStartExchange).toHaveBeenCalledTimes(1);
    for (const fn of Object.values(ops)) expect(fn).not.toHaveBeenCalled();
  });

  it('omits the My Signet route where invites are unavailable', () => {
    setup(contact(), { onStartExchange: undefined });
    open();
    expect(screen.queryByRole('button', { name: 'They have My Signet' })).toBeNull();
    expect(flow().getByRole('button', { name: 'Scan their QR code' })).toBeDefined();
  });
});
