// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PrivateVaultStatus } from './PrivateVaultStatus';
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
