import { describe, it, expect } from 'vitest';
import { ConnectRouteTracker } from './connect-route-cancel';
import { AuthRequestSettlement } from './auth-request-settlement';

describe('ConnectRouteTracker', () => {
  it('a Cancel that takes over an in-flight approval clears its route at once', () => {
    const settlement = new AuthRequestSettlement();
    const routes = new ConnectRouteTracker();
    settlement.beginApproval('k');
    routes.record('k', 7);
    expect(routes.takeOnCancel('k', settlement.deny('k'), false)).toBe(7);
    // Taken once: the approval's own rollback finds nothing more to clear here.
    expect(routes.takeOnCancel('k', 'denied', false)).toBeNull();
  });

  it('a Cancel while the claimed response is in flight clears the route at once', () => {
    const settlement = new AuthRequestSettlement();
    const routes = new ConnectRouteTracker();
    settlement.beginApproval('k');
    routes.record('k', 3);
    expect(settlement.claimDelivery('k')).toBe(true);
    const outcome = settlement.deny('k');
    expect(outcome).toBe('already-answered');
    const recorded = settlement.requestCancelDuringDelivery('k');
    expect(recorded).toBe(true);
    expect(routes.takeOnCancel('k', outcome, recorded)).toBe(3);
  });

  it('keeps the route of a request that already connected', () => {
    const settlement = new AuthRequestSettlement();
    const routes = new ConnectRouteTracker();
    settlement.beginApproval('k');
    routes.record('k', 4);
    settlement.claimDelivery('k');
    settlement.finishDelivery('k');
    settlement.endApproval('k');
    const outcome = settlement.deny('k');
    expect(outcome).toBe('already-answered');
    expect(routes.takeOnCancel('k', outcome, settlement.requestCancelDuringDelivery('k'))).toBeNull();
  });

  it('clears the route left by an earlier failed approval when the request is then denied', () => {
    const settlement = new AuthRequestSettlement();
    const routes = new ConnectRouteTracker();
    settlement.beginApproval('k');
    routes.record('k', 9);
    settlement.endApproval('k'); // every relay failed; the request is open again
    expect(routes.takeOnCancel('k', settlement.deny('k'), false)).toBe(9);
  });

  it('never returns another request\'s route, nor one it forgot on connect', () => {
    const routes = new ConnectRouteTracker();
    routes.record('a', 1);
    routes.record('b', 2);
    routes.forget('b');
    expect(routes.takeOnCancel('b', 'took-over', false)).toBeNull();
    expect(routes.takeOnCancel('a', 'took-over', false)).toBe(1);
  });
});
