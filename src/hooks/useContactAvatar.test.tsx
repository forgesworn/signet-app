// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getContactAvatar = vi.hoisted(() => vi.fn());
const fetchContactAvatarPointer = vi.hoisted(() => vi.fn());
const fetchAvatar = vi.hoisted(() => vi.fn());
vi.mock('../lib/db', () => ({ getContactAvatar }));
vi.mock('../lib/contact-avatar', () => ({ fetchContactAvatarPointer }));
vi.mock('../lib/avatar', () => ({ fetchAvatar }));

import { useContactAvatar, seedContactAvatarPointer } from './useContactAvatar';

const pk = (n: string) => n.repeat(64);
const record = { pubkey: pk('a'), shareKey: pk('1'), addedAt: 1, fallback: { server: 'https://card.example.com/', hash: pk('2') } };
beforeEach(() => {
  vi.resetAllMocks();
  URL.createObjectURL = vi.fn(() => 'blob:x'); URL.revokeObjectURL = vi.fn();
  fetchAvatar.mockResolvedValue(new Blob(['x']));
});

describe('useContactAvatar fallback from the contact card', () => {
  it('uses the stored { server, hash } when no pointer is found on the relays', async () => {
    getContactAvatar.mockResolvedValue(record);
    fetchContactAvatarPointer.mockResolvedValue(null);
    const { result } = renderHook(() => useContactAvatar(pk('a'), 'wss://relay.example', 'unlock'));
    await waitFor(() => expect(result.current).toBe('blob:x'));
    expect(fetchAvatar).toHaveBeenCalledWith({ hash: pk('2'), blossomUrl: 'https://card.example.com/', keyHex: pk('1') });
  });
  it('prefers the sharer pointer when one is found (later changes arrive that way)', async () => {
    getContactAvatar.mockResolvedValue({ ...record, pubkey: pk('b') });
    fetchContactAvatarPointer.mockResolvedValue({ hash: pk('3'), blossomUrl: 'https://pointer.example.com' });
    const { result } = renderHook(() => useContactAvatar(pk('b'), 'wss://relay.example', 'unlock'));
    await waitFor(() => expect(result.current).toBe('blob:x'));
    expect(fetchAvatar).toHaveBeenCalledWith({ hash: pk('3'), blossomUrl: 'https://pointer.example.com', keyHex: pk('1') });
  });
  it('shows nothing when there is no pointer and no fallback, and never falls back to a non-https server', async () => {
    getContactAvatar.mockResolvedValue({ pubkey: pk('c'), shareKey: pk('1'), addedAt: 1 });
    fetchContactAvatarPointer.mockResolvedValue(null);
    const none = renderHook(() => useContactAvatar(pk('c'), 'wss://relay.example', 'unlock'));
    await waitFor(() => expect(fetchContactAvatarPointer).toHaveBeenCalled());
    expect(none.result.current).toBeNull();
    getContactAvatar.mockResolvedValue({ ...record, pubkey: pk('d'), fallback: { server: 'http://card.example.com', hash: pk('2') } });
    renderHook(() => useContactAvatar(pk('d'), 'wss://relay.example', 'unlock'));
    await waitFor(() => expect(getContactAvatar).toHaveBeenCalledWith(pk('d'), 'unlock'));
    await new Promise(r => setTimeout(r, 20));
    expect(fetchAvatar).not.toHaveBeenCalled();
  });
  it('uses a seeded pointer without asking the relays', async () => {
    getContactAvatar.mockResolvedValue({ ...record, pubkey: pk('e') });
    seedContactAvatarPointer(pk('e'), { hash: pk('4'), blossomUrl: 'https://seeded.example.com' });
    const { result } = renderHook(() => useContactAvatar(pk('e'), 'wss://relay.example', 'unlock'));
    await waitFor(() => expect(result.current).toBe('blob:x'));
    expect(fetchContactAvatarPointer).not.toHaveBeenCalled();
    expect(fetchAvatar).toHaveBeenCalledWith({ hash: pk('4'), blossomUrl: 'https://seeded.example.com', keyHex: pk('1') });
  });
});
