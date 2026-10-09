// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createContactAcceptance, createContactRequest } from '@forgesworn/signet-contacts';
import { useHandshake, type HandshakeHost } from './useHandshake';
import type { ContactInviteService } from '../lib/contact-invite-service';
import type { ContactInviteVault, StoredContactExchange, StoredContactInvite } from '../lib/contact-invite-store';
import { contactExchangeKey } from '../lib/contact-exchange-key';
import { handshakeQR } from '../lib/handshake-proof';

const haptics = vi.hoisted(() => ({ play: vi.fn(), cancel: vi.fn() }));
vi.mock('../lib/handshake-haptics', () => ({ handshakeHaptic: haptics.play, cancelHandshakeHaptics: haptics.cancel }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function setup(recipient = false) {
  const now = Math.floor(Date.now() / 1000), lower = '1'.repeat(64), higher = '2'.repeat(64);
  const own: StoredContactInvite = { id: 'a'.repeat(32), identityPubkey: recipient ? higher : lower,
    name: 'Handshake', mode: 'single-use', enabled: true, createdAt: now, updatedAt: now,
    invite: { v: 1, recipient: recipient ? higher : lower, secret: '3'.repeat(64), expiresAt: now + 120, relays: ['wss://relay.example/'] } };
  const peer = { ...own.invite, recipient: recipient ? lower : higher, secret: '4'.repeat(64) };
  const request = createContactRequest({ id: 'b'.repeat(32), from: lower, to: higher, nonce: '5'.repeat(64), now,
    reply: { secret: '6'.repeat(64), relays: own.invite.relays }, expiresAt: now + 120 });
  const exchange: StoredContactExchange = { role: recipient ? 'recipient' : 'requester', request, nonce: '5'.repeat(64),
    phase: 'reveal-pending', acceptance: createContactAcceptance(request, '7'.repeat(64), now, { name: 'Other person' }), handshake: { startedAt: now } };
  const vault: ContactInviteVault = { v: 1, directoryId: 'owner', invites: [own], arrivals: [], exchanges: [], outbox: [] };
  const service = {
    create: vi.fn(async () => own), read: vi.fn(async () => vault), openInbox: vi.fn(async () => {}),
    request: vi.fn(async () => { vault.exchanges = [exchange]; return contactExchangeKey(request); }),
    acceptHandshake: vi.fn(async () => { throw new Error('Handshake proof failed'); }),
    sendOpticalAcceptance: vi.fn(async () => {}), flush: vi.fn(async () => {}),
    setEnabled: vi.fn(async () => {}), cancel: vi.fn(async () => {}),
  };
  const host: HandshakeHost = { persona: own.identityPubkey, version: 0, relays: own.invite.relays,
    service: () => service as unknown as ContactInviteService, card: async () => undefined };
  return { host, service, vault, exchange, request, own, peer, now };
}
it('keeps the QR unfinished for an ordinary acceptance until the verified optical delivery arrives', async () => {
  const state = setup();
  const hook = renderHook(({ version }) => useHandshake({ ...state.host, version }), { initialProps: { version: 0 } });
  await waitFor(() => expect(hook.result.current.view.invite).toEqual(state.own.invite));
  act(() => hook.result.current.scan(handshakeQR(state.peer)));
  await waitFor(() => expect(hook.result.current.view.name).toBe('Other person'));
  expect(state.service.sendOpticalAcceptance).toHaveBeenCalled();
  expect(hook.result.current.view.peer).toEqual(state.peer);
  expect(hook.result.current.view.scansConfirmed).not.toBe(true);
  expect(haptics.play).not.toHaveBeenCalledWith('double');
  state.exchange.handshake!.opticalAcceptanceAt = state.now;
  hook.rerender({ version: 1 });
  await waitFor(() => expect(hook.result.current.view.scansConfirmed).toBe(true));
  expect(haptics.play).toHaveBeenCalledWith('double');
});
it('never marks the return scan complete when recipient proof verification rejects the request', async () => {
  const state = setup(true);
  state.vault.arrivals = [{ id: 'c'.repeat(64), inviteId: state.own.id, identityPubkey: state.own.identityPubkey,
    receivedAt: state.now, channel: 'invite', request: state.request }];
  const hook = renderHook(() => useHandshake(state.host));
  await waitFor(() => expect(hook.result.current.view.invite).toEqual(state.own.invite));
  act(() => hook.result.current.scan(handshakeQR(state.peer)));
  await waitFor(() => expect(hook.result.current.view.phase).toBe('failed'));
  expect(state.service.acceptHandshake).toHaveBeenCalled();
  expect(hook.result.current.view.scansConfirmed).not.toBe(true);
  expect(haptics.play).not.toHaveBeenCalledWith('double');
});
