// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BunkerPanel } from './BunkerPanel';
import type { PendingApproval, PendingCryptoApproval, PendingSignApproval } from '../hooks/useBunkerServer';
import { FAMILY_PURPOSE } from '../lib/kinterest-authority';

const NOW = new Date(2026, 10, 18, 15, 0, 0).getTime();
const OWNER = 'b'.repeat(64);
const CLIENT = 'c'.repeat(64);
const BIDI = '‮⁦​\u0007\u0000';

function sign(over: Partial<PendingSignApproval> = {}): PendingSignApproval {
  return {
    handle: 1, askedAt: NOW - 30_000, route: { pubkey: OWNER, dependantId: null }, method: 'sign_event',
    client: { pubkey: CLIENT, appName: 'Unknown app', existing: false },
    description: 'app state (kind 30078)', alwaysAvailable: true,
    template: { pubkey: '', kind: 30078, created_at: 1, tags: [['d', 'axolittle/state'], ['p', 'x'], ['p', 'y']], content: 'hello from the app' },
    ...over,
  };
}
function crypto(over: Partial<PendingCryptoApproval> = {}): PendingCryptoApproval {
  return {
    handle: 2, askedAt: NOW - 30_000, route: { pubkey: OWNER, dependantId: null }, method: 'nip44_encrypt', peerPubkey: OWNER,
    client: { pubkey: CLIENT, appName: 'Unknown app', existing: false },
    description: 'Encrypt data to yourself', alwaysAvailable: true, payloadLength: 5000, payloadPreview: 'secret plan',
    ...over,
  };
}

function renderPanel(pendingApprovals: PendingApproval[], extra: Partial<React.ComponentProps<typeof BunkerPanel>> = {}) {
  const fns = { approve: vi.fn(), always: vi.fn(), deny: vi.fn(), clear: vi.fn() };
  const view = render(<BunkerPanel onClose={() => {}} bunkerAllowed onGoToSecurity={() => {}} stayAwakeUntil={null}
    onArmStayAwake={() => {}} onCloseStayAwake={() => {}} wakeLockSupported={false}
    pendingApprovals={pendingApprovals} onApproveOnce={fns.approve} onApproveAlways={fns.always} onDeny={fns.deny} onClear={fns.clear}
    dependantNameFor={() => undefined} ownerLabelFor={(pk) => (pk === OWNER ? 'Poppy' : undefined)}
    hasDependants={false} serveStatus={{ phase: 'off', routePubkeys: [], relayUrl: null } as never}
    locked={false} onRequestUnlockWithPendingArm={() => {}} onRequestUnlockForAlwaysOn={() => {}} isNative={false}
    backgroundServing={false} alwaysOnWanted={false} onSetBackgroundServing={async () => {}} {...extra} />);
  return { ...fns, ...view };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('collapsed card', () => {
  it('shows the age, the persona name, the app key and the site', () => {
    renderPanel([sign({ client: { pubkey: CLIENT, appName: 'Unknown app', existing: false, declaredName: 'Axolittle', declaredUrl: 'https://axolittle.example' } })]);
    expect(screen.getByText('Unknown app · calls itself "Axolittle"')).toBeTruthy();
    expect(screen.getByText('just now')).toBeTruthy();
    expect(screen.getByText('Poppy')).toBeTruthy();
    expect(screen.getByText(/signing as/)).toBeTruthy();
    expect(screen.getByText(`says it's from axolittle.example · app key ${CLIENT.slice(0, 10)}…${CLIENT.slice(-6)}`)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'More about this request' }).getAttribute('aria-expanded')).toBe('false');
  });
  it('falls back to "You" with no persona label, and to a bare "Unknown app" with no declared name', () => {
    renderPanel([sign()], { ownerLabelFor: () => undefined });
    expect(screen.getByText('You')).toBeTruthy();
    expect(screen.getByText('Unknown app')).toBeTruthy();
    expect(screen.queryByText(/calls itself/)).toBeNull();
  });
  it('prints a saved app name sanitised, and a dependant pairing label as it is', () => {
    renderPanel([sign({ handle: 1, client: { pubkey: CLIENT, appName: `Pa${BIDI}ired`, existing: true } }),
      sign({ handle: 3, route: { pubkey: OWNER, dependantId: 'd'.repeat(64), routeKind: 'app' }, client: { pubkey: 'e'.repeat(64), appName: 'Lego Game', existing: false } })],
      { dependantNameFor: (id) => (id ? 'Wren' : undefined) });
    expect(screen.getByText('Paired')).toBeTruthy();
    expect(screen.getByText('Lego Game')).toBeTruthy();
    expect(screen.getByText('Wren')).toBeTruthy();
    expect(screen.queryByText(/calls itself/)).toBeNull();
  });
  it('does not call a dependant\'s own bound device an unpaired stranger', () => {
    renderPanel([sign({ route: { pubkey: OWNER, dependantId: 'd'.repeat(64), routeKind: 'device' } })]);
    expect(screen.getByText('A dependant')).toBeTruthy();
    expect(screen.getByText('Their paired device')).toBeTruthy(); // the card's title, not "Unknown app"
    expect(screen.queryByText('Unknown app')).toBeNull();
    expect(screen.queryByText(/calls itself/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More about this request' }));
    expect(screen.getByText("The dependant's paired device")).toBeTruthy();
    expect(screen.queryByText(/Not paired on this phone/)).toBeNull();
  });
  it('does not mistake an app pairing labelled "Unknown app" for the dependant\'s own device', () => {
    renderPanel([sign({ route: { pubkey: OWNER, dependantId: 'd'.repeat(64), routeKind: 'app' }, client: { pubkey: CLIENT, appName: 'Unknown app', existing: false } })]);
    expect(screen.queryByText('Their paired device')).toBeNull();
    expect(screen.getByText('Unknown app')).toBeTruthy();
  });
  it('frames a site the app only claims, and a saved site as it is', () => {
    renderPanel([sign({ handle: 1, client: { pubkey: CLIENT, appName: 'Unknown app', existing: false, declaredUrl: 'https://kithmoot.example' } }),
      sign({ handle: 2, client: { pubkey: 'e'.repeat(64), appName: 'Saved', existing: true, appUrl: 'https://saved.example/x' } })]);
    expect(screen.getByText(`says it's from kithmoot.example · app key ${CLIENT.slice(0, 10)}…${CLIENT.slice(-6)}`)).toBeTruthy();
    expect(screen.getByText(`saved.example · app key ${'e'.repeat(10)}…${'e'.repeat(6)}`)).toBeTruthy();
  });
  it('never turns a declared URL into a link', () => {
    renderPanel([sign({ client: { pubkey: CLIENT, appName: 'Unknown app', existing: false, declaredUrl: 'https://axolittle.example' } })]);
    expect(document.querySelector('a')).toBeNull();
  });
  it('warns when an unpaired app calls itself by the name of a paired app under another key', () => {
    renderPanel([sign({ client: { pubkey: CLIENT, appName: 'Unknown app', existing: false, declaredName: 'kithmoot' } })],
      { connectedClients: [{ clientPubkey: 'a'.repeat(64), appName: 'KithMoot' }] });
    expect(screen.getByText('Not the KithMoot paired on this phone: different app key.')).toBeTruthy();
  });
  it('still warns when the declared name hides an invisible character, and when the site is a paired app\'s', () => {
    const paired = [{ clientPubkey: 'a'.repeat(64), appName: 'KithMoot', appUrl: 'https://kithmoot.example/play' }];
    const { unmount } = renderPanel([sign({ client: { pubkey: CLIENT, appName: 'Unknown app', existing: false, declaredName: 'Kith\u2060Moot' } })], { connectedClients: paired });
    expect(screen.getByText('Not the KithMoot paired on this phone: different app key.')).toBeTruthy();
    unmount();
    renderPanel([sign({ client: { pubkey: CLIENT, appName: 'Unknown app', existing: false, declaredName: 'Something Else', declaredUrl: 'https://kithmoot.example' } })], { connectedClients: paired });
    expect(screen.getByText('Not the KithMoot paired on this phone: different app key.')).toBeTruthy();
  });
  it('cannot be made to break out of the quotes around a declared name', () => {
    renderPanel([sign({ client: { pubkey: CLIENT, appName: 'Unknown app', existing: false, declaredName: 'KithMoot" · paired' } })]);
    expect(screen.getByText(`Unknown app · calls itself "KithMoot' · paired"`)).toBeTruthy();
  });
  it('does not warn for the same key or a different name', () => {
    renderPanel([sign({ client: { pubkey: CLIENT, appName: 'Unknown app', existing: false, declaredName: 'kithmoot' } })],
      { connectedClients: [{ clientPubkey: CLIENT, appName: 'KithMoot' }, { clientPubkey: 'a'.repeat(64), appName: 'Other' }] });
    expect(screen.queryByText(/paired on this phone/)).toBeNull();
  });
  it('cuts a long declared name to about 40 characters', () => {
    renderPanel([sign({ client: { pubkey: CLIENT, appName: 'Unknown app', existing: false, declaredName: 'N'.repeat(90) } })]);
    expect(screen.getByText(`Unknown app · calls itself "${'N'.repeat(40)}…"`)).toBeTruthy();
  });
});

describe('expanded card', () => {
  it('toggles the sign-request rows', () => {
    renderPanel([sign({ client: { pubkey: CLIENT, appName: 'Unknown app', existing: false, declaredName: 'Axolittle' } })]);
    expect(screen.queryByText('Asked')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More about this request' }));
    expect(screen.getByRole('button', { name: 'More about this request' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Today 14:59:30')).toBeTruthy();
    expect(screen.getByText('Not paired on this phone (calls itself "Axolittle")')).toBeTruthy();
    expect(screen.getByText('None given')).toBeTruthy();
    expect(screen.getByText('Sign · kind 30078 (app state)')).toBeTruthy();
    expect(screen.getByText('axolittle/state')).toBeTruthy();
    expect(screen.getByText('3: d, p ×2')).toBeTruthy();
    expect(screen.getByText('hello from the app')).toBeTruthy();
    expect(screen.getByText(/As sent by the app · 18 characters/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'More about this request' }));
    expect(screen.queryByText('Asked')).toBeNull();
  });
  it('shows pairing facts for a saved app and "Encrypted" for ciphertext content', () => {
    renderPanel([sign({
      client: { pubkey: CLIENT, appName: 'Saved', existing: true, appUrl: 'https://saved.example/a/long/path/that/goes/on/and/on/forever/and/ever', connectedAt: Math.floor(new Date(2026, 10, 1).getTime() / 1000), lastSeenAt: Math.floor((NOW - 7_200_000) / 1000) },
      template: { pubkey: '', kind: 1, created_at: 1, tags: [], content: 'AgEA' + 'A'.repeat(200) },
    })]);
    fireEvent.click(screen.getByRole('button', { name: 'More about this request' }));
    expect(screen.getByText('Paired 1 Nov 2026 · last seen 2 h ago')).toBeTruthy();
    expect(screen.getByText('Encrypted, 204 characters')).toBeTruthy();
    expect(screen.getByText('None')).toBeTruthy();
    expect(screen.getByText(/^https:\/\/saved\.example\/a\/long\/path/).textContent!.length).toBeLessThan(70);
  });
  it('shows crypto rows: encrypt with a preview, decrypt with a size only', () => {
    renderPanel([crypto({ handle: 2 }), crypto({ handle: 4, method: 'nip04_decrypt', peerPubkey: 'd'.repeat(64), payloadLength: 321, payloadPreview: undefined })]);
    const [first, second] = screen.getAllByRole('button', { name: 'More about this request' });
    fireEvent.click(first);
    fireEvent.click(second);
    expect(screen.getByText('Encrypt')).toBeTruthy();
    expect(screen.getByText('Yourself')).toBeTruthy();
    expect(screen.getByText('secret plan…')).toBeTruthy();
    expect(screen.getByText('As sent by the app · first 280 of 5000 characters')).toBeTruthy();
    expect(screen.getByText('Decrypt (older format)')).toBeTruthy();
    expect(screen.getByText('Encrypted, 321 characters')).toBeTruthy();
    expect(screen.getAllByText('Yourself')).toHaveLength(1);
  });
  it('renders hostile strings sanitised and cut', () => {
    const big = `line\n${BIDI}${'<b>x</b>'.repeat(1000)}`;
    renderPanel([sign({
      client: { pubkey: CLIENT, appName: 'Unknown app', existing: false, declaredName: `E${BIDI}vil<script>` },
      template: { pubkey: '', kind: 1, created_at: 1, tags: [['d', `${BIDI}${'D'.repeat(300)}`], [`t${BIDI}ag`, 'v']], content: big },
    })]);
    fireEvent.click(screen.getByRole('button', { name: 'More about this request' }));
    const html = document.body.innerHTML;
    for (const ch of ['‮', '⁦', '​', '\u0007', '\u0000']) expect(html).not.toContain(ch);
    expect(document.querySelector('b')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText('D'.repeat(80))).toBeTruthy();
    expect(screen.getByText('2: d, tag')).toBeTruthy();
    const content = screen.getByText(/^line <b>x<\/b>/);
    expect(content.textContent!.length).toBeLessThanOrEqual(281);
    expect(screen.getByText(`As sent by the app · first 280 of ${big.length} characters`)).toBeTruthy();
  });
});

describe('late requests', () => {
  it('shows no note and no Clear before five minutes', () => {
    renderPanel([sign({ askedAt: NOW - 299_000 })]);
    expect(screen.queryByText(/stopped waiting/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
  });
  it('shows the note and a Clear after five minutes, and the age keeps ticking', () => {
    renderPanel([sign({ askedAt: NOW - 290_000 })]);
    expect(screen.queryByText(/stopped waiting/)).toBeNull();
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(screen.getByText('Asked 5 min ago. The app has probably stopped waiting.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy();
  });
  it('Clear calls onClear, never deny', () => {
    const p = renderPanel([sign({ handle: 11, askedAt: NOW - 400_000 })]);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(p.clear).toHaveBeenCalledWith(11);
    expect(p.deny).not.toHaveBeenCalled();
    expect(p.approve).not.toHaveBeenCalled();
  });
  it('offers "Clear late requests (N)" only at two or more late, and clears only those', () => {
    const one = renderPanel([sign({ handle: 1, askedAt: NOW - 400_000 }), sign({ handle: 2 })]);
    expect(screen.queryByRole('button', { name: /Clear late requests/ })).toBeNull();
    one.unmount();
    const p = renderPanel([sign({ handle: 1, askedAt: NOW - 400_000 }), crypto({ handle: 2, askedAt: NOW - 900_000 }), sign({ handle: 3 })]);
    fireEvent.click(screen.getByRole('button', { name: 'Clear late requests (2)' }));
    expect(p.clear.mock.calls.map(c => c[0])).toEqual([1, 2]);
    expect(p.deny).not.toHaveBeenCalled();
  });
  it('offers no Clear when the caller gives none', () => {
    renderPanel([sign({ askedAt: NOW - 400_000 })], { onClear: undefined });
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
  });
});

describe('Kinterest authority card', () => {
  const family = 'a'.repeat(64);
  const kinterest = (over: Partial<PendingSignApproval> = {}): PendingSignApproval => sign({
    client: { pubkey: CLIENT, appName: 'Kinterest', appUrl: 'https://kin.example', existing: true },
    description: 'Family authorisation',
    template: { pubkey: OWNER, kind: 30078, created_at: 1, content: FAMILY_PURPOSE,
      tags: [['d', `kin-jar/family-authorisation/v2/${family}`], ['scope', 'kin-jar:family:v2'], ['family', family], ['challenge', 'd'.repeat(64)], ['approval', 'request']] },
    ...over,
  });
  it('keeps "Review authorisation" with no Approve or Always, and now shows the age, the down-arrow and its rows', () => {
    renderPanel([kinterest({ askedAt: NOW - 125_000 })]);
    expect(screen.getByRole('button', { name: 'Review authorisation' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Always' })).toBeNull();
    expect(screen.getByText('2 min ago')).toBeTruthy();
    expect(screen.queryByText('Asked')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More about this request' }));
    expect(screen.getByText('Asked')).toBeTruthy();
    expect(screen.getByText('Paired on this phone')).toBeTruthy();
  });
  it('"Review authorisation" still opens the review modal', () => {
    renderPanel([kinterest()]);
    fireEvent.click(screen.getByRole('button', { name: 'Review authorisation' }));
    expect(screen.getByText(`Family key: ${family}`)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve this Kinterest authorisation' })).toBeTruthy();
  });
  it('gets the late note and Clear too, and counts in the header', () => {
    const p = renderPanel([kinterest({ handle: 5, askedAt: NOW - 400_000 }), kinterest({ handle: 6, askedAt: NOW - 500_000 })]);
    expect(screen.getAllByText(/The app has probably stopped waiting\./)).toHaveLength(2);
    fireEvent.click(within(screen.getAllByRole('button', { name: 'Clear' })[0].parentElement!).getByRole('button', { name: 'Clear' }));
    expect(p.clear).toHaveBeenCalledWith(5);
    fireEvent.click(screen.getByRole('button', { name: 'Clear late requests (2)' }));
    expect(p.clear).toHaveBeenCalledWith(6);
  });
});
