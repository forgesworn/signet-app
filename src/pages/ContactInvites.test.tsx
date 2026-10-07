// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContactInvites } from './ContactInvites';
import { ContactCardPhotoError } from '../lib/contact-card-share';
import { shortNpub } from '../lib/nostr-follows';

const avatarHook = vi.hoisted(() => vi.fn());
const fetchAvatar = vi.hoisted(() => vi.fn());
const fetchPointer = vi.hoisted(() => vi.fn());
vi.mock('../hooks/useContactAvatar', () => ({ useContactAvatar: avatarHook, seedContactAvatarPointer: vi.fn() }));
vi.mock('../lib/avatar', () => ({ fetchAvatar }));
vi.mock('../lib/contact-avatar', () => ({ fetchContactAvatarPointer: fetchPointer }));

const ME = 'a'.repeat(64), FROM = 'b'.repeat(64);
const request = (card?: unknown) => ({ v: 1, type: 'signet-contact-request', id: 'f'.repeat(32), from: FROM, to: ME, createdAt: 1, expiresAt: 2e9,
  commitment: 'c'.repeat(64), reply: { secret: 'd'.repeat(64), relays: ['wss://relay.example'] }, ...(card ? { card } : {}) });
const vault = (req: unknown) => ({ invites: [], exchanges: [], outbox: [], arrivals: [{ id: 'arr1', inviteId: 'inv1', identityPubkey: ME, receivedAt: 1, request: req }] });
function setup(req: unknown, cards?: Parameters<typeof ContactInvites>[0]['cards']) {
  const service = { read: vi.fn(async () => vault(req)), accept: vi.fn(async () => {}), flush: vi.fn(async () => {}), dismiss: vi.fn(async () => {}) };
  render(<ContactInvites service={service as never} identityPubkey={ME} identityName="Pip" relays={[]} version={0} cards={cards}
    onAddContact={async () => {}} onBack={() => {}} />);
  return service;
}
const info = { name: 'Pip', hasPhoto: true };
beforeEach(() => { vi.clearAllMocks(); });

describe('request row', () => {
  it('calls the sender by the name they declared, never as fact, with their short key', async () => {
    setup(request({ name: 'Mum', photo: { key: '1'.repeat(64), server: 'https://blossom.example.com/', hash: '2'.repeat(64) } }));
    await screen.findByText('Request from someone calling themselves “Mum”');
    expect(screen.getByText(shortNpub(FROM))).toBeTruthy();
  });
  it('keeps today\'s wording when the request has no card name', async () => {
    setup(request());
    await screen.findByText(`Request from ${FROM.slice(0, 12)}…`);
    expect(screen.queryByText(/calling themselves/)).toBeNull();
  });
  it('fetches nothing and renders no avatar for an unaccepted request, even with a photo in the card', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    setup(request({ name: 'Mum', photo: { key: '1'.repeat(64), server: 'https://blossom.example.com/', hash: '2'.repeat(64) } }));
    await screen.findByText(/calling themselves/);
    expect(avatarHook).not.toHaveBeenCalled();
    expect(fetchAvatar).not.toHaveBeenCalled();
    expect(fetchPointer).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(document.querySelector('img')).toBeNull();
    fetchSpy.mockRestore();
  });
});

describe('accepting with a card', () => {
  it('shows the chips only when cards are offered (not for a paired child)', async () => {
    setup(request(), undefined);
    await screen.findByRole('button', { name: 'Accept request' });
    expect(screen.queryByText("They'll see:")).toBeNull();
  });
  it('builds nothing on tick; builds on Accept and passes the card to service.accept', async () => {
    const card = { name: 'Pip', photo: { key: '1'.repeat(64), server: 'https://blossom.example.com/', hash: '2'.repeat(64) } };
    const build = vi.fn(async () => card);
    const service = setup(request(), { infoFor: () => info, build });
    const photo = await screen.findByLabelText('Your photo');
    expect((photo as HTMLInputElement).checked).toBe(false);
    fireEvent.click(photo); fireEvent.click(photo); fireEvent.click(photo);
    expect(build).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Accept request' }));
    await waitFor(() => expect(service.accept).toHaveBeenCalledTimes(1));
    expect(build).toHaveBeenCalledWith(ME, { name: true, photo: true });
    expect(service.accept).toHaveBeenCalledWith('arr1', expect.any(Number), false, false, card);
  });
  it('accepts nothing when the photo cannot be shared, and offers "Accept without your photo"', async () => {
    const build = vi.fn<(p: string, c: { name: boolean; photo: boolean }) => Promise<undefined | { name: string }>>()
      .mockRejectedValueOnce(new ContactCardPhotoError()).mockResolvedValueOnce({ name: 'Pip' });
    const service = setup(request(), { infoFor: () => info, build: build as never });
    fireEvent.click(await screen.findByLabelText('Your photo'));
    fireEvent.click(screen.getByRole('button', { name: 'Accept request' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe("Your photo couldn't be shared, so nothing was sent."));
    expect(service.accept).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Accept without your photo' }));
    await waitFor(() => expect(service.accept).toHaveBeenCalledTimes(1));
    expect(build).toHaveBeenLastCalledWith(ME, { name: true, photo: false });
    expect(service.accept).toHaveBeenCalledWith('arr1', expect.any(Number), false, false, { name: 'Pip' });
  });
});
