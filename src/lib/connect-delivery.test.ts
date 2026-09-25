import { describe, it, expect } from 'vitest';
import { deliverConnectApproval, ConnectWithdrawnError } from './connect-delivery';
import { AuthRequestSettlement, requestObjectKey } from './auth-request-settlement';

/**
 * Drives the NIP-46 connect approval the way App.tsx wires it: a
 * synchronously written request ref, the one-answer settlement keyed per
 * request object, and deliverConnectApproval's gated outward effects.
 */

type Req = { clientPubkey: string };

function harness(opts: {
  sendOk?: (relay: string) => boolean;
  afterSave?: () => void;
  /** Runs while the connect response is in flight (after the claim). */
  duringSend?: () => void;
  /** Runs while the response is being encrypted/signed (before the claim). */
  duringSigning?: () => void;
  /** An earlier pairing record for this app, from a previous approval. */
  existing?: string;
} = {}) {
  let stored: string | undefined = opts.existing;
  // The live transient route, identified by install token (0 = none).
  let liveRoute = 0;
  let nextToken = 0;
  let approvalSeq = 0;
  const settlement = new AuthRequestSettlement();
  const ref: { current: Req | null } = { current: null };
  const effects: string[] = [];
  let gate: Promise<void> = Promise.resolve();
  let release: () => void = () => {};
  const hold = () => { gate = new Promise<void>(r => { release = r; }); };

  async function approve(relays = ['wss://a']): Promise<string> {
    const request = ref.current;
    if (!request) throw new Error('none');
    const key = requestObjectKey(request);
    const began = settlement.beginApproval(key);
    if (began === 'settled') { ref.current = null; return 'dismissed'; }
    if (began === 'in-flight') throw new Error('Already connecting');
    const mine = `new#${++approvalSeq}`;
    let myRoute = 0;
    try {
      await gate;                       // the device-held route wait
      const stillPending = () => ref.current === request;
      const r = await deliverConnectApproval({
        relayCandidates: relays,
        stillOpen: () => stillPending() && settlement.isInFlight(key),
        claim: () => stillPending() && settlement.claimDelivery(key),
        unclaim: () => settlement.unclaimDelivery(key),
        finishDelivery: () => settlement.finishDelivery(key),
        loadExisting: async () => stored,
        restoreClient: async (prev) => { stored = prev; effects.push(`restore:${prev}`); },
        installRoute: () => { myRoute = liveRoute = ++nextToken; effects.push('route'); },
        clearRoute: () => { if (liveRoute === myRoute) { liveRoute = 0; effects.push('route-cleared'); } },
        arm: async (relay) => { effects.push(`arm:${relay}`); },
        saveClient: async (relay) => { stored = mine; effects.push(`save:${relay}`); opts.afterSave?.(); },
        stillOurs: async () => stored === mine,
        deleteClient: async () => { stored = undefined; effects.push('delete'); },
        send: async (relay, beforePublish) => {
          effects.push(`sign:${relay}`);          // encrypt + sign through the signer
          await Promise.resolve();
          opts.duringSigning?.();
          if (!beforePublish()) throw new ConnectWithdrawnError();
          opts.duringSend?.();
          const ok = opts.sendOk ? opts.sendOk(relay) : true;
          effects.push(`${ok ? 'send' : 'send-failed'}:${relay}`);
          return ok;
        },
      });
      if (r.status === 'failed') throw new Error('Could not complete NostrConnect pairing');
      return r.status;
    } finally {
      settlement.endApproval(key);
    }
  }

  /** Cancel/Deny/back chevron (handleConnectDone). */
  function cancel(): string {
    const request = ref.current;
    const key = request ? requestObjectKey(request) : '';
    if (request && settlement.deny(key) === 'already-answered') {
      settlement.requestCancelDuringDelivery(key);
      ref.current = null;
      return 'dismissed';
    }
    ref.current = null;
    effects.push('denied-callback');
    return 'denied';
  }

  return {
    ref, effects, approve, cancel, hold, release: () => release(),
    stored: () => stored,
    liveRoute: () => liveRoute,
    /** Another approval re-pairs the same app and installs its own route. */
    externalRepair: () => { stored = 'R2'; liveRoute = ++nextToken; return liveRoute; },
    /** The user revokes the pairing in Connections. */
    revoke: () => { stored = undefined; },
  };
}

describe('connect approval — one answer per request', () => {
  it('Cancel during an in-flight connect: no route, no pairing persisted, no connect response', async () => {
    const h = harness();
    h.ref.current = { clientPubkey: '1'.repeat(64) };
    h.hold();
    const approving = h.approve();
    expect(h.cancel()).toBe('denied');         // takes over while waiting for the route
    h.release();
    await expect(approving).resolves.toBe('withdrawn');
    expect(h.effects).toEqual(['denied-callback']);
  });

  it('Cancel after the route is armed and the pairing saved tears both down and sends nothing', async () => {
    let cancel: () => string = () => '';
    const h = harness({ afterSave: () => { cancel(); } });
    cancel = h.cancel;
    h.ref.current = { clientPubkey: '1'.repeat(64) };
    await expect(h.approve()).resolves.toBe('withdrawn');
    expect(h.effects).toEqual(['route', 'arm:wss://a', 'save:wss://a', 'denied-callback', 'delete', 'route-cleared']);
  });

  it('approve completes first: a later Cancel is a no-op dismissal (no denied callback)', async () => {
    const h = harness();
    h.ref.current = { clientPubkey: '1'.repeat(64) };
    await expect(h.approve()).resolves.toBe('connected');
    h.ref.current = h.ref.current ?? { clientPubkey: 'x' };
    expect(h.cancel()).toBe('dismissed');
    expect(h.effects).toEqual(['route', 'arm:wss://a', 'save:wss://a', 'sign:wss://a', 'send:wss://a']);
  });

  it('a failed approve reopens the request: retry works', async () => {
    let fail = true;
    const h = harness({ sendOk: () => !fail });
    h.ref.current = { clientPubkey: '1'.repeat(64) };
    await expect(h.approve()).rejects.toThrow('Could not complete');
    expect(h.effects).toContain('delete');     // the failed relay's pairing record is removed
    fail = false;
    await expect(h.approve()).resolves.toBe('connected');
  });

  it('a failed send on one relay hands the claim back for the next relay', async () => {
    const h = harness({ sendOk: (relay) => relay === 'wss://b' });
    h.ref.current = { clientPubkey: '1'.repeat(64) };
    await expect(h.approve(['wss://a', 'wss://b'])).resolves.toBe('connected');
    expect(h.effects).toContain('send-failed:wss://a');
    expect(h.effects).toContain('send:wss://b');
  });

  it('a request replaced mid-wait gets nothing delivered for the old one', async () => {
    const h = harness();
    h.ref.current = { clientPubkey: '1'.repeat(64) };
    h.hold();
    const approving = h.approve();
    h.ref.current = { clientPubkey: '2'.repeat(64) };   // a new connect request arrives
    h.release();
    await expect(approving).resolves.toBe('withdrawn');
    expect(h.effects).toEqual([]);
  });

  it('a settled request opened again is dismissed silently by Approve', async () => {
    const h = harness();
    const req = { clientPubkey: '1'.repeat(64) };
    h.ref.current = req;
    h.cancel();
    h.ref.current = req;
    await expect(h.approve()).resolves.toBe('dismissed');
    expect(h.effects).toEqual(['denied-callback']);
  });

  it('a Cancel while the connect response is in flight undoes the pairing and route once it resolves', async () => {
    let cancel: () => string = () => '';
    const h = harness({ duringSend: () => { expect(cancel()).toBe('dismissed'); } });
    cancel = h.cancel;
    h.ref.current = { clientPubkey: '1'.repeat(64) };
    await expect(h.approve()).resolves.toBe('cancelled');
    expect(h.effects).toEqual(['route', 'arm:wss://a', 'save:wss://a', 'sign:wss://a', 'send:wss://a', 'delete', 'route-cleared']);
    expect(h.stored()).toBeUndefined();
  });

  it('undoing a re-pair restores the earlier pairing record instead of deleting it', async () => {
    let cancel: () => string = () => '';
    const h = harness({ existing: 'old@wss://x', afterSave: () => { cancel(); } });
    cancel = h.cancel;
    h.ref.current = { clientPubkey: '1'.repeat(64) };
    await expect(h.approve()).resolves.toBe('withdrawn');
    expect(h.effects).not.toContain('delete');
    expect(h.effects).toContain('restore:old@wss://x');
    expect(h.stored()).toBe('old@wss://x');
  });

  it('a failed re-pair also restores the earlier record', async () => {
    const h = harness({ existing: 'old@wss://x', sendOk: () => false });
    h.ref.current = { clientPubkey: '1'.repeat(64) };
    await expect(h.approve()).rejects.toThrow('Could not complete');
    expect(h.stored()).toBe('old@wss://x');
  });

  it('re-pair during a slow send: the late rollback leaves the new pairing and its route alone', async () => {
    let h!: ReturnType<typeof harness>;
    let newRoute = 0;
    h = harness({
      duringSend: () => {
        h.cancel();                         // cancel while the response is in flight
        newRoute = h.externalRepair();      // user re-scans: new approval saves R2 + its own route
      },
    });
    h.ref.current = { clientPubkey: '1'.repeat(64) };
    await expect(h.approve()).resolves.toBe('cancelled');
    expect(h.stored()).toBe('R2');
    expect(h.liveRoute()).toBe(newRoute);
    expect(h.effects).not.toContain('delete');
    expect(h.effects).not.toContain('route-cleared');
  });

  it('revoke during a slow send: the late rollback does not resurrect the revoked pairing', async () => {
    let h!: ReturnType<typeof harness>;
    h = harness({
      existing: 'old@wss://x',
      duringSend: () => { h.cancel(); h.revoke(); },
    });
    h.ref.current = { clientPubkey: '1'.repeat(64) };
    await expect(h.approve()).resolves.toBe('cancelled');
    expect(h.stored()).toBeUndefined();
    expect(h.effects.some(e => e.startsWith('restore:'))).toBe(false);
    expect(h.effects).toContain('route-cleared');   // its own route still goes
  });

  it('Cancel while the response is being signed (slow routed connection) publishes nothing and leaves no route or pairing', async () => {
    let h!: ReturnType<typeof harness>;
    h = harness({ duringSigning: () => { expect(h.cancel()).toBe('denied'); } });
    h.ref.current = { clientPubkey: '1'.repeat(64) };
    await expect(h.approve()).resolves.toBe('withdrawn');
    expect(h.effects.filter(e => e.startsWith('send:'))).toEqual([]);   // zero connect responses
    expect(h.liveRoute()).toBe(0);                                      // no route
    expect(h.stored()).toBeUndefined();                                 // no pairing record
    expect(h.effects).toContain('denied-callback');
  });

  it('Cancel during the route wait: once the wait resolves nothing is sent and nothing remains', async () => {
    const h = harness();
    h.ref.current = { clientPubkey: '1'.repeat(64) };
    h.hold();                                   // parked in the device-held route wait
    const approving = h.approve();
    h.cancel();
    h.release();                                // the route comes back
    await expect(approving).resolves.toBe('withdrawn');
    expect(h.effects).toEqual(['denied-callback']);
    expect(h.liveRoute()).toBe(0);
    expect(h.stored()).toBeUndefined();
  });
});
