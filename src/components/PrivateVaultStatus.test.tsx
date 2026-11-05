// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PrivateVaultStatus, privateVaultNeedsAttention, privateVaultWarningVisible } from './PrivateVaultStatus';
import type { PrivateVaultHealth } from '../hooks/usePrivateVaults';

afterEach(cleanup);
const verified = { state: 'verified' as const, canonical: true };

function health(over: Partial<PrivateVaultHealth>): PrivateVaultHealth {
  return { phase: 'running', datasets: {}, ...over };
}

const idleWith = (datasets: PrivateVaultHealth['datasets']): PrivateVaultHealth => ({ phase: 'idle', datasets });
const DAMUS = 'wss://relay.damus.io';
const DITTO = 'wss://relay.ditto.pub';

describe('PrivateVaultStatus blocking relays', () => {
  it('names each distinct failing relay once and offers a button per relay', () => {
    const onDisableRelay = vi.fn();
    render(<PrivateVaultStatus importedDependants={0} onDisableRelay={onDisableRelay} health={idleWith({
      'signet:vault:profiles': { state: 'unavailable', failedRelays: [DAMUS, DITTO] },
      'signet:vault:contacts': { state: 'unavailable', failedRelays: [DAMUS] },
      'signet:vault:grants': { state: 'verified' },
    })} />);
    expect(screen.getByText('Private backups are waiting for a connection')).toBeDefined();
    expect(screen.getByText(/Backups wait until every relay you save to answers\. Not answering: relay\.damus\.io, relay\.ditto\.pub\./)).toBeDefined();
    expect(screen.getAllByRole('button', { name: 'Turn off relay.damus.io' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Turn off relay.damus.io' }));
    expect(onDisableRelay).toHaveBeenCalledWith(DAMUS);
    fireEvent.click(screen.getByRole('button', { name: 'Turn off relay.ditto.pub' }));
    expect(onDisableRelay).toHaveBeenLastCalledWith(DITTO);
  });

  it('shows nothing about relays when no dataset names a failing one', () => {
    render(<PrivateVaultStatus importedDependants={0} onDisableRelay={vi.fn()} health={idleWith({
      'signet:vault:profiles': { state: 'unavailable' },
      'signet:vault:contacts': { state: 'verified', failedRelays: [DAMUS] },
    })} />);
    expect(screen.queryByText(/Not answering/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Turn off/ })).toBeNull();
  });

  it('offers no button for a relay that holds the only checked copy of a backup', () => {
    render(<PrivateVaultStatus importedDependants={0} onDisableRelay={vi.fn()} health={idleWith({
      'signet:vault:profiles': { state: 'unavailable', failedRelays: [DAMUS, DITTO], heldOn: [DAMUS] },
    })} />);
    expect(screen.getByText(/relay\.damus\.io holds your only checked copy of a backup\. Backups carry on once it answers\./)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Turn off relay.damus.io' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Turn off relay.ditto.pub' })).toBeDefined();
  });

  it('still offers the button when the confirmed copy is on more than one relay', () => {
    render(<PrivateVaultStatus importedDependants={0} onDisableRelay={vi.fn()} health={idleWith({
      'signet:vault:profiles': { state: 'unavailable', failedRelays: [DAMUS], heldOn: [DAMUS, DITTO] },
    })} />);
    expect(screen.queryByText(/only checked copy/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Turn off relay.damus.io' })).toBeDefined();
  });

  it('counts a verified dataset whose only confirmed relay is the failing one', () => {
    render(<PrivateVaultStatus importedDependants={0} onDisableRelay={vi.fn()} health={idleWith({
      'signet:vault:profiles': { state: 'unavailable', failedRelays: [DAMUS] },
      'signet:vault:contacts': { state: 'verified', confirmedRelays: [DAMUS] },
    })} />);
    expect(screen.queryByRole('button', { name: /Turn off/ })).toBeNull();
    expect(screen.getByText(/only checked copy/)).toBeDefined();
  });

  it('hides the button for a relay the caller says cannot be switched off', () => {
    render(<PrivateVaultStatus importedDependants={0} onDisableRelay={vi.fn()} canDisableRelay={url => url !== DAMUS} health={idleWith({
      'signet:vault:profiles': { state: 'unavailable', failedRelays: [DAMUS, DITTO] },
    })} />);
    expect(screen.queryByRole('button', { name: 'Turn off relay.damus.io' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Turn off relay.ditto.pub' })).toBeDefined();
    expect(screen.getByText(/Not answering: relay\.damus\.io, relay\.ditto\.pub\./)).toBeDefined();
  });
});

describe('PrivateVaultStatus heading (A5)', () => {
  const sent = { ...verified, published: true };

  it('first sync shows "Backing up 3 of 5…" with two done', () => {
    render(<PrivateVaultStatus importedDependants={0} health={health({
      total: 5,
      datasets: { 'signet:vault:a': sent, 'signet:vault:b': sent },
    })} />);
    expect(screen.getByText('Backing up 3 of 5…')).toBeTruthy();
  });

  it('m6: an unlock re-check that has sent nothing never reads as a backup', () => {
    render(<PrivateVaultStatus importedDependants={0} health={health({ total: 5 })} />);
    expect(screen.getByText('Checking private backups')).toBeTruthy();
    cleanup();
    render(<PrivateVaultStatus importedDependants={0} health={health({
      total: 5, datasets: { 'signet:vault:a': verified, 'signet:vault:b': verified },
    })} />);
    expect(screen.getByText('Checking private backups')).toBeTruthy();
  });

  it('m6: a dataset that ended unavailable still counts as finished, so the number moves on', () => {
    render(<PrivateVaultStatus importedDependants={0} health={health({
      total: 5,
      datasets: { 'signet:vault:a': sent, 'signet:vault:b': { state: 'unavailable' as const, canonical: false } },
    })} />);
    expect(screen.getByText('Backing up 3 of 5…')).toBeTruthy();
  });

  it('a later poll where everything is already verified keeps the quiet heading', () => {
    render(<PrivateVaultStatus importedDependants={0} health={health({
      total: 2, datasets: { 'signet:vault:a': sent, 'signet:vault:b': sent },
    })} />);
    expect(screen.getByText('Checking private backups')).toBeTruthy();
  });

  it('without a total it is unchanged', () => {
    render(<PrivateVaultStatus importedDependants={0} health={health({})} />);
    expect(screen.getByText('Checking private backups')).toBeTruthy();
  });
});

describe('privateVaultNeedsAttention', () => {
  const canonical = { canonical: true };
  it('is true for a backup that failed validation, even mid-check', () => {
    expect(privateVaultNeedsAttention(health({ datasets: { a: { state: 'unusable', ...canonical } } }))).toBe(true);
  });
  it('is true once settled with a relay not answering or an upload waiting', () => {
    expect(privateVaultNeedsAttention(idleWith({ a: { state: 'unavailable', ...canonical } }))).toBe(true);
    expect(privateVaultNeedsAttention(idleWith({ a: { state: 'pending', ...canonical } }))).toBe(true);
  });
  it('stays quiet while a check is still running', () => {
    expect(privateVaultNeedsAttention(health({ datasets: { a: { state: 'unavailable', ...canonical }, b: { state: 'pending', ...canonical } } }))).toBe(false);
  });
  it('stays quiet when healthy, unsupported, waiting on migration or empty', () => {
    expect(privateVaultNeedsAttention(idleWith({ a: verified }))).toBe(false);
    expect(privateVaultNeedsAttention({ phase: 'unsupported', datasets: {} })).toBe(false);
    expect(privateVaultNeedsAttention(idleWith({ a: { state: 'waiting-legacy', ...canonical } }))).toBe(false);
    expect(privateVaultNeedsAttention(idleWith({}))).toBe(false);
  });
  it('stays quiet while the signer is waiting on an approval, whatever the datasets report', () => {
    expect(privateVaultNeedsAttention({ phase: 'idle', needsApproval: true, datasets: {
      a: { state: 'unusable', ...canonical }, b: { state: 'unavailable', ...canonical } } })).toBe(false);
  });
  it('is true when backups have stopped and no dataset can say so', () => {
    expect(privateVaultNeedsAttention({ phase: 'idle', datasets: {}, stopped: 'listing' })).toBe(true);
    expect(privateVaultNeedsAttention({ phase: 'checking', datasets: {}, stopped: 'contacts-import' })).toBe(true);
  });
});

describe('privateVaultWarningVisible', () => {
  const failing = { a: { state: 'unavailable' as const } };
  it('shows when attention is needed, whatever came before', () => {
    expect(privateVaultWarningVisible(idleWith(failing), false)).toBe(true);
  });
  it('stays up through a running re-check once shown', () => {
    expect(privateVaultWarningVisible({ phase: 'running', datasets: failing }, true)).toBe(true);
    expect(privateVaultWarningVisible({ phase: 'running', datasets: {} }, true)).toBe(true);
  });
  it('drops when a lost signer holds the phase at checking', () => {
    expect(privateVaultWarningVisible({ phase: 'checking', datasets: {} }, true)).toBe(false);
  });
  it('does not call a backup invalid while a signer approval is what is missing', () => {
    render(<PrivateVaultStatus importedDependants={0} health={{ phase: 'idle', needsApproval: true, datasets: { a: { state: 'unusable', canonical: true } } }} />);
    expect(screen.queryByText(/could not be validated/)).toBeNull();
    expect(screen.queryByText('A private backup needs attention')).toBeNull();
  });
  it.each(['running', 'checking'] as const)('does not appear during a %s check if it was not showing', (phase) => {
    expect(privateVaultWarningVisible({ phase, datasets: failing }, false)).toBe(false);
  });
  it('re-evaluates when the check settles', () => {
    expect(privateVaultWarningVisible(idleWith({ a: verified }), true)).toBe(false);
    expect(privateVaultWarningVisible(idleWith(failing), true)).toBe(true);
  });
  it('gives way to the approval banner even mid-check', () => {
    expect(privateVaultWarningVisible({ phase: 'running', datasets: failing, needsApproval: true }, true)).toBe(false);
  });
  it('keeps an open details element and a rotation message across the re-check', () => {
    const onRotate = vi.fn(async () => 'Backup key changed.');
    const shown = (h: PrivateVaultHealth) => (
      <div>{privateVaultWarningVisible(h, true) && <PrivateVaultStatus importedDependants={0} health={h} onRotate={onRotate} />}</div>
    );
    const { container, rerender } = render(shown(idleWith({ a: verified, b: { state: 'pending' } })));
    const details = container.querySelector('details')!;
    details.open = true;
    rerender(shown({ phase: 'running', datasets: { a: verified, b: { state: 'pending' } } }));
    expect(container.querySelector('details')).toBe(details);
    expect(details.open).toBe(true);
  });
});

describe('PrivateVaultStatus stopped', () => {
  it('says plainly that a failed job list has stopped backups, and that it retries', () => {
    render(<PrivateVaultStatus importedDependants={0} health={{ phase: 'idle', datasets: {}, stopped: 'listing' }} />);
    expect(screen.getByText('Private backups have stopped')).toBeDefined();
    expect(screen.getByText(/tries again by itself/)).toBeDefined();
    expect(screen.queryByText(/retry automatically/)).toBeNull();
  });
  it('replaces "Checking existing backups" after a failed contacts import, and names the remedy', () => {
    render(<PrivateVaultStatus importedDependants={0} health={{ phase: 'checking', datasets: {}, stopped: 'contacts-import' }} />);
    expect(screen.getByText('Private backups have stopped')).toBeDefined();
    expect(screen.queryByText('Checking existing backups before migration')).toBeNull();
    expect(screen.getByText(/Lock and unlock Signet to try again/)).toBeDefined();
  });
});
