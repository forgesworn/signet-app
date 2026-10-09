// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { HandshakeHost, HandshakeView } from '../hooks/useHandshake';
import type { ContactInviteService } from '../lib/contact-invite-service';
import { ContactHandshake } from './ContactHandshake';
const mocks = vi.hoisted(() => ({ load: vi.fn(async () => ({ name: true, photo: true })), save: vi.fn(async () => {}), handshake: vi.fn((_host: HandshakeHost) => ({ view: { phase: 'reading' } as HandshakeView, scan: vi.fn(), oneWay: vi.fn(), confirm: vi.fn() })) }));
vi.mock('../lib/handshake-defaults', () => ({ loadHandshakeChoice: mocks.load, saveHandshakeChoice: mocks.save }));
vi.mock('../hooks/useHandshake', () => ({ useHandshake: mocks.handshake }));
vi.mock('../components/HandshakeCamera', () => ({ HandshakeCamera: () => <video data-testid="live-camera" /> }));
vi.mock('../components/QRCode', () => ({ QRCode: () => <canvas data-testid="invite-qr" /> }));
vi.mock('../hooks/useScreenWakeLock', () => ({ useScreenWakeLock: vi.fn() }));
const props = () => ({ persona: '1'.repeat(64), encryptionKey: 'test', version: 0, relays: ['wss://relay.example/'],
  service: vi.fn(() => ({} as ContactInviteService)), info: { name: 'Private persona', hasPhoto: true }, choose: false,
  buildCard: vi.fn(async () => undefined), onChildInvite: vi.fn(), onTier: vi.fn(async () => {}), onOpenContact: vi.fn(async () => {}) });
afterEach(() => {
  cleanup(); vi.clearAllMocks();
  mocks.handshake.mockImplementation((_host: HandshakeHost) => ({ view: { phase: 'reading' }, scan: vi.fn(), oneWay: vi.fn(), confirm: vi.fn() }));
});
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
it('offers the saved contact below the seal without requiring a tier choice', async () => {
  const p = props(), contactId = 'a'.repeat(32);
  mocks.handshake.mockReturnValue({ view: { phase: 'sealed', contactId, sigil: 'b'.repeat(64) }, scan: vi.fn(), oneWay: vi.fn(), confirm: vi.fn() });
  render(<ContactHandshake {...p} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open contact' }));
  await waitFor(() => expect(p.onOpenContact).toHaveBeenCalledWith(contactId));
  expect(p.onTier).not.toHaveBeenCalled();
  expect(screen.getByRole('img', { name: 'Handshake sigil' })).toBeInTheDocument();
});
it('does not offer a contact before it is saved', async () => {
  render(<ContactHandshake {...props()} />); await screen.findByTestId('live-camera');
  expect(screen.queryByRole('button', { name: 'Open contact' })).not.toBeInTheDocument();
});
const opticalInvite = () => ({ v: 1 as const, recipient: '2'.repeat(64), secret: '3'.repeat(64),
  relays: ['wss://relay.example/'], expiresAt: Math.floor(Date.now() / 1000) + 120 });
it('replaces the finished camera with a tick while keeping the QR for their return scan', async () => {
  mocks.handshake.mockReturnValue({ view: { phase: 'waiting', invite: opticalInvite(), peer: opticalInvite() }, scan: vi.fn(), oneWay: vi.fn(), confirm: vi.fn() });
  render(<ContactHandshake {...props()} />);
  await screen.findByText('Their QR scanned');
  expect(screen.queryByTestId('live-camera')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Switch camera' })).not.toBeInTheDocument();
  expect(screen.getByTestId('invite-qr')).toBeInTheDocument();
  expect(screen.queryByText('Your QR scanned')).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Waiting for their scan confirmation…');
  expect(screen.getByText('Let their phone scan your QR.')).toBeInTheDocument();
});
it('keeps both scans available after an incoming request until our camera pins the peer', async () => {
  mocks.handshake.mockReturnValue({ view: { phase: 'waiting', invite: opticalInvite(), name: 'Other person' }, scan: vi.fn(), oneWay: vi.fn(), confirm: vi.fn() });
  render(<ContactHandshake {...props()} />); await screen.findByTestId('live-camera');
  expect(screen.getByTestId('invite-qr')).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Scan their QR');
  expect(screen.queryByText('Their QR scanned')).not.toBeInTheDocument();
  expect(screen.queryByText('Your QR scanned')).not.toBeInTheDocument();
});
it('replaces both completed scans with ticks only after reciprocal proof and explains the remaining exchange', async () => {
  mocks.handshake.mockReturnValue({ view: { phase: 'waiting', invite: opticalInvite(), peer: opticalInvite(), scansConfirmed: true }, scan: vi.fn(), oneWay: vi.fn(), confirm: vi.fn() });
  render(<ContactHandshake {...props()} />); await screen.findByText('Their QR scanned');
  expect(screen.getByText('Your QR scanned')).toBeInTheDocument();
  expect(screen.queryByTestId('live-camera')).not.toBeInTheDocument();
  expect(screen.queryByTestId('invite-qr')).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Both scans confirmed. Finishing the exchange…');
  expect(screen.queryByRole('button', { name: 'Use Jigsaw' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Open contact' })).not.toBeInTheDocument();
});
it('shows activity while waiting for the peer, and stops it at expiry', async () => {
  mocks.handshake.mockReturnValue({ view: { phase: 'waiting', invite: opticalInvite(), peer: opticalInvite() }, scan: vi.fn(), oneWay: vi.fn(), confirm: vi.fn() });
  const p = props(), view = render(<ContactHandshake {...p} />);
  await screen.findByText('Their QR scanned');
  expect(view.container.querySelector('.handshake-wait')).toBeInTheDocument();
  expect(view.container.querySelector('.jigsaw-closing')).toBeInTheDocument();
  mocks.handshake.mockReturnValue({ view: { phase: 'expired' }, scan: vi.fn(), oneWay: vi.fn(), confirm: vi.fn() });
  view.rerender(<ContactHandshake {...p} />);
  expect(screen.getByRole('status')).toHaveTextContent('Expired');
  expect(view.container.querySelector('.handshake-wait')).not.toBeInTheDocument();
  expect(view.container.querySelector('.jigsaw-closing')).not.toBeInTheDocument();
});
