// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PrivateVaultStatus } from './PrivateVaultStatus';
import type { PrivateVaultHealth } from '../hooks/usePrivateVaults';

afterEach(cleanup);
const verified = { state: 'verified' as const, canonical: true };

function health(over: Partial<PrivateVaultHealth>): PrivateVaultHealth {
  return { phase: 'running', datasets: {}, ...over };
}

describe('PrivateVaultStatus heading (A5)', () => {
  it('first sync shows "Backing up 3 of 5…" with two done', () => {
    render(<PrivateVaultStatus importedDependants={0} health={health({
      total: 5,
      datasets: { 'signet:vault:a': verified, 'signet:vault:b': verified },
    })} />);
    expect(screen.getByText('Backing up 3 of 5…')).toBeTruthy();
  });

  it('shows 1 of N before anything has verified', () => {
    render(<PrivateVaultStatus importedDependants={0} health={health({ total: 5 })} />);
    expect(screen.getByText('Backing up 1 of 5…')).toBeTruthy();
  });

  it('a later poll where everything is already verified keeps the quiet heading', () => {
    render(<PrivateVaultStatus importedDependants={0} health={health({
      total: 2, datasets: { 'signet:vault:a': verified, 'signet:vault:b': verified },
    })} />);
    expect(screen.getByText('Checking private backups')).toBeTruthy();
  });

  it('without a total it is unchanged', () => {
    render(<PrivateVaultStatus importedDependants={0} health={health({})} />);
    expect(screen.getByText('Checking private backups')).toBeTruthy();
  });
});
