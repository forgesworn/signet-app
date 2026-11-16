/**
 * Copy for the child-direct ready check: every Heartwood press a family will
 * ever need is collected during setup, at home, and both phones say plainly
 * when one is still owed. British English. Shown on the guardian's phone (end
 * of pairing, the child's Permissions page) and the child's phone (home,
 * banners, Permissions page).
 */

export const CHILD_READY_COPY = {
  notReadyHeading: 'Not ready away from home',
  pressesOwed: (n: number) => (n === 1 ? `${n} press still needed on your Heartwood.` : `${n} presses still needed on your Heartwood.`),
  doAtHome: 'Do this at home, with the Heartwood in reach.',
  finishNow: 'Finish now',
  ready: 'Ready to use away from home.',
  pressAndHold: 'Press and hold the button on your Heartwood to finish.',
  /** Checklist row states. */
  state: {
    waiting: 'Waiting for a press',
    ready: 'Ready',
    skipped: 'Skipped',
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
} as const;
