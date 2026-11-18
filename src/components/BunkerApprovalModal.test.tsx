// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BunkerApprovalModal } from './BunkerApprovalModal';
import { BunkerPanel } from './BunkerPanel';
import type { PendingApproval, PendingCryptoApproval, PendingSignApproval } from '../hooks/useBunkerServer';

function approval(over: Partial<PendingSignApproval> & { dependantId?: string | null } = {}): PendingApproval {
  const { dependantId = null, ...rest } = over;
  return {
    handle: 7,
    askedAt: Date.now() - 1000,
    route: { pubkey: 'b'.repeat(64), dependantId },
    method: 'sign_event',
    client: { appName: 'Some App', appUrl: 'https://example.com', existing: true, pubkey: 'c'.repeat(64) },
    description: 'note',
    alwaysAvailable: true,
    template: { pubkey: 'b'.repeat(64), kind: 31337, created_at: 1, content: '', tags: [] },
    ...rest,
  };
}
afterEach(cleanup);

function cryptoApproval(over: Partial<PendingCryptoApproval> = {}): PendingCryptoApproval {
  return {
    handle: 9,
    askedAt: Date.now() - 1000,
    payloadLength: 12,
    route: { pubkey: 'b'.repeat(64), dependantId: null },
    method: 'nip44_decrypt',
    peerPubkey: 'b'.repeat(64),
    client: { appName: 'Stash', existing: true, pubkey: 'c'.repeat(64) },
    description: 'Decrypt data you encrypted to yourself',
    alwaysAvailable: true,
    ...over,
  };
}

function renderModal(a: PendingApproval, once = vi.fn(), always = vi.fn()) {
  render(<BunkerApprovalModal approval={a} onApproveOnce={once} onApproveAlways={always} onDeny={() => {}} />);
  return { once, always };
}

it('offers "Allow always" for an owner approval', () => {
  renderModal(approval());
  expect(screen.getByRole('button', { name: /Allow always for Some App/ })).toBeTruthy();
});

it('hides "Allow always" for a dependant approval it could not save (unclassified kind), keeping once and deny', () => {
  const { once, always } = renderModal(approval({ dependantId: 'd'.repeat(64), alwaysAvailable: false }));
  expect(screen.queryByRole('button', { name: /Allow always/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
  expect(once).toHaveBeenCalledWith(7);
  expect(always).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy();
});

it('still offers "Allow always" for a dependant approval that will be saved', () => {
  renderModal(approval({ dependantId: 'd'.repeat(64), alwaysAvailable: true }));
  expect(screen.getByRole('button', { name: /Allow always for Some App/ })).toBeTruthy();
});

it('hides the first-contact "Allow always" too when it would not be saved', () => {
  renderModal(approval({ dependantId: 'd'.repeat(64), alwaysAvailable: false, client: { appName: 'New App', existing: false, pubkey: 'c'.repeat(64) } }));
  expect(screen.queryByRole('button', { name: /Allow always/ })).toBeNull();
  expect(screen.getByRole('button', { name: 'Allow once' })).toBeTruthy();
});

it('hides the Bunker panel "Always" button for an approval that would not be saved', () => {
  render(<BunkerPanel onClose={() => {}} bunkerAllowed onGoToSecurity={() => {}} stayAwakeUntil={null}
    onArmStayAwake={() => {}} onCloseStayAwake={() => {}} wakeLockSupported={false}
    pendingApprovals={[approval({ handle: 1 }), approval({ handle: 2, dependantId: 'd'.repeat(64), alwaysAvailable: false })]}
    onApproveOnce={() => {}} onApproveAlways={() => {}} onDeny={() => {}}
    dependantNameFor={() => undefined} hasDependants={false} serveStatus={{ phase: 'idle', routePubkeys: [], relayUrl: 'wss://example.com' } as never}
    locked={false} onRequestUnlockWithPendingArm={() => {}} onRequestUnlockForAlwaysOn={() => {}} isNative={false} backgroundServing={false} alwaysOnWanted={false} onSetBackgroundServing={async () => {}} />);
  expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(2);
  expect(screen.getAllByRole('button', { name: 'Always' })).toHaveLength(1);
});

it('shows the Bunker panel "Always" button for a dependant approval that will be saved', () => {
  render(<BunkerPanel onClose={() => {}} bunkerAllowed onGoToSecurity={() => {}} stayAwakeUntil={null}
    onArmStayAwake={() => {}} onCloseStayAwake={() => {}} wakeLockSupported={false}
    pendingApprovals={[approval({ handle: 3, dependantId: 'd'.repeat(64), alwaysAvailable: true })]}
    onApproveOnce={() => {}} onApproveAlways={() => {}} onDeny={() => {}}
    dependantNameFor={() => 'Sam'} hasDependants serveStatus={{ phase: 'idle', routePubkeys: [], relayUrl: 'wss://example.com' } as never}
    locked={false} onRequestUnlockWithPendingArm={() => {}} onRequestUnlockForAlwaysOn={() => {}} isNative={false} backgroundServing={false} alwaysOnWanted={false} onSetBackgroundServing={async () => {}} />);
  expect(screen.getAllByRole('button', { name: 'Always' })).toHaveLength(1);
});

it('frames an owner decrypt request as a decryption, says the app sees the result, and offers "Allow always" (#189)', () => {
  const { always } = renderModal(cryptoApproval());
  expect(screen.getByText('Decryption request')).toBeTruthy();
  expect(screen.getByRole('heading').textContent).toBe('Stash wants to: Decrypt data you encrypted to yourself.');
  expect(screen.getByText(/The app will see what it decrypts/)).toBeTruthy();
  expect(screen.queryByText(/Event kind/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Allow always for Stash/ }));
  expect(always).toHaveBeenCalledWith(9);
});

it('frames an owner encrypt request as an encryption (#189)', () => {
  renderModal(cryptoApproval({ method: 'nip44_encrypt', description: 'Encrypt data to yourself' }));
  expect(screen.getByText('Encryption request')).toBeTruthy();
  expect(screen.getByText(/encrypt with your key without asking again/)).toBeTruthy();
});

describe('request detail in the modal', () => {
  const unknown = (over: Partial<PendingSignApproval> = {}) => approval({
    askedAt: Date.now() - 125_000,
    client: { appName: 'Unknown app', existing: false, pubkey: 'c'.repeat(64), declaredName: 'KithMoot', declaredUrl: 'https://kithmoot.example' },
    template: { pubkey: '', kind: 30078, created_at: 1, content: 'saved game', tags: [['d', 'kithmoot/save']] },
    ...over,
  });

  it('shows when it was asked, the persona name and the name the app gives itself', () => {
    render(<BunkerApprovalModal approval={unknown()} ownerLabel="Poppy" onApproveOnce={() => {}} onApproveAlways={() => {}} onDeny={() => {}} />);
    expect(screen.getByText('2 min ago')).toBeTruthy();
    expect(screen.getByText('Poppy')).toBeTruthy();
    expect(screen.getByText('Unknown app · calls itself "KithMoot"')).toBeTruthy();
  });

  it('keeps every button label "Unknown app", never the declared name', () => {
    renderModal(unknown());
    expect(screen.getByRole('button', { name: 'Allow always for Unknown app' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /KithMoot/ })).toBeNull();
    expect(screen.getByRole('heading').textContent).toContain('Unknown app');
    expect(screen.getByRole('heading').textContent).not.toContain('KithMoot');
  });

  it('warns when the declared name is a paired app under another key', () => {
    render(<BunkerApprovalModal approval={unknown()} connectedClients={[{ clientPubkey: 'a'.repeat(64), appName: 'KithMoot' }]}
      onApproveOnce={() => {}} onApproveAlways={() => {}} onDeny={() => {}} />);
    expect(screen.getByText('Not the KithMoot paired on this phone: different app key.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Allow always for Unknown app' })).toBeTruthy();
  });

  it('has a down-arrow with the same rows as the panel card', () => {
    render(<BunkerApprovalModal approval={unknown()} ownerLabel="Poppy" onApproveOnce={() => {}} onApproveAlways={() => {}} onDeny={() => {}} />);
    expect(screen.queryByText('Sign · kind 30078 (app state)')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More about this request' }));
    expect(screen.getByText('Sign · kind 30078 (app state)')).toBeTruthy();
    expect(screen.getByText('kithmoot/save')).toBeTruthy();
    expect(screen.getByText('saved game')).toBeTruthy();
    expect(screen.getByText('Not paired on this phone (calls itself "KithMoot")')).toBeTruthy();
  });

  it('leaves the existing copy and button order alone for a paired app', () => {
    renderModal(approval());
    expect(screen.getByText('Some App')).toBeTruthy();
    expect(screen.getAllByRole('button').map(b => b.textContent).filter(t => t !== null && /Allow|Deny/.test(t))).toEqual(['Allow always for Some App', 'Allow once', 'Deny']);
    expect(screen.queryByText(/calls itself/)).toBeNull();
  });

  it('names the dependant a request is for', () => {
    render(<BunkerApprovalModal approval={approval({ dependantId: 'd'.repeat(64), askedAt: Date.now() })} dependantName="Wren" onApproveOnce={() => {}} onApproveAlways={() => {}} onDeny={() => {}} />);
    expect(screen.getByText('Wren')).toBeTruthy();
  });

  it('heads a dependant\'s own paired device as the device, not as an unknown app', () => {
    render(<BunkerApprovalModal approval={approval({ dependantId: 'd'.repeat(64), client: { appName: 'Unknown app', existing: false, pubkey: 'c'.repeat(64) } })}
      dependantName="Wren" onApproveOnce={() => {}} onApproveAlways={() => {}} onDeny={() => {}} />);
    expect(screen.getByRole('heading').textContent).toBe('Their paired device wants to sign a note.');
    expect(screen.queryByText(/calls itself/)).toBeNull();
  });

  it('warns on a look-alike name written with an invisible character, and on a paired app\'s site', () => {
    const { unmount } = render(<BunkerApprovalModal approval={unknown({ client: { appName: 'Unknown app', existing: false, pubkey: 'c'.repeat(64), declaredName: 'Kith\u2060Moot' } })}
      connectedClients={[{ clientPubkey: 'a'.repeat(64), appName: 'KithMoot' }]} onApproveOnce={() => {}} onApproveAlways={() => {}} onDeny={() => {}} />);
    expect(screen.getByText('Not the KithMoot paired on this phone: different app key.')).toBeTruthy();
    unmount();
    render(<BunkerApprovalModal approval={unknown({ client: { appName: 'Unknown app', existing: false, pubkey: 'c'.repeat(64), declaredUrl: 'https://kithmoot.example' } })}
      connectedClients={[{ clientPubkey: 'a'.repeat(64), appName: 'KithMoot', appUrl: 'https://kithmoot.example/play' }]} onApproveOnce={() => {}} onApproveAlways={() => {}} onDeny={() => {}} />);
    expect(screen.getByText('Not the KithMoot paired on this phone: different app key.')).toBeTruthy();
  });

  it('shows a decrypt request\'s size and no preview', () => {
    render(<BunkerApprovalModal approval={cryptoApproval({ askedAt: Date.now(), payloadLength: 640 })} onApproveOnce={() => {}} onApproveAlways={() => {}} onDeny={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'More about this request' }));
    expect(screen.getByText('Encrypted, 640 characters')).toBeTruthy();
    expect(screen.getByText('Yourself')).toBeTruthy();
  });
});
