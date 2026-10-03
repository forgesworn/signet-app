// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PersonaAdvanced } from './PersonaAdvanced';
import { FollowsImportPanel } from '../components/FollowsImportPanel';
import type { SignetIdentity } from '../types';
import type { FollowsImportOutcome } from '../lib/follows-import-flow';

function identityWith(persona: Partial<SignetIdentity['persona']> = {}): SignetIdentity {
  return {
    id: 'a'.repeat(64), primaryKeypair: 'persona', mnemonic: '', isChild: false, createdAt: 0,
    naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: '' },
    persona: { publicKey: 'b'.repeat(64), privateKey: '', displayName: 'Alex', ...persona },
  };
}

function renderPage(identity: SignetIdentity, extra: Record<string, unknown> = {}) {
  render(
    <PersonaAdvanced
      slotTarget="persona" identity={identity} dependants={[]}
      onPublishProfile={vi.fn(async () => ({ ok: true }))} onDisablePublicProfile={vi.fn(async () => {})} onBack={() => {}}
      {...extra}
    />,
  );
}

const done = (over: Partial<Extract<FollowsImportOutcome, { status: 'done' }>> = {}): FollowsImportOutcome => ({
  status: 'done', total: 12, createdAt: 1, added: 9, linked: 1, unchanged: 2, skippedRemoved: 0, covered: 12, trimmedNotice: null,
  unfollowed: [], unfollowedKept: 0, ...over,
});

describe('PersonaAdvanced — Nostr follows block', () => {
  it('is hidden unless the host passes both handlers (dependants, paired-child installs, wrong scope)', () => {
    renderPage(identityWith());
    expect(screen.queryByText('Nostr follows')).toBeNull();
    renderPage(identityWith(), { onImportFollows: vi.fn() });
    expect(screen.queryByText('Nostr follows')).toBeNull();
  });

  it('a followsPending owner slot renders the disabled panel with the reason', () => {
    renderPage(identityWith(), { followsPending: 'Loading your contacts…' });
    expect(screen.getByText('Nostr follows')).toBeDefined();
    expect(screen.getByText('Loading your contacts…')).toBeDefined();
    expect((screen.getByRole('button', { name: 'Import who this account follows' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a dependant slot renders no panel even with followsPending', () => {
    const dep = {
      id: 'c'.repeat(64), guardianPubkey: '1'.repeat(64), displayName: 'Sam',
      naturalPerson: { publicKey: 'c'.repeat(64), privateKey: '', displayName: 'Sam' },
      persona: { publicKey: 'd'.repeat(64), privateKey: '', displayName: 'Sam' },
      derivationPath: 'dependant-0', createdAt: 1, autonomyStage: 'full-control', primaryKeypair: 'persona',
    } as never;
    render(
      <PersonaAdvanced
        slotTarget="persona" depPubkey={'c'.repeat(64)} identity={identityWith()} dependants={[dep]}
        followsPending="Loading your contacts…"
        onPublishProfile={vi.fn(async () => ({ ok: true }))} onDisablePublicProfile={vi.fn(async () => {})} onBack={() => {}}
      />,
    );
    expect(screen.getAllByText('Sam').length).toBeGreaterThan(0);
    expect(screen.queryByText('Nostr follows')).toBeNull();
  });

  it('first import: shows the explanation line, imports, and summarises added / already there', async () => {
    const onImport = vi.fn(async () => done());
    renderPage(identityWith(), { onImportFollows: onImport, onUnlinkFollows: vi.fn() });
    expect(screen.getByText("Adds them to Alex's contacts as Ken. Signet never changes who you follow.")).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Import who this account follows' }));
    await screen.findByText(/Added 9 · 1 you already had, now on this list · 2 already there/);
    expect(onImport).toHaveBeenCalledTimes(1);
  });

  it('after an import: Refresh from Nostr, with the last update and follow count', () => {
    renderPage(identityWith({ followsImport: { eventId: 'e'.repeat(64), createdAt: 1, importedAt: Date.UTC(2026, 8, 30, 12), count: 321 } }), {
      onImportFollows: vi.fn(), onUnlinkFollows: vi.fn(),
    });
    expect(screen.getByRole('button', { name: 'Refresh from Nostr' })).toBeDefined();
    expect(screen.getByText(/Last updated .* · 321 follows/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Import who this account follows' })).toBeNull();
  });

  it('says so plainly when relays are unreachable or nothing is there', async () => {
    const onImport = vi.fn<() => Promise<FollowsImportOutcome>>()
      .mockResolvedValueOnce({ status: 'unreachable' })
      .mockResolvedValueOnce({ status: 'empty', found: false });
    renderPage(identityWith(), { onImportFollows: onImport, onUnlinkFollows: vi.fn() });
    fireEvent.click(screen.getByRole('button', { name: 'Import who this account follows' }));
    await screen.findByText("Couldn't reach Nostr relays. Try again in a moment.");
    fireEvent.click(screen.getByRole('button', { name: 'Import who this account follows' }));
    await screen.findByText('No follow list found on Nostr for this account.');
  });
});

describe('FollowsImportPanel', () => {
  it('disabledReason disables Import and shows the reason', () => {
    const onImport = vi.fn();
    render(<FollowsImportPanel personaName="Alex" onImport={onImport} onUnlink={vi.fn()} disabledReason="Loading your contacts…" />);
    const btn = screen.getByRole('button', { name: 'Import who this account follows' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText('Loading your contacts…')).toBeDefined();
    fireEvent.click(btn);
    expect(onImport).not.toHaveBeenCalled();
  });

  it('says how many were skipped because the user removed them', async () => {
    render(<FollowsImportPanel personaName="Alex" onImport={async () => done({ skippedRemoved: 3 })} onUnlink={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Import who this account follows' }));
    await screen.findByText(/3 skipped — you removed them/);
  });

  it('shows the size notice when the import was trimmed', async () => {
    const notice = "Alex follows 1500 accounts. Signet imported the 940 most recent — that's all it can back up alongside your other contacts.";
    render(<FollowsImportPanel personaName="Alex" onImport={async () => done({ trimmedNotice: notice, total: 1500, covered: 940 })} onUnlink={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Import who this account follows' }));
    await screen.findByText(notice);
  });

  it('asks before taking unfollowed accounts off the list, names them, and removes only on confirm', async () => {
    const onUnlink = vi.fn(async (ids: string[]) => ids.length);
    const unfollowed = [{ contactId: '1'.repeat(32), name: 'Pal One' }, { contactId: '2'.repeat(32), name: 'Pal Two' }];
    render(<FollowsImportPanel personaName="Alex" onImport={async () => done({ unfollowed })} onUnlink={onUnlink} />);
    fireEvent.click(screen.getByRole('button', { name: 'Import who this account follows' }));
    await screen.findByText("2 accounts you no longer follow — remove them from Alex's list?");
    expect(screen.getByText('Pal One, Pal Two')).toBeDefined();
    expect(onUnlink).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: "Remove from Alex's list" }));
    await waitFor(() => expect(onUnlink).toHaveBeenCalledWith(unfollowed.map(u => u.contactId)));
    await screen.findByText("Took 2 accounts off Alex's list.");
  });

  it('"Keep them" leaves everything as it is', async () => {
    const onUnlink = vi.fn();
    render(<FollowsImportPanel personaName="Alex" onImport={async () => done({ unfollowed: [{ contactId: '1'.repeat(32), name: 'Pal One' }] })} onUnlink={onUnlink} />);
    fireEvent.click(screen.getByRole('button', { name: 'Import who this account follows' }));
    await screen.findByText("1 account you no longer follow — remove it from Alex's list?");
    fireEvent.click(screen.getByRole('button', { name: 'Keep them' }));
    expect(screen.queryByText(/no longer follow —/)).toBeNull();
    expect(onUnlink).not.toHaveBeenCalled();
  });

  it('says the contacts that are only on this list are kept', async () => {
    render(<FollowsImportPanel personaName="Alex" onImport={async () => done({ unfollowedKept: 2 })} onUnlink={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Import who this account follows' }));
    await screen.findByText(/only on Alex's list, so Signet keeps them/);
  });

  it('the post-import offer has Not now and Import, and finishes with Done', async () => {
    const onNotNow = vi.fn();
    render(<FollowsImportPanel variant="offer" personaName="Alex" onImport={async () => done()} onUnlink={vi.fn()} onNotNow={onNotNow} />);
    expect(screen.getByText('Import who this account follows?')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onNotNow).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByText(/Added 9/);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onNotNow).toHaveBeenCalledTimes(2);
  });

  it('shows an import failure and lets the user retry', async () => {
    const onImport = vi.fn<() => Promise<FollowsImportOutcome>>().mockRejectedValueOnce(new Error('Choose an identity list first.')).mockResolvedValueOnce(done());
    render(<FollowsImportPanel personaName="Alex" onImport={onImport} onUnlink={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Import who this account follows' }));
    await screen.findByText('Choose an identity list first.');
    fireEvent.click(screen.getByRole('button', { name: 'Import who this account follows' }));
    await screen.findByText(/Added 9/);
  });
});
