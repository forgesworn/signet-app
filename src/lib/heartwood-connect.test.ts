import { describe, it, expect, vi } from 'vitest';
import {
  resolveHeartwoodConnect, HeartwoodConnectCancelled, HeartwoodConnectFailed, ownerGrantFromDecision,
  type HeartwoodConnectSigner,
} from './heartwood-connect';
import {
  pairWordsForClient, type FullAccessDecision, type FullAccessOffer, type HeartwoodConnectUi, type OwnerStyle,
} from './heartwood-one-hold';
import { HeartwoodOnboardingError } from './heartwood-onboarding';

const NP = 'a'.repeat(64);
const PERSONA = 'b'.repeat(64);
const MASTER = 'c'.repeat(64);
const CLIENT = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const METHODS = ['sign_event', 'heartwood_approve_bundle'];
/** `heartwood_list_identities`, as the firmware lists the owner's two keys. */
const IDENTITIES = JSON.stringify([
  { pubkey: NP, purpose: 'nostr:persona:natural-person', index: 0 },
  { pubkey: PERSONA, purpose: 'nostr:persona:persona', index: 0 },
]);

function reply(over: Record<string, unknown> = {}) {
  return JSON.stringify({ v: 1, pubkeys: { 'natural-person': NP, persona: PERSONA }, act_as: ['persona'], owner: true, style: 'everyday', ...over });
}
function signer(handler: (method: string, params: string[]) => Promise<string>): HeartwoodConnectSigner & { request: ReturnType<typeof vi.fn> } {
  return { transportClientPubkeyHex: CLIENT, activePublicKeyHex: MASTER, request: vi.fn(handler) };
}
/** The screen: taps "set up" with the given style the moment it is shown. */
function tapping(style: OwnerStyle): HeartwoodConnectUi & { offers: FullAccessOffer[] } {
  const offers: FullAccessOffer[] = [];
  return {
    offers,
    chooseFullAccess: async (offer) => {
      offers.push(offer);
      const out = await offer.run(style);
      return out.ok ? { mode: 'bundle', reply: out.reply, style: out.reply.style } : { mode: 'separate' };
    },
  };
}

describe('resolveHeartwoodConnect (handleConnectHeartwood, A1)', () => {
  it('probe, choice, keys from the reply: the words and the request share the signer\'s client key', async () => {
    const s = signer(async () => reply());
    const ui = tapping('everyday');
    const probe = vi.fn().mockResolvedValue(METHODS);
    const out = await resolveHeartwoodConnect({ signer: s, ui, probe });
    expect(probe).toHaveBeenCalledTimes(1);
    // The words shown are the ones for the key that makes the request.
    expect(ui.offers).toHaveLength(1);
    expect(ui.offers[0].words).toEqual(pairWordsForClient(s.transportClientPubkeyHex));
    expect(ui.offers[0].words).toHaveLength(5);
    // One bundle, over the same signer, nothing else asked for.
    expect(s.request).toHaveBeenCalledTimes(1);
    expect(s.request.mock.calls[0][0]).toBe('heartwood_approve_bundle');
    expect(out.keys).toEqual({ kind: 'heartwood', naturalPerson: NP, persona: PERSONA });
  });

  it('the grant on file is the device\'s answer: its style, and its act_as echo', async () => {
    const s = signer(async () => reply({ style: 'careful', act_as: ['persona'] }));
    const out = await resolveHeartwoodConnect({ signer: s, ui: tapping('everyday'), probe: async () => METHODS });
    expect(out.ownerGrant).toEqual({ style: 'careful', actAs: ['persona'] });
  });

  it('onboarding asks for the persona only, so the echo can never name the real name', async () => {
    const s = signer(async (m) => (m === 'heartwood_approve_bundle' ? reply({ act_as: ['natural-person', 'persona'] }) : IDENTITIES));
    const out = await resolveHeartwoodConnect({ signer: s, ui: tapping('everyday'), probe: async () => METHODS });
    // A wider answer than asked is not a success: it falls to today's flow.
    expect(out.fullAccess.mode).toBe('separate');
    expect(out.ownerGrant).toBeUndefined();
    const sent = JSON.parse(s.request.mock.calls[0][1][0]);
    expect(sent.act_as).toEqual(['persona']);
  });

  it('no hold on file when the owner chose to approve separately, or the firmware has no bundle method', async () => {
    const list = IDENTITIES;
    const ui = { chooseFullAccess: vi.fn().mockResolvedValue({ mode: 'separate' }) };
    const s1 = signer(async () => list);
    const a = await resolveHeartwoodConnect({ signer: s1, ui, probe: async () => METHODS });
    expect(a.ownerGrant).toBeUndefined();
    expect(a.fullAccess).toEqual({ mode: 'separate' });
    expect(s1.request.mock.calls.every(c => c[0] !== 'heartwood_approve_bundle')).toBe(true);

    const ui2 = { chooseFullAccess: vi.fn() };
    const b = await resolveHeartwoodConnect({ signer: signer(async () => list), ui: ui2, probe: async () => ['sign_event'] });
    expect(ui2.chooseFullAccess).not.toHaveBeenCalled();
    expect(b.ownerGrant).toBeUndefined();
  });

  it('backing out of the choice throws a cancel and sends nothing', async () => {
    const s = signer(async () => reply());
    const ui = { chooseFullAccess: vi.fn().mockResolvedValue({ mode: 'cancel' }) };
    await expect(resolveHeartwoodConnect({ signer: s, ui, probe: async () => METHODS })).rejects.toBeInstanceOf(HeartwoodConnectCancelled);
    expect(s.request).not.toHaveBeenCalled();
  });

  it('a retry keeps the decision: no second probe, no second choice, no second bundle', async () => {
    const bundleRan = signer(async (m) => {
      if (m === 'heartwood_approve_bundle') return reply();
      throw new Error('unreachable');
    });
    // First attempt: the hold worked, then key resolution is not even needed.
    const first = await resolveHeartwoodConnect({ signer: bundleRan, ui: tapping('everyday'), probe: async () => METHODS });
    expect(first.fullAccess.mode).toBe('bundle');

    // A decision of "separate" whose key listing then fails: the failure carries the decision.
    const failing = signer(async () => { throw new Error('socket closed'); });
    const separate: FullAccessDecision = { mode: 'separate' };
    const ui = { chooseFullAccess: vi.fn().mockResolvedValue(separate) };
    let carried: FullAccessDecision | undefined;
    try {
      await resolveHeartwoodConnect({ signer: failing, ui, probe: async () => METHODS });
    } catch (e) {
      expect(e).toBeInstanceOf(HeartwoodConnectFailed);
      expect((e as HeartwoodConnectFailed).original).toBeInstanceOf(HeartwoodOnboardingError);
      carried = (e as HeartwoodConnectFailed).fullAccess;
    }
    expect(carried).toEqual({ mode: 'separate' });

    // The retry hands that back: nothing is probed or asked again.
    const retrySigner = signer(async () => IDENTITIES);
    const probe = vi.fn();
    const ui2 = { chooseFullAccess: vi.fn() };
    const retried = await resolveHeartwoodConnect({ signer: retrySigner, ui: ui2, probe, held: carried });
    expect(probe).not.toHaveBeenCalled();
    expect(ui2.chooseFullAccess).not.toHaveBeenCalled();
    expect(retried.keys).toEqual({ kind: 'heartwood', naturalPerson: NP, persona: PERSONA });
  });

  it('a held bundle decision is reused without a second hold', async () => {
    const s = signer(async () => { throw new Error('must not be asked'); });
    const held: FullAccessDecision = {
      mode: 'bundle', style: 'careful',
      reply: { naturalPerson: NP, persona: PERSONA, actAs: ['persona'], style: 'careful' },
    };
    const out = await resolveHeartwoodConnect({ signer: s, ui: undefined, probe: async () => null, held });
    expect(s.request).not.toHaveBeenCalled();
    expect(out.keys).toEqual({ kind: 'heartwood', naturalPerson: NP, persona: PERSONA });
    expect(out.ownerGrant).toEqual({ style: 'careful', actAs: ['persona'] });
  });

  it('ownerGrantFromDecision is empty unless a bundle worked', () => {
    expect(ownerGrantFromDecision(undefined)).toBeUndefined();
    expect(ownerGrantFromDecision({ mode: 'separate' })).toBeUndefined();
    expect(ownerGrantFromDecision({ mode: 'cancel' })).toBeUndefined();
  });
});
