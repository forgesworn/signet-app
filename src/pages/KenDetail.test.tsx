// @vitest-environment jsdom
//
// kenspeckle 0.2.0 maintainer findings pinned here:
//  - resolveKen now sets `rotation.rollback: true` when a NIP-05 domain
//    re-serves a key the entry already rotated away from, and
//    acceptKenRotation throws unless called with `{ allowRevert: true }`.
//    KenDetail must show a distinct warning with an explicit "Revert
//    anyway" confirm step, and must NOT offer the normal "Accept rotation"
//    button for a rollback.
//  - resolveKen returns the SAME entry reference (no fetch) for a revoked
//    entry or one whose stored nip05 fails the stricter validation —
//    KenDetail must say "can't be re-checked", not "no change found".
//  - rotation/re-check actions are hidden (not merely disabled) on a
//    revoked entry.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import type { KenEntry } from '@forgesworn/kenspeckle';

vi.mock('@forgesworn/kenspeckle/ken', () => ({
  buildKeyControlChallenge: vi.fn(() => ({ nonce: 'n'.repeat(64), createdAt: 0 })),
  verifyKeyControl: vi.fn(),
  resolveKen: vi.fn(),
  acceptKenRotation: vi.fn(),
  revokeKen: vi.fn((e: KenEntry) => ({ ...e, revoked: true })),
}));

vi.mock('../hooks/useContactAvatar', () => ({
  useContactAvatar: () => undefined,
}));

vi.mock('../components/ContactAvatar', () => ({
  ContactAvatar: () => <div />,
}));

vi.mock('../lib/public-profile-publish', () => ({
  fetchPublicProfile: vi.fn(async () => null),
  safeImageOrLinkUrl: vi.fn(() => null),
}));

import { resolveKen, acceptKenRotation } from '@forgesworn/kenspeckle/ken';
import { KenDetail } from './KenDetail';

const mockResolveKen = vi.mocked(resolveKen);
const mockAcceptKenRotation = vi.mocked(acceptKenRotation);

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const OWNER = 'a'.repeat(64);
const PUBKEY = 'c'.repeat(64);
const NEW_PUBKEY = 'd'.repeat(64);

function makeEntry(overrides: Partial<KenEntry> = {}): KenEntry {
  return {
    pubkey: PUBKEY,
    ownerPubkey: OWNER,
    tier: 'ken',
    addedAt: 1000,
    provenance: { source: 'nip05', locator: 'someone@example.com', confirmedAt: 1000 },
    nip05: 'someone@example.com',
    ...overrides,
  };
}

function renderDetail(entry: KenEntry, onAddKen = vi.fn()) {
  const utils = render(
    <KenDetail
      entry={entry}
      onAddKen={onAddKen}
      onRemoveKen={vi.fn()}
      onBack={vi.fn()}
      relayUrl="wss://relay.example.com"
      encryptionKey={null}
    />,
  );
  const rerenderWithEntry = (nextEntry: KenEntry) => utils.rerender(
    <KenDetail
      entry={nextEntry}
      onAddKen={onAddKen}
      onRemoveKen={vi.fn()}
      onBack={vi.fn()}
      relayUrl="wss://relay.example.com"
      encryptionKey={null}
    />,
  );
  return { onAddKen, rerenderWithEntry };
}

async function openRotation() {
  await act(async () => {
    fireEvent.click(screen.getByText('Review rotation'));
  });
}

describe('KenDetail — rotation rollback', () => {
  it('shows the rollback warning and "Revert anyway", with the normal Accept rotation button absent', async () => {
    const entry = makeEntry();
    const rolledBack: KenEntry = {
      ...entry,
      lastResolvedAt: 2000,
      rotation: { newPubkey: NEW_PUBKEY, observedAt: 2000, via: 'nip05', accepted: false, rollback: true },
    };
    mockResolveKen.mockResolvedValue(rolledBack);
    renderDetail(entry);

    await openRotation();

    expect(screen.getByText(/serving an OLD key again/)).toBeDefined();
    expect(screen.getByText('Revert anyway')).toBeDefined();
    expect(screen.queryByText('Accept rotation')).toBeNull();
  });

  it('"Revert anyway" requires a second confirm, then calls acceptKenRotation with { allowRevert: true }', async () => {
    const entry = makeEntry();
    const rolledBack: KenEntry = {
      ...entry,
      lastResolvedAt: 2000,
      rotation: { newPubkey: NEW_PUBKEY, observedAt: 2000, via: 'nip05', accepted: false, rollback: true },
    };
    mockResolveKen.mockResolvedValue(rolledBack);
    mockAcceptKenRotation.mockReturnValue({
      ...rolledBack,
      pubkey: NEW_PUBKEY,
      previousPubkeys: [PUBKEY],
      rotation: { ...rolledBack.rotation!, accepted: true },
    });
    const { onAddKen } = renderDetail(entry);

    await openRotation();
    fireEvent.click(screen.getByText('Revert anyway'));

    // Confirm step — the revert has not happened yet.
    expect(screen.getByText(/Are you sure/)).toBeDefined();
    expect(mockAcceptKenRotation).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByText('Confirm revert'));
    });

    expect(mockAcceptKenRotation).toHaveBeenCalledWith(rolledBack, { allowRevert: true });
    expect(onAddKen).toHaveBeenCalledTimes(1);
  });

  it('a normal (non-rollback) rotation still offers Accept rotation and calls acceptKenRotation without allowRevert', async () => {
    const entry = makeEntry();
    const proposed: KenEntry = {
      ...entry,
      lastResolvedAt: 2000,
      rotation: { newPubkey: NEW_PUBKEY, observedAt: 2000, via: 'nip05', accepted: false },
    };
    mockResolveKen.mockResolvedValue(proposed);
    mockAcceptKenRotation.mockReturnValue({
      ...proposed,
      pubkey: NEW_PUBKEY,
      previousPubkeys: [PUBKEY],
      rotation: { ...proposed.rotation!, accepted: true },
    });
    renderDetail(entry);

    await openRotation();
    expect(screen.queryByText('Revert anyway')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByText('Accept rotation'));
    });

    expect(mockAcceptKenRotation).toHaveBeenCalledWith(proposed, undefined);
  });
});

describe('KenDetail — revoked entry', () => {
  it('hides the Review rotation button entirely (not merely disabled)', () => {
    const entry = makeEntry({ revoked: true });
    renderDetail(entry);
    expect(screen.queryByText('Review rotation')).toBeNull();
  });
});

describe('KenDetail — resolveKen returns the same entry (no fetch happened)', () => {
  it('shows "can\'t be re-checked" rather than "no change found"', async () => {
    const entry = makeEntry();
    mockResolveKen.mockResolvedValue(entry); // same reference — no fetch occurred
    renderDetail(entry);

    await openRotation();

    expect(screen.getByText("This address can't be re-checked.")).toBeDefined();
    expect(screen.queryByText(/No key rotation detected/)).toBeNull();
  });

  // The "can't be re-checked" flag is captured once, at resolve time,
  // against the entry reference resolveKen was actually called with — not
  // recomputed at render time against the CURRENT `entry` prop, which can
  // be a freshly-constructed (but logically identical) object by then
  // (App.tsx's `kens.find(...)` on every render).
  it('keeps showing "can\'t be re-checked" even after the entry prop is replaced by an equal-but-different object', async () => {
    const entry = makeEntry();
    mockResolveKen.mockResolvedValue(entry); // same reference at resolve time
    const { rerenderWithEntry } = renderDetail(entry);

    await openRotation();
    expect(screen.getByText("This address can't be re-checked.")).toBeDefined();

    const recreatedEntry: KenEntry = { ...entry }; // deep-equal, different reference
    rerenderWithEntry(recreatedEntry);

    expect(screen.getByText("This address can't be re-checked.")).toBeDefined();
  });
});

describe('KenDetail — accept rotation guards against a stale resolved copy', () => {
  it('aborts (no acceptKenRotation call) and shows a human message when the CURRENT entry has been revoked since the panel opened', async () => {
    const entry = makeEntry();
    const proposed: KenEntry = {
      ...entry,
      lastResolvedAt: 2000,
      rotation: { newPubkey: NEW_PUBKEY, observedAt: 2000, via: 'nip05', accepted: false },
    };
    mockResolveKen.mockResolvedValue(proposed);
    const { rerenderWithEntry, onAddKen } = renderDetail(entry);

    await openRotation();
    expect(screen.getByText('Accept rotation')).toBeDefined();

    // The record was revoked from another device while the panel was open
    // — a NEW entry object, same pubkey, `revoked: true`.
    rerenderWithEntry({ ...entry, revoked: true });

    fireEvent.click(screen.getByText('Accept rotation'));

    expect(mockAcceptKenRotation).not.toHaveBeenCalled();
    expect(onAddKen).not.toHaveBeenCalled();
    expect(screen.getByText(/This entry has changed since you opened this screen/)).toBeDefined();
  });

  it('aborts when the CURRENT entry pubkey no longer matches the resolved copy', async () => {
    const entry = makeEntry();
    const proposed: KenEntry = {
      ...entry,
      lastResolvedAt: 2000,
      rotation: { newPubkey: NEW_PUBKEY, observedAt: 2000, via: 'nip05', accepted: false },
    };
    mockResolveKen.mockResolvedValue(proposed);
    const { rerenderWithEntry } = renderDetail(entry);

    await openRotation();

    rerenderWithEntry({ ...entry, pubkey: 'e'.repeat(64) });

    fireEvent.click(screen.getByText('Accept rotation'));

    expect(mockAcceptKenRotation).not.toHaveBeenCalled();
    expect(screen.getByText(/This entry has changed since you opened this screen/)).toBeDefined();
  });

  it('still accepts normally when the current entry has not changed', async () => {
    const entry = makeEntry();
    const proposed: KenEntry = {
      ...entry,
      lastResolvedAt: 2000,
      rotation: { newPubkey: NEW_PUBKEY, observedAt: 2000, via: 'nip05', accepted: false },
    };
    mockResolveKen.mockResolvedValue(proposed);
    mockAcceptKenRotation.mockReturnValue({
      ...proposed,
      pubkey: NEW_PUBKEY,
      previousPubkeys: [PUBKEY],
      rotation: { ...proposed.rotation!, accepted: true },
    });
    const { onAddKen } = renderDetail(entry);

    await openRotation();
    await act(async () => {
      fireEvent.click(screen.getByText('Accept rotation'));
    });

    expect(mockAcceptKenRotation).toHaveBeenCalledWith(proposed, undefined);
    expect(onAddKen).toHaveBeenCalledTimes(1);
  });
});
