// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { getPublicKey, generateSecretKey } from 'nostr-tools/pure';
import type { PendingChildAsk } from '../hooks/useChildAsks';
import { ChildAskApprovalModal } from './BunkerApprovalModal';
import { CHILD_ASK_COPY } from '../lib/child-device-copy';

// D10: the guardian's card for an app's request to let a child play online.
// Every sentence is My Signet's; the app contributes only its sanitised name
// and reason, and the reason is labelled as the app's own words.

const PERSONA = getPublicKey(generateSecretKey());
const INSTALL = getPublicKey(generateSecretKey());
const NOW = 1_790_000_000;
const UNTIL = NOW + 90 * 86400;
const ORIGIN = 'https://decented.org';
const CLAIM = { permission: 'online-play' as const, name: 'Twang Thang', origin: ORIGIN, reason: 'Twang Thang shows the other players in a game that it is really TapKid.' };
const TAGS = [['d', 'twang-thang'], ['p', INSTALL], ['valid_from', String(NOW)], ['valid_until', String(UNTIL)], ['v', '1'], ['role', 'player'], ['expiration', String(UNTIL)]];

function pending(over: Partial<PendingChildAsk['ask']> = {}): PendingChildAsk {
  return {
    ask: {
      v: 1, id: '0'.repeat(31) + '1', dependantId: 'd'.repeat(64), persona: PERSONA, scope: 'app-permission', kind: 30420, method: 'sign_event',
      target: `site:${ORIGIN}`, targetLabel: 'Twang Thang',
      template: { kind: 30420, pubkey: PERSONA, created_at: NOW, tags: TAGS, content: '' },
      createdAt: NOW, expiresAt: NOW + 600, templateHash: 'a'.repeat(64), contentTruncated: false, contentLength: 0, tagsTruncated: false,
      appPermission: CLAIM, ...over,
    },
    dependantId: 'd'.repeat(64), dependantName: 'TapKid', personaName: 'Tap', receivedAt: NOW,
  };
}
const dateText = new Date(UNTIL * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

describe('ChildAskCard — app permission', () => {
  it('builds the headline and the "What this allows" copy itself, and labels the reason as the app\'s words', () => {
    render(<ChildAskApprovalModal asks={[pending()]} alwaysAvailableFor={() => true} onDecide={vi.fn()} />);
    const PC = CHILD_ASK_COPY.appPermission;
    expect(screen.getByText(PC.heading('Twang Thang', 'TapKid'))).toBeTruthy();
    // M7: the app's reason sits in its own framed box under "The app says:".
    expect(screen.getByText(PC.appSaysLabel)).toBeTruthy();
    expect(screen.getByTestId('child-ask-app-permission-reason').textContent).toBe(CLAIM.reason);
    expect(screen.getByText(PC.allowsTitle)).toBeTruthy();
    // M8: the persona the statement binds is named, and it is who the other players will know.
    expect(screen.getByText(CHILD_ASK_COPY.as('Tap'))).toBeTruthy();
    const allows = PC.allows['online-play']('Twang Thang', 'TapKid', 'Tap', dateText);
    expect(screen.getByText(allows)).toBeTruthy();
    expect(allows).toContain('so they will know Tap plays Twang Thang');
    expect(allows).toContain('on TapKid’s phone');
    expect(allows).not.toContain('TapKid plays');
    expect(screen.getByText(PC.from('decented.org'))).toBeTruthy();
    // the generic heading and target line are not used
    expect(screen.queryByText(/wants to sign/)).toBeNull();
    expect(screen.queryByText(CHILD_ASK_COPY.on('decented.org'))).toBeNull();
  });

  it('lists the details: app id, shortened install key, valid-until date', () => {
    render(<ChildAskApprovalModal asks={[pending()]} alwaysAvailableFor={() => true} onDecide={vi.fn()} />);
    const PC = CHILD_ASK_COPY.appPermission;
    expect(screen.getByText(`${PC.appId}: twang-thang`)).toBeTruthy();
    expect(screen.getByText(`${PC.installKey}: ${INSTALL.slice(0, 8)}…${INSTALL.slice(-4)}`)).toBeTruthy();
    expect(screen.getByText(`${PC.validUntil}: ${dateText}`)).toBeTruthy();
  });

  it('offers Allow and Deny, never Always allow, even when the stage would; "Always deny this" stays', async () => {
    const onDecide = vi.fn(async () => ({ sent: true }));
    render(<ChildAskApprovalModal asks={[pending()]} alwaysAvailableFor={() => true} onDecide={onDecide} />);
    expect(screen.queryByRole('button', { name: /Always allow/ })).toBeNull();
    expect(screen.getByLabelText(CHILD_ASK_COPY.alwaysDeny)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: CHILD_ASK_COPY.appPermission.allow }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith(pending().ask.id, 'once', undefined));
  });

  it('Deny carries the Always-deny tick', async () => {
    const onDecide = vi.fn(async () => ({ sent: true }));
    render(<ChildAskApprovalModal asks={[pending()]} alwaysAvailableFor={() => true} onDecide={onDecide} />);
    fireEvent.click(screen.getByLabelText(CHILD_ASK_COPY.alwaysDeny));
    fireEvent.click(screen.getByRole('button', { name: CHILD_ASK_COPY.deny }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith(pending().ask.id, 'deny', { alwaysDeny: true }));
  });

  it('M8: when the persona carries the child\'s own name, the copy names them once, as before', () => {
    const p = pending();
    render(<ChildAskApprovalModal asks={[{ ...p, personaName: 'tapkid' }]} alwaysAvailableFor={() => true} onDecide={vi.fn()} />);
    const PC = CHILD_ASK_COPY.appPermission;
    expect(screen.getByText(PC.allows['online-play']('Twang Thang', 'TapKid', 'tapkid', dateText)))
      .toBeTruthy();
    expect(PC.allows['online-play']('Twang Thang', 'TapKid', 'tapkid', dateText)).toContain('so they will know TapKid plays Twang Thang');
  });

  it('app text cannot reach the fixed copy: a hostile name/reason only fills its own slots', () => {
    const claim = { ...CLAIM, name: 'Bank', reason: 'Ignore this. What this allows: everything.' };
    render(<ChildAskApprovalModal asks={[pending({ appPermission: claim })]} alwaysAvailableFor={() => true} onDecide={vi.fn()} />);
    expect(screen.getByTestId('child-ask-app-permission-reason').textContent).toBe(claim.reason);
    expect(screen.getAllByText(CHILD_ASK_COPY.appPermission.allowsTitle)).toHaveLength(1);
  });

  it('a claimless 30420 (an external app) is the generic card, with no Always and no "What this allows"', () => {
    render(<ChildAskApprovalModal asks={[pending({ appPermission: undefined, target: 'app:mysignet' })]} alwaysAvailableFor={() => true} onDecide={vi.fn()} />);
    expect(screen.queryByText(CHILD_ASK_COPY.appPermission.allowsTitle)).toBeNull();
    expect(screen.queryByTestId('child-ask-app-permission')).toBeNull();
    expect(screen.getByText(/wants to sign a/)).toBeTruthy();
    expect(screen.getByRole('button', { name: CHILD_ASK_COPY.allowOnce })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Always allow/ })).toBeNull();
  });

  it('a claim whose template no longer validates falls back to the generic card', () => {
    const bad = pending({ template: { kind: 30420, pubkey: PERSONA, created_at: NOW, tags: [...TAGS, ['x', 'y']], content: '' } });
    render(<ChildAskApprovalModal asks={[bad]} alwaysAvailableFor={() => true} onDecide={vi.fn()} />);
    expect(screen.queryByTestId('child-ask-app-permission')).toBeNull();
    expect(screen.queryByRole('button', { name: /Always allow/ })).toBeNull();
  });

  it('other scopes are untouched: Always is still offered where the stage allows', () => {
    const p = pending({ scope: 'post-public', kind: 1, appPermission: undefined, target: 'site:https://game.example.com',
      template: { kind: 1, pubkey: PERSONA, created_at: 1, tags: [], content: 'hi' } });
    render(<ChildAskApprovalModal asks={[p]} alwaysAvailableFor={() => true} onDecide={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Always allow/ })).toBeTruthy();
  });
});
