import { describe, it, expect } from 'vitest';
import { AuthRequestSettlement, authRequestKey } from './auth-request-settlement';
import { handOffAuthCallback, shouldRedirectDenial } from './auth-redirect-handoff';

/**
 * Drives the approve/deny race the way App.tsx wires it: a synchronously
 * written request ref (App's setPendingAuthRequest wrapper), the settlement
 * guard, and the delivery gates in front of every callback / relay publish.
 */

type Req = { requestId: string; challenge: string };

function harness() {
  const settlement = new AuthRequestSettlement();
  const ref: { current: Req | null } = { current: null };
  const delivered: string[] = [];
  let dismissed = 0;
  // Mirrors App's setPendingAuthRequest: ref written synchronously; the React
  // state commit happens later and is irrelevant to the gates.
  const setPending = (r: Req | null) => { ref.current = r; };
  const claim = (r: Req) => ref.current === r && settlement.claimDelivery(authRequestKey(r));

  let releaseSign!: () => void;
  const signing = new Promise<void>(res => { releaseSign = res; });

  /** Approve: begin synchronously, await the (routed, slow) signature, then deliver once. */
  async function approve(mode: 'redirect' | 'relay'): Promise<void> {
    const request = ref.current;
    if (!request) throw new Error('No pending auth request');
    const key = authRequestKey(request);
    const began = settlement.beginApproval(key);
    if (began === 'settled') { setPending(null); dismissed++; return; }
    if (began === 'in-flight') throw new Error('already signing');
    try {
      await signing;
      if (!claim(request)) return;
      if (mode === 'redirect') {
        handOffAuthCallback('cb?signature=sig', {
          retireRequest: () => setPending(null),
          leaveApprovalPage: () => {},
          redirect: url => delivered.push(url),
        });
      } else {
        setPending(null);
        delivered.push('relay:approved');
      }
    } finally {
      settlement.endApproval(key);
    }
  }

  /** Explicit Deny/Cancel/back chevron: may take over an in-flight approval; an answered request is dismissed. */
  function deny(mode: 'redirect' | 'relay'): void {
    const request = ref.current;
    // No pending request ⇒ nothing to answer (App's deny sends no callback then).
    if (!request) return;
    if (settlement.deny(authRequestKey(request)) === 'already-answered') { setPending(null); dismissed++; return; }
    setPending(null);
    delivered.push(mode === 'redirect' ? 'cb?error=denied' : 'relay:rejected');
  }

  return { settlement, ref, setPending, delivered, approve, deny, releaseSign: () => releaseSign(), dismissed: () => dismissed };
}

const req = (): Req => ({ requestId: 'f'.repeat(32), challenge: 'c'.repeat(64) });

describe('AuthRequestSettlement — one answer per sign-in request', () => {
  for (const mode of ['redirect', 'relay'] as const) {
    const approved = mode === 'redirect' ? 'cb?signature=sig' : 'relay:approved';
    const denied = mode === 'redirect' ? 'cb?error=denied' : 'relay:rejected';

    it(`${mode}: an explicit Deny/Cancel mid-approval takes over — exactly one answer (the denial)`, async () => {
      const h = harness();
      h.setPending(req());
      const approving = h.approve(mode);
      h.deny(mode);                 // paired-child Cancel / back chevron mid-sign
      expect(h.delivered).toEqual([denied]);
      h.releaseSign();
      await approving;              // the signature lands, but its delivery claim fails
      expect(h.delivered).toEqual([denied]);
    });

    it(`${mode}: an approval that delivered first wins; a stray Deny afterwards sends nothing`, async () => {
      const h = harness();
      const r = req();
      h.setPending(r);
      const approving = h.approve(mode);
      h.releaseSign();
      await approving;
      expect(h.delivered).toEqual([approved]);
      h.setPending(r);              // the same request shown again
      h.deny(mode);
      expect(h.delivered).toEqual([approved]);
      expect(h.ref.current).toBeNull();   // dismissed, not stuck
    });

    it(`${mode}: Deny first — a later Approve of the same request sends nothing and dismisses it`, async () => {
      const h = harness();
      const r = req();
      h.setPending(r);
      h.deny(mode);
      h.setPending({ ...r });       // the same link opened again (new object, same id)
      await h.approve(mode);
      expect(h.delivered).toEqual([denied]);
      expect(h.ref.current).toBeNull();
      expect(h.dismissed()).toBe(1);
    });
  }

  it('the ref beats a not-yet-rendered state clear: a withdrawn request delivers nothing', async () => {
    const h = harness();
    h.setPending(req());
    const approving = h.approve('redirect');
    h.setPending(null);             // cleared synchronously; no render has happened
    h.releaseSign();
    await approving;
    expect(h.delivered).toEqual([]);
  });

  it('a replacing request is not answered by the old approval', async () => {
    const h = harness();
    h.setPending(req());
    const approving = h.approve('redirect');
    h.setPending({ requestId: 'e'.repeat(32), challenge: 'd'.repeat(64) });
    h.releaseSign();
    await approving;
    expect(h.delivered).toEqual([]);
  });

  it('a failed, undelivered approval reopens the request for retry or deny', () => {
    const s = new AuthRequestSettlement();
    const key = authRequestKey(req());
    expect(s.beginApproval(key)).toBe('ok');
    expect(s.beginApproval(key)).toBe('in-flight');
    s.endApproval(key);
    expect(s.deny(key)).toBe('denied');
    expect(s.deny(key)).toBe('already-answered');
    expect(s.beginApproval(key)).toBe('settled');
    expect(s.claimDelivery(key)).toBe(false);
  });

  it('keys requests without requestId/challenge per request, never a shared ":"', () => {
    const a = {};
    const b = {};
    expect(authRequestKey(a)).not.toBe(authRequestKey(b));
    expect(authRequestKey(a)).toBe(authRequestKey(a));
    expect(authRequestKey(a)).not.toBe(':');
    const s = new AuthRequestSettlement();
    expect(s.deny(authRequestKey(a))).toBe('denied');
    expect(s.beginApproval(authRequestKey(b))).toBe('ok');
  });
});

describe('shouldRedirectDenial — a normal Deny of a URL sign-in hands back error=denied', () => {
  it('redirects a URL-auth request even when the consumer sent no name=', () => {
    expect(shouldRedirectDenial({ fromUrlAuth: true, siteName: '', callbackUrl: 'http://localhost:5175/callback.html' })).toBe(true);
  });
  it('still redirects when only the site name marks it as URL auth', () => {
    expect(shouldRedirectDenial({ fromUrlAuth: false, siteName: 'Test', callbackUrl: 'https://x.example/cb' })).toBe(true);
  });
  it('keeps a QR/BroadcastChannel request in the app', () => {
    expect(shouldRedirectDenial({ fromUrlAuth: false, siteName: '', callbackUrl: 'https://x.example/cb' })).toBe(false);
    expect(shouldRedirectDenial({ fromUrlAuth: true, siteName: 'Test', callbackUrl: undefined })).toBe(false);
  });
  it('after an unlock, a not-in-flight Deny hands off exactly one error=denied callback', () => {
    const s = new AuthRequestSettlement();
    const r = req();
    const calls: string[] = [];
    expect(s.deny(authRequestKey(r))).toBe('denied');
    handOffAuthCallback('cb?error=denied', {
      retireRequest: () => calls.push('retire'),
      leaveApprovalPage: () => calls.push('home'),
      redirect: u => calls.push(u),
    });
    expect(calls).toEqual(['retire', 'home', 'cb?error=denied']);
  });
});
