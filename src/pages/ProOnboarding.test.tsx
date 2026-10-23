// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ProOnboarding } from './ProOnboarding';
import { proResolver } from '../lib/professional/resolver';
import { getWriteRelayUrls } from '../lib/relay-service';
import type { SigningBackend } from '../lib/signing-backend';

vi.mock('../lib/professional/resolver', () => ({ proResolver: { resolve: vi.fn() } }));
vi.mock('../lib/relay-service', () => ({ getWriteRelayUrls: vi.fn(), publishEvent: vi.fn() }));

async function completeRegistryLookup() {
  render(<ProOnboarding leadPubkeyHex={'a'.repeat(64)} backend={{} as SigningBackend}
    proAnchorHook={{ publish: vi.fn() }} onComplete={vi.fn()} onBack={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: /Head teacher/ }));
  fireEvent.click(screen.getByRole('button', { name: 'England' }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.change(screen.getByPlaceholderText('100000'), { target: { value: '100000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Look up in registry' }));
  await screen.findByText('Confirm your website');
  fireEvent.click(screen.getByRole('button', { name: 'Confirm and generate signet.json' }));
}

describe('Professional relay publication', () => {
  beforeEach(() => {
    vi.mocked(proResolver.resolve).mockResolvedValue({
      professionKind: 'school', jurisdiction: 'england', registry: 'GIAS',
      identifier: '100000', identifierKind: 'URN', name: 'Example school', status: 'Active',
      website: 'school.example', inferredCandidateWebsite: null, postcode: '', locality: '',
      tags: [], fetchedAt: new Date().toISOString(),
    });
  });

  it('advertises the relays used for publishing the professional record', async () => {
    vi.mocked(getWriteRelayUrls).mockReturnValue(['wss://chosen.example', 'wss://second.example']);
    await completeRegistryLookup();
    const json = JSON.parse(document.querySelector('pre')!.textContent!);
    expect(json.relays).toEqual(['wss://chosen.example', 'wss://second.example']);
    expect(json.headPubkey).toMatch(/^npub1/);
  });

  it('keeps onboarding at confirmation when no publishing relay is enabled', async () => {
    vi.mocked(getWriteRelayUrls).mockReturnValue([]);
    await completeRegistryLookup();
    expect(screen.getByText(/Enable a relay for publishing/)).toBeInTheDocument();
    expect(document.querySelector('pre')).toBeNull();
  });
});
