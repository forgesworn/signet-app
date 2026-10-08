// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContactDetail } from './ContactDetail';
import type { EffectiveContact, SignetIdentity } from '../types';
import { resolveActorRights } from '../lib/contacts-v2-rights';
import { detailSections } from '../lib/contacts-v2-detail';
import { CONTACT_ACTION_FAILED_COPY, pictureBackupAskBody } from '../lib/contacts-v2-copy';
import type { PictureBackupHost } from './ContactDetail';
import { useContactPicture } from '../hooks/useContactPicture';

// The crop screen has its own tests; here it is a stub that hands back a fixed crop.
const CROP = { x: 0.1, y: 0.2, side: 0.5 };
vi.mock('../components/ContactPictureCrop', () => ({
  ContactPictureCrop: ({ onUse, onCancel }: { onUse: (c: typeof CROP) => void; onCancel: () => void }) => (
    <div role="dialog" aria-label="crop stub">
      <button onClick={() => onUse(CROP)}>Use this picture</button>
      <button onClick={onCancel}>Cancel crop</button>
    </div>
  ),
}));
vi.mock('../hooks/useContactPicture', () => ({ useContactPicture: vi.fn() }));
const NO_PICTURE = { url: null, badgeUrl: null, hasOwn: false, backup: null };
beforeEach(() => { vi.mocked(useContactPicture).mockReturnValue(NO_PICTURE); });

// A 3 x 2 PNG: passes the header gate. GIF and the empty file do not.
const PNG_3x2 = 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFUlEQVR4nGM8wcXFwMDAwMDAxAADABByAOAp6i43AAAAAElFTkSuQmCC';
const GIF = 'R0lGODdhAwACAIEAAMgKCgAAAAAAAAAAACwAAAAAAwACAAAIBgABCBwYEAA7';
const bytesOf = (b64: string) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
const pngFile = (name = 'me.png') => new File([bytesOf(PNG_3x2)], name, { type: 'image/png' });
const gifFile = () => new File([bytesOf(GIF)], 'x.gif', { type: 'image/gif' });
const pick = (file: File) => fireEvent.change(screen.getByLabelText('Add your own picture'), { target: { files: [file] } });


const ME = '1'.repeat(64);
const GUARDIAN = '2'.repeat(64);

function identity(): SignetIdentity {
  return {
    id: ME, mnemonic: '',
    naturalPerson: { publicKey: ME, privateKey: '', displayName: 'Real' },
    persona: { publicKey: 'b'.repeat(64), privateKey: '', displayName: 'Anon' },
    primaryKeypair: 'persona', isChild: false, createdAt: 1,
  } as SignetIdentity;
}

function contact(over: Partial<EffectiveContact> = {}): EffectiveContact {
  return {
    directoryId: 'owner', contactId: 'c1', type: 'person', displayName: 'Dave',
    tier: 'kin', roles: [], identities: [], contactMethods: [], accessGrants: [],
    lifecycle: 'active', createdAt: 1, updatedAt: 2,
    createdByActorRole: 'owner', createdByOperationId: 'op-1',
    vouches: [], ceilings: [], blocks: [],
    effectiveTier: 'kin', tierSource: 'direct', blocked: false, blockedBy: [],
    ...over,
  };
}

function detailProps(record: EffectiveContact, actorRole: 'owner' | 'dependant', handlers: Record<string, unknown> = {}) {
  const rights = resolveActorRights(record, { actorRole, actorPubkey: ME });
  const legacy = { hasSharedSecret: false, hasKenEntry: false };
  const noop = async () => {};
  return {
    contact: record,
    identity: identity(),
    rights,
    sections: detailSections(record, rights, legacy),
    legacy,
    legacyContact: undefined,
    actorPubkey: ME,
    guardianName: 'Joe',
    onRename: noop,
    onSetTier: noop,
    onAddRole: noop,
    onRemoveRole: noop,
    onAddMethod: noop,
    onRemoveItem: noop,
    onSetNote: noop,
    onBlock: noop,
    onUnblock: noop,
    onRemove: noop,
    onOpenKenDetail: () => {},
    ...handlers,
  };
}

function renderDetail(record: EffectiveContact, actorRole: 'owner' | 'dependant', handlers = {}) {
  return render(<ContactDetail {...detailProps(record, actorRole, handlers)} />);
}

describe('ContactDetail on v2', () => {
  it('shows the keyless marker and explainer when there is no identity', () => {
    renderDetail(contact(), 'owner');
    expect(screen.getByText('No key verified')).toBeDefined();
    expect(screen.getByText(/need a verified key/)).toBeDefined();
  });

  it('shows the effective tier line with provenance', () => {
    renderDetail(contact({ effectiveTier: 'ken', tierSource: 'guardian-limited' }), 'dependant');
    expect(screen.getByText('Joe limited this to Ken')).toBeDefined();
  });

  it('offers Block with a reason field and reports the boundary', () => {
    const onBlock = vi.fn(async () => {});
    renderDetail(contact(), 'owner', { onBlock });
    fireEvent.click(screen.getByRole('button', { name: 'Block' }));
    fireEvent.change(screen.getByLabelText('Reason (optional)'), { target: { value: 'spam' } });
    expect(screen.getByText(/cannot stop someone posting on Nostr/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Block Dave' }));
    expect(onBlock).toHaveBeenCalledWith('spam');
  });

  it('disables Unblock with the guardian copy for a dependant', () => {
    const record = contact({
      blocked: true, blockedBy: [GUARDIAN],
      blocks: [{ blockedBy: GUARDIAN, scope: { kind: 'contact' }, blockedAt: 5, operationId: 'op-b' }],
    });
    renderDetail(record, 'dependant');
    expect(screen.getByText('Joe blocked Dave')).toBeDefined();
    const unblock = screen.getByRole('button', { name: 'Unblock' }) as HTMLButtonElement;
    expect(unblock.disabled).toBe(true);
    expect(screen.getByText('A guardian applied this block')).toBeDefined();
  });

  it('enables Unblock for the actor own block', () => {
    const record = contact({
      blocked: true, blockedBy: [ME],
      blocks: [{ blockedBy: ME, scope: { kind: 'contact' }, blockedAt: 5, operationId: 'op-b' }],
    });
    renderDetail(record, 'owner');
    expect(screen.getByText('Blocked by you')).toBeDefined();
    expect((screen.getByRole('button', { name: 'Unblock' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('adds a contact method through the validator', () => {
    const onAddMethod = vi.fn(async () => {});
    renderDetail(contact(), 'owner', { onAddMethod });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'dave@example.com' } });
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'email' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add method' }));
    expect(onAddMethod).toHaveBeenCalledWith({
      kind: 'email', value: 'dave@example.com',
      verification: 'unverified', sharingPolicy: 'private',
    });
  });

  it('confirms before removing', () => {
    const onRemove = vi.fn(async () => {});
    renderDetail(contact(), 'owner', { onRemove });
    fireEvent.click(screen.getByRole('button', { name: 'Remove contact' }));
    expect(screen.getByText(/Remove Dave from your contacts/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onRemove).toHaveBeenCalled();
  });

  // I1 (fix round 1): a rejected mutator must not become a silent unhandled
  // rejection. `onRemove` is the closest stand-in for "the navigation
  // callback" this page has — in App.tsx it's `async () => { await
  // contactsV2.removeContact(...); navigateReplace('contacts'); }`, so a
  // rejection here is exactly the case where navigation must never fire.
  // The page itself has no separate navigation prop to assert against, so
  // this asserts the error copy renders and `onRemove` was invoked exactly
  // once (no retry-on-failure loop hiding the rejection).
  it('shows the error copy when a mutation rejects, and does not retry', async () => {
    const onRemove = vi.fn(async () => { throw new Error('boom'); });
    renderDetail(contact(), 'owner', { onRemove });
    fireEvent.click(screen.getByRole('button', { name: 'Remove contact' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText(CONTACT_ACTION_FAILED_COPY)).toBeDefined();
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  // M6
  it('requires field selection before exporting even an unclassified contact', () => {
    const record = contact({
      effectiveTier: 'none', tierSource: 'direct',
      identities: [{ itemId: 'i1', pubkey: 'a'.repeat(64), provenance: 'direct', verification: 'proven', addedAt: 1 }],
    });
    renderDetail(record, 'owner');
    expect(screen.queryByRole('link', { name: /vCard/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Choose fields to share' }));
    expect(screen.getByRole('link', { name: /vCard/ })).toBeDefined();
    expect(screen.getByRole('checkbox', { name: /Public key/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Notes' })).not.toBeChecked();
  });

  // M10
  it('re-seeds the name and note drafts when the record changes underneath an untouched field', () => {
    const record = contact({ displayName: 'Dave', notes: 'old note' });
    const { rerender } = render(<ContactDetail {...detailProps(record, 'owner')} />);
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Dave');
    expect((screen.getByLabelText('Private note') as HTMLTextAreaElement).value).toBe('old note');

    const renamed = contact({ displayName: 'David', notes: 'new note' });
    rerender(<ContactDetail {...detailProps(renamed, 'owner')} />);
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('David');
    expect((screen.getByLabelText('Private note') as HTMLTextAreaElement).value).toBe('new note');
  });

  it('never clobbers a touched name or note draft with an incoming record change', () => {
    const record = contact({ displayName: 'Dave', notes: 'old note' });
    const { rerender } = render(<ContactDetail {...detailProps(record, 'owner')} />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My draft name' } });
    fireEvent.change(screen.getByLabelText('Private note'), { target: { value: 'my draft note' } });

    const renamed = contact({ displayName: 'David', notes: 'new note' });
    rerender(<ContactDetail {...detailProps(renamed, 'owner')} />);

    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('My draft name');
    expect((screen.getByLabelText('Private note') as HTMLTextAreaElement).value).toBe('my draft note');
  });
});

describe('ContactDetail — your own picture', () => {
  it('is offered for a keyless contact, crops the picked file, then sends the file and the crop', async () => {
    const onSetOwnPicture = vi.fn(async () => 'saved' as const);
    renderDetail(contact(), 'owner', { onSetOwnPicture, onRemoveOwnPicture: vi.fn() });
    expect(screen.getByRole('button', { name: 'Add your own picture' })).toBeDefined();
    const file = pngFile();
    pick(file);
    // The crop screen opens once the file has passed the header gate; nothing is saved yet.
    fireEvent.click(await screen.findByRole('button', { name: 'Use this picture' }));
    await vi.waitFor(() => expect(onSetOwnPicture).toHaveBeenCalledWith(file, CROP));
    expect(screen.queryByRole('dialog', { name: 'crop stub' })).toBeNull();
  });

  it('Cancel on the crop screen saves nothing', async () => {
    const onSetOwnPicture = vi.fn(async () => 'saved' as const);
    renderDetail(contact(), 'owner', { onSetOwnPicture });
    pick(pngFile());
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel crop' }));
    expect(screen.queryByRole('dialog', { name: 'crop stub' })).toBeNull();
    expect(onSetOwnPicture).not.toHaveBeenCalled();
  });

  it('a photo the header gate refuses says so and never opens the crop screen', async () => {
    const onSetOwnPicture = vi.fn(async () => 'saved' as const);
    renderDetail(contact(), 'owner', { onSetOwnPicture });
    pick(gifFile());
    expect(await screen.findByText("That picture couldn't be used. Choose a JPEG, PNG or WebP photo.")).toBeDefined();
    expect(screen.queryByRole('dialog', { name: 'crop stub' })).toBeNull();
    expect(onSetOwnPicture).not.toHaveBeenCalled();
  });

  it('an empty or oversized file is refused the same way', async () => {
    renderDetail(contact(), 'owner', { onSetOwnPicture: vi.fn(async () => 'saved' as const) });
    pick(new File([], 'empty.png'));
    expect(await screen.findByText("That picture couldn't be used. Choose a JPEG, PNG or WebP photo.")).toBeDefined();
    const big = pngFile('big.png');
    Object.defineProperty(big, 'size', { value: 21 * 1024 * 1024 });
    pick(big);
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Add your own picture' })).toHaveProperty('disabled', false));
    expect(screen.queryByRole('dialog', { name: 'crop stub' })).toBeNull();
    expect(screen.getByText("That picture couldn't be used. Choose a JPEG, PNG or WebP photo.")).toBeDefined();
  });

  it('says so when the photo could not be read, without opening the crop screen', async () => {
    renderDetail(contact(), 'owner', { onSetOwnPicture: vi.fn(async () => 'saved' as const) });
    const file = pngFile();
    Object.defineProperty(file, 'arrayBuffer', { value: () => Promise.reject(new Error('picker uri')) });
    pick(file);
    expect(await screen.findByText("Couldn't read that photo. Pick it again.")).toBeDefined();
    expect(screen.queryByRole('dialog', { name: 'crop stub' })).toBeNull();
  });

  it('says so when the saved crop is then refused or unreadable', async () => {
    const onSetOwnPicture = vi.fn<(file: File, crop: typeof CROP) => Promise<'refused' | 'unreadable'>>(async () => 'refused');
    renderDetail(contact(), 'owner', { onSetOwnPicture });
    pick(pngFile());
    fireEvent.click(await screen.findByRole('button', { name: 'Use this picture' }));
    expect(await screen.findByText("That picture couldn't be used. Choose a JPEG, PNG or WebP photo.")).toBeDefined();
    onSetOwnPicture.mockResolvedValueOnce('unreadable');
    pick(pngFile('again.png'));
    fireEvent.click(await screen.findByRole('button', { name: 'Use this picture' }));
    expect(await screen.findByText("Couldn't read that photo. Pick it again.")).toBeDefined();
  });

  it('shows nothing when the app locked mid-save, and the generic copy on a throw', async () => {
    const onSetOwnPicture = vi.fn<(file: File, crop: typeof CROP) => Promise<'locked'>>(async () => 'locked');
    renderDetail(contact(), 'owner', { onSetOwnPicture });
    pick(pngFile());
    fireEvent.click(await screen.findByRole('button', { name: 'Use this picture' }));
    await vi.waitFor(() => expect(onSetOwnPicture).toHaveBeenCalled());
    // Busy clears in the same render as any error, so this waits for the outcome to land.
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Add your own picture' })).toHaveProperty('disabled', false));
    expect(screen.queryByText(/couldn't|didn't save/i)).toBeNull();
    onSetOwnPicture.mockRejectedValueOnce(new Error('idb'));
    pick(pngFile('y.png'));
    fireEvent.click(await screen.findByRole('button', { name: 'Use this picture' }));
    expect(await screen.findByText("That change didn't save. Try again.")).toBeDefined();
  });

  it('is absent when the host passes no handler', () => {
    renderDetail(contact(), 'owner');
    expect(screen.queryByRole('button', { name: 'Add your own picture' })).toBeNull();
  });
});

describe('ContactDetail — swapping the two pictures', () => {
  const avatarSrcs = (container: HTMLElement) => {
    const imgs = container.querySelectorAll('img');
    return { main: imgs[0]?.getAttribute('src'), badge: imgs[1]?.getAttribute('src') };
  };

  it('has no swap button with only one picture', () => {
    vi.mocked(useContactPicture).mockReturnValue({ url: 'blob:own', badgeUrl: null, hasOwn: true, backup: 'local' as const });
    renderDetail(contact(), 'owner');
    expect(screen.queryByRole('button', { name: 'Show their picture' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show your picture' })).toBeNull();
  });

  it('has no swap button with no picture', () => {
    renderDetail(contact(), 'owner');
    expect(screen.queryByRole('button', { name: /Show (their|your) picture/ })).toBeNull();
  });

  it('opens with yours as main and theirs as the badge, and tapping swaps them and back', () => {
    vi.mocked(useContactPicture).mockReturnValue({ url: 'blob:own', badgeUrl: 'blob:theirs', hasOwn: true, backup: 'local' as const });
    const { container } = renderDetail(contact(), 'owner');
    expect(avatarSrcs(container)).toEqual({ main: 'blob:own', badge: 'blob:theirs' });
    fireEvent.click(screen.getByRole('button', { name: 'Show their picture' }));
    expect(avatarSrcs(container)).toEqual({ main: 'blob:theirs', badge: 'blob:own' });
    fireEvent.click(screen.getByRole('button', { name: 'Show your picture' }));
    expect(avatarSrcs(container)).toEqual({ main: 'blob:own', badge: 'blob:theirs' });
  });

  it('the swap is not saved: it resets when their picture goes away and comes back', () => {
    vi.mocked(useContactPicture).mockReturnValue({ url: 'blob:own', badgeUrl: 'blob:theirs', hasOwn: true, backup: 'local' as const });
    const props = detailProps(contact(), 'owner');
    const { container, rerender } = render(<ContactDetail {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show their picture' }));
    vi.mocked(useContactPicture).mockReturnValue({ url: 'blob:own', badgeUrl: null, hasOwn: true, backup: 'local' as const });
    rerender(<ContactDetail {...props} />);
    vi.mocked(useContactPicture).mockReturnValue({ url: 'blob:own', badgeUrl: 'blob:theirs', hasOwn: true, backup: 'local' as const });
    rerender(<ContactDetail {...props} />);
    expect(avatarSrcs(container)).toEqual({ main: 'blob:own', badge: 'blob:theirs' });
  });
});

describe('ContactDetail — own picture backup status line and ask', () => {
  const host = (over: Partial<PictureBackupHost> = {}): PictureBackupHost => ({
    availability: 'possible', serverHost: 'nostr.download', ask: false,
    onAnswer: vi.fn(async () => {}), onBackItUp: vi.fn(async () => {}), ...over,
  });
  const own = (backup: 'synced' | 'pending' | 'local') =>
    vi.mocked(useContactPicture).mockReturnValue({ url: 'blob:own', badgeUrl: null, hasOwn: true, backup });
  const show = (h: PictureBackupHost) => renderDetail(contact(), 'owner', { onSetOwnPicture: vi.fn(), pictureBackup: h });
  const backItUp = () => screen.queryByRole('button', { name: 'Back it up' });

  it('synced: "Backed up, encrypted", no link', () => {
    own('synced'); show(host());
    expect(screen.getByRole('status').textContent).toBe('Backed up, encrypted');
    expect(backItUp()).toBeNull();
  });

  it('pending: "Not backed up yet", no link', () => {
    own('pending'); show(host());
    expect(screen.getByRole('status').textContent).toBe('Not backed up yet');
    expect(backItUp()).toBeNull();
  });

  it('local with uploads possible: "Only on this phone" and a "Back it up" link that calls the host', async () => {
    own('local');
    const h = host();
    show(h);
    expect(screen.getByRole('status').textContent).toContain('Only on this phone');
    fireEvent.click(backItUp()!);
    await vi.waitFor(() => expect(h.onBackItUp).toHaveBeenCalledTimes(1));
  });

  it('local with Blossom uploads off: the settings sentence, no link', () => {
    own('local'); show(host({ availability: 'uploads-off' }));
    expect(screen.getByRole('status').textContent).toBe('Only on this phone. Blossom uploads are off in Advanced settings.');
    expect(backItUp()).toBeNull();
  });

  it('paired-child: "Only on this phone.", no link, no ask', () => {
    own('local'); show(host({ availability: 'paired-child', ask: true }));
    expect(screen.getByRole('status').textContent).toBe('Only on this phone.');
    expect(backItUp()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Back them up' })).toBeNull();
  });

  it('shows no status line without an own picture', () => {
    vi.mocked(useContactPicture).mockReturnValue(NO_PICTURE);
    show(host());
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows no ask unless the host says so', () => {
    own('local'); show(host({ ask: false }));
    expect(screen.queryByRole('button', { name: 'Back them up' })).toBeNull();
  });

  it('the ask names the server and its buttons answer yes and no', async () => {
    own('local');
    const h = host({ ask: true });
    show(h);
    expect(screen.getByText('Back up your contact pictures?')).toBeDefined();
    expect(screen.getByText(pictureBackupAskBody('nostr.download'))).toBeDefined();
    expect(pictureBackupAskBody('nostr.download')).toBe("They're encrypted on this phone first, then stored on nostr.download. The server can't see them, but it does see your IP address when you save or restore one.");
    fireEvent.click(screen.getByRole('button', { name: 'Back them up' }));
    await vi.waitFor(() => expect(h.onAnswer).toHaveBeenLastCalledWith(true));
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Only on this phone' })).toHaveProperty('disabled', false));
    fireEvent.click(screen.getByRole('button', { name: 'Only on this phone' }));
    await vi.waitFor(() => expect(h.onAnswer).toHaveBeenLastCalledWith(false));
  });

  it('a failing answer shows the action-failed copy', async () => {
    own('local');
    show(host({ ask: true, onAnswer: vi.fn(async () => { throw new Error('x'); }) }));
    fireEvent.click(screen.getByRole('button', { name: 'Back them up' }));
    expect(await screen.findByText(CONTACT_ACTION_FAILED_COPY)).toBeDefined();
  });
});
