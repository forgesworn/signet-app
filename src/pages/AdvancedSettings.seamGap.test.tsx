// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { AppPreferences, SignetIdentity } from '../types';
import { AdvancedSettings } from './AdvancedSettings';

vi.mock('../lib/relay-health', () => ({ checkRelayHealth: vi.fn(async () => ({
  status: 'reachable', latencyMs: 12, checkedAt: Date.now(), detail: 'Read check completed.',
})) }));

function renderPage(onSetHandshakeSeamGapMm?: (mm: number | undefined) => void) {
  return render(
    <AdvancedSettings
      identity={{ backedUp: true } as SignetIdentity}
      preferences={{} as AppPreferences}
      relays={[]}
      onSetRelays={async () => {}}
      onNavigateBridge={() => {}}
      onSetDefaultBlossomUrl={async () => {}}
      onSetBlossomConsent={async () => {}}
      onSetHandshakeSeamGapMm={onSetHandshakeSeamGapMm}
    />,
  );
}

describe('AdvancedSettings: Jigsaw edge distance', () => {
  afterEach(cleanup);

  it('offers seam calibration when the page is given a setter', () => {
    renderPage(vi.fn());
    expect(screen.getByLabelText('Jigsaw edge distance')).toBeTruthy();
  });

  it('does not offer it when no setter is given (paired child)', () => {
    renderPage(undefined);
    expect(screen.queryByLabelText('Jigsaw edge distance')).toBeNull();
  });
});
