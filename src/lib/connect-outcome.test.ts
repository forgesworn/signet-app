import { describe, it, expect } from 'vitest';
import { AuthRequestSettlement } from './auth-request-settlement';
import { trackApproval, connectErrorMessage, CONNECT_FAILED_COPY, type ConnectOutcome } from './connect-outcome';

function setup(opts: { current?: () => boolean } = {}) {
  const settlement = new AuthRequestSettlement();
  const key = 'k1';
  const recorded: Array<ConnectOutcome | null> = [];
  const track = (run: (s: AuthRequestSettlement) => Promise<void>) => trackApproval({
    key,
    settlement,
    isCurrent: opts.current ?? (() => true),
    record: o => recorded.push(o),
    run: async () => { settlement.beginApproval(key); await run(settlement); },
  });
  return { settlement, key, recorded, track };
}

describe('trackApproval', () => {
  it('records sending first', async () => {
    const t = setup();
    await t.track(async s => { s.claimDelivery(t.key); });
    expect(t.recorded[0]).toEqual({ key: 'k1', status: 'sending' });
  });

  it('in flight when the run throws: error (the request is open for another try), and rethrows', async () => {
    const t = setup();
    await expect(t.track(async () => { throw new Error('relay down'); })).rejects.toThrow('relay down');
    expect(t.recorded.at(-1)).toEqual({ key: 'k1', status: 'error', error: 'relay down' });
    expect(t.settlement.isAnswered(t.key)).toBe(false);
  });

  it('a claim handed back before the throw is still an error', async () => {
    const t = setup();
    await expect(t.track(async s => { s.claimDelivery(t.key); s.unclaimDelivery(t.key); throw new Error('send failed'); })).rejects.toThrow();
    expect(t.recorded.at(-1)).toMatchObject({ status: 'error' });
  });

  it('settled when the run throws: closed (answered), with the message, and rethrows', async () => {
    const t = setup();
    await expect(t.track(async s => { s.claimDelivery(t.key); throw new Error('may be paired'); })).rejects.toThrow('may be paired');
    expect(t.recorded.at(-1)).toEqual({ key: 'k1', status: 'closed', error: 'may be paired' });
  });

  it('settled when the run resolves: sent', async () => {
    const t = setup();
    await t.track(async s => { s.claimDelivery(t.key); });
    expect(t.recorded.at(-1)).toEqual({ key: 'k1', status: 'sent' });
  });

  it('in flight when the run resolves (returned without answering): the outcome is cleared', async () => {
    const t = setup();
    await t.track(async () => {});
    expect(t.recorded).toEqual([{ key: 'k1', status: 'sending' }, null]);
  });

  it('records nothing once the request is no longer the current one', async () => {
    let current = true;
    const t = setup({ current: () => current });
    await t.track(async s => { s.claimDelivery(t.key); current = false; });
    expect(t.recorded).toEqual([{ key: 'k1', status: 'sending' }]);
    const u = setup({ current: () => current });
    await expect(u.track(async () => { throw new Error('x'); })).rejects.toThrow();
    expect(u.recorded).toEqual([]);
  });

  it('a request taken over by Deny while it ran records no outcome', async () => {
    let current = true;
    const t = setup({ current: () => current });
    await t.track(async s => { s.deny(t.key); current = false; });
    expect(t.recorded).toEqual([{ key: 'k1', status: 'sending' }]);
  });
});

describe('connectErrorMessage', () => {
  it('uses an Error\'s message and a generic line otherwise', () => {
    expect(connectErrorMessage(new Error('boom'))).toBe('boom');
    expect(connectErrorMessage('boom')).toBe(CONNECT_FAILED_COPY);
  });
});
