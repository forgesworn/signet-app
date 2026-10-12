// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HandshakeHost, HandshakeView } from '../hooks/useHandshake';
import type { ContactInviteService } from '../lib/contact-invite-service';
import { useState } from 'react';
import { useContactAvatar } from '../hooks/useContactAvatar';
import { useContactPicture } from '../hooks/useContactPicture';
import { ContactHandshake } from './ContactHandshake';
import { SEAM_GAP_DP } from '../lib/handshake-seam-gap';
import { SIGIL_SEAM, SIGIL_WIDTH } from '../lib/handshake-sigil';
const mocks = vi.hoisted(() => ({ load: vi.fn(async (..._args: unknown[]): Promise<{ name: boolean; photo: boolean; blur?: boolean }> => ({ name: true, photo: true })), save: vi.fn(async () => {}), handshake: vi.fn((_host: HandshakeHost) => ({ view: { phase: 'reading' } as HandshakeView, scan: vi.fn(), oneWay: vi.fn(), confirm: vi.fn() })) }));
vi.mock('../lib/handshake-defaults', () => ({ loadHandshakeChoice: mocks.load, saveHandshakeChoice: mocks.save }));
vi.mock('../hooks/useHandshake', () => ({ useHandshake: mocks.handshake }));
vi.mock('../components/HandshakeCamera', () => ({ HandshakeCamera: () => <video data-testid="live-camera" /> }));
vi.mock('../components/QRCode', () => ({ QRCode: () => <canvas data-testid="invite-qr" /> }));
const radio = vi.hoisted(() => ({ value: null as null | { nfc: string; bluetooth: string }, refresh: vi.fn(),
  nearbyPermission: vi.fn(), nearbyEnable: vi.fn(), radioSettings: vi.fn() }));
vi.mock('../hooks/useRadioStatus', () => ({ useRadioStatus: () => radio.value }));
vi.mock('../lib/radio-status', () => ({ refreshRadioStatus: radio.refresh }));
vi.mock('../lib/native', () => ({ isNativeApp: () => false,
  SignetNative: { nearbyPermission: radio.nearbyPermission, nearbyEnable: radio.nearbyEnable, radioSettings: radio.radioSettings } }));
vi.mock('../hooks/useScreenWakeLock', () => ({ useScreenWakeLock: vi.fn() }));
vi.mock('../hooks/useContactAvatar', () => ({ useContactAvatar: vi.fn(() => null) }));
vi.mock('../hooks/useContactPicture', () => ({ useContactPicture: vi.fn(() => ({ url: null, badgeUrl: null })) }));
const props = () => ({ persona: '1'.repeat(64), encryptionKey: 'test', version: 0, relays: ['wss://relay.example/'],
  service: vi.fn(() => ({} as ContactInviteService)), info: { name: 'Private persona', hasPhoto: true }, choose: false,
  buildCard: vi.fn(async () => undefined), onChildInvite: vi.fn(), onOpenContact: vi.fn(async () => {}),
  relayUrl: 'wss://relay.example/', directoryId: 'owner' });
afterEach(() => {
  cleanup(); vi.clearAllMocks(); radio.value = null;
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
  expect(screen.queryByRole('button', { name: 'Kin' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Kith' })).not.toBeInTheDocument();
  expect(screen.getByRole('img', { name: 'Handshake sigil' })).toBeInTheDocument();
});
const partner = '3'.repeat(64);
const sealedWith = (view: Partial<HandshakeView>) => ({ view: { phase: 'sealed', contactId: 'a'.repeat(32), sigil: 'b'.repeat(64), partner, ...view } as HandshakeView,
  scan: vi.fn(), oneWay: vi.fn(), confirm: vi.fn() });
it('shows who arrived under the seal, and says they went straight to contacts', async () => {
  mocks.handshake.mockReturnValue(sealedWith({ name: 'Sam' }));
  render(<ContactHandshake {...props()} />);
  expect(await screen.findByText('Sam')).toBeInTheDocument();
  expect(screen.getByText(/^npub1/)).toBeInTheDocument();
  expect(screen.getByText('Saved straight to your contacts. You can change Kith or Kin on their contact page.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Tap to show who you added' })).not.toBeInTheDocument();
});
it('keeps their name out of the status line too when the user blurs identities (review L2)', async () => {
  mocks.handshake.mockReturnValue({ view: { phase: 'waiting', code: sessionCode, scanned: true, name: 'Sam' } as HandshakeView,
    scan: vi.fn(), oneWay: vi.fn(), confirm: vi.fn() });
  const view = render(<ContactHandshake {...props()} blurArrival />);
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Waiting for their scan confirmation…'));
  expect(screen.queryByText(/Sam/)).not.toBeInTheDocument();
  view.unmount();
  render(<ContactHandshake {...props()} />);
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Sam'));
});
it('arrives blurred, shown on a tap, when the user blurs identities', async () => {
  mocks.handshake.mockReturnValue(sealedWith({ name: 'Sam' }));
  const view = render(<ContactHandshake {...props()} blurArrival />);
  fireEvent.click(await screen.findByRole('button', { name: 'Tap to show who you added' }));
  expect(view.container.querySelector('.handshake-arrival.is-hidden')).toBeNull();
  expect(screen.getByText('Sam')).toBeVisible();
});
it('blurs the arrival before any tap', async () => {
  mocks.handshake.mockReturnValue(sealedWith({ name: 'Sam' }));
  const view = render(<ContactHandshake {...props()} blurArrival />);
  await screen.findByRole('button', { name: 'Tap to show who you added' });
  expect(view.container.querySelector('.handshake-arrival.is-hidden .handshake-arrival-body')?.getAttribute('aria-hidden')).toBe('true');
});
it('does not offer a contact before it is saved', async () => {
  render(<ContactHandshake {...props()} />); await screen.findByTestId('live-camera');
  expect(screen.queryByRole('button', { name: 'Open contact' })).not.toBeInTheDocument();
});
const sessionCode = 'SGH2:CODE';
it('replaces the finished camera with a tick while keeping the QR for their return scan', async () => {
  mocks.handshake.mockReturnValue({ view: { phase: 'waiting', code: sessionCode, scanned: true }, scan: vi.fn(), oneWay: vi.fn(), confirm: vi.fn() });
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
  mocks.handshake.mockReturnValue({ view: { phase: 'waiting', code: sessionCode, name: 'Other person' }, scan: vi.fn(), oneWay: vi.fn(), confirm: vi.fn() });
  render(<ContactHandshake {...props()} />); await screen.findByTestId('live-camera');
  expect(screen.getByTestId('invite-qr')).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Scan their QR');
  expect(screen.queryByText('Their QR scanned')).not.toBeInTheDocument();
  expect(screen.queryByText('Your QR scanned')).not.toBeInTheDocument();
});
it('says the phones can tap back to back only where NFC is on', async () => {
  mocks.handshake.mockReturnValue({ view: { phase: 'reading', code: sessionCode, tapAvailable: true }, scan: vi.fn(), oneWay: vi.fn(), confirm: vi.fn() });
  render(<ContactHandshake {...props()} />); await screen.findByTestId('live-camera');
  expect(screen.getByRole('status')).toHaveTextContent('Scan their QR, or tap the phones back to back');
});
it('says so when a phone on a child-pairing screen is tapped', async () => {
  mocks.handshake.mockReturnValue({ view: { phase: 'reading', code: sessionCode, tapAvailable: true, pairingPeer: true }, scan: vi.fn(), oneWay: vi.fn(), confirm: vi.fn() });
  render(<ContactHandshake {...props()} />); await screen.findByTestId('live-camera');
  expect(screen.getByRole('alert')).toHaveTextContent('That phone is pairing a child’s phone, not on the Handshake screen.');
  // Directly under the status line, in the error style, so it is seen without scrolling.
  const alert = screen.getByRole('alert');
  expect(alert).toHaveClass('handshake-alert');
  expect(screen.getByRole('status').nextElementSibling).toBe(alert);
});
it('after a tap, says the codes crossed by tap rather than by a QR scan', async () => {
  const handshake = (view: Partial<HandshakeView>) => ({ view: { phase: 'waiting', code: sessionCode, scanned: true, via: 'tap', ...view } as HandshakeView,
    scan: vi.fn(), oneWay: vi.fn(), confirm: vi.fn() });
  mocks.handshake.mockReturnValue(handshake({}));
  const view = render(<ContactHandshake {...props()} />);
  await screen.findByText('Their code received by tap');
  expect(screen.getByRole('status')).toHaveTextContent('Waiting for their phone to confirm the tap…');
  expect(screen.queryByText('Let their phone scan your QR.')).not.toBeInTheDocument();
  mocks.handshake.mockReturnValue(handshake({ scansConfirmed: true }));
  view.rerender(<ContactHandshake {...props()} />);
  await screen.findByText('Their phone has your code');
  expect(screen.getByRole('status')).toHaveTextContent('Tap confirmed on both phones. Finishing the exchange…');
  expect(screen.queryByText(/QR scanned|scan confirmation|Both scans/)).not.toBeInTheDocument();
});
it('replaces both completed scans with ticks only after reciprocal proof and explains the remaining exchange', async () => {
  mocks.handshake.mockReturnValue({ view: { phase: 'waiting', code: sessionCode, scanned: true, scansConfirmed: true }, scan: vi.fn(), oneWay: vi.fn(), confirm: vi.fn() });
  render(<ContactHandshake {...props()} />); await screen.findByText('Their QR scanned');
  expect(screen.getByText('Your QR scanned')).toBeInTheDocument();
  expect(screen.queryByTestId('live-camera')).not.toBeInTheDocument();
  expect(screen.queryByTestId('invite-qr')).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Both scans confirmed. Finishing the exchange…');
  expect(screen.queryByRole('button', { name: 'Use Jigsaw' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Open contact' })).not.toBeInTheDocument();
});
it('shows activity while waiting for the peer, and stops it at expiry', async () => {
  mocks.handshake.mockReturnValue({ view: { phase: 'waiting', code: sessionCode, scanned: true }, scan: vi.fn(), oneWay: vi.fn(), confirm: vi.fn() });
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
it('chooser shows no radio section on the web', async () => {
  render(<ContactHandshake {...props()} choose />);
  await screen.findByText('They’ll see');
  expect(screen.queryByText('Phone radios')).not.toBeInTheDocument();
});
it('chooser says what is on, with no buttons or hint', async () => {
  radio.value = { nfc: 'on', bluetooth: 'on' };
  render(<ContactHandshake {...props()} choose />);
  await screen.findByText('Phone radios');
  expect(screen.getByText('Bluetooth is on')).toBeInTheDocument();
  expect(screen.getByText('NFC is on, so you can tap phones')).toBeInTheDocument();
  expect(screen.queryByText('Without these, the handshake uses the camera and the internet.')).not.toBeInTheDocument();
});
it('chooser turns Bluetooth and NFC on by explicit taps', async () => {
  radio.value = { nfc: 'off', bluetooth: 'off' };
  radio.nearbyEnable.mockResolvedValue({ enabled: true }); radio.radioSettings.mockResolvedValue(undefined);
  render(<ContactHandshake {...props()} choose />);
  await screen.findByText('Bluetooth is off');
  expect(screen.getByText('Without these, the handshake uses the camera and the internet.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
  await waitFor(() => expect(radio.nearbyEnable).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(radio.refresh).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: 'Turn on NFC' }));
  expect(radio.radioSettings).toHaveBeenCalledWith({ which: 'nfc' });
});
it('chooser asks for the Bluetooth permission, then points to app settings if it is refused', async () => {
  radio.value = { nfc: 'none', bluetooth: 'denied' };
  radio.nearbyPermission.mockResolvedValue({ granted: false }); radio.radioSettings.mockResolvedValue(undefined);
  render(<ContactHandshake {...props()} choose />);
  await screen.findByText('Bluetooth is not allowed');
  fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
  await waitFor(() => expect(radio.nearbyPermission).toHaveBeenCalledTimes(1));
  fireEvent.click(await screen.findByRole('button', { name: 'Open app settings' }));
  expect(radio.radioSettings).toHaveBeenCalledWith({ which: 'app' });
  expect(radio.nearbyEnable).not.toHaveBeenCalled();
});
const confirming = (view: Partial<HandshakeView> = {}, actions: { confirmTap?: () => void; rejectTap?: () => void } = {}) => ({
  view: { phase: 'confirming', partner, name: 'Sam', sigil: 'b'.repeat(64), half: 'top', via: 'tap', ...view } as HandshakeView,
  scan: vi.fn(), oneWay: vi.fn(), confirm: vi.fn(), confirmTap: vi.fn(), rejectTap: vi.fn(), ...actions });
it('asks "Is this them?" before a tapped contact is saved: their name, key and initials only, and no photo fetch', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  mocks.handshake.mockReturnValue(confirming());
  const view = render(<ContactHandshake {...props()} />);
  expect(await screen.findByRole('heading', { name: 'Is this them?' })).toBeInTheDocument();
  expect(screen.getByText('The name they gave')).toBeInTheDocument();
  expect(screen.getByText('Sam')).toBeVisible();
  expect(screen.getByText(/^npub1/)).toBeInTheDocument();
  expect(view.container.querySelector('.handshake-confirm img:not([role])')).toBeNull();
  expect(screen.getByRole('img', { name: 'Handshake sigil' })).toBeInTheDocument();
  expect(screen.getByText(/the lines join only with the phone you tapped/)).toBeInTheDocument();
  // H1: nothing contact-controlled is fetched or even looked up before the save.
  expect(useContactAvatar).not.toHaveBeenCalled(); expect(useContactPicture).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Open contact' })).not.toBeInTheDocument();
  fetchSpy.mockRestore();
});
it('without a shared name the question says so, and omits the Jigsaw hint when there is no sigil', async () => {
  mocks.handshake.mockReturnValue(confirming({ name: undefined, sigil: undefined }));
  render(<ContactHandshake {...props()} />);
  await screen.findByRole('heading', { name: 'Is this them?' });
  expect(screen.getByText('No name shared')).toBeInTheDocument();
  expect(screen.queryByText(/the lines join only/)).not.toBeInTheDocument();
});
it('the question is blurred until tapped when the user blurs identities', async () => {
  mocks.handshake.mockReturnValue(confirming());
  const view = render(<ContactHandshake {...props()} blurArrival />);
  await screen.findByRole('button', { name: 'Tap to show who it is' });
  expect(view.container.querySelector('.handshake-confirm .handshake-arrival.is-hidden .handshake-arrival-body')?.getAttribute('aria-hidden')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'Tap to show who it is' }));
  expect(view.container.querySelector('.handshake-arrival.is-hidden')).toBeNull();
  expect(screen.getByText('Sam')).toBeVisible();
});
it('"Yes, save them" and "Not them" call the tap actions', async () => {
  const confirmTap = vi.fn(), rejectTap = vi.fn();
  mocks.handshake.mockReturnValue(confirming({}, { confirmTap, rejectTap }));
  render(<ContactHandshake {...props()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Yes, save them' }));
  expect(confirmTap).toHaveBeenCalledTimes(1); expect(rejectTap).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Not them' }));
  expect(rejectTap).toHaveBeenCalledTimes(1);
});
it('a declined tap says nothing was saved, and Start again begins a fresh session', async () => {
  let mounts = 0;
  mocks.handshake.mockImplementation(() => {
    const [mount] = useState(() => ++mounts);
    return { view: (mount === 1 ? { phase: 'declined', partner } : { phase: 'reading' }) as HandshakeView, scan: vi.fn(), oneWay: vi.fn(), confirm: vi.fn() };
  });
  render(<ContactHandshake {...props()} />);
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Not saved. They may still have saved you.'));
  expect(screen.queryByRole('button', { name: 'Yes, save them' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Start again' }));
  await screen.findByTestId('live-camera');
  expect(mounts).toBe(2);
  expect(screen.queryByRole('button', { name: 'Start again' })).not.toBeInTheDocument();
});
it('chooser lists its checkboxes one per line, each with its text beside it', async () => {
  const view = render(<ContactHandshake {...props()} choose />);
  await screen.findByText('They’ll see');
  const labels = [...view.container.querySelectorAll('.handshake-choices > label')];
  expect(labels.map(l => l.textContent?.trim())).toEqual(['Your name', 'Your npub', 'Your picture', 'Hide me on their screen until they tap', 'Save as default']);
  for (const l of labels) expect(l.querySelector('input[type=checkbox]')).not.toBeNull();
  expect(view.container.querySelector('.handshake-choices .field-hint')?.textContent).toBe('Your npub is needed to connect.');
});
it('draws the Jigsaw with this phone’s edge distance, or the default', async () => {
  const spy = vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 400 } as DOMRect);
  const strip = async (seamGapMm?: number) => {
    mocks.handshake.mockReturnValue(sealedWith({}));
    const view = render(<ContactHandshake {...props()} seamGapMm={seamGapMm} />);
    const svg = await screen.findByRole('img', { name: 'Handshake sigil' });
    const [, y] = svg.getAttribute('viewBox')!.split(' ').map(Number);
    view.unmount();
    return (y - SIGIL_SEAM) * 400 / SIGIL_WIDTH;
  };
  try {
    expect(await strip(undefined)).toBeCloseTo(SEAM_GAP_DP, 0);
    expect(await strip(10)).toBeCloseTo(10 * 160 / 25.4, 0);
  } finally { spy.mockRestore(); }
});
describe('Hide me on their screen', () => {
  it('starts from the user\'s own blur setting, and the chooser box saves with the default', async () => {
    mocks.load.mockImplementation(async (...args: unknown[]) => ({ name: true, photo: false, ...(args[3] ? { blur: true } : {}) }));
    const p = props();
    const view = render(<ContactHandshake {...p} choose blurArrival />);
    const box = await screen.findByLabelText('Hide me on their screen until they tap') as HTMLInputElement;
    expect(mocks.load.mock.calls.at(-1)?.[3]).toBe(true);
    expect(box.checked).toBe(true);
    view.unmount();
    render(<ContactHandshake {...p} choose />);
    const off = await screen.findByLabelText('Hide me on their screen until they tap') as HTMLInputElement;
    expect(mocks.load.mock.calls.at(-1)?.[3]).toBe(false);
    expect(off.checked).toBe(false);
    fireEvent.click(off);
    fireEvent.click(screen.getByLabelText('Save as default'));
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith(p.persona, p.encryptionKey, { name: true, photo: false, blur: true }));
    mocks.load.mockImplementation(async () => ({ name: true, photo: true }));
  });
  it('sends the ticked choice to the card builder, and nothing about blur when it is not ticked', async () => {
    mocks.load.mockImplementation(async () => ({ name: true, photo: false, blur: true }));
    const p = props();
    const view = render(<ContactHandshake {...p} />);
    await screen.findByTestId('live-camera');
    await mocks.handshake.mock.calls.at(-1)![0].card();
    expect(p.buildCard).toHaveBeenLastCalledWith({ name: true, photo: false, blur: true });
    view.unmount();
    mocks.load.mockImplementation(async () => ({ name: true, photo: false }));
    render(<ContactHandshake {...p} />);
    await screen.findByTestId('live-camera');
    await mocks.handshake.mock.calls.at(-1)![0].card();
    expect(p.buildCard).toHaveBeenLastCalledWith({ name: true, photo: false });
    mocks.load.mockImplementation(async () => ({ name: true, photo: true }));
  });
  it('blurs the question, the arrival and the status name when their card asks, with the local setting off', async () => {
    mocks.handshake.mockReturnValue(confirming({ blur: true }));
    const view = render(<ContactHandshake {...props()} />);
    await screen.findByRole('button', { name: 'Tap to show who it is' });
    expect(view.container.querySelector('.handshake-confirm .handshake-arrival.is-hidden')).not.toBeNull();
    view.unmount();
    mocks.handshake.mockReturnValue(sealedWith({ name: 'Sam', blur: true }));
    const arrival = render(<ContactHandshake {...props()} />);
    await screen.findByRole('button', { name: 'Tap to show who you added' });
    expect(arrival.container.querySelector('.handshake-arrival.is-hidden')).not.toBeNull();
    arrival.unmount();
    mocks.handshake.mockReturnValue({ view: { phase: 'waiting', code: sessionCode, scanned: true, name: 'Sam', blur: true } as HandshakeView,
      scan: vi.fn(), oneWay: vi.fn(), confirm: vi.fn() });
    render(<ContactHandshake {...props()} />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Waiting for their scan confirmation…'));
    expect(screen.queryByText(/Sam/)).not.toBeInTheDocument();
  });
  it('shows them plainly when neither side asks', async () => {
    mocks.handshake.mockReturnValue(sealedWith({ name: 'Sam', blur: false }));
    const view = render(<ContactHandshake {...props()} />);
    expect(await screen.findByText('Sam')).toBeVisible();
    expect(view.container.querySelector('.is-hidden')).toBeNull();
  });
});
