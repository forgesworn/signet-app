// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { KnownPlacesCard, KnownPlacesDependantCard, type KnownPlacesCardProps } from './KnownPlacesCard';
import type { KnownPlace } from '../types/known-places';
import { HeartwoodCopyError } from '../lib/heartwood-mgmt-error-copy';
import { HandoffUnmanagedError } from '../lib/heartwood-handoff';

const native = vi.hoisted(() => ({ value: true }));
vi.mock('../lib/native', () => ({ isNativeApp: () => native.value }));

const NOW = 1_800_000_000;
const DAY = 86_400;
const PK = 'a'.repeat(64);

function place(key: string, over: Partial<KnownPlace> = {}): KnownPlace {
  return {
    id: `${key}:${PK}`, pubkey: PK, placeKey: key, kind: 'sign-in', name: key, origin: `https://${key}.example`,
    channel: 'browser', signer: 'local', firstAt: NOW - 100 * DAY, lastAt: NOW - DAY, uses: 3, shared: {}, ...over,
  };
}
const actions = () => ({
  pin: vi.fn(), setAlias: vi.fn(), setAuto: vi.fn(), open: vi.fn(), forget: vi.fn(), disconnect: vi.fn(), revokeOnHeartwood: vi.fn(),
  forgetHandoffHere: vi.fn(),
});

function setup(over: Partial<KnownPlacesCardProps> = {}) {
  const a = actions();
  const props: KnownPlacesCardProps = {
    identityName: 'Alice', identityType: 'persona', places: [], locked: false, onUnlock: vi.fn(),
    focusId: null, onFocusConsumed: vi.fn(), ctxFor: () => ({}), heartwoodClients: null, actions: a, ...over,
  };
  const view = render(<KnownPlacesCard {...props} />);
  return { a, props, view };
}
const settle = () => act(async () => {});
const expand = (name: string) => fireEvent.click(screen.getByRole('button', { name: new RegExp(name) }));

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW * 1000); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('KnownPlacesCard', () => {
  it('groups places: pinned, recent, not used in 3 months', () => {
    setup({ places: [
      place('pinned', { pinned: true }), place('fresh'), place('old', { lastAt: NOW - 120 * DAY }),
    ] });
    expect(within(screen.getByRole('region', { name: 'Pinned' })).getByText('pinned')).toBeDefined();
    expect(within(screen.getByRole('region', { name: 'Recent' })).getByText('fresh')).toBeDefined();
    expect(within(screen.getByRole('region', { name: 'Not used in 3 months' })).getByText('old')).toBeDefined();
  });

  it('uses the paired client last-seen time to keep a place recent', () => {
    setup({ places: [place('zeta', { kind: 'nip46', lastAt: NOW - 200 * DAY })], ctxFor: () => ({ lastSeenAt: NOW - 3600 }) });
    expect(screen.queryByRole('region', { name: 'Not used in 3 months' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Recent' })).toBeDefined();
  });

  it('shows search only above twelve entries and filters by name, alias and origin', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => place(`s${i}`));
    const { view, props } = setup({ places: twelve });
    expect(screen.queryByLabelText('Search places')).toBeNull();
    view.rerender(<KnownPlacesCard {...props} places={[...twelve, place('needle', { alias: 'Findme' })]} />);
    const box = screen.getByLabelText('Search places');
    fireEvent.change(box, { target: { value: 'findme' } });
    expect(screen.getAllByRole('button', { expanded: false })).toHaveLength(1);
    fireEvent.change(box, { target: { value: 'nothing-like-it' } });
    expect(screen.getByText('Nothing matches.')).toBeDefined();
  });

  it('expands one row at a time and collapses on a second tap', () => {
    setup({ places: [place('alpha'), place('bravo')] });
    expand('alpha');
    expect(screen.getByText('Identity')).toBeDefined();
    expand('bravo');
    expect(screen.getAllByText('Identity')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /bravo/ }).getAttribute('aria-expanded')).toBe('true');
    expand('bravo');
    expect(screen.queryByText('Identity')).toBeNull();
  });

  it('expands the focused row on arrival and reports it consumed', () => {
    const places = [place('alpha'), place('bravo')];
    const { props } = setup({ places, focusId: places[1].id });
    expect(screen.getByRole('button', { name: /bravo/ }).getAttribute('aria-expanded')).toBe('true');
    expect(props.onFocusConsumed).toHaveBeenCalledTimes(1);
  });

  it('shows the row summary: identity, channel, time', () => {
    setup({ places: [place('alpha', { channel: 'phone-app', nativePackage: 'org.x' })] });
    expect(screen.getByText('Alice · phone app · 1 day ago')).toBeDefined();
  });

  it('says signing asks each time for a Nostr Connect app set to ask', () => {
    setup({ places: [place('nc', { kind: 'nip46', channel: 'nip46', origin: undefined })], ctxFor: () => ({ askToSign: true }) });
    expect(screen.getAllByText('Encrypts and decrypts for this app without asking; signing asks each time.').length).toBeGreaterThan(0);
  });

  it('pins and sets an alias', async () => {
    const p = place('alpha');
    const { a } = setup({ places: [p] });
    expand('alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }));
    expect(a.pin).toHaveBeenCalledWith(p.id, true);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Add alias' }));
    fireEvent.change(screen.getByLabelText('Alias'), { target: { value: '  Home  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(a.setAlias).toHaveBeenCalledWith(p.id, 'Home');
    await settle();
  });

  it('forgets a sign-in only after confirming, with the plain copy', async () => {
    const p = place('alpha');
    const { a } = setup({ places: [p] });
    expand('alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Forget' }));
    expect(a.forget).not.toHaveBeenCalled();
    expect(screen.getByText('Removes this from your phone. The site still has your account; sign out there too.')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Forget' }));
    expect(a.forget).toHaveBeenCalledWith(p);
    await settle();
  });

  it('opens a browser or phone-app place, and not other-device or Nostr Connect places', async () => {
    const browser = place('web');
    const app = place('zeta', { channel: 'phone-app', nativePackage: 'org.x' });
    const other = place('far', { channel: 'other-device' });
    const nc = place('nc', { kind: 'nip46', channel: 'nip46', origin: undefined });
    const { a } = setup({ places: [browser, app, other, nc] });
    expand('web');
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(a.open).toHaveBeenCalledWith(browser);
    await settle();
    expand('zeta');
    expect(screen.getByRole('button', { name: 'Open' })).toBeDefined();
    expand('far');
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
    expect(screen.getByText('Signed in on another device')).toBeDefined();
    expand('nc');
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
    expect(screen.getByText('Paired app')).toBeDefined();
  });

  it('toggles automatic signing for Nostr Connect and phone-app callers', async () => {
    const nc = place('nc', { kind: 'nip46', channel: 'nip46', origin: undefined });
    const { a, view, props } = setup({ places: [nc], ctxFor: () => ({}) });
    expand('nc');
    fireEvent.click(screen.getByRole('button', { name: 'Stop signing automatically' }));
    expect(a.setAuto).toHaveBeenCalledWith(nc, 'ask');
    await settle();
    view.rerender(<KnownPlacesCard {...props} ctxFor={() => ({ askToSign: true })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign automatically' }));
    expect(a.setAuto).toHaveBeenLastCalledWith(nc, 'always');
    await settle();

    const app = place('pkg', { kind: 'nip55', channel: 'nip55', origin: undefined, nativePackage: 'org.y' });
    view.rerender(<KnownPlacesCard {...props} places={[app]} ctxFor={() => ({ nip55Grant: { allowAlways: true, denyAlways: false } })} />);
    expand('pkg');
    fireEvent.click(screen.getByRole('button', { name: 'Stop signing automatically' }));
    expect(a.setAuto).toHaveBeenLastCalledWith(app, 'ask');
    await settle();
  });

  it('offers no automatic-signing action for a sign-in', () => {
    setup({ places: [place('alpha')] });
    expand('alpha');
    expect(screen.queryByRole('button', { name: /signing automatically|Sign automatically/ })).toBeNull();
  });

  it('disconnects a paired app after confirming', async () => {
    const nc = place('nc', { kind: 'nip46', channel: 'nip46', origin: undefined });
    const { a } = setup({ places: [nc] });
    expand('nc');
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(screen.getByText('This app will have to pair again.')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(a.disconnect).toHaveBeenCalledWith(nc);
    await settle();
  });

  it('says why a Disconnect failed', async () => {
    const nc = place('nc', { kind: 'nip46', channel: 'nip46', origin: undefined });
    const { a } = setup({ places: [nc] });
    a.disconnect.mockRejectedValue(new Error('timeout waiting for device (revoke_client)'));
    expand('nc');
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await settle();
    expect(screen.getByRole('alert').textContent).toBe("Your Heartwood didn't answer. Check it's on and online, then try again.");
  });

  it('shows copy already put in plain words as it is, not mapped a second time', async () => {
    const nc = place('nc', { kind: 'nip46', channel: 'nip46', origin: undefined });
    const { a } = setup({ places: [nc] });
    const copy = 'Your Heartwood replied: "failed to publish (slot_table)".';
    a.disconnect.mockRejectedValue(new HeartwoodCopyError(copy));
    expand('nc');
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await settle();
    expect(screen.getByRole('alert').textContent).toBe(copy);
  });

  it('an app on a Heartwood this phone cannot manage can be forgotten here, with the Sapwood hint', async () => {
    const nc = place('nc', { kind: 'nip46', channel: 'nip46', origin: undefined, signer: 'heartwood' });
    const { a } = setup({ places: [nc], ctxFor: () => ({ heartwoodHeld: true }) });
    expand('nc');
    expect(screen.queryByRole('button', { name: 'Forget on this phone' })).toBeNull();
    a.disconnect.mockRejectedValue(new HandoffUnmanagedError());
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await settle();
    expect(screen.getByRole('alert').textContent).toMatch(/Forget on this phone.*Sapwood/);
    fireEvent.click(screen.getByRole('button', { name: 'Forget on this phone' }));
    expect(screen.getByText(/It may still sign on your Heartwood: remove it there in Sapwood\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Forget on this phone' }));
    await settle();
    expect(a.forgetHandoffHere).toHaveBeenCalledWith(nc);
  });

  it('any failed Disconnect of a Heartwood app offers Forget on this phone, beside Disconnect', async () => {
    const nc = place('nc', { kind: 'nip46', channel: 'nip46', origin: undefined, signer: 'heartwood' });
    const { a } = setup({ places: [nc], ctxFor: () => ({ heartwoodHeld: true }) });
    a.disconnect.mockRejectedValue(new Error('timeout waiting for device (revoke_client)'));
    expand('nc');
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await settle();
    expect(screen.getByRole('alert').textContent).toMatch(/didn't answer/);
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Forget on this phone' }));
    expect(screen.getByText(/It may still sign on your Heartwood: remove it there in Sapwood\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Forget on this phone' }));
    await settle();
    expect(a.forgetHandoffHere).toHaveBeenCalledWith(nc);
  });

  it('only a failed Disconnect offers it, and only for an app handed to a Heartwood', async () => {
    const hw = place('hw', { kind: 'nip46', channel: 'nip46', origin: undefined, signer: 'heartwood' });
    const { a } = setup({ places: [hw], ctxFor: () => ({ heartwoodHeld: true }) });
    a.pin.mockRejectedValue(new Error('timeout waiting for device (revoke_client)'));
    expand('hw');
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }));
    await settle();
    expect(screen.queryByRole('button', { name: 'Forget on this phone' })).toBeNull();
    cleanup();

    const nc = place('nc', { kind: 'nip46', channel: 'nip46', origin: undefined });
    const b = setup({ places: [nc] }).a;
    b.disconnect.mockRejectedValue(new Error('timeout waiting for device (revoke_client)'));
    expand('nc');
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await settle();
    expect(screen.queryByRole('button', { name: 'Forget on this phone' })).toBeNull();
  });

  it('says why a Revoke on Heartwood failed', async () => {
    const { a } = setup({ heartwoodClients: [{ fingerprint: 'ff00', label: 'Bark', boundIdentity: 'Alice', policySummary: 'Asks on the device' }] });
    a.revokeOnHeartwood.mockRejectedValue(new Error('failed to publish to any relay'));
    fireEvent.click(screen.getByRole('button', { name: /Bark/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke on Heartwood' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await settle();
    expect(screen.getByRole('alert').textContent).toMatch(/couldn't reach your Heartwood's relays/);
  });

  it('hides the Heartwood group without data and says where those apps are managed', () => {
    setup({ places: [place('alpha')], heartwoodClients: null });
    expect(screen.queryByRole('region', { name: 'On your Heartwood' })).toBeNull();
    expect(screen.getByText('Apps paired straight to your Heartwood are managed in Sapwood.')).toBeDefined();
  });

  it('lists Heartwood apps and revokes one after confirming', async () => {
    const { a } = setup({ heartwoodClients: [{ fingerprint: 'ff00', label: 'Bark', boundIdentity: 'Alice', policySummary: 'Asks on the device' }] });
    expect(screen.queryByText(/managed in Sapwood/)).toBeNull();
    expand('Bark');
    fireEvent.click(screen.getByRole('button', { name: 'Revoke on Heartwood' }));
    expect(screen.getByText('Removes this app from the device.')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(a.revokeOnHeartwood).toHaveBeenCalledWith('ff00');
    await settle();
  });

  it('shows only the unlock chip when locked', () => {
    const { props } = setup({ places: [place('alpha')], locked: true });
    expect(screen.queryByText('one')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Unlock to see where this identity is known' }));
    expect(props.onUnlock).toHaveBeenCalledTimes(1);
  });

  it('shows an empty line when nothing is known', () => {
    setup();
    expect(screen.getByText(/Not known anywhere yet/)).toBeDefined();
  });

  it('puts the known-places-card class on its root', () => {
    const { view } = setup();
    expect(view.container.firstElementChild?.className).toContain('known-places-card');
  });

  it('offers no Auto or Disconnect for a NIP-55 row whose app is paired to another identity', () => {
    const app = place('pkg', { kind: 'nip55', channel: 'nip55', origin: undefined, nativePackage: 'org.y' });
    setup({ places: [app], ctxFor: () => ({ nip55Grant: null, nip55OtherIdentity: true }) });
    expand('pkg');
    expect(screen.queryByRole('button', { name: /signing automatically|Sign automatically|Ask each time/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
    expect(screen.getByText('This app is currently paired to a different identity.')).toBeDefined();
  });

  it('offers no Auto action for a NIP-55 row with no grant, but still lets the stale row be removed', () => {
    const app = place('pkg', { kind: 'nip55', channel: 'nip55', origin: undefined, nativePackage: 'org.y' });
    setup({ places: [app], ctxFor: () => ({ nip55Grant: null }) });
    expand('pkg');
    expect(screen.queryByRole('button', { name: /signing automatically|Sign automatically/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeDefined();
    expect(screen.queryByText('This app is currently paired to a different identity.')).toBeNull();
  });

  it('shows no auto action while the paired clients load', () => {
    const nc = place('nc', { kind: 'nip46', channel: 'nip46', origin: undefined });
    setup({ places: [nc], ctxFor: () => ({ loading: true }) });
    expand('nc');
    expect(screen.queryByRole('button', { name: /signing automatically|Sign automatically/ })).toBeNull();
  });

  it('offers no auto action for an app handed to a Heartwood, and says who signs', () => {
    const nc = place('nc', { kind: 'nip46', channel: 'nip46', origin: undefined });
    setup({ places: [nc], ctxFor: () => ({ heartwoodHeld: true }) });
    expand('nc');
    expect(screen.queryByRole('button', { name: /signing automatically|Sign automatically/ })).toBeNull();
    expect(screen.getByText('By your Heartwood, without asking this phone')).toBeTruthy();
  });

  it('opens a phone-app place only on native', () => {
    native.value = false;
    try {
      setup({ places: [place('zeta', { channel: 'phone-app', nativePackage: 'org.x' })] });
      expand('zeta');
      expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
    } finally { native.value = true; }
  });

  it("names an app by the phone's own label, with the package in a smaller line", () => {
    setup({ places: [place('Stampede', { channel: 'phone-app', nativePackage: 'dev.stampede', origin: undefined })], ctxFor: () => ({ appLabel: 'Stampede' }) });
    expand('Stampede');
    expect(screen.getByText('Stampede app')).toBeDefined();
    expect(screen.getByText('dev.stampede').className).toContain('kp-fact-sub');
  });

  it('hides the revoke action when the device cannot revoke, and the whole group for a paired child', () => {
    const hw = [{ fingerprint: 'ff00', label: 'Bark', boundIdentity: 'Alice', policySummary: 'Asks on the device' }];
    const { view, props } = setup({ heartwoodClients: hw, canRevokeOnHeartwood: false });
    expand('Bark');
    expect(screen.queryByRole('button', { name: 'Revoke on Heartwood' })).toBeNull();
    view.rerender(<KnownPlacesCard {...props} heartwoodClients={null} hideHeartwood />);
    expect(screen.queryByText(/managed in Sapwood/)).toBeNull();
    expect(screen.queryByRole('region', { name: 'On your Heartwood' })).toBeNull();
  });

  it('renders a minimal dependant card pointing at their Activity page', () => {
    const { container } = render(<KnownPlacesDependantCard name="Sam" />);
    expect(container.firstElementChild?.className).toContain('known-places-card');
    expect(screen.getByText('Where Sam is known shows on their Activity page.')).toBeDefined();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
