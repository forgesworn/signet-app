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
