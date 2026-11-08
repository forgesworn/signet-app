// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { KnownPlacesCard, type KnownPlacesCardProps } from './KnownPlacesCard';
import type { KnownPlace } from '../types/known-places';

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
});
