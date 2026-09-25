import { describe, it, expect } from 'vitest';
import { handOffAuthCallback } from './auth-redirect-handoff';

describe('handOffAuthCallback', () => {
  it('retires the request and leaves the page before redirecting, redirecting exactly once', () => {
    const calls: string[] = [];
    handOffAuthCallback('https://example.com/cb?pubkey=x', {
      retireRequest: () => calls.push('retire'),
      leaveApprovalPage: () => calls.push('home'),
      redirect: (url) => calls.push(`redirect:${url}`),
    });
    expect(calls).toEqual(['retire', 'home', 'redirect:https://example.com/cb?pubkey=x']);
  });

  it('leaves no pending request behind when the redirect does not unload the app (native)', () => {
    let pending: object | null = { challenge: 'c' };
    let page = 'approve-auth';
    handOffAuthCallback('http://localhost:5175/callback.html', {
      retireRequest: () => { pending = null; },
      leaveApprovalPage: () => { page = 'home'; },
      redirect: () => { /* native: WebView stays alive */ },
    });
    expect(pending).toBeNull();
    expect(page).toBe('home');
  });
});
