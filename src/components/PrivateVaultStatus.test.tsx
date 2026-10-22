// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PrivateVaultStatus } from './PrivateVaultStatus';
import type { PrivateVaultHealth } from '../hooks/usePrivateVaults';

const health = (datasets: PrivateVaultHealth['datasets']): PrivateVaultHealth => ({ phase: 'idle', datasets });
const DAMUS = 'wss://relay.damus.io';
const DITTO = 'wss://relay.ditto.pub';

describe('PrivateVaultStatus blocking relays', () => {
  it('names each distinct failing relay once and offers a button per relay', () => {
    const onDisableRelay = vi.fn();
    render(<PrivateVaultStatus importedDependants={0} onDisableRelay={onDisableRelay} health={health({
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
    render(<PrivateVaultStatus importedDependants={0} onDisableRelay={vi.fn()} health={health({
      'signet:vault:profiles': { state: 'unavailable' },
      'signet:vault:contacts': { state: 'verified', failedRelays: [DAMUS] },
    })} />);
    expect(screen.queryByText(/Not answering/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Turn off/ })).toBeNull();
  });
});
