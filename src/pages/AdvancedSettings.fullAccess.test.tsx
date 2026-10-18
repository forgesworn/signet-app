// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SignetIdentity, AppPreferences } from '../types';
import { AdvancedSettings, type HeartwoodOwnerSettingsProps } from './AdvancedSettings';
import { FULL_ACCESS_COPY, PAIRING_PROBLEM_COPY } from '../lib/heartwood-one-hold';

vi.mock('../lib/relay-health', () => ({ checkRelayHealth: vi.fn(async () => ({
  status: 'reachable', latencyMs: 12, checkedAt: Date.now(), detail: 'ok',
})) }));

const NP = 'a'.repeat(64);
const PERSONA = 'b'.repeat(64);
afterEach(cleanup);

function owner(over: Partial<HeartwoodOwnerSettingsProps> = {}): HeartwoodOwnerSettingsProps {
  return {
    supported: true,
    status: { owner: false, style: 'everyday' },
    checking: false,
    everHadFullAccess: false,
    label: null,
    hasOperatorKey: false,
    canNarrow: true,
    narrow: vi.fn(),
    turnOff: vi.fn(),
    words: ['nice', 'never', 'repair'],
    includeRealName: false,
    storedStyle: undefined,
    run: vi.fn().mockResolvedValue({ ok: true, reply: { naturalPerson: NP, persona: PERSONA, actAs: ['persona'], style: 'everyday' } }),
    ...over,
  };
}

function renderSettings(heartwoodOwner?: HeartwoodOwnerSettingsProps, extra: Partial<React.ComponentProps<typeof AdvancedSettings>> = {}) {
  return render(
    <AdvancedSettings
      identity={{ backedUp: true } as SignetIdentity}
      preferences={{ id: 'current' } as AppPreferences}
      relays={[]} onSetRelays={() => {}} onNavigateBridge={() => {}}
      onSetDefaultBlossomUrl={async () => {}} onSetBlossomConsent={async () => {}}
      signingMode="bunker" bunkerUri="bunker://x"
      heartwoodOwner={heartwoodOwner}
      {...extra}
    />,
  );
}

describe('Settings -> Heartwood full access', () => {
  it('shows nothing about full access on firmware that does not list the method', () => {
    renderSettings(undefined);
    expect(screen.queryByText(/Full access/)).toBeNull();
  });

  it('A10: existing install is offered the hold once; tapping opens the choice screen with words, create:false run on tap', async () => {
    const o = owner();
    renderSettings(o);
    fireEvent.click(screen.getByRole('button', { name: FULL_ACCESS_COPY.offerExisting }));
    expect(await screen.findByRole('heading', { name: FULL_ACCESS_COPY.heading })).toBeTruthy();
    expect(screen.getByTestId('full-access-card').textContent).toContain('nice never');
    expect(o.run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: FULL_ACCESS_COPY.setUp }));
    await waitFor(() => expect(o.run).toHaveBeenCalledWith('everyday'));
    // Back on the settings page afterwards.
    expect(await screen.findByText('Connected to Heartwood signer.')).toBeTruthy();
  });

  it('A10: "Not now" closes the choice without running anything', async () => {
    const o = owner();
    renderSettings(o);
    fireEvent.click(screen.getByRole('button', { name: FULL_ACCESS_COPY.offerExisting }));
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(o.run).not.toHaveBeenCalled();
    expect(await screen.findByText('Connected to Heartwood signer.')).toBeTruthy();
  });

  it('A10: a pubkey mismatch stops with the keys-don\'t-match message', async () => {
    const run = vi.fn().mockResolvedValue({ ok: false, failure: { action: 'mismatch', code: 'pubkey-mismatch', message: FULL_ACCESS_COPY.pairingMismatch } });
    renderSettings(owner({ run }));
    fireEvent.click(screen.getByRole('button', { name: FULL_ACCESS_COPY.offerExisting }));
    fireEvent.click(await screen.findByRole('button', { name: FULL_ACCESS_COPY.setUp }));
    expect(await screen.findByText(FULL_ACCESS_COPY.pairingMismatch)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('A8: re-run starts on the style on file', async () => {
    const o = owner({ everHadFullAccess: true, storedStyle: 'careful' });
    renderSettings(o);
    fireEvent.click(screen.getByRole('button', { name: FULL_ACCESS_COPY.approveAgain }));
    expect((await screen.findByLabelText(/Extra careful/) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: FULL_ACCESS_COPY.setUp }));
    await waitFor(() => expect(o.run).toHaveBeenCalledWith('careful'));
  });

  it('A8: a refused pairing says to pair again', async () => {
    const run = vi.fn().mockResolvedValue({ ok: false, failure: { action: 'continue', code: 'strict', message: PAIRING_PROBLEM_COPY.strict } });
    renderSettings(owner({ everHadFullAccess: true, storedStyle: 'everyday', run }));
    fireEvent.click(screen.getByRole('button', { name: FULL_ACCESS_COPY.approveAgain }));
    fireEvent.click(await screen.findByRole('button', { name: FULL_ACCESS_COPY.setUp }));
    expect(await screen.findByText(new RegExp(FULL_ACCESS_COPY.pairAgain))).toBeTruthy();
  });

  it('A11: Extra careful -> Everyday opens the choice screen on Everyday', async () => {
    renderSettings(owner({ status: { owner: true, style: 'careful' }, everHadFullAccess: true, storedStyle: 'careful' }));
    fireEvent.click(screen.getByRole('button', { name: 'Switch back to Everyday' }));
    expect((await screen.findByLabelText(/Everyday/) as HTMLInputElement).checked).toBe(true);
  });

  it('the approve-again banner lands on the choice screen via openOwnerChoice', async () => {
    const handled = vi.fn();
    renderSettings(owner({ everHadFullAccess: true, storedStyle: 'everyday' }), { openOwnerChoice: 'again', onOwnerChoiceHandled: handled });
    expect(await screen.findByRole('heading', { name: FULL_ACCESS_COPY.heading })).toBeTruthy();
    expect(handled).toHaveBeenCalled();
  });

  it('m8: a banner request that arrives before the words are ready is dropped, not opened later', async () => {
    const handled = vi.fn();
    const props = { openOwnerChoice: 'again' as const, onOwnerChoiceHandled: handled };
    const view = renderSettings(owner({ everHadFullAccess: true, storedStyle: 'everyday', words: null }), props);
    await waitFor(() => expect(handled).toHaveBeenCalled());
    expect(screen.queryByRole('heading', { name: FULL_ACCESS_COPY.heading })).toBeNull();
    // The words arrive later: the screen must not open by itself.
    view.rerender(
      <AdvancedSettings
        identity={{ backedUp: true } as SignetIdentity}
        preferences={{ id: 'current' } as AppPreferences}
        relays={[]} onSetRelays={() => {}} onNavigateBridge={() => {}}
        onSetDefaultBlossomUrl={async () => {}} onSetBlossomConsent={async () => {}}
        signingMode="bunker" bunkerUri="bunker://x"
        heartwoodOwner={owner({ everHadFullAccess: true, storedStyle: 'everyday' })}
        onOwnerChoiceHandled={handled}
      />,
    );
    expect(screen.queryByRole('heading', { name: FULL_ACCESS_COPY.heading })).toBeNull();
  });
});
