// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { getPublicKey, generateSecretKey } from 'nostr-tools/pure';
import type { PendingChildAsk } from '../hooks/useChildAsks';
import { ChildAskApprovalModal } from './BunkerApprovalModal';
import { signInAskDetails } from '../lib/child-sign-asks';
import { CHILD_ASK_COPY } from '../lib/child-device-copy';

// Part B: a direct-paired child's own relay-mode Sign in with Signet is one
// plain card. The site's name is its own claim; "From" is the origin the
// guardian's phone re-derived from the signed 21236 itself.

const PERSONA = getPublicKey(generateSecretKey());
const NOW = 1_790_000_000;
const ORIGIN = 'https://decented.org';

function pending(over: Partial<PendingChildAsk['ask']> = {}): PendingChildAsk {
  return {
    ask: {
      v: 1, id: '0'.repeat(31) + '2', dependantId: 'd'.repeat(64), persona: PERSONA, scope: 'sign-in', kind: 21236, method: 'sign_event',
      target: `site:${ORIGIN}`, targetLabel: 'Twang Thang',
      template: { kind: 21236, pubkey: PERSONA, created_at: NOW, tags: [['challenge', 'c'.repeat(64)], ['origin', ORIGIN], ['app', 'Twang Thang']], content: '' },
      createdAt: NOW, expiresAt: NOW + 600, templateHash: 'a'.repeat(64), contentTruncated: false, contentLength: 0, tagsTruncated: false,
      signIn: { sharesHandle: true }, ...over,
    },
    dependantId: 'd'.repeat(64), dependantName: 'TapKid', personaName: 'Tap', receivedAt: NOW,
  };
}
const SC = CHILD_ASK_COPY.signIn;

describe('ChildAskCard — a marked sign-in (Part B)', () => {
  it('reads "<child> wants to sign in to <site>" · "From <origin>" · "Shares <child>\'s handle: yes"', () => {
    render(<ChildAskApprovalModal asks={[pending()]} alwaysAvailableFor={() => true} onDecide={vi.fn()} />);
    expect(SC.heading('TapKid', 'Twang Thang')).toBe('TapKid wants to sign in to Twang Thang');
    expect(screen.getByText(SC.heading('TapKid', 'Twang Thang'))).toBeTruthy();
    expect(screen.getByText(SC.from('decented.org'))).toBeTruthy();
    expect(SC.sharesHandle('TapKid', true)).toBe('Shares TapKid’s handle: yes');
    expect(screen.getByText(SC.sharesHandle('TapKid', true))).toBeTruthy();
    expect(screen.getByText(CHILD_ASK_COPY.as('Tap'))).toBeTruthy();
    expect(screen.getByTestId('child-ask-sign-in')).toBeTruthy();
    // none of the mechanics wording
    expect(screen.queryByText(/wants to sign a/)).toBeNull();
    expect(screen.queryByText(/kind 21236/)).toBeNull();
  });

  it('says "no" when the handle is not shared', () => {
    render(<ChildAskApprovalModal asks={[pending({ signIn: { sharesHandle: false } })]} alwaysAvailableFor={() => true} onDecide={vi.fn()} />);
    expect(SC.sharesHandle('TapKid', false)).toBe('Shares TapKid’s handle: no');
    expect(screen.getByText(SC.sharesHandle('TapKid', false))).toBeTruthy();
  });

  it('with no site name, the heading names the origin\'s host', () => {
    render(<ChildAskApprovalModal asks={[pending({ targetLabel: '' })]} alwaysAvailableFor={() => true} onDecide={vi.fn()} />);
    expect(screen.getByText(SC.heading('TapKid', 'decented.org'))).toBeTruthy();
  });

  it('offers Allow once, Always (as today for sign-in) and Deny with the Always-deny tick', async () => {
    const onDecide = vi.fn(async () => ({ sent: true }));
    render(<ChildAskApprovalModal asks={[pending()]} alwaysAvailableFor={() => true} onDecide={onDecide} />);
    expect(screen.getByRole('button', { name: CHILD_ASK_COPY.allowAlways('sign-in to', 'decented.org', 'Tap') })).toBeTruthy();
    expect(screen.getByLabelText(CHILD_ASK_COPY.alwaysDeny)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: CHILD_ASK_COPY.allowOnce }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith(pending().ask.id, 'once', undefined));
  });

  it('Always follows the stage as today (hidden at full-control)', () => {
    render(<ChildAskApprovalModal asks={[pending()]} alwaysAvailableFor={() => false} onDecide={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Always allow/ })).toBeNull();
    expect(screen.getByRole('button', { name: CHILD_ASK_COPY.deny })).toBeTruthy();
  });

  it('Deny carries the Always-deny tick', async () => {
    const onDecide = vi.fn(async () => ({ sent: true }));
    render(<ChildAskApprovalModal asks={[pending()]} alwaysAvailableFor={() => true} onDecide={onDecide} />);
    fireEvent.click(screen.getByLabelText(CHILD_ASK_COPY.alwaysDeny));
    fireEvent.click(screen.getByRole('button', { name: CHILD_ASK_COPY.deny }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith(pending().ask.id, 'deny', { alwaysDeny: true }));
  });

  it('a site name cannot reach the fixed copy: it only fills its own slot', () => {
    render(<ChildAskApprovalModal asks={[pending({ targetLabel: 'Bank. Shares TapKid’s handle: no' })]} alwaysAvailableFor={() => true} onDecide={vi.fn()} />);
    expect(screen.getByText(SC.sharesHandle('TapKid', true))).toBeTruthy();
    expect(screen.getByText(SC.from('decented.org'))).toBeTruthy();
  });
});

describe('ChildAskCard — unmarked or malformed sign-in asks keep today\'s card', () => {
  it('unmarked (an older child, an outside app, redirect mode): the generic card', () => {
    const p = pending({ signIn: undefined });
    render(<ChildAskApprovalModal asks={[p]} alwaysAvailableFor={() => true} onDecide={vi.fn()} />);
    expect(screen.queryByTestId('child-ask-sign-in')).toBeNull();
    expect(screen.getByText(/wants to sign a/)).toBeTruthy();
    expect(screen.getByText(CHILD_ASK_COPY.on('decented.org'))).toBeTruthy();
  });

  it('the details helper refuses anything but a marked 21236 sign-in on a site', () => {
    expect(signInAskDetails(pending().ask)).toEqual({ site: 'Twang Thang', sharesHandle: true });
    expect(signInAskDetails(pending({ signIn: undefined }).ask)).toBeNull();
    expect(signInAskDetails(pending({ scope: 'post-public' }).ask)).toBeNull();
    expect(signInAskDetails(pending({ kind: 1 }).ask)).toBeNull();
    expect(signInAskDetails(pending({ target: 'app:mysignet' }).ask)).toBeNull();
    expect(signInAskDetails(pending({ method: 'nip44_encrypt', template: undefined }).ask)).toBeNull();
    expect(signInAskDetails(pending({ template: { kind: 1, pubkey: PERSONA, created_at: NOW, tags: [], content: '' } }).ask)).toBeNull();
  });

  it('a malformed marker falls back to the generic card', () => {
    const p = pending({ kind: 1 });
    render(<ChildAskApprovalModal asks={[p]} alwaysAvailableFor={() => true} onDecide={vi.fn()} />);
    expect(screen.queryByTestId('child-ask-sign-in')).toBeNull();
  });
});
