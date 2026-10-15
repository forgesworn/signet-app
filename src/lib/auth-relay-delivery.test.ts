import { describe, it, expect, vi } from 'vitest';
import { armFirstOpenRelay, authBunkerRelays, deliveredToConsumer, planAuthDeliveryTargets, publishToEveryRelay } from './auth-relay-delivery';

const A = 'wss://nos.lol';
const B = 'wss://relay.trotters.cc';
const C = 'wss://relay.primal.net';
const USER = 'wss://relay.user.example';

describe('planAuthDeliveryTargets', () => {
  it('puts every consumer relay first, then the user relay', () => {
    expect(planAuthDeliveryTargets([A, B], USER)).toEqual({ targets: [A, B, USER], consumerCount: 2 });
  });
  it('drops the user relay when it is already a consumer relay (normalised)', () => {
    expect(planAuthDeliveryTargets([A, B], 'wss://relay.trotters.cc/')).toEqual({ targets: [A, B], consumerCount: 2 });
  });
  it('one consumer relay, no user relay', () => {
    expect(planAuthDeliveryTargets([A], undefined)).toEqual({ targets: [A], consumerCount: 1 });
  });
});

describe('deliveredToConsumer', () => {
  it('consumer relay #1 fails, #2 accepts: delivered', () => {
    const { targets, consumerCount } = planAuthDeliveryTargets([A, B], USER);
    const results = targets.map(t => t === B);
    expect(deliveredToConsumer(results, consumerCount)).toBe(true);
  });
  it('only the user relay accepts: not delivered', () => {
    const { targets, consumerCount } = planAuthDeliveryTargets([A, B], USER);
    const results = targets.map(t => t === USER);
    expect(deliveredToConsumer(results, consumerCount)).toBe(false);
  });
  it('single consumer relay keeps the old rule', () => {
    expect(deliveredToConsumer([true, false], 1)).toBe(true);
    expect(deliveredToConsumer([false, true], 1)).toBe(false);
  });
  it('nothing accepted: not delivered', () => {
    expect(deliveredToConsumer([false, false, false], 3)).toBe(false);
  });
});

describe('armFirstOpenRelay', () => {
  it('falls through to relay #2 when #1 does not open', async () => {
    const arm = vi.fn(async (relay: string) => {
      if (relay === A) throw new Error('listener not ready (phase connecting; relay wss://nos.lol/)');
    });
    await expect(armFirstOpenRelay([A, B, C], arm)).resolves.toBe(B);
    expect(arm.mock.calls.map(c => c[0])).toEqual([A, B]);
  });

  it('names every relay tried when none opens', async () => {
    const arm = vi.fn(async (relay: string) => { throw new Error(`timeout on ${relay}`); });
    const err: unknown = await armFirstOpenRelay([A, B], arm).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain(`${A}: timeout on ${A}`);
    expect(message).toContain(`${B}: timeout on ${B}`);
    expect(arm).toHaveBeenCalledTimes(2);
  });

  it('a single relay rethrows its own error unchanged', async () => {
    const original = new Error('listener not ready (phase connecting; relay wss://nos.lol/)');
    await expect(armFirstOpenRelay([A], async () => { throw original; })).rejects.toBe(original);
  });

  it('stops before the next relay once the request is withdrawn', async () => {
    let open = true;
    const arm = vi.fn(async () => { open = false; throw new Error('nope'); });
    await expect(armFirstOpenRelay([A, B], arm, () => open)).resolves.toBeNull();
    expect(arm).toHaveBeenCalledTimes(1);
  });
});

describe('authBunkerRelays', () => {
  it('armed relay first, then other consumer relays, then the rest, deduped', () => {
    expect(authBunkerRelays(B, [A, B], [USER, 'wss://nos.lol/', C, undefined, ''])).toEqual([B, A, USER, C]);
  });
});

describe('publishToEveryRelay (sign-in Deny)', () => {
  it('sends to every consumer relay in parallel, and one failure does not stop the rest', async () => {
    const started: string[] = [];
    const releases: Array<() => void> = [];
    const publish = vi.fn((relay: string) => {
      started.push(relay);
      if (relay === A) return Promise.reject(new Error('unreachable'));
      return new Promise<boolean>(resolve => releases.push(() => resolve(true)));
    });
    const done = publishToEveryRelay([A, B, C, 'wss://relay.trotters.cc/'], publish);
    // All started before any answered: parallel, deduped.
    expect(started).toEqual([A, B, C]);
    releases.forEach(r => r());
    await expect(done).resolves.toEqual([false, true, true]);
  });

  it('a publish that throws synchronously counts as false', async () => {
    await expect(publishToEveryRelay([A, B], relay => {
      if (relay === A) throw new Error('boom');
      return Promise.resolve(true);
    })).resolves.toEqual([false, true]);
  });
});
