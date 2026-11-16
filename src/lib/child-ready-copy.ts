/**
 * Copy for the child-direct ready check: every Heartwood press a family will
 * ever need is collected during setup, at home, and both phones say plainly
 * when one is still owed. British English. Shown on the guardian's phone (end
 * of pairing, the child's Permissions page, the dependant's settings and home
 * card) and the child's phone (home, banners).
 *
 * The rule behind every line: never say Ready unless the Heartwood has
 * confirmed it, never ask for a press that cannot be shown to be owed, and say
 * so when this phone cannot tell. Lines about the child take the child's name
 * on the guardian's phone and speak to the child (`child`) on the child's own.
 */
import { HEARTWOOD_HOLD_TO_FINISH } from './local-key-only-copy';

export const CHILD_READY_COPY = {
  notReadyHeading: 'Not ready away from home',
  pressesOwed: (n: number) => (n === 1 ? `${n} press still needed on your Heartwood.` : `${n} presses still needed on your Heartwood.`),
  doAtHome: 'Do this at home, with the Heartwood in reach.',
  finishNow: 'Finish now',
  ready: 'Ready to use away from home.',
  pressAndHold: HEARTWOOD_HOLD_TO_FINISH,
  /** The Heartwood did not say what it has remembered (older firmware, or a reply this phone could not read). */
  unknownHeading: 'Can\'t confirm from this phone',
  unknownBody: (name: string) => `Your Heartwood didn't report what it has remembered. Check ${name}'s phone shows Ready, or update the Heartwood.`,
  /** The slot already holds as many identities as the Heartwood can remember for it. */
  fullHeading: 'Your Heartwood can\'t remember any more identities for this phone',
  fullBody: (name: string) => `It will ask for a press each time ${name} uses this one.`,
  /** A paused child's slot refuses everything, so nothing is asked of the Heartwood. */
  paused: (name: string) => `Paused. Readiness will be checked when ${name} is unpaused.`,
  /** The child's card after a minute without a connection to the Heartwood. */
  unreachableHeading: 'Can\'t reach your family Heartwood',
  unreachableBody: (guardianName: string) => `If this keeps happening, ask ${guardianName} to check this phone's pairing.`,
  /** Checklist row states. */
  state: {
    waiting: 'Waiting for a press',
    ready: 'Ready',
    skipped: 'Skipped',
    unknown: 'Not confirmed',
    full: 'Asks every time',
  },
  retry: 'Try again',
  later: 'Later',
  approveNow: 'Approve now',
  /** The guardian's own row: never names the guardian's real identity. */
  guardianRow: 'This phone, as guardian',
  /** Guardian's checklist: the child's presses are started from the child's phone. */
  childPressHint: (name: string) => `${name}'s presses start from their phone: tap “Finish now” there.`,
  /** Each row's identity line, as the Heartwood card shows it. */
  onHeartwood: (shortNpub: string) => `On the Heartwood: ${shortNpub}`,
  /**
   * On the child's own phone the same lines speak to the child ("you"), never
   * about them by name. The guardian-side lines above keep `{name}`.
   */
  child: {
    unknownBody: 'Your Heartwood didn\'t report what it has remembered.',
    fullBody: 'It will ask for a press each time you use this one.',
    paused: 'Paused. Readiness will be checked when you are unpaused.',
  },
} as const;
