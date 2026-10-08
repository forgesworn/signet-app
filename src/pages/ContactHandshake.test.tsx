// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { HandshakeHost } from '../hooks/useHandshake';
import type { ContactInviteService } from '../lib/contact-invite-service';
import { ContactHandshake } from './ContactHandshake';
const mocks = vi.hoisted(() => ({ load: vi.fn(async () => ({ name: true, photo: true })), save: vi.fn(async () => {}), handshake: vi.fn((_host: HandshakeHost) => ({ view: { phase: 'reading' as const }, scan: vi.fn(), oneWay: vi.fn(), confirm: vi.fn() })) }));
vi.mock('../lib/handshake-defaults', () => ({ loadHandshakeChoice: mocks.load, saveHandshakeChoice: mocks.save }));
vi.mock('../hooks/useHandshake', () => ({ useHandshake: mocks.handshake }));
vi.mock('../components/HandshakeCamera', () => ({ HandshakeCamera: () => <video data-testid="live-camera" /> }));
vi.mock('../components/QRCode', () => ({ QRCode: () => <canvas data-testid="invite-qr" /> }));
vi.mock('../hooks/useScreenWakeLock', () => ({ useScreenWakeLock: vi.fn() }));
const props = () => ({ persona: '1'.repeat(64), encryptionKey: 'test', version: 0, relays: ['wss://relay.example/'],
  service: vi.fn(() => ({} as ContactInviteService)), info: { name: 'Private persona', hasPhoto: true }, choose: false,
  buildCard: vi.fn(async () => undefined), onChildInvite: vi.fn(), onTier: vi.fn(async () => {}) });
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it('starts with remembered sharing choices, without displaying the persona name, key or picture', async () => {
  const p = props(); render(<ContactHandshake {...p} />);
  await screen.findByTestId('live-camera');
  expect(screen.queryByText(p.info.name)).not.toBeInTheDocument();
  expect(screen.queryByText(p.persona)).not.toBeInTheDocument();
  expect(screen.queryByRole('img', { name: /persona/i })).not.toBeInTheDocument();
  expect(mocks.handshake.mock.calls[0][0].card).toBeTypeOf('function');
  await mocks.handshake.mock.calls[0][0].card(); expect(p.buildCard).toHaveBeenCalledWith({ name: true, photo: true });
});
it('long-press chooser saves its selection only when requested, then starts', async () => {
  const p = props(); render(<ContactHandshake {...p} choose />);
  await screen.findByText('They’ll see');
  fireEvent.click(screen.getByLabelText('Your picture'));
  fireEvent.click(screen.getByLabelText('Save as default'));
  fireEvent.click(screen.getByRole('button', { name: 'Go' }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith(p.persona, p.encryptionKey, { name: true, photo: false }));
  await screen.findByTestId('live-camera');
});
it('paired-child Handshake never creates an owner exchange', async () => {
  const p = props(); render(<ContactHandshake {...p} pairedChild info={{ name: '', hasPhoto: false }} />);
  await screen.findByText('Ask your guardian');
  expect(p.service).not.toHaveBeenCalled(); expect(p.buildCard).not.toHaveBeenCalled();
  expect(mocks.handshake).not.toHaveBeenCalled(); expect(screen.getByTestId('invite-qr')).toBeInTheDocument();
});
